// ============================================================================
// Background Task Execution Framework — orchestration mode.
//
// ONE execution mode: "cloud" — the operator connected a Trigger.dev Cloud
// key (Settings → Cloud) and every background task executes durably on
// their own trigger.dev Cloud project (the deployed agent-run task).
// Without a connected key the app has NO background execution (the trigger
// route answers with actionable guidance) — self-hosting and the in-process
// local driver were removed by design.
//
// Resolution is ASYNC (cloud config lives in SQLite) with a short-lived
// in-memory cache so hot paths (every status poll, every scheduler tick)
// never hammer the database. invalidateOrchestrationModeCache() is called by
// the cloud-config route whenever the operator connects/disconnects.
// ============================================================================

import { getCloudConfig } from "./trigger-cloud";

/** Legacy DB values still present on historical rows ("local", "triggerdev"
 *  from the removed modes) — reported as the frozen protocol's
 *  "triggerdev" union member; new rows are always "cloud". */
export type OrchestrationMode = "off" | "cloud";

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
  const cached = g.__onyxOrchestrationMode;
  if (cached && Date.now() - cached.at < MODE_CACHE_TTL_MS) return cached.mode;

  const cloud = await getCloudConfig();
  const mode: OrchestrationMode = cloud ? "cloud" : "off";
  g.__onyxOrchestrationMode = { mode, at: Date.now() };
  return mode;
}

/** Drop the mode cache (called after the cloud config is created, updated or
 *  deleted so the next request sees the new mode immediately). */
export function invalidateOrchestrationModeCache(): void {
  g.__onyxOrchestrationMode = null;
}
