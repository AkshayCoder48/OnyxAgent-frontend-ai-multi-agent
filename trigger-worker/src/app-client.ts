// ============================================================================
// Background Task Execution Framework — worker→app HTTP client.
//
// The app owns ALL task state behind /api/tasks/worker. This client speaks
// the pull-based claim/report/sweep protocol (frozen in protocol.ts):
//
//   POST {APP_URL}/api/tasks/worker
//     {action:"claim",  token, limit}                    → {ok, runs[]}
//     {action:"report", token, runId, phase?, ...}       → {ok:true}
//     {action:"sweep",  token}                           → {ok, fired}
//
// Transport policy: 30s timeout per request, up to 2 retries on 5xx /
// network errors (linear backoff). 4xx responses are contract or auth
// problems (e.g. WORKER_TOKEN mismatch surfaces as 503/401 on the app) —
// they fail fast so the caller sees the real status code.
// ============================================================================

import type {
  WorkerClaimResponse,
  WorkerClaimedRun,
  WorkerReportRequest,
  WorkerReportResponse,
  WorkerSweepResponse,
} from "./protocol.js";
import { normalizeOrigin } from "./env.js";

/** Per-request timeout (the app should answer claims/reports in ms). */
const REQUEST_TIMEOUT_MS = 30_000;
/** 1 attempt + 2 retries on retryable failures. */
const MAX_ATTEMPTS = 3;
/** Linear backoff between retries. */
const RETRY_DELAY_MS = 500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Endpoint URL for the worker protocol on the app. */
function workerEndpoint(appUrl: string): string {
  return `${normalizeOrigin(appUrl)}/api/tasks/worker`;
}

/** Error carrying the app's HTTP status (4xx = fatal, 5xx = retryable). */
class AppHttpError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`app returned HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "AppHttpError";
    this.status = status;
  }
}

/**
 * POST JSON and parse the JSON response. Retries 5xx / network / timeout
 * errors up to MAX_ATTEMPTS; anything else (ok 2xx, or 4xx) is final.
 */
async function postJson<T>(url: string, body: unknown): Promise<T> {
  let lastError: unknown = new Error("request never attempted");

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.ok) {
        return (await res.json()) as T;
      }

      const detail = await res
        .text()
        .then((t) => t.slice(0, 300))
        .catch(() => "");
      if (res.status < 500 || attempt === MAX_ATTEMPTS) {
        // 4xx (contract/auth error) or the last 5xx attempt — give up now.
        throw new AppHttpError(res.status, detail);
      }
      lastError = new AppHttpError(res.status, detail); // 5xx → retry
    } catch (err) {
      if (err instanceof AppHttpError && err.status < 500) throw err;
      // Network / abort / timeout — retryable.
      lastError = err;
      if (attempt === MAX_ATTEMPTS) break;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ---------------------------------------------------------------------------
// Protocol actions
// ---------------------------------------------------------------------------

/**
 * Claim up to `limit` queued runs from the app. Returns [] when nothing is
 * queued (the common case — poll-claims stays silent).
 */
export async function claimRuns(
  appUrl: string,
  token: string,
  limit: number,
): Promise<WorkerClaimedRun[]> {
  const json = await postJson<WorkerClaimResponse>(workerEndpoint(appUrl), {
    action: "claim",
    token,
    limit,
  });
  if (!json || typeof json !== "object" || json.ok !== true || !Array.isArray(json.runs)) {
    throw new Error("malformed claim response from the app (expected {ok, runs[]})");
  }
  return json.runs;
}

/**
 * Report progress / chunks / artifacts / terminal status for a run. Chunks
 * are sent WITHOUT seq — the server assigns the monotonic sequence.
 */
export async function reportRun(
  appUrl: string,
  token: string,
  payload: Omit<WorkerReportRequest, "token">,
): Promise<void> {
  await postJson<WorkerReportResponse>(workerEndpoint(appUrl), {
    action: "report",
    token,
    ...payload,
  });
}

/**
 * Ask the app to fire due TaskSchedule rows (cron scheduler sweep).
 * Returns the number of schedules fired (0 = nothing due — skip silently).
 */
export async function sweepSchedules(appUrl: string, token: string): Promise<number> {
  const json = await postJson<WorkerSweepResponse>(workerEndpoint(appUrl), {
    action: "sweep",
    token,
  });
  if (!json || typeof json !== "object" || json.ok !== true || typeof json.fired !== "number") {
    throw new Error("malformed sweep response from the app (expected {ok, fired})");
  }
  return json.fired;
}
