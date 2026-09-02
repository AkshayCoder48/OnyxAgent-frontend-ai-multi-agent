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
import { validateSpec } from "./validate";

/**
 * Walk a (possibly incomplete) JSON string and patch it so it parses.
 *
 * Patches applied:
 *   1. If we're inside a string when the input ends, append a closing `"`.
 *   2. RAW CONTROL CHARACTERS inside strings (literal newlines, tabs, CR)
 *      are escaped to `\n` / `\t` / `\r` — strict JSON.parse rejects raw
 *      control chars, and models frequently emit multi-line `html`/`js`
 *      strings with REAL newlines. Without this, the whole block fails to
 *      parse and the user sees raw `<<<genui>>>` JSON as plain text.
 *   3. Strip trailing commas inside objects/arrays (`,]` → `]`, `,}` → `}`).
 *   4. Close every unclosed `[` and `{` at the end.
 *   5. If a value was truncated mid-token (e.g. `"key": tru`), drop the
 *      partial token so we don't get a parse error on the whole object.
 *   6. TRAILING GARBAGE TRUNCATION: when the root container is already
 *      closed and non-whitespace follows (the model emitted the WRONG
 *      closing sentinel — `<<<genui>>>` instead of `<<</genui>>>` — or any
 *      stray text after the JSON), everything after the root's closing
 *      brace is cut. This is the #1 cause of "the card never renders / raw
 *      JSON shows after refresh": `{...valid json...}\n<<<genui>>>` fails
 *      JSON.parse on trailing characters and the whole block was dropped.
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
  // Index of the character that CLOSED the root container (stack hit 0).
  let rootClosedIdx = -1;

  while (i < input.length) {
    const ch = input[i]!;

    if (inString) {
      if (escape) {
        escape = false;
        out += ch;
      } else if (ch === "\\") {
        escape = true;
        out += ch;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === "\n") {
        out += "\\n";
      } else if (ch === "\r") {
        out += "\\r";
      } else if (ch === "\t") {
        out += "\\t";
      } else {
        out += ch;
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
          // Root container just closed — remember where.
          if (stack.length === 0) rootClosedIdx = out.length;
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

  // TRAILING GARBAGE: the root object closed but junk follows (wrong
  // `<<<genui>>>` close sentinel, stray prose, a duplicated marker…). Cut
  // everything after the root's closing character — the JSON itself is
  // complete and valid up to that point.
  if (stack0Closed(rootClosedIdx, out)) {
    // rootClosedIdx points at the `}`/`]` position in `out` BEFORE
    // trimPartialValue may have trimmed content — recompute it safely by
    // scanning for the last balanced root close.
    const cut = findRootEnd(out);
    if (cut !== -1 && cut < out.length) {
      let trimmed = out.slice(0, cut + 1);
      // Also strip trailing commas / whitespace at the root level.
      trimmed = trimmed.replace(/[\s,]+$/, "");
      out = trimmed;
    }
  }

  return out;
}

/** True when a root container was seen closing during the walk. */
function stack0Closed(rootClosedIdx: number, _out: string): boolean {
  void _out;
  return rootClosedIdx !== -1;
}

/** Find the index of the character that closes the ROOT container (the
 *  position where bracket depth returns to zero for the last time). Returns
 *  -1 when the root never closes. Ignores brackets inside strings. */
function findRootEnd(s: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  let rootEnd = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) rootEnd = i;
    }
  }
  return rootEnd;
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

/** Extract nodes from a parsed GenUI JSON payload (several accepted shapes). */
function nodesFromRaw(raw: unknown): unknown[] | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.nodes)) return obj.nodes;
  if (obj.type === "root" && Array.isArray(obj.children)) return obj.children;
  if (Array.isArray(raw)) return raw;
  if (typeof obj.type === "string") return [obj];
  return null;
}

// ---------------------------------------------------------------------------
// WRONG-CLOSE-MARKER RECOVERY + COMPLETE-MODE SEGMENTATION
//
// The #1 GenUI failure observed in the wild: the model emits the OPENING
// sentinel correctly, streams a complete JSON spec, then writes the WRONG
// closing marker — `<<<genui>>>` instead of `<<</genui>>>`. The block never
// "closes", so (a) live rendering stays in streaming mode forever, (b) after
// a refresh the raw JSON text leaks into the chat as markdown, and (c) the
// custom_html iframe never mounts (it waits for streaming=false).
//
// Recovery, applied consistently in ONE place (segmentText + the shared
// buildTextSegments below):
//   • FAKE CLOSE — a second `<<<genui>>>` encountered while inside a block is
//     treated as the close marker (when no real `<<</genui>>>` comes first).
//   • COMPLETE MODE — when the message is no longer streaming, an
//     unterminated block is treated as CLOSED at end-of-text; combined with
//     repairJson's trailing-garbage truncation the JSON parses and the card
//     renders exactly as the user saw live.
// ---------------------------------------------------------------------------

/** Find the end of the current GenUI block: the real close sentinel, a fake
 *  close (second `<<<genui>>>`), or end-of-text in complete mode.
 *  Returns [endIndex, isClosed] where endIndex is the position of the close
 *  marker start (or -1 / text end when unterminated). */
function findBlockEnd(
  fullText: string,
  jsonStart: number,
  complete: boolean,
): { closeIdx: number; closed: boolean } {
  const realClose = fullText.indexOf(GENUI_CLOSE, jsonStart);
  // Fake close: another OPEN sentinel while we're inside a block — the model
  // wrote `<<<genui>>>` where `<<</genui>>>` belonged.
  const fakeClose = fullText.indexOf(GENUI_OPEN, jsonStart);
  if (realClose !== -1 && (fakeClose === -1 || realClose < fakeClose)) {
    return { closeIdx: realClose, closed: true };
  }
  if (fakeClose !== -1) {
    return { closeIdx: fakeClose, closed: true };
  }
  // No close marker at all. In complete mode (message finished) the block
  // ends at end-of-text; while still streaming it stays open.
  return { closeIdx: complete ? fullText.length : -1, closed: complete };
}

/** Normalize wrong closing sentinels: walk the text tracking block state;
 *  any `<<<genui>>>` seen while INSIDE a block is rewritten to
 *  `<<</genui>>>`. Correct blocks pass through unchanged. Used by the agent
 *  runtime before persisting content so the DB copy (and the history sent
 *  back to the provider) carries well-formed sentinels. */
export function normalizeGenUISentinels(text: string): string {
  if (!text || !text.includes(GENUI_OPEN)) return text;
  let out = "";
  let cursor = 0;
  let inBlock = false;
  while (cursor < text.length) {
    const openIdx = text.indexOf(GENUI_OPEN, cursor);
    const closeIdx = text.indexOf(GENUI_CLOSE, cursor);
    if (openIdx === -1 && closeIdx === -1) {
      out += text.slice(cursor);
      break;
    }
    // Which comes first?
    if (closeIdx !== -1 && (openIdx === -1 || closeIdx < openIdx)) {
      // A close marker — valid only inside a block; outside a block it's
      // stray (leave it — nothing to do about it here).
      out += text.slice(cursor, closeIdx + GENUI_CLOSE.length);
      cursor = closeIdx + GENUI_CLOSE.length;
      inBlock = false;
      continue;
    }
    // An open marker comes first.
    if (!inBlock) {
      out += text.slice(cursor, openIdx + GENUI_OPEN.length);
      cursor = openIdx + GENUI_OPEN.length;
      inBlock = true;
      continue;
    }
    // OPEN marker while already inside a block → this was meant to be the
    // CLOSE marker. Rewrite it.
    out += text.slice(cursor, openIdx) + GENUI_CLOSE;
    cursor = openIdx + GENUI_OPEN.length;
    inBlock = false;
  }
  return out;
}

export interface TextSegmentUI {
  type: "text" | "genui";
  text?: string;
  spec?: GenUISpec;
  streaming?: boolean;
}

/** Build ordered text/genui segments from the full message text in ONE walk
 *  — shared by the live streaming hook and the persisted-message renderer
 *  so both behave identically.
 *
 *  `complete` — true when the message is no longer streaming. Unterminated
 *  blocks are then treated as closed (their JSON parses via the tolerant
 *  parser + trailing-garbage truncation) and custom_html iframes mount.
 *
 *  `cache` — last-good spec per block ordinal (streaming flicker guard; see
 *  useGenUIStream). Optional.
 */
export function buildTextSegments(
  fullText: string,
  cache?: Map<number, GenUISpec>,
  complete: boolean = false,
): TextSegmentUI[] {
  if (!fullText || !fullText.includes(GENUI_OPEN)) {
    if (cache && cache.size > 0) cache.clear();
    return [];
  }
  const segments: TextSegmentUI[] = [];
  let cursor = 0;
  let blockOrdinal = 0;

  while (cursor < fullText.length) {
    const openIdx = fullText.indexOf(GENUI_OPEN, cursor);
    if (openIdx === -1) {
      // No more blocks — remaining text is a text segment
      const text = fullText.slice(cursor);
      if (text.trim()) segments.push({ type: "text", text });
      break;
    }

    // Text before this block
    const textBefore = fullText.slice(cursor, openIdx);
    if (textBefore.trim()) segments.push({ type: "text", text: textBefore });

    const jsonStart = openIdx + GENUI_OPEN.length;
    const { closeIdx, closed } = findBlockEnd(fullText, jsonStart, complete);
    const isStreaming = !closed;

    // Open block → parse the partial JSON; closed block → parse complete JSON.
    const jsonText = closed
      ? fullText.slice(jsonStart, closeIdx)
      : fullText.slice(jsonStart);

    let pushed = false;
    const raw = parseTolerant(jsonText);
    if (raw) {
      const nodes = nodesFromRaw(raw);
      if (nodes && nodes.length > 0) {
        let spec = validateSpec({ nodes: nodes as GenUINode[] });
        if (isStreaming && spec.nodes.length > 0) {
          spec = pruneStreamingArtifacts(spec);
        }
        if (spec.nodes.length > 0) {
          segments.push({ type: "genui", spec, streaming: isStreaming });
          cache?.set(blockOrdinal, spec);
          pushed = true;
        }
      }
    }
    if (!pushed && isStreaming) {
      // Parse failed or produced nothing — keep the last GOOD render for
      // this block (the card never blanks mid-stream).
      const cached = cache?.get(blockOrdinal);
      if (cached) {
        segments.push({ type: "genui", spec: cached, streaming: true });
        pushed = true;
      }
    }

    if (isStreaming) {
      blockOrdinal++;
      break;
    }
    // Closed block: drop the cache entry only if it re-parsed to nothing.
    if (!pushed) cache?.delete(blockOrdinal);
    blockOrdinal++;
    cursor = Math.min(closeIdx + GENUI_CLOSE.length, fullText.length);
    if (cursor <= jsonStart) break; // safety — never loop forever
  }

  // Drop cache entries for blocks that no longer exist (text changed above).
  if (cache && cache.size > blockOrdinal) {
    for (const k of [...cache.keys()]) {
      if (k >= blockOrdinal) cache.delete(k);
    }
  }

  return segments;
}

/** Extract + validate GenUI nodes from a message's full text — used by the
 *  persistence path (message.genui) with COMPLETE semantics: unterminated
 *  blocks (wrong close marker) parse via the tolerant fallbacks. */
export function extractGenUINodes(fullText: string): GenUINode[] | null {
  if (!fullText || !fullText.includes(GENUI_OPEN)) return null;
  const segments = buildTextSegments(fullText, undefined, true);
  const allNodes: GenUINode[] = [];
  for (const seg of segments) {
    if (seg.type === "genui" && seg.spec) allNodes.push(...seg.spec.nodes);
  }
  return allNodes.length > 0 ? allNodes : null;
}

/** While a block is still STREAMING, a node whose `type` is not a known kind
 *  is almost always a MID-STREAM ARTIFACT. Drop them recursively; a genuinely
 *  unknown type on a CLOSED block still renders the fallback by design. */
function pruneStreamingArtifacts(spec: GenUISpec): GenUISpec {
  const pruneNodes = (nodes: GenUINode[]): GenUINode[] => {
    const out: GenUINode[] = [];
    for (const n of nodes) {
      if (n.type === "unknown_json") continue; // partial type string — skip
      if (n.children && n.children.length > 0) {
        const pruned = pruneNodes(n.children);
        out.push(pruned.length > 0 ? { ...n, children: pruned } : omitChildren(n));
      } else {
        out.push(n);
      }
    }
    return out;
  };
  return { nodes: pruneNodes(spec.nodes) };
}

const omitChildren = (n: GenUINode): GenUINode => {
  const { children: _children, ...rest } = n;
  void _children;
  return rest as GenUINode;
};

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

/** Normalize a raw parsed value into a `GenUISpec` (validation included). */
function specFromRaw(raw: unknown, streaming: boolean): GenUISpec | null {
  void streaming; // kept for API symmetry; validation is streaming-agnostic
  const nodes = nodesFromRaw(raw);
  if (!nodes || nodes.length === 0) return null;
  const spec = validateSpec({ nodes: nodes as GenUINode[] });
  return spec.nodes.length > 0 ? spec : null;
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

    // Find the matching close — real close, or FAKE close (a second
    // `<<<genui>>>` the model wrote where `<<</genui>>>` belonged).
    const { closeIdx, closed } = findBlockEnd(full, jsonStart, false);
    if (!closed) {
      // Open block — parse the partial JSON tolerantly.
      const partial = full.slice(jsonStart);
      const raw = parseTolerant(partial);
      const spec = raw ? specFromRaw(raw, true) : null;
      if (spec) blocks.push(spec);
      inGenUI = true;
      cursor = full.length;
      break;
    }

    // Closed block — parse the complete JSON.
    const jsonText = full.slice(jsonStart, closeIdx);
    const raw = parseTolerant(jsonText);
    const spec = raw ? specFromRaw(raw, false) : null;
    if (spec) blocks.push(spec);
    firstBlockSeen = true;
    cursor = Math.min(closeIdx + GENUI_CLOSE.length, full.length);
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
