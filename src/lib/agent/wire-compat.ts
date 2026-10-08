/**
 * Strict-gateway wire compatibility — session-learned request downgrades for
 * providers that reject OpenAI-standard request structures with HTTP 400.
 *
 * VERIFIED FAILURE MODES (live-debugged on
 * gen.pollinations.ai → community/scriptsnsenses-sys/glm-5.3-flash-free,
 * upstream dg-ai.daivikdagar.workers.dev, 2026-09-26):
 *
 *  A. `role: "tool"` result messages → 400 `Invalid role "tool"`.
 *     The model happily EMITS tool_calls, but tool RESULTS must be fed back
 *     as plain user messages.
 *  B. `assistant.tool_calls` fields + a system message present → generic
 *     400 "Something was wrong with the input data". Without a system
 *     message the same history is accepted.
 *  C. System-prompt CONTENT filter → the same generic 400. Trigger words
 *     observed with a ~15-char system passing while 44 chars mentioning
 *     "directive" fail: "assistant" (any "You are a helpful assistant…"
 *     style prompt), "directive", tool-USE instructions ("Use the available
 *     tools…"). The upstream is filtering agent-workload system prompts.
 *
 * VERIFIED-COMPATIBLE shapes (all HTTP 200 against that upstream):
 *   - no system message at all (tools param + streaming + stream_options OK)
 *   - tiny neutral system: "You are helpful. Be concise." (h3)
 *   - tools param declared (the model still emits native tool_calls)
 *   - tool calls as TEXT in assistant content + tool results as
 *     `<tool_result>` user messages (test 18)
 *   - stream_options {include_usage} with stream:true
 *
 * THE LADDER (applied per request, most-preserving first; each step only
 * after the previous one still 400s; every step is remembered per
 * provider base URL + model for the session so later requests start in
 * the working shape):
 *
 *   1. toolText — tool results → merged user messages with
 *      <tool_result> blocks; assistant.tool_calls → textual call lines.
 *      (Fixes A + B.)
 *   2. system compact — replace the system message with the verified
 *      neutral COMPAT_SYSTEM_PROMPT. (First try at C.)
 *   3. system drop — remove the system message entirely. (C when even a
 *      neutral system is rejected.)
 *   4. noTools — omit the `tools`/`tool_choice` params. (Providers that
 *      reject tool declarations outright; the turn degrades to plain chat.)
 *
 * Used by the in-browser runtime (streamRound), subagent-runtime and the
 * chat-title naming call. The E2B background runner inlines its own copy
 * (bg-agent-script.ts must stay self-contained).
 */

import { getLearnedParamBans } from "@/lib/agent/param-policy";

// ---------------------------------------------------------------------------
// Types — structural so every local ChatCompletionMessage shape matches.
// ---------------------------------------------------------------------------

export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
}

/** The verified-neutral fallback system prompt (see module docs — h3). */
export const COMPAT_SYSTEM_PROMPT = "You are helpful. Be concise.";

// ---------------------------------------------------------------------------
// Session-scoped learning (per provider base URL + model) — PERSISTED to
// localStorage so a strict gateway's quirks are learned ONCE per provider
// ever, not once per browser session (each re-learn cost 1-3 extra 400s on
// rate-limited providers).
// ---------------------------------------------------------------------------

export interface WireCompatMode {
  /** Tool results as user messages + textual tool calls (fixes A + B). */
  toolText: boolean;
  /** "native" | "compact" | "dropped" — how the system message is sent. */
  system: "native" | "compact" | "dropped";
  /** Omit the tools/tool_choice params entirely (plain-chat degradation). */
  noTools: boolean;
}

const DEFAULT_MODE: WireCompatMode = { toolText: false, system: "native", noTools: false };

const learnedModes = new Map<string, WireCompatMode>();
// v2 — bumped when noTools stopped persisting (false-positive protection:
// a provider-side CONTENT filter (verified live on gen.pollinations.ai
// community routes — they filter USER messages mentioning tools/MCP
// workloads) made the ladder's noTools step learn permanently even though
// the provider accepts tools fine).
const PERSIST_KEY = "onyx-wire-compat-v2";

function modeKey(baseUrl: string, model: string): string {
  return `${baseUrl.replace(/\/+$/, "")}|${model}`;
}

/** Read the persisted modes map (SSR/test-safe — {} when unavailable). */
function readPersistedModes(): Record<string, WireCompatMode> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, WireCompatMode>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Persist one mode under its key (best-effort — never throws). */
function persistMode(key: string, mode: WireCompatMode): void {
  try {
    if (typeof localStorage === "undefined") return;
    const all = readPersistedModes();
    all[key] = mode;
    localStorage.setItem(PERSIST_KEY, JSON.stringify(all));
  } catch {
    // Quota / private-mode — session memory still works.
  }
}

function modesFor(baseUrl: string, model: string): WireCompatMode {
  const key = modeKey(baseUrl, model);
  let mode = learnedModes.get(key);
  if (!mode) {
    // Hydrate from persistence on first touch this session.
    const persisted = readPersistedModes()[key];
    mode =
      persisted && typeof persisted === "object" && typeof persisted.system === "string"
        ? { toolText: !!persisted.toolText, system: persisted.system as WireCompatMode["system"], noTools: !!persisted.noTools }
        : { ...DEFAULT_MODE };
    learnedModes.set(key, mode);
  }
  return mode;
}

export function getWireCompat(baseUrl: string, model: string): Readonly<WireCompatMode> {
  return modesFor(baseUrl, model);
}

/** BEGIN-OF-TURN RESET (the "browser tool isn't available in this mode"
 * fix): give the tool surface a FRESH chance on every turn. The ladder's
 * noTools step used to stay learned for the whole session — one generic-400
 * false positive (a content filter, a transient gateway quirk) and every
 * later request for that provider silently shipped WITHOUT tools, so the
 * model truthfully claimed it lacked use_browser and fell back to plain
 * search. toolText / system steps stay learned (they only change message
 * ENCODING — safe); noTools is the one step that removes CAPABILITY, so it
 * must never outlive the request that learned it. Call at the top of every
 * agent turn / subagent run, before the request body is built. */
export function beginTurnWireCompat(baseUrl: string, model: string): void {
  const mode = modesFor(baseUrl, model) as WireCompatMode;
  if (mode.noTools) {
    mode.noTools = false;
    // noTools is never persisted, so nothing to un-persist — the reset is
    // purely the in-session (and hydrated) mode object.
  }
}

/** Does the current request still carry native tool structures on the wire? */
export function wireHasToolStructures(messages: readonly WireMessage[]): boolean {
  return messages.some(
    (m) => m && (m.role === "tool" || (Array.isArray(m.tool_calls) && m.tool_calls.length > 0)),
  );
}

// ---------------------------------------------------------------------------
// The wire transform — a PURE copy; the caller's message array (which the
// runtime also uses for persistence + later rounds) is never mutated.
// ---------------------------------------------------------------------------

/** Render one assistant tool_call batch as text lines (toolText mode). */
function toolCallsAsText(
  calls: NonNullable<WireMessage["tool_calls"]>,
): string {
  return calls
    .map((tc) => {
      let args = tc.function?.arguments ?? "{}";
      if (args.length > 2000) args = `${args.slice(0, 2000)}…`;
      return `[Calling ${tc.function?.name ?? "tool"} with ${args}]`;
    })
    .join("\n");
}

export function buildWireMessages(
  messages: readonly WireMessage[],
  mode: Readonly<WireCompatMode>,
): WireMessage[] {
  const out: WireMessage[] = [];

  // System handling. Only the FIRST system message is the turn prompt;
  // mid-conversation system notes (e.g. the background runner's wrap-up
  // note) are converted to USER messages in downgraded modes — strict
  // gateways that filter system content reject them as system too, and a
  // user-role instruction is universally accepted.
  let sawFirstSystem = false;
  for (const m of messages) {
    if (m && m.role === "system") {
      if (!sawFirstSystem) {
        sawFirstSystem = true;
        if (mode.system === "dropped") continue;
        if (mode.system === "compact") {
          out.push({ ...m, content: COMPAT_SYSTEM_PROMPT });
          continue;
        }
        out.push({ ...m });
        continue;
      }
      if (mode.system !== "native") {
        out.push({ ...m, role: "user" });
        continue;
      }
      out.push({ ...m });
      continue;
    }
    out.push({ ...m });
  }

  if (!mode.toolText) return out;

  // toolText transform:
  //  - assistant.tool_calls → textual call lines appended to the content
  //    (the field itself is dropped → fixes failure mode B)
  //  - role:"tool" results → consecutive runs merged into ONE user message
  //    of <tool_result> blocks (fixes failure mode A; merging keeps the
  //    user/assistant alternation strict gateways expect)
  const transformed: WireMessage[] = [];
  let pendingToolResults: string[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return;
    transformed.push({
      role: "user",
      content: pendingToolResults.join("\n"),
    });
    pendingToolResults = [];
  };

  for (const m of out) {
    if (!m) continue;
    if (m.role === "tool") {
      const header =
        m.name || m.tool_call_id
          ? `<tool_result${m.name ? ` name="${m.name}"` : ""}${
              m.tool_call_id ? ` tool_call_id="${m.tool_call_id}"` : ""
            }">`
          : "<tool_result>";
      const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      pendingToolResults.push(`${header}\n${body}\n</tool_result>`);
      continue;
    }
    flushToolResults();
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const callText = toolCallsAsText(m.tool_calls);
      const base = typeof m.content === "string" && m.content.trim() ? `${m.content.trim()}\n` : "";
      const { tool_calls: _tc, ...rest } = m;
      void _tc;
      transformed.push({ ...rest, content: `${base}${callText}` });
      continue;
    }
    transformed.push(m);
  }
  flushToolResults();
  return transformed;
}

// ---------------------------------------------------------------------------
// Ladder step decision — called from a 400 handler AFTER the
// unsupported-parameter strip and the reasoning-replay check had their turn.
// Learns the next mode step (session scope) and returns a short reason, or
// null when the ladder is exhausted (caller surfaces the original error).
// ---------------------------------------------------------------------------

export function nextStrictGatewayStep(opts: {
  baseUrl: string;
  model: string;
  /** The ORIGINAL messages (pre-transform) — used to see what structures exist. */
  messages: readonly WireMessage[];
  /** Whether the request body still declares tools. */
  hasToolsParam: boolean;
  /** Raw 400 body text (specific "Invalid role" errors jump straight to toolText). */
  errorText?: string;
  /** Extra params the user already disabled — no point keeping tools then. */
}): string | null {
  const { baseUrl, model, messages, hasToolsParam, errorText = "" } = opts;
  const key = modeKey(baseUrl, model);
  const mode = modesFor(baseUrl, model);
  const before = JSON.stringify(mode);
  const reason = nextStep(mode, messages, hasToolsParam, errorText);
  // Persist learning — EXCEPT the final noTools step. When the real cause
  // of a 400 is a provider-side CONTENT filter (generic "input data" errors
  // the ladder can't fix), every structural step is a FALSE positive. The
  // toolText/system steps only change message ENCODING (safe to keep);
  // noTools permanently disables tool calling for that provider — the most
  // damaging false positive — so it stays session-scoped only. A provider
  // that genuinely rejects tool declarations re-learns it with one extra
  // call per session.
  if (reason && !mode.noTools && JSON.stringify(mode) !== before) {
    persistMode(key, mode);
  }
  return reason;
}

/** The pure ladder-step decision (mutates `mode`). */
function nextStep(
  mode: WireCompatMode,
  messages: readonly WireMessage[],
  hasToolsParam: boolean,
  errorText: string,
): string | null {
  const hasToolStructures = wireHasToolStructures(messages);
  const hasSystem = messages.some((m) => m && m.role === "system");
  const invalidRoleTool = /invalid role\s*["']?tool/i.test(errorText);

  // 1. toolText — when the request carries tool structures (or the error
  //    explicitly names the tool role).
  if (!mode.toolText && (hasToolStructures || invalidRoleTool)) {
    mode.toolText = true;
    return "tool-text mode (tool results as user messages)";
  }
  // 2. compact system.
  if (hasSystem && mode.system === "native") {
    mode.system = "compact";
    return "compact system prompt (provider filters system content)";
  }
  // 3. drop system.
  if (hasSystem && mode.system === "compact") {
    mode.system = "dropped";
    return "no system message (provider rejects system prompts)";
  }
  // 4. no tools — EXPLICIT TOOL EVIDENCE ONLY (the "browser tool isn't
  //    available in this mode" fix). This is the ONLY step that removes
  //    CAPABILITY rather than re-encoding, and a generic 400 "Something was
  //    wrong with the input data" is usually a content filter, NOT a tools
  //    rejection. Take the step only when the error itself names tools
  //    ("tools is not supported", "invalid tools parameter", …) — and even
  //    then it lasts only until the next turn's beginTurnWireCompat reset.
  //    The learned step is applied to the in-flight retry by the caller's
  //    buildBody(); generic errors fall through to "exhausted" and surface
  //    the honest content-filter explanation instead.
  if (hasToolsParam && !mode.noTools && /\btool/i.test(errorText)) {
    mode.noTools = true;
    return "no tools param (provider rejects tool declarations)";
  }
  return null;
}

/** Convenience: whether the tools param should be sent at all. */
export function wireAllowsTools(baseUrl: string, model: string): boolean {
  if (getWireCompat(baseUrl, model).noTools) return false;
  // "tools"/"tool_choice" may also be banned via the param policy.
  const bans = getLearnedParamBans(baseUrl, model);
  return !bans.has("tools") && !bans.has("tool_choice");
}
