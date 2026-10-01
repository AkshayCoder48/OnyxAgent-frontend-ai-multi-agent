"use client";

/**
 * Auto Router — intelligent per-round model routing across the user's AI
 * providers.
 *
 * WHEN IT EXISTS (picker rule, see chat-controls.tsx):
 *   - > 1 configured provider  → the model picker shows an "Auto Router"
 *     entry (the old hardcoded "Default" row is gone).
 *   - 0 or 1 provider          → NO "Default" and NO "Auto Router" entry —
 *     there is nothing to route between.
 *
 * WHAT IT DOES: when selected, every LLM ROUND of a turn (a turn = text →
 * tool calls → text → …) is served by whichever provider+model is currently
 * the best choice — not one fixed provider for the whole turn. The runtime
 * (lib/agent/runtime.ts) calls `pickCandidate` before each round and
 * `reportResult` after it, so routing adapts DURING a turn: a provider that
 * errors is benched (cool-down) and the next round — including an automatic
 * transient retry of the SAME round — is served by the next-best candidate.
 *
 * The health map is module-level and SESSION-SCOPED (in-memory only): it
 * survives rounds and turns within this browser tab, and a fresh session
 * starts clean. Nothing is persisted.
 */

import type { AgentTurnOptions } from "@/lib/agent/runtime";

// ---------------------------------------------------------------------------
// Picker sentinels (shared by the UI + the turn-options builder).
// ---------------------------------------------------------------------------

/** Store sentinel for `selectedProviderId` — "the Auto Router is selected".
 *  Distinct from null (null = no selection / plain provider default) so the
 *  picker, the turn builder and the runtime can tell them apart. Never a
 *  real provider id (real ids are nanoids). */
export const AUTO_ROUTER_PROVIDER_ID = "__auto_router__";

/** Built-in picker row value for the Auto Router entry. */
export const AUTO_ROUTER_MODEL_VALUE = "auto-router";

/** Display label for the picker row + the trigger chip. */
export const AUTO_ROUTER_LABEL = "Auto Router";

// ---------------------------------------------------------------------------
// Candidates + health.
// ---------------------------------------------------------------------------

/** One routable destination: a provider config (ready for streamRound)
 *  pre-resolved with ONE model — the provider's first model. Bounded by
 *  design: one candidate per provider keeps routing cheap and comparable. */
export interface RouterCandidate {
  /** Stable identity — the provider row id (or baseUrl::model when absent). */
  key: string;
  /** Fully-resolved provider config (baseUrl + decrypted key + model). */
  provider: AgentTurnOptions["provider"];
  /** The model this candidate serves (=== provider.model; convenience). */
  model: string;
  /** Human label (provider name) — for logs + diagnostics. */
  label: string;
}

/** Per-candidate health, session-scoped. */
export interface CandidateHealth {
  /** Epoch ms of the last reported failure (drives the 60s cool-down). */
  lastErrorAt?: number;
  /** Consecutive failures (a success resets it; ≥3 benches the candidate
   *  until it serves successfully again via the fail-open path). */
  consecutiveErrors: number;
  /** Last successful round duration (ms) — the latency tie-break. */
  lastLatencyMs?: number;
  /** How many rounds this candidate has been picked for. */
  roundsServed: number;
  /** Epoch ms of the last pick — the "least-recently-served" tie-break. */
  lastServedAt?: number;
  /** Last failure classification (ratelimit/network/http/other) — diagnostics. */
  lastErrorKind?: RouterErrorKind;
}

export type RouterErrorKind = "ratelimit" | "network" | "http" | "other";

/** A candidate is benched while an error is this fresh… */
const ERROR_COOLDOWN_MS = 60_000;
/** …or after this many consecutive errors (sticky until a success resets). */
const CONSECUTIVE_ERROR_LIMIT = 3;

/** Session-scoped health registry (key → health). In-memory only. */
const healthMap = new Map<string, CandidateHealth>();

function healthOf(key: string): CandidateHealth {
  let h = healthMap.get(key);
  if (!h) {
    h = { consecutiveErrors: 0, roundsServed: 0 };
    healthMap.set(key, h);
  }
  return h;
}

/** Read-only view for diagnostics/tests. */
export function routerHealthSnapshot(): ReadonlyMap<string, CandidateHealth> {
  return healthMap;
}

/** Clear all health (tests + "fresh session" semantics). */
export function resetRouterHealth(): void {
  healthMap.clear();
}

function isCoolingDown(key: string, now: number): boolean {
  const h = healthMap.get(key);
  if (!h) return false;
  if (h.consecutiveErrors >= CONSECUTIVE_ERROR_LIMIT) return true;
  return h.lastErrorAt !== undefined && now - h.lastErrorAt < ERROR_COOLDOWN_MS;
}

// ---------------------------------------------------------------------------
// pickCandidate — the routing brain.
// ---------------------------------------------------------------------------

/**
 * Pick the candidate that serves the given round.
 *
 * STRATEGY (in priority order):
 *   1. HEALTH FIRST — candidates with an error in the last 60s or ≥3
 *      consecutive errors are benched. If EVERY candidate is benched we
 *      FAIL-OPEN (routing must never dead-end the turn): all candidates stay
 *      eligible, but the LEAST-RECENTLY-ERRORED one wins (the stalest
 *      failure is the most likely to have recovered).
 *   2. ROUND-ROBIN FAIRNESS — among healthy candidates, the one with the
 *      fewest rounds served so far wins. This spreads a multi-round turn
 *      across providers (the "route models on every round" requirement)
 *      without needing to understand the task.
 *   3. TIE-BREAKS — equal rounds served → least-recently-served; then lower
 *      last latency (when both are known); then NOT the candidate that just
 *      served the previous round (avoids immediate repeats when equally
 *      fresh); then list order (stable + deterministic).
 *
 * The pick itself counts as "served": `roundsServed`/`lastServedAt` are
 * stamped here, so a candidate that was picked but failed is naturally
 * deprioritized for later rounds too.
 *
 * @param roundNumber 1-based round of the current turn (diagnostics).
 * @param previousKey key of the candidate that served the previous round, if
 *  any — used only as a soft tie-break.
 */
export function pickCandidate(
  candidates: RouterCandidate[],
  roundNumber: number,
  previousKey?: string,
): RouterCandidate {
  if (candidates.length === 0) {
    throw new Error("[auto-router] pickCandidate called with no candidates");
  }
  if (candidates.length === 1) {
    noteServed(candidates[0]!);
    return candidates[0]!;
  }

  const now = Date.now();
  const healthy = candidates.filter((c) => !isCoolingDown(c.key, now));

  // FAIL-OPEN: everyone is benched → ignore the cool-downs, prefer the
  // least-recently-errored candidate.
  if (healthy.length === 0) {
    let pick = candidates[0]!;
    let pickErrorAt = healthOf(pick.key).lastErrorAt ?? 0;
    for (const c of candidates.slice(1)) {
      const errAt = healthOf(c.key).lastErrorAt ?? 0;
      if (errAt < pickErrorAt) {
        pick = c;
        pickErrorAt = errAt;
      }
    }
    noteServed(pick);
    return pick;
  }

  let best: RouterCandidate | null = null;
  for (const c of healthy) {
    if (best === null) {
      best = c;
      continue;
    }
    const hc = healthOf(c.key);
    const hb = healthOf(best.key);
    // 2. Fewest rounds served wins.
    if (hc.roundsServed < hb.roundsServed) {
      best = c;
      continue;
    }
    if (hc.roundsServed > hb.roundsServed) continue;
    // 3a. Least-recently-served (never served = most eligible).
    const cs = hc.lastServedAt ?? 0;
    const bs = hb.lastServedAt ?? 0;
    if (cs < bs) {
      best = c;
      continue;
    }
    if (cs > bs) continue;
    // 3b. Lower known latency. Only comparable when BOTH are known.
    if (hc.lastLatencyMs !== undefined && hb.lastLatencyMs !== undefined) {
      if (hc.lastLatencyMs < hb.lastLatencyMs) {
        best = c;
        continue;
      }
      if (hc.lastLatencyMs > hb.lastLatencyMs) continue;
    }
    // 3c. Avoid serving the previous round's candidate twice in a row when
    // an equally-fresh alternative exists.
    if (previousKey && c.key !== previousKey && best.key === previousKey) {
      best = c;
      continue;
    }
    // 3d. List order — `best` (earlier index) wins by doing nothing.
  }
  noteServed(best!);
  void roundNumber; // kept for signature stability / diagnostics
  return best!;
}

function noteServed(candidate: RouterCandidate): void {
  const h = healthOf(candidate.key);
  h.roundsServed += 1;
  h.lastServedAt = Date.now();
}

// ---------------------------------------------------------------------------
// reportResult — the runtime's feedback channel.
// ---------------------------------------------------------------------------

export interface RouterResultReport {
  ok: boolean;
  /** Round duration in ms (recorded on success — the latency tie-break). */
  latencyMs?: number;
  /** Failure classification (recorded on failure). */
  errorKind?: RouterErrorKind;
}

/**
 * Record a round's outcome for the candidate that served it. Success resets
 * the consecutive-error streak and records the latency; failure increments
 * the streak and stamps `lastErrorAt` (which benches the candidate for 60s).
 */
export function reportResult(key: string, report: RouterResultReport): void {
  const h = healthOf(key);
  if (report.ok) {
    h.consecutiveErrors = 0;
    if (typeof report.latencyMs === "number" && report.latencyMs >= 0) {
      h.lastLatencyMs = report.latencyMs;
    }
  } else {
    h.consecutiveErrors += 1;
    h.lastErrorAt = Date.now();
    h.lastErrorKind = report.errorKind ?? "other";
  }
}

// ---------------------------------------------------------------------------
// Error classification (used by the runtime when reporting failures).
// ---------------------------------------------------------------------------

/** Classify a round error message for the health record. */
export function classifyRouterError(message: string): RouterErrorKind {
  if (/rate.?limit|too many requests|quota|resource_exhausted|http 429|http 529/i.test(message)) {
    return "ratelimit";
  }
  if (
    /timeout|econnreset|socket hang up|fetch failed|network|aborted|terminated|stream read|stream failed|524/i.test(
      message,
    )
  ) {
    return "network";
  }
  if (/http \d{3}/i.test(message)) return "http";
  return "other";
}
