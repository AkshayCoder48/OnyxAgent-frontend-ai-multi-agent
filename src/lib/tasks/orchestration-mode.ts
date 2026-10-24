// ============================================================================
// Background Task Execution Framework — orchestration mode switch.
//
// Lives in its own module (not cron-scheduler / local-driver) because BOTH
// need it and they import each other — a shared definition there would be a
// dependency cycle.
//
// THREE modes, resolved in priority order:
//
//   1. "selfhosted" — TRIGGER_DEV_URL + TRIGGER_DEV_TOKEN env vars point at a
//      SELF-HOSTED Trigger.dev v3 instance. The deployed worker owns
//      execution: the trigger route leaves runs "queued", the local scheduler
//      loop only ARMS nextRunAt, and the worker polls
//      POST /api/tasks/worker {action:"claim"|"sweep"}.
//
//   2. "cloud" — the operator connected Trigger.dev CLOUD (api.trigger.dev)
//      via Settings → Cloud Tasks (a verified key stored in TaskCloudConfig)
//      — no self-hosting needed. Same worker protocol, PLUS the app kicks
//      the deployed `agent-run` task directly through the cloud REST API for
//      zero-queue-latency dispatch, and self-heals stuck runs from cloud
//      run state (see trigger-cloud.ts).
//
//   3. "local" (default) — the in-process local driver owns execution.
//
// Resolution is ASYNC (cloud config lives in SQLite) with a short-lived
// in-memory cache so hot paths (every status poll, every scheduler tick)
// never hammer the database. invalidateOrchestrationModeCache() is called by
// the cloud-config route whenever the operator connects/disconnects.
// ============================================================================

import { getCloudConfig } from "./trigger-cloud";

export type OrchestrationMode = "local" | "selfhosted" | "cloud";

/** True when a SELF-HOSTED Trigger.dev worker owns execution (env-configured;
 *  takes priority over the cloud key so explicit server config always wins). */
export function isSelfHostedMode(): boolean {
  return Boolean(
    process.env.TRIGGER_DEV_URL?.trim() && process.env.TRIGGER_DEV_TOKEN?.trim(),
  );
}

/** Cache lifetime — the mode only changes when the operator connects or
 *  disconnects a key (which also invalidates explicitly), so 30s is generous. */
const MODE_CACHE_TTL_MS = 30_000;

interface ModeGlobal {
  __onyxOrchestrationMode?: { mode: OrchestrationMode; at: number } | null;
}
const g = globalThis as unknown as ModeGlobal;

/**
 * Resolve the active orchestration mode (async; cached ~30s per process).
 * Hot paths may call this on every request — the cache keeps it to at most
 * one SQLite read per TTL window.
 */
export async function getOrchestrationMode(): Promise<OrchestrationMode> {
  // Env-configured self-hosting always wins — explicit server config.
  if (isSelfHostedMode()) return "selfhosted";

  const cached = g.__onyxOrchestrationMode;
  if (cached && Date.now() - cached.at < MODE_CACHE_TTL_MS) return cached.mode;

  const cloud = await getCloudConfig();
  const mode: OrchestrationMode = cloud ? "cloud" : "local";
  g.__onyxOrchestrationMode = { mode, at: Date.now() };
  return mode;
}

/** Drop the mode cache (called after the cloud config is created, updated or
 *  deleted so the next request sees the new mode immediately). */
export function invalidateOrchestrationModeCache(): void {
  g.__onyxOrchestrationMode = null;
}
