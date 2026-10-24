// ============================================================================
// OnyxAgent cloud worker — small shared helpers (clamps + error extraction).
// ============================================================================

import {
  TASK_DEFAULT_MAX_ROUNDS,
  TASK_HARD_MAX_ROUNDS,
  TASK_MAX_DURATION_MS,
  TASK_DEFAULT_DURATION_MS,
} from "./protocol.js";

/** Clamp a run window into [1 min, TASK_MAX_DURATION_MS]. */
export function clampTimeoutMs(timeoutMs: unknown): number {
  const raw =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? timeoutMs
      : TASK_DEFAULT_DURATION_MS;
  return Math.min(Math.max(Math.round(raw), 60_000), TASK_MAX_DURATION_MS);
}

/** Clamp the agent round budget. */
export function clampMaxRounds(maxRounds: unknown): number {
  const raw =
    typeof maxRounds === "number" && Number.isFinite(maxRounds)
      ? maxRounds
      : TASK_DEFAULT_MAX_ROUNDS;
  return Math.max(1, Math.min(Math.round(raw), TASK_HARD_MAX_ROUNDS));
}

/** Parse the run's startedAt (ISO string) — falls back to now. */
export function startedAtMs(startedAt: string | undefined): number {
  const t = startedAt ? Date.parse(startedAt) : NaN;
  return Number.isFinite(t) ? t : Date.now();
}

/** Uniform error message extraction (never throws). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return typeof err === "string" ? err : JSON.stringify(err);
  } catch {
    return String(err);
  }
}
