/**
 * GenUI stream-parser — sentinel scanner + tolerant incremental JSON parser.
 *
 * Watches the streaming text for `<<<genui>>>` ... `<<</genui>>>` sentinels.
 * Between the sentinels, accumulates JSON text and tries to parse it on every
 * delta. The parser is *tolerant*: it handles incomplete JSON that's been cut
 * mid-value (unterminated strings, missing brackets, trailing commas, etc.)
 * so the UI can render a partial spec live as it streams in.
 *
 * Public API:
 *   - `processTextDelta(accumulated, newChunk)` → returns the text to render
 *     as normal markdown + the parsed GenUI spec + whether we're mid-block.
 *
 * Internal helpers (also exported for the `useGenUIStream` hook):
 *   - `segmentText(full)` → splits into before / blocks / after
 *   - `parseTolerant(jsonish)` → never throws, always returns something
 */

import {
  GENUI_CLOSE,
  GENUI_OPEN,
  type GenUINode,
  type GenUISpec,
  type ProcessTextDeltaResult,
} from "./types";

/**
 * Walk a (possibly incomplete) JSON string and patch it so it parses.
 *
 * Patches applied:
 *   1. If we're inside a string when the input ends, append a closing `"`.
 *   2. Strip trailing commas inside objects/arrays (`,]` → `]`, `,}` → `}`).
 *   3. Close every unclosed `[` and `{` at the end.
 *   4. If a value was truncated mid-token (e.g. `"key": tru`), drop the
 *      partial token so we don't get a parse error on the whole object.
 *
 * Returns the patched string. Always returns a string — never throws.
 */
export function repairJson(input: string): string {
  if (!input) return "{}";
  let out = "";
  let i = 0;
  // Stack of open containers: '{' or '['.
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escape = false;

  while (i < input.length) {
    const ch = input[i]!;

    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    // Not in a string.
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === "{" || ch === "[") {
      stack.push(ch);
      out += ch;
      i++;
      continue;
    }

    if (ch === "}" || ch === "]") {
      // Pop matching opener if any.
      if (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (
          (ch === "}" && top === "{") ||
          (ch === "]" && top === "[")
        ) {
          stack.pop();
        }
      }
      out += ch;
      i++;
      continue;
    }

    // Trailing comma just before EOF or before a closer → drop it.
    if (ch === ",") {
      const rest = input.slice(i + 1).trimStart();
      if (
        rest === "" ||
        rest.startsWith("}") ||
        rest.startsWith("]")
      ) {
        // Skip the comma — don't append.
        i++;
        continue;
      }
      out += ch;
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  // Close any open string.
  if (inString) {
    out += '"';
  }

  // If the last non-whitespace token is a partial value (e.g. `: tru` or
  // `: 12.`), trim back to a safe boundary. We detect this by checking if
  // we're mid-value: the last meaningful char is alphanumeric / `.` / `-`
  // AND the char before the colon (or comma) doesn't form a complete value.
  out = trimPartialValue(out);

  // Close all open containers in reverse order.
  while (stack.length > 0) {
    const top = stack.pop();
    out += top === "{" ? "}" : "]";
  }

  return out;
}

/**
 * Trim a truncated value at the end of the JSON string. Handles cases like:
 *   `{"nodes":[{"type":"header","title":"Hel` → `{"nodes":[{"type":"header"}`
 *   `{"x": tru`                              → `{}`
 *   `{"x": 12.`                              → `{}`
 *
 * Strategy: walk backwards from the end. If the last complete token (after
 * the last `:`) is an unterminated primitive, drop the key/value pair.
 */
function trimPartialValue(input: string): string {
  // Find the last `:` that's NOT inside a string — walk from the end.
  let inStr = false;
  let escape = false;
  let colonIdx = -1;
  for (let i = input.length - 1; i >= 0; i--) {
    const ch = input[i]!;
    if (inStr) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === ":") {
      colonIdx = i;
      break;
    }
    if (ch === "{" || ch === "[" || ch === ",") {
      // No value started after the last key — nothing to trim.
      return input;
    }
  }
  if (colonIdx === -1) return input;

  // Look at what comes after the colon.
  const after = input.slice(colonIdx + 1).trimStart();
  if (after === "") {
    // `{"x":` → drop the key entirely.
    return dropLastKey(input, colonIdx);
  }

  const firstCh = after[0]!;
  // Complete value starters — leave as-is (the closing logic will patch).
  if (
    firstCh === '"' ||
    firstCh === "{" ||
    firstCh === "[" ||
    firstCh === "t" || // true
    firstCh === "f" || // false
    firstCh === "n" // null
  ) {
    // Check for partial keyword: `tru`, `fals`, `nu`
    if (firstCh === "t" && !after.startsWith("true")) {
      return dropLastKey(input, colonIdx);
    }
    if (firstCh === "f" && !after.startsWith("false")) {
      return dropLastKey(input, colonIdx);
    }
    if (firstCh === "n" && !after.startsWith("null")) {
      return dropLastKey(input, colonIdx);
    }
    return input;
  }

  // Number — could be `12`, `12.`, `-3`, `1e`. If it ends with `.`, `e`, `-`
  // after digits, it's truncated.
  if (firstCh === "-" || (firstCh >= "0" && firstCh <= "9")) {
    // Heuristic: if it ends with `.`, `e`, `E`, `+`, `-` it's truncated.
    const last = after[after.length - 1]!;
    if (last === "." || last === "e" || last === "E" || last === "+" || last === "-") {
      return dropLastKey(input, colonIdx);
    }
    return input;
  }

  // Unknown — drop the key to be safe.
  return dropLastKey(input, colonIdx);
}

/** Drop the `"key":` segment ending at `colonIdx` from the input. */
function dropLastKey(input: string, colonIdx: number): string {
  // Walk back from colonIdx to find the start of the key (the opening `"`).
  let keyStart = -1;
  let inStr = false;
  for (let i = colonIdx - 1; i >= 0; i--) {
    const ch = input[i]!;
    if (ch === '"' && (i === 0 || input[i - 1] !== "\\")) {
      if (!inStr) {
        // This is the closing quote of the key — keep walking to find opening.
        inStr = true;
        continue;
      } else {
        // Opening quote of the key.
        keyStart = i;
        break;
      }
    }
  }
  if (keyStart === -1) return input;
  // Also drop the comma before the key if present.
  let cutStart = keyStart;
  for (let i = keyStart - 1; i >= 0; i--) {
    const ch = input[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;
    if (ch === ",") {
      cutStart = i;
    }
    break;
  }
  return input.slice(0, cutStart);
}

/**
 * Parse a (possibly partial) JSON string into a value. Never throws.
 *
 * Tries `JSON.parse` first; on failure, runs `repairJson` and tries again.
 * Returns `null` if both attempts fail (which only happens on truly empty
 * or malformed input — repairJson is very aggressive).
 */
export function parseTolerant<T = unknown>(jsonish: string): T | null {
  if (!jsonish || !jsonish.trim()) return null;
  // Fast path: already valid JSON.
  try {
    return JSON.parse(jsonish) as T;
  } catch {
    // Fall through to repair.
  }
  try {
    const repaired = repairJson(jsonish);
    return JSON.parse(repaired) as T;
  } catch {
    // Even repair failed — try one more aggressive trim.
    try {
      const repaired = repairJson(jsonish.slice(0, Math.max(0, jsonish.lastIndexOf(","))));
      return JSON.parse(repaired) as T;
    } catch {
      return null;
    }
  }
}

/** Normalize a raw parsed value into a `GenUISpec`. */
function toSpec(raw: unknown, streaming: boolean): GenUISpec | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  // Accept either `{nodes: [...]}` or a bare `[...]` or a single node object.
  let nodes: unknown;
  if (Array.isArray(obj.nodes)) {
    nodes = obj.nodes;
  } else if (Array.isArray(raw)) {
    nodes = raw;
  } else if (typeof obj.type === "string") {
    // Single node — wrap it.
    nodes = [obj];
  } else {
    return null;
  }

  const normalized = (nodes as unknown[])
    .filter((n): n is Record<string, unknown> => !!n && typeof n === "object")
    .map((n: Record<string, unknown>, idx: number) => normalizeNode(n, idx, streaming));
  if (normalized.length === 0) return null;
  return { nodes: normalized };
}

/** Ensure a node has an `id` and that `meta.streaming` is set correctly.
 *
 * CRITICAL: The AI often emits nodes with props at the TOP LEVEL (not nested
 * in a `props` field), e.g. `{"type":"header","title":"..."}`. We must collect
 * all unknown keys (everything except `type`, `id`, `children`, `meta`, `props`)
 * into the `props` object so validateSpec + the renderers can find them.
 */
function normalizeNode(
  raw: Record<string, unknown>,
  idx: number,
  streaming: boolean,
): GenUINode {
  const type = typeof raw.type === "string" ? raw.type : "unknown";
  const id =
    typeof raw.id === "string" && raw.id.length > 0
      ? raw.id
      : `genui-${idx}-${type}`;

  // Collect props from BOTH `raw.props` (proper format) AND top-level keys
  // (flat format that the AI naturally emits). Top-level keys take precedence
  // only if `raw.props` doesn't have them (so explicit props win).
  const RESERVED_KEYS = new Set(["type", "id", "children", "meta", "props"]);
  const flatProps: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!RESERVED_KEYS.has(key)) {
      flatProps[key] = raw[key];
    }
  }

  const nestedProps =
    raw.props && typeof raw.props === "object"
      ? (raw.props as Record<string, unknown>)
      : {};

  // Merge: flat props first, then nested props (nested wins on conflict)
  const props = { ...flatProps, ...nestedProps };

  const children = Array.isArray(raw.children)
    ? raw.children
        .filter(
          (c): c is Record<string, unknown> => !!c && typeof c === "object",
        )
        .map((c, i) => normalizeNode(c, i, streaming))
    : undefined;

  const metaRaw =
    raw.meta && typeof raw.meta === "object"
      ? (raw.meta as Record<string, unknown>)
      : undefined;
  const meta: GenUINode["meta"] = {
    streaming,
    ...(metaRaw && typeof metaRaw.source === "string"
      ? { source: metaRaw.source }
      : {}),
  };

  return { id, type, props, children, meta };
}

/** One parsed segment of the text. */
export interface TextSegment {
  /** Text before the first GenUI sentinel. */
  before: string;
  /** Parsed GenUI blocks (complete + in-progress). */
  blocks: GenUISpec[];
  /** True if the last block is still open (streaming). */
  inGenUI: boolean;
  /** Text after the last CLOSED `<<</genui>>>`. Empty while streaming. */
  after: string;
}

/**
 * Split the full text into before / blocks / after segments.
 *
 * Walks the text scanning for `<<<genui>>>` and `<<</genui>>>`. Anything
 * before the first opening sentinel is `before`. Between matched sentinels
 * is a GenUI block. Anything after the last closing sentinel is `after`.
 *
 * If there's an open `<<<genui>>>` without a closing `<<</genui>>>`, the
 * partial JSON is parsed tolerantly and added as a streaming block.
 */
export function segmentText(full: string): TextSegment {
  if (!full) return { before: "", blocks: [], inGenUI: false, after: "" };

  let before = "";
  const blocks: GenUISpec[] = [];
  let after = "";
  let inGenUI = false;

  let cursor = 0;
  let firstBlockSeen = false;

  while (cursor < full.length) {
    const openIdx = full.indexOf(GENUI_OPEN, cursor);
    if (openIdx === -1) {
      // No more opening sentinels — rest is either `before` or `after`.
      if (firstBlockSeen) {
        after += full.slice(cursor);
      } else {
        before += full.slice(cursor);
      }
      break;
    }

    // Text before the opening sentinel.
    const textBefore = full.slice(cursor, openIdx);
    if (firstBlockSeen) {
      // Text between blocks → append to `after` (rare; AI usually emits one block).
      after += textBefore;
    } else {
      before += textBefore;
    }

    // Move past the opening sentinel.
    const jsonStart = openIdx + GENUI_OPEN.length;

    // Find the matching close.
    const closeIdx = full.indexOf(GENUI_CLOSE, jsonStart);
    if (closeIdx === -1) {
      // Open block — parse the partial JSON tolerantly.
      const partial = full.slice(jsonStart);
      const raw = parseTolerant(partial);
      const spec = raw ? toSpec(raw, true) : null;
      if (spec) blocks.push(spec);
      inGenUI = true;
      cursor = full.length;
      break;
    }

    // Closed block — parse the complete JSON.
    const jsonText = full.slice(jsonStart, closeIdx);
    const raw = parseTolerant(jsonText);
    const spec = raw ? toSpec(raw, false) : null;
    if (spec) blocks.push(spec);
    firstBlockSeen = true;
    cursor = closeIdx + GENUI_CLOSE.length;
  }

  // Strip wrapping code fences around GenUI blocks.
  //
  // The AI sometimes wraps the <<<genui>>> sentinel in a markdown code fence:
  //   ```json
  //   <<<genui>>>
  //   {"nodes":[...]}
  //   <<</genui>>>
  //   ```
  //
  // This leaves an unclosed ```json at the end of `before` and a stray ``` at
  // the start of `after`, which breaks markdown rendering. Detect and strip
  // both halves so the markdown renders cleanly.
  if (blocks.length > 0) {
    // Check if `before` ends with an opening code fence (```lang or ~~~lang).
    // The fence may be followed by a newline before the <<<genui>>> sentinel.
    const fenceMatch = before.match(/\n?[ \t]*(`{3,}|~{3,})[a-zA-Z0-9+#.-]*\s*$/);
    if (fenceMatch && fenceMatch.index !== undefined) {
      before = before.slice(0, fenceMatch.index);
      // Strip the matching closing fence from `after` (or from the streaming
      // tail if the block is still open).
      if (after) {
        after = after.replace(/^\s*(`{3,}|~{3,})\s*/, "");
      }
    }
  }

  return { before, blocks, inGenUI, after };
}

/**
 * Process a streaming text delta. Returns what the caller should render:
 *   - `beforeText`: text outside sentinels (render as markdown)
 *   - `genuiSpec`: merged spec from all blocks, or null
 *   - `inGenUI`: true if currently inside a `<<<genui>>>` block
 *
 * The `accumulated` parameter is the FULL text received so far (it should
 * already include `newChunk`). `newChunk` is accepted for future optimization
 * (incremental scanning) but the current implementation re-scans the full
 * text on each call — text streams are short enough that this is fine.
 */
export function processTextDelta(
  accumulated: string,
  _newChunk: string = "",
): ProcessTextDeltaResult {
  const seg = segmentText(accumulated);
  if (seg.blocks.length === 0) {
    return {
      beforeText: seg.before,
      genuiSpec: null,
      inGenUI: seg.inGenUI,
    };
  }
  // Merge all blocks into one spec.
  const allNodes: GenUINode[] = [];
  for (const b of seg.blocks) {
    for (const n of b.nodes) allNodes.push(n);
  }
  return {
    beforeText: seg.before,
    genuiSpec: { nodes: allNodes },
    inGenUI: seg.inGenUI,
  };
}
