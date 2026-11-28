/**
 * Identical-call retry budget (PRD Issue 3 / Test C).
 *
 * WHY THIS EXISTS: in the imagedescriber incident the model re-issued the
 * SAME failing call (same tool, same arguments) round after round —
 * "restart the browser", fail, "restart the browser", fail — each round
 * consuming a turn budget while the underlying failure never changed.
 * The runtime watched every dispatch but never counted them.
 *
 * THE POLICY (PRD §Issue-3 retry ladder):
 *   1st identical failure → the tool result carries a RETRY_ADVICE note
 *                          (diagnose before retrying; retry is allowed).
 *   2nd identical failure → STRATEGY_CHANGE_REQUIRED — the result tells
 *                          the model the identical call failed twice and
 *                          a DIFFERENT approach is now required.
 *   3rd identical failure → the call is NOT dispatched. The model gets a
 *                          structured BLOCKED_REPETITION result stating
 *                          the exact repetition count and that this
 *                          approach is exhausted; it must switch tools,
 *                          change arguments, or report the blocker
 *                          honestly.
 *
 * "Identical" = same tool name + stable-hash of the args. Near-identical
 * calls (e.g. a changed URL) count separately — the budget only stops
 * LITERAL repetition, never legitimate iteration.
 *
 * The budget is per-turn (a ledger instance lives in the agent runtime's
 * turn scope) and caps the WHOLE turn's failed dispatches too, so a task
 * that fans out over many different failing calls still terminates.
 */

/** Stable, order-insensitive hash of a JSON value — the same args always
 *  hash the same, regardless of key order the provider emitted. */
export function stableArgsHash(value: unknown): string {
  const json = canonicalJson(value);
  // FNV-1a — fast, dependency-free, and collision risk is irrelevant here
  // (a collision merely merges two call-classes, still bounded).
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const obj = value as Record<string, unknown>;
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** Max identical (name+args) FAILING dispatches before hard block. */
export const MAX_IDENTICAL_FAILURES = 3;
/** Max total FAILED dispatches in one turn before the whole turn's tool
 *  lane is declared exhausted (a task-level attempt budget, PRD §Issue-3
 *  "bounded by a task-level deadline and attempt budget"). */
export const MAX_TURN_FAILURES = 25;

export type RepetitionVerdict = {
  /** allow — dispatch the call. */
  action: "allow";
} | {
  /** allow, but annotate the eventual failure with recovery advice. */
  action: "allow-with-advice";
  /** "retry_advice" (1st failure) or "strategy_change" (2nd). */
  tier: "retry_advice" | "strategy_change";
  /** How many identical failures already happened. */
  failures: number;
} | {
  /** block — do NOT dispatch; return the structured refusal instead. */
  action: "block";
  reason: "repetition_exhausted" | "turn_budget_exhausted";
  failures: number;
  message: string;
};

/** Per-turn ledger of failed dispatches. Created once per agent turn by
 *  the runtime; `recordSuccess` clears the identical-class counter (the
 *  SAME call succeeding later means the failure was transient and the
 *  repetition concern is over). */
export class RetryBudget {
  private failures = new Map<string, number>();
  private totalFailures = 0;

  /** Key for one call-class: tool name + args hash. */
  static key(toolName: string, args: Record<string, unknown>): string {
    return `${toolName}#${stableArgsHash(args)}`;
  }

  /** Decide what to do with a call BEFORE dispatching it. */
  check(toolName: string, args: Record<string, unknown>): RepetitionVerdict {
    if (this.totalFailures >= MAX_TURN_FAILURES) {
      return {
        action: "block",
        reason: "turn_budget_exhausted",
        failures: this.totalFailures,
        message:
          `This turn has already recorded ${this.totalFailures} failed tool dispatches — the task-level attempt ` +
          `budget is exhausted. Do not issue more failing calls. Summarize what was attempted, what failed and why, ` +
          `and report the task as BLOCKED with the specific blocker.`,
      };
    }
    const n = this.failures.get(RetryBudget.key(toolName, args)) ?? 0;
    if (n === 0) return { action: "allow" };
    if (n === 1) {
      return {
        action: "allow-with-advice",
        tier: "retry_advice",
        failures: n,
      };
    }
    if (n === 2) {
      return {
        action: "allow-with-advice",
        tier: "strategy_change",
        failures: n,
      };
    }
    return {
      action: "block",
      reason: "repetition_exhausted",
      failures: n,
      message:
        `This EXACT call (${toolName} with identical arguments) has already failed ${n} times and was NOT ` +
        `dispatched again. Repeating an identical failing call cannot succeed — the underlying failure has not ` +
        `changed. Choose a DIFFERENT approach: change the arguments, use a different tool, work around the ` +
        `failing step, or report the task as BLOCKED with this specific failure as the blocker.`,
    };
  }

  /** Record a failed dispatch (called by the runtime when a tool result
   *  carries an error status). */
  recordFailure(toolName: string, args: Record<string, unknown>): void {
    const k = RetryBudget.key(toolName, args);
    this.failures.set(k, (this.failures.get(k) ?? 0) + 1);
    this.totalFailures += 1;
  }

  /** A success in the same class resets it — a retry that WORKED means
   *  the failure was transient; no repetition problem exists. */
  recordSuccess(toolName: string, args: Record<string, unknown>): void {
    this.failures.delete(RetryBudget.key(toolName, args));
  }

  /** The note appended to a FAILED tool result that was allowed through
   *  with advice (tier messaging per the PRD ladder). */
  static adviceNote(verdict: Extract<RepetitionVerdict, { action: "allow-with-advice" }>, toolName: string): string {
    if (verdict.tier === "retry_advice") {
      return (
        `\n\n[RECOVERY NOTICE] An identical ${toolName} call already failed once this turn. ` +
        `Before retrying, READ the error above and identify the failure category (bad arguments, missing runtime, ` +
        `network, timeout, permissions). If a retry is safe and the failure looks transient, retry; otherwise fix ` +
        `the cause first.`
      );
    }
    return (
      `\n\n[RECOVERY NOTICE — STRATEGY CHANGE REQUIRED] The identical ${toolName} call has now failed ` +
      `${verdict.failures} times this turn. Retrying the same call with the same arguments is no longer permitted ` +
      `and will be blocked. You MUST change the execution strategy: different arguments, a different tool, or an ` +
      `entirely different approach to the underlying goal. If nothing works, report the task as BLOCKED and name ` +
      `the specific blocker.`
    );
  }

  /** The structured refusal payload for a blocked call (never dispatched,
   *  so it must be unmistakably NOT an execution result). */
  static blockedResult(toolName: string, reason: string, message: string): { error: { code: string; tool: string; message: string; blocked: true } } {
    return {
      error: {
        code: reason === "turn_budget_exhausted" ? "TURN_BUDGET_EXHAUSTED" : "REPETITION_BLOCKED",
        tool: toolName,
        message,
        blocked: true,
      },
    };
  }
}
