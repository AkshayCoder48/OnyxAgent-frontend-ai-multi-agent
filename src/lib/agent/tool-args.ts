/**
 * Robust parsing + best-effort REPAIR of streamed tool-call arguments.
 *
 * WHY THIS EXISTS (Create File / provider SSE failure, 2026-09-27):
 * Tool arguments arrive across MANY SSE chunks — the payload is only
 * complete when the stream finishes. When a provider cuts the stream
 * mid-argument (or emits invalid JSON), the accumulated string can look
 * like:
 *
 *     {"path": "/home/user/gym_cutting_diet.md"
 *
 * Previously that string was JSON.parse'd → failure → wrapped as
 * `{ _raw: <truncated> }` and PASSED TO THE TOOL anyway. The tool saw
 * `args.path === undefined` and answered `{ error: "Invalid path" }` —
 * and far worse, the RAW truncated string was replayed VERBATIM as the
 * assistant message's `tool_calls[].function.arguments` on the next
 * round. Providers validate that field: the gateway choked and injected
 * an error into its own SSE stream ("JSON error injected into SSE
 * stream"), which the runtime misread as a PROVIDER failure and retried
 * — a tool-argument bug escalating into an endless provider-retry loop.
 *
 * THE CONTRACT (PRD §§1–5):
 *   1. Never execute a tool call whose arguments are malformed — return
 *      a structured tool result so the model can re-issue the call.
 *   2. Never replay malformed JSON back to the provider — repair it, or
 *      send valid `{}`.
 *   3. A tool failure is a TOOL result, never a provider error/retry.
 *
 * The repair algorithm closes what a truncation left open: first the
 * string literal being written (honoring trailing escape backslashes),
 * then any open containers (`{`/`[`) in reverse order, and trims a
 * dangling trailing comma. It is deterministic, allocation-light and
 * safe to call on every tool call — valid JSON returns unchanged.
 */

/** Marker key used when arguments could not be parsed or repaired.
 *  Tool handlers must NEVER receive this — the runtime checks it BEFORE
 *  dispatching and short-circuits to a structured error result. */
export const MALFORMED_ARGS_KEY = "_raw";

export interface ParsedToolCallArgs {
  /** Parsed (or repaired) argument object. `{}` when malformed. */
  args: Record<string, unknown>;
  /** True when the raw string was NOT valid JSON. */
  malformed: boolean;
  /** True when the raw string was invalid but the repair produced a
   *  usable object (args are repaired values, not the raw text). */
  repaired: boolean;
  /** The original raw string (for logging / the tool card's raw view). */
  raw: string;
  /** Human-readable explanation when malformed (for the tool result). */
  error?: { code: string; message: string };
}

/**
 * Best-effort repair of a (possibly truncated) JSON object string.
 * Returns the repaired STRING (parseable JSON) or null when nothing
 * sensible could be produced (e.g. empty input, or garbage that never
 * looked like an object).
 */
export function repairTruncatedJson(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const text = raw.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;

  // Walk the string tracking string-literal state, escapes, and the
  // open container stack.
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      escaped = false;
    } else if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" || ch === "]") {
      const open = stack.pop();
      // Mismatched closer — unrecoverable for our purposes.
      if (open === undefined) return null;
      if ((open === "{" && ch !== "}") || (open === "[" && ch !== "]")) return null;
    }
  }

  let candidate = text;
  // Close an unterminated string literal (a trailing lone backslash is an
  // incomplete escape — drop it before closing).
  if (inString) {
    if (escaped) candidate = candidate.slice(0, -1);
    candidate += '"';
  }
  // Trim a dangling trailing comma (or comma + whitespace) before closing.
  candidate = candidate.replace(/,\s*$/, "");
  // Close containers in reverse order.
  for (let i = stack.length - 1; i >= 0; i--) {
    candidate += stack[i] === "{" ? "}" : "]";
  }

  // The candidate must actually parse — otherwise we fixed nothing.
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Parse a tool call's argument string with repair. NEVER throws.
 *
 *   parseToolCallArguments('{"path":"a.md"}')      → { args: {path:"a.md"}, malformed:false, … }
 *   parseToolCallArguments('{"path":"a.md"')       → { args: {path:"a.md"}, malformed:true, repaired:true, … }
 *   parseToolCallArguments('{"path": "/home/u…')   → { args: {}, malformed:true, repaired:false, … }
 */
export function parseToolCallArguments(raw: string | undefined | null): ParsedToolCallArgs {
  const text = typeof raw === "string" ? raw.trim() : "";
  const empty = "{}";

  // 1. Fast path — valid JSON as-is.
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { args: parsed as Record<string, unknown>, malformed: false, repaired: false, raw: text };
      }
      // Valid JSON but not a plain object (e.g. a bare string/number) —
      // treat as malformed; tools expect an object.
    } catch {
      // fall through to repair
    }
  } else {
    return { args: {}, malformed: false, repaired: false, raw: empty };
  }

  // 2. Repair path — truncated streaming payloads.
  const repairedStr = repairTruncatedJson(text);
  if (repairedStr !== null) {
    try {
      const parsed = JSON.parse(repairedStr);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { args: parsed as Record<string, unknown>, malformed: true, repaired: true, raw: text };
      }
    } catch {
      // fall through
    }
  }

  // 3. Unrecoverable — empty args + a structured error the runtime turns
  //    into a TOOL result (never a provider error, never an execution).
  return {
    args: {},
    malformed: true,
    repaired: false,
    raw: text,
    error: {
      code: "MALFORMED_TOOL_ARGUMENTS",
      message:
        "The tool call arguments arrived truncated or malformed and could not be parsed. " +
        "Do not retry with the same broken payload — re-issue the complete tool call with valid JSON arguments.",
    },
  };
}

/**
 * The structured tool result a malformed tool call resolves to. Feeds the
 * agent continuation layer through the normal tool-result protocol so the
 * model can self-correct on the next round.
 */
export function malformedToolResult(raw: string): { error: { code: string; message: string; raw?: string } } {
  const { error } = parseToolCallArguments(raw);
  return {
    error: {
      code: error?.code ?? "MALFORMED_TOOL_ARGUMENTS",
      message:
        error?.message ??
        "The tool call arguments were malformed. Re-issue the complete tool call with valid JSON arguments.",
      raw: raw.length > 500 ? `${raw.slice(0, 500)}…` : raw,
    },
  };
}

/**
 * Arguments safe to REPLAY to the provider as
 * `tool_calls[].function.arguments`. Always returns a parseable JSON
 * object string — a repaired copy when possible, `{}` when not. The raw
 * truncated text must never go back on the wire (that is what made the
 * gateway inject "JSON error injected into SSE stream" errors).
 */
export function wireSafeArguments(raw: string | undefined | null): string {
  const parsed = parseToolCallArguments(raw);
  if (!parsed.malformed) return JSON.stringify(parsed.args);
  if (parsed.repaired) return JSON.stringify(parsed.args);
  return "{}";
}

/** True when a parsed-args object is the malformed sentinel shape. */
export function isMalformedArgsSentinel(
  args: unknown,
): args is { _raw: string } {
  return (
    !!args &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    Object.keys(args as Record<string, unknown>).length === 1 &&
    MALFORMED_ARGS_KEY in (args as Record<string, unknown>)
  );
}
