// ============================================================================
// Background Task Execution Framework — /api/tasks/cloud (Trigger.dev CLOUD).
//
// The Settings → Cloud backend. The ONLY execution mode: connect a
// trigger.dev Cloud key and every background task (chat agent runs,
// sub-agent chains, scheduled business tasks, terminal commands) runs
// durably on the operator's own cloud project — zero setup beyond the key:
//
//   GET    → mode + connection status (masked key, verification snapshot,
//            dashboard base) + WORKER BOOTSTRAP state (liveness probe of the
//            deployed agent-run task; auto-deploy progress when a deploy is
//            in flight). NEVER returns the API key itself.
//   POST   { apiKey }             → verify against api.trigger.dev
//                                   (whoami), persist (AES-256-GCM), probe
//                                   the worker and AUTO-DEPLOY it to the
//                                   operator's project when missing.
//   POST   { action:"retest" }    → re-verify the stored key + liveness.
//   POST   { action:"deploy" }    → (re)deploy the bundled worker now.
//   PATCH  { taskSlug }           → change the task id the app kicks.
//   DELETE → disconnect.
//
// Body-logging discipline mirrors /api/tasks/trigger: keys are NEVER logged
// — only statuses and masked forms.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import {
  autoDeployWorker,
  clearCloudConfig,
  cloudApiBase,
  cloudDashboardBase,
  getCloudConfig,
  getWorkerBootstrapState,
  invalidateCloudConfigCache,
  maskSecret,
  probeWorkerLiveness,
  refreshCloudAccount,
  saveCloudConfig,
  updateCloudTaskSlug,
  verifyCloudKey,
  type WorkerBootstrapState,
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
async function statusPayload(
  request: NextRequest,
  bootstrap?: WorkerBootstrapState,
): Promise<Record<string, unknown>> {
  const [mode, config, state] = await Promise.all([
    getOrchestrationMode(),
    getCloudConfig(),
    bootstrap ? Promise.resolve(bootstrap) : getWorkerBootstrapState().catch(() => null),
  ]);
  const appUrl =
    process.env.APP_URL?.trim() || new URL(request.url).origin.replace(/\/+$/, "");

  return {
    ok: true,
    mode,
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
          apiBase: cloudApiBase(),
        },
    ...(state ? { bootstrap: state } : {}),
  };
}

// ---------------------------------------------------------------------------
// GET — connection status (+ cached worker bootstrap state).
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  return NextResponse.json(await statusPayload(request));
}

// ---------------------------------------------------------------------------
// POST — verify + connect (+ auto-bootstrap the worker), retest, deploy.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { action?: unknown; apiKey?: unknown; taskSlug?: unknown };
  try {
    body = (await request.json()) as {
      action?: unknown;
      apiKey?: unknown;
      taskSlug?: unknown;
    };
  } catch {
    return bad("invalid JSON body");
  }

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
    const bootstrap = await getWorkerBootstrapState({ skipCache: true }).catch(() => null);
    const payload = await statusPayload(request, bootstrap ?? undefined);
    return NextResponse.json({ ...payload, verified: true });
  }

  // ── action:"deploy" — (re)deploy the bundled worker to the operator's
  // project now (from Settings; requires a writable server filesystem).
  if (body.action === "deploy") {
    const config = await getCloudConfig();
    if (!config) {
      return bad("not connected — connect a key first", 409);
    }
    const deploy = await autoDeployWorker(config);
    const bootstrap = await getWorkerBootstrapState().catch(() => null);
    const payload = await statusPayload(request, bootstrap ?? undefined);
    return NextResponse.json({ ...payload, deploy });
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

  // 2) Persist (seals the key). On a read-only filesystem (serverless) this
  //    degrades to process memory (persisted:false) — still a SUCCESSFUL
  //    connect.
  try {
    await saveCloudConfig({ apiKey, taskSlug, account: verified.account });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: `verified, but saving failed: ${message.slice(0, 200)}` },
      { status: 500 },
    );
  }

  invalidateOrchestrationModeCache();
  startSchedulerLoop(); // re-arm the schedule loop under the new mode

  // 3) Bootstrap: probe the deployed worker; auto-deploy it when missing
  //    (writable server filesystems only — deployments persist server-side
  //    on the cloud, so serverless instances ride the existing deployment).
  let bootstrap: WorkerBootstrapState | null = null;
  try {
    const config = await getCloudConfig();
    if (config) {
      const liveness = await probeWorkerLiveness(config, { skipCache: true });
      if (liveness === "undeployed" || liveness === "unknown") {
        await autoDeployWorker(config);
      }
      bootstrap = await getWorkerBootstrapState().catch(() => null);
    }
  } catch (err) {
    console.warn(
      `[tasks] worker bootstrap check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const status = await statusPayload(request, bootstrap ?? undefined);
  console.log(
    status.cloud && typeof status.cloud === "object" && (status.cloud as { ephemeral?: boolean }).ephemeral
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
    console.log("[tasks] Trigger.dev Cloud disconnected");
  }
  return NextResponse.json(await statusPayload(request));
}
