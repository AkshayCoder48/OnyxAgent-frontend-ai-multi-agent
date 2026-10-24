// ============================================================================
// Background Task Execution Framework — /api/tasks/cloud (Trigger.dev CLOUD).
//
// The Settings → Cloud Tasks backend:
//
//   GET    → mode + connection status (masked key, verification snapshot,
//            task slug, effective WORKER_TOKEN for the setup checklist,
//            dashboard base, appUrl). NEVER returns the API key itself.
//   POST   { apiKey, taskSlug? }  → verify against api.trigger.dev, then
//            persist (AES-256-GCM). Mints a WORKER_TOKEN when neither the
//            env var nor a previous token exists, so the operator can wire
//            the deployed cloud worker without editing .env.
//   PATCH  { taskSlug }           → change the task id the app kicks.
//   DELETE → disconnect (back to the local orchestrator).
//
// Body-logging discipline mirrors /api/tasks/trigger: keys and tokens are
// NEVER logged — only statuses and masked forms.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import {
  clearCloudConfig,
  cloudApiBase,
  cloudDashboardBase,
  getCloudConfig,
  getEffectiveWorkerToken,
  invalidateCloudConfigCache,
  maskSecret,
  refreshCloudAccount,
  saveCloudConfig,
  updateCloudTaskSlug,
  verifyCloudKey,
} from "@/lib/tasks/trigger-cloud";
import {
  getOrchestrationMode,
  invalidateOrchestrationModeCache,
} from "@/lib/tasks/orchestration-mode";
import { startSchedulerLoop } from "@/lib/tasks/cron-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Cloud key shapes: tr_prod_sk_/tr_dev_sk_… (environment secret keys),
 * tr_trigger_… (environment), tr_pat_… (personal access). */
const CLOUD_KEY_RE = /^tr_[A-Za-z0-9_\-]{16,}$/;
/** Trigger.dev task id (slug) shape. */
const TASK_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const DEFAULT_TASK_SLUG = "agent-run";

function bad(detail: string, status = 400): NextResponse {
  return NextResponse.json({ ok: false, error: detail }, { status });
}

function normalizeTaskSlug(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return DEFAULT_TASK_SLUG;
  if (typeof value !== "string") return null;
  const slug = value.trim();
  return TASK_SLUG_RE.test(slug) ? slug : null;
}

/** Shared status payload (GET + POST responses). */
async function statusPayload(request: NextRequest): Promise<Record<string, unknown>> {
  const [mode, config, workerToken] = await Promise.all([
    getOrchestrationMode(),
    getCloudConfig(),
    getEffectiveWorkerToken(),
  ]);
  const appUrl =
    process.env.APP_URL?.trim() || new URL(request.url).origin.replace(/\/+$/, "");

  return {
    ok: true,
    mode,
    selfHosted: mode === "selfhosted",
    appUrl,
    cloud: config
      ? {
          configured: true,
          keySource: config.keySource,
          maskedKey: config.maskedKey,
          taskSlug: config.taskSlug,
          account: config.account,
          verifiedAt: config.verifiedAt,
          dashboardBase: cloudDashboardBase(config.account),
          // True when the server filesystem is read-only (serverless) and
          // the config lives in process memory — the browser mirror is the
          // durable store and re-applies the key after each cold start.
          ephemeral: config.ephemeral === true,
          // The operator's own worker token — needed to wire the deployed
          // cloud project (setup checklist). Not the API key.
          workerToken: workerToken.token,
          workerTokenSource: workerToken.source,
          apiBase: cloudApiBase(),
        }
      : {
          configured: false,
          keySource: null as string | null,
          maskedKey: null as string | null,
          taskSlug: DEFAULT_TASK_SLUG,
          account: null,
          verifiedAt: null as string | null,
          dashboardBase: null as string | null,
          ephemeral: false,
          workerToken: workerToken.token,
          workerTokenSource: workerToken.source,
          apiBase: cloudApiBase(),
        },
  };
}

// ---------------------------------------------------------------------------
// GET — connection status.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  return NextResponse.json(await statusPayload(request));
}

// ---------------------------------------------------------------------------
// POST — verify + connect.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { action?: unknown; apiKey?: unknown; taskSlug?: unknown; workerToken?: unknown };
  try {
    body = (await request.json()) as {
      action?: unknown;
      apiKey?: unknown;
      taskSlug?: unknown;
      workerToken?: unknown;
    };
  } catch {
    return bad("invalid JSON body");
  }

  // The browser mirror's WORKER_TOKEN (reconnect path) — re-used instead of
  // re-minting so the deployed-worker setup checklist stays stable across
  // serverless cold starts. Shape-guarded; empty/invalid → ignored.
  const mirrorWorkerToken =
    typeof body.workerToken === "string" && /^[A-Za-z0-9_\-]{16,128}$/.test(body.workerToken.trim())
      ? body.workerToken.trim()
      : undefined;

  // ── action:"retest" — re-verify the STORED key against api.trigger.dev
  // (refreshes the account snapshot + verifiedAt; the key never leaves the
  // server — only its verification result round-trips).
  if (body.action === "retest") {
    const config = await getCloudConfig();
    if (!config || config.keySource !== "settings") {
      return bad("not connected — connect a key first", 409);
    }
    const verified = await verifyCloudKey(config.apiKey);
    if (!verified.ok) {
      return NextResponse.json(
        { ok: false, error: verified.error, verified: false },
        { status: verified.status === 0 ? 502 : 400 },
      );
    }
    try {
      await refreshCloudAccount(verified.account);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return bad(`verified, but refreshing the snapshot failed: ${message.slice(0, 200)}`, 500);
    }
    invalidateOrchestrationModeCache();
    const payload = await statusPayload(request);
    return NextResponse.json({ ...payload, verified: true });
  }

  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey || !CLOUD_KEY_RE.test(apiKey)) {
    return bad(
      "apiKey must be a trigger.dev key — tr_prod_sk_… / tr_dev_sk_… (environment secret keys) or tr_pat_… (personal access), from cloud.trigger.dev → API keys",
    );
  }
  const taskSlug = normalizeTaskSlug(body.taskSlug);
  if (!taskSlug) {
    return bad("taskSlug must be a valid task id (letters, digits, . _ -, max 64 chars)");
  }

  // 1) Verify against api.trigger.dev BEFORE persisting anything.
  const verified = await verifyCloudKey(apiKey);
  if (!verified.ok) {
    return NextResponse.json(
      { ok: false, error: verified.error, verified: false },
      { status: verified.status === 0 ? 502 : 400 },
    );
  }

  // 2) Persist (seals the key; mints a WORKER_TOKEN when none exists).
  //    On a read-only filesystem (serverless) this degrades to process
  //    memory (persisted:false) — still a SUCCESSFUL connect.
  try {
    await saveCloudConfig({ apiKey, taskSlug, account: verified.account, workerToken: mirrorWorkerToken });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: `verified, but saving failed: ${message.slice(0, 200)}` },
      { status: 500 },
    );
  }

  invalidateOrchestrationModeCache();
  startSchedulerLoop(); // re-arm the loop under the new mode
  const status = await statusPayload(request);
  console.log(
    status.cloud.ephemeral
      ? `[tasks] Trigger.dev Cloud connected in SESSION mode (read-only filesystem — key lives in the operator's browser) (${maskSecret(apiKey)}, task "${taskSlug}")`
      : `[tasks] Trigger.dev Cloud connected (${maskSecret(apiKey)}, task "${taskSlug}") — background tasks now dispatch to the cloud`,
  );

  return NextResponse.json({ ...status, verified: true });
}

// ---------------------------------------------------------------------------
// PATCH — change the kicked task slug.
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  let body: { taskSlug?: unknown };
  try {
    body = (await request.json()) as { taskSlug?: unknown };
  } catch {
    return bad("invalid JSON body");
  }
  const taskSlug = normalizeTaskSlug(body.taskSlug);
  if (!taskSlug) {
    return bad("taskSlug must be a valid task id (letters, digits, . _ -, max 64 chars)");
  }
  const config = await getCloudConfig();
  if (!config || config.keySource !== "settings") {
    return bad("not connected — connect a key first", 409);
  }
  try {
    await updateCloudTaskSlug(taskSlug);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return bad(`failed to save the task slug: ${message.slice(0, 200)}`, 500);
  }
  invalidateCloudConfigCache();
  invalidateOrchestrationModeCache();
  return NextResponse.json(await statusPayload(request));
}

// ---------------------------------------------------------------------------
// DELETE — disconnect.
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const config = await getCloudConfig();
  if (config && config.keySource === "settings") {
    try {
      await clearCloudConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return bad(`failed to disconnect: ${message.slice(0, 200)}`, 500);
    }
    invalidateCloudConfigCache();
    invalidateOrchestrationModeCache();
    console.log("[tasks] Trigger.dev Cloud disconnected — back to the local orchestrator");
  }
  return NextResponse.json(await statusPayload(request));
}
