// ============================================================================
// Background Task Execution Framework — worker env helpers.
//
// All worker configuration comes from environment variables (set them on the
// Trigger.dev project, or in .env for local `trigger dev`). NOTHING here is
// ever logged with its value — tokens are referenced by name only.
// ============================================================================

import type { WorkerClaimedRun } from "./protocol.js";
import { TASK_DEFAULT_MAX_ROUNDS, TASK_DEFAULT_DURATION_MS, TASK_HARD_MAX_ROUNDS, TASK_MAX_DURATION_MS, TASK_PAYLOAD_BUDGET } from "./protocol.js";

/** Fail fast on a missing/empty env var (used at the top of every task). */
export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required env var ${name} — set it on the Trigger.dev project ` +
        `(or in trigger-worker/.env for local dev; see .env.example)`,
    );
  }
  return value;
}

/** Optional env var ("" when unset/blank). */
export function optionalEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/** Normalize an app origin (strip trailing slashes). */
export function normalizeOrigin(url: string): string {
  return url.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// LLM bridge resolution (what the sandbox runner calls)
// ---------------------------------------------------------------------------

export interface WorkerLlmConfig {
  /** OpenAI-compatible chat-completions URL for the runner. */
  url: string;
  /** Bearer token ("" when none — e.g. a local gateway without auth). */
  token: string;
  /** FR-1.3 rotational provider key pool (runner v2 rotates on 429/401). */
  pool: string[];
}

/**
 * Resolve the LLM endpoint a run's sandbox runner should call:
 *
 *  1. run.config.chatUrl (the triggering client pinned a provider gateway) —
 *     bearer = the first TASK_KEY_POOL key; TASK_LLM_TOKEN wins when set.
 *  2. otherwise the worker's TASK_LLM_URL, defaulting to the app's own
 *     keyless bridge `${APP_URL}/api/tasks/llm` — bearer = TASK_LLM_TOKEN
 *     (a long-lived worker token minted by the operator; this is the
 *     simplest setup).
 */
export function resolveLlmConfig(appUrl: string, run: WorkerClaimedRun): WorkerLlmConfig {
  const bridgeUrl = optionalEnv("TASK_LLM_URL") || `${normalizeOrigin(appUrl)}/api/tasks/llm`;
  const url = run.config.chatUrl?.trim() || bridgeUrl;
  const token = optionalEnv("TASK_LLM_TOKEN");
  const pool = optionalEnv("TASK_KEY_POOL")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .slice(0, TASK_PAYLOAD_BUDGET.maxKeyPool);
  return { url, token, pool };
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Clamp a run window into [1 min, TASK_MAX_DURATION_MS] (mirrors the app's
 *  local driver clampTimeoutMs). */
export function clampTimeoutMs(timeoutMs: unknown): number {
  const raw =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? timeoutMs
      : TASK_DEFAULT_DURATION_MS;
  return Math.min(Math.max(Math.round(raw), 60_000), TASK_MAX_DURATION_MS);
}

/** Clamp the agent round budget (mirrors the app's runner-config builder). */
export function clampMaxRounds(maxRounds: unknown): number {
  const raw =
    typeof maxRounds === "number" && Number.isFinite(maxRounds)
      ? maxRounds
      : TASK_DEFAULT_MAX_ROUNDS;
  return Math.max(1, Math.min(Math.round(raw), TASK_HARD_MAX_ROUNDS));
}

/** Parse the claim's startedAt (ISO string) — falls back to now. */
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
