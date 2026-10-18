"use client";

/**
 * ANTI-HALLUCINATION TOOL-CALL NORMALIZER (user report 2026-10-19):
 * "AI repeatedly using this unknown tool `media_generation.operation` …
 * calling multiple fake tools by predicting their names and definitions".
 *
 * Models occasionally emit INVENTED tool-call names — most commonly:
 *   1. DOTTED NAMES — "media_generation.operation", "manage_skill.list":
 *      the model glues the multi-function tool's action/operation ARGUMENT
 *      onto the tool NAME. The fix rewrites the call to the REAL tool with
 *      the subtool as the argument, so the intended call EXECUTES instead
 *      of failing (and burning tokens on retries).
 *   2. NAMESPACE PREFIXES — "functions.web_search", "tools.read_file"
 *      (older OpenAI conventions).
 *   3. SUBTOOL-AS-TOOL — calling "generate_image" as if it were a tool,
 *      when it is the `operation` value of `media_generation`.
 *   4. PURE GUESS NAMES — "search_web", "fetch_url", …
 *
 * For anything uncorrectable, `unknownToolResult` builds a RICH corrective
 * tool result (suggestions + exact how-to-call example + the never-invent
 * rule) so the model self-corrects in ONE round instead of repeating the
 * mistake and wasting tokens.
 *
 * Pure module: no registry import (avoids cycles) — callers pass a lookup
 * function. Used by the in-browser runtime, the subagent runtime, and its
 * logic is mirrored (plain-JS) inside the E2B background runner script.
 */

export interface ToolLookupTarget {
  readonly name: string;
  readonly parameters?: Record<string, unknown> | undefined;
}

export type ToolLookup = (name: string) => ToolLookupTarget | undefined | null;

export interface NormalizedToolCall {
  /** The tool name to actually execute (corrected when possible). */
  readonly name: string;
  /** The arguments to actually execute with (action/operation merged in). */
  readonly args: Record<string, unknown>;
  /** The original (hallucinated) name when a correction was applied. */
  readonly correctedFrom?: string;
  /** Human/model-readable explanation of the correction. */
  readonly correctionNote?: string;
}

/** Multi-function tools route their subtool through one of these params. */
const ACTION_PARAMS = ["action", "operation"] as const;

/** Legacy/namespace prefixes that some providers still emit. */
const NAMESPACE_PREFIXES = new Set(["functions", "tools", "tool", "onyx", "onyxagent"]);

function schemaProperties(tool: ToolLookupTarget): Record<string, unknown> | null {
  const params = tool?.parameters;
  if (!params || typeof params !== "object") return null;
  const props = (params as { properties?: unknown }).properties;
  return props && typeof props === "object" ? (props as Record<string, unknown>) : null;
}

function actionParamOf(tool: ToolLookupTarget): string | null {
  const props = schemaProperties(tool);
  if (!props) return null;
  for (const p of ACTION_PARAMS) {
    const def = props[p];
    if (def && typeof def === "object" && (def as { type?: unknown }).type === "string") {
      return p;
    }
  }
  return null;
}

function enumOf(tool: ToolLookupTarget, param: string): readonly string[] | null {
  const props = schemaProperties(tool);
  if (!props) return null;
  const def = props[param];
  const en = def && typeof def === "object" ? (def as { enum?: unknown }).enum : null;
  return Array.isArray(en) ? (en as string[]) : null;
}

function corrected(
  from: string,
  name: string,
  args: Record<string, unknown>,
  note: string,
): NormalizedToolCall {
  return { name, args, correctedFrom: from, correctionNote: note };
}

/**
 * Normalize ONE tool call. Returns the call unchanged when the name is
 * already registered (the overwhelmingly common case — zero overhead
 * beyond a lookup). Otherwise applies the correction ladder above.
 */
export function normalizeToolCall(
  name: string,
  args: unknown,
  lookup: ToolLookup,
): NormalizedToolCall {
  const cleanArgs =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const rawName = typeof name === "string" ? name.trim() : "";
  if (!rawName) return { name: rawName || "unknown", args: cleanArgs };
  if (lookup(rawName)) return { name: rawName, args: cleanArgs };

  // 1. Namespace prefixes: "functions.web_search" → "web_search".
  let working = rawName;
  let strippedAny = false;
  for (let guard = 0; guard < 4; guard += 1) {
    const dot = working.indexOf(".");
    if (dot <= 0) break;
    if (!NAMESPACE_PREFIXES.has(working.slice(0, dot).toLowerCase())) break;
    working = working.slice(dot + 1);
    strippedAny = true;
    if (lookup(working)) {
      return corrected(
        rawName,
        working,
        cleanArgs,
        `namespaced name "${rawName}" → "${working}"`,
      );
    }
  }
  if (strippedAny && lookup(working)) {
    // (unreachable — covered above; kept for clarity)
    return corrected(rawName, working, cleanArgs, `stripped "${rawName}" → "${working}"`);
  }

  // 2. Dotted subtool: "media_generation.generate_image" → media_generation
  //    { operation: "generate_image" }. Longest registered prefix wins.
  const parts = working.split(".");
  if (parts.length > 1) {
    for (let i = parts.length - 1; i >= 1; i -= 1) {
      const prefix = parts.slice(0, i).join(".");
      const suffix = parts.slice(i).join(".");
      const tool = lookup(prefix);
      if (!tool) continue;
      const param = actionParamOf(tool);
      if (!param) {
        // Tool has no action/operation parameter — route to the tool and
        // keep args as-is (the suffix was meaningless).
        return corrected(
          rawName,
          prefix,
          cleanArgs,
          `"${rawName}" → "${prefix}" (tool names never contain dots)`,
        );
      }
      if (suffix === param) {
        // "media_generation.operation" — the model appended the PARAM NAME.
        // Route to the tool; if the args lack the param, the tool's own
        // validation returns its list of valid operations.
        return corrected(
          rawName,
          prefix,
          cleanArgs,
          `"${rawName}" → "${prefix}" — the subtool is the "${param}" ARGUMENT of ${prefix}`,
        );
      }
      // "media_generation.generate_image" → operation="generate_image".
      // An invalid value still routes: the tool answers with its exact
      // valid-operations list (perfect self-correction) — but never
      // overwrite an already-valid value that arrived in the args.
      const en = enumOf(tool, param);
      const existing = typeof cleanArgs[param] === "string" ? (cleanArgs[param] as string) : null;
      let value = suffix;
      if (
        existing &&
        en &&
        !en.includes(value) &&
        en.includes(existing)
      ) {
        value = existing;
      }
      const merged = { ...cleanArgs, [param]: value };
      return corrected(
        rawName,
        prefix,
        merged,
        `"${rawName}" → "${prefix}" (${param}="${value}")`,
      );
    }
  }

  // 3. Uncorrectable — return unchanged; the caller reports the rich
  //    unknown-tool error (with suggestions) so the model self-corrects.
  return { name: rawName, args: cleanArgs };
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export interface ToolSuggestion {
  readonly name: string;
  readonly score: number;
  /** Set when the called name IS an action/operation value of this tool. */
  readonly viaParam?: string;
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Levenshtein with an early-exit cap (cap+1 returned when over budget). */
function levenshtein(a: string, b: string, cap: number): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > cap) return cap + 1;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j += 1) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[n];
}

function tokensOf(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 4);
}

/**
 * Rank registered tools against a hallucinated name. Strong signals:
 * exact normalized match, prefix/substring, small edit distance, token
 * overlap — and the STRONGEST: the called name IS an action/operation
 * value of a multi-function tool ("generate_image" → media_generation).
 */
export function suggestToolCalls(
  name: string,
  tools: readonly ToolLookupTarget[],
  limit = 5,
): ToolSuggestion[] {
  const needle = normName(name);
  if (!needle) return [];
  const needleTokens = tokensOf(name);
  const scored: ToolSuggestion[] = [];

  for (const tool of tools) {
    if (!tool?.name) continue;
    const cand = normName(tool.name);
    if (!cand) continue;

    // Subtool-value hit: "generate_image" is media_generation's operation.
    // viaParam is ONLY set on this path — a genuine value hit — so the
    // unknown-tool payload's how_to_call example never embeds a bogus
    // (e.g. dotted) name as the argument value.
    const param = actionParamOf(tool);
    if (param) {
      const en = enumOf(tool, param);
      const valueHit =
        en?.find((v) => normName(v) === needle) ??
        (typeof name === "string" && en?.includes(name) ? name : undefined);
      if (valueHit) {
        scored.push({ name: tool.name, score: 95, viaParam: param });
        continue;
      }
    }

    let s = 0;
    const lenDiff = Math.abs(cand.length - needle.length);
    if (cand === needle) s = 100;
    else if (cand.startsWith(needle) || needle.startsWith(cand)) s = 85 - lenDiff;
    else if (cand.includes(needle) || needle.includes(cand)) s = 70 - lenDiff;
    else {
      const maxDist = Math.max(2, Math.floor(Math.min(cand.length, needle.length) / 4));
      const d = levenshtein(needle, cand, maxDist);
      if (d <= maxDist) {
        s = 60 - d * 8;
      } else if (needleTokens.length) {
        const candTokens = tokensOf(tool.name);
        const overlap = candTokens.filter((t) =>
          needleTokens.some((nt) => nt.startsWith(t) || t.startsWith(nt)),
        ).length;
        if (overlap) s = 40 + overlap * 10 - lenDiff / 2;
      }
    }
    if (s > 0) scored.push({ name: tool.name, score: Math.round(s) });
  }

  scored.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Corrective unknown-tool result
// ---------------------------------------------------------------------------

/**
 * The structured tool result returned when a hallucinated tool name cannot
 * be corrected. Replaces the old bare "Tool 'x' is not registered" — the
 * model now gets the closest real tools + an exact how-to-call example +
 * the never-invent rule, so it self-corrects in ONE round.
 */
export function unknownToolResult(
  name: string,
  tools: readonly ToolLookupTarget[],
): Record<string, unknown> {
  const suggestions = suggestToolCalls(name, tools);
  const top = suggestions[0];

  const payload: Record<string, unknown> = {
    error:
      `Tool '${name}' does not exist. NEVER invent or predict tool names, ` +
      `parameter names or parameter definitions — call ONLY tools from your ` +
      `ACTIVE tool definitions for this turn.`,
    fix:
      `Re-issue the call with an exact tool name from your tool definitions` +
      (top ? ` (closest real tool: '${top.name}')` : "") +
      `. Do not retry '${name}' — it is not registered.`,
    did_you_mean: suggestions.map((s) => s.name),
    next_step:
      `If unsure of the real tool surface, call analyze_workspace — its ` +
      `available_tools field lists every registered tool — or read ` +
      `/home/user/Onyx.md. Never fabricate a tool to work around this error.`,
  };

  if (top?.viaParam) {
    const example = JSON.stringify({ [top.viaParam]: name });
    payload.how_to_call =
      `${top.name} is ONE tool — the subtool is an ARGUMENT. Call it as ` +
      `{"name": "${top.name}", "arguments": ${JSON.stringify(example)}} ` +
      `(pass the remaining parameters alongside "${top.viaParam}").`;
  }
  if (name.includes(".")) {
    payload.name_rule =
      `Tool names never contain dots. Multi-function tools take ONE name; ` +
      `the subtool (after the dot) is the value of an 'action' or ` +
      `'operation' argument.`;
  }
  return payload;
}
