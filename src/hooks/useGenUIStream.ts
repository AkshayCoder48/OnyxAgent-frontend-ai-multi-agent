"use client";

/**
 * useGenUIStream — React hook for streaming GenUI.
 *
 * Subscribes to the chat store's message updates, watches the streaming text
 * for `<<<genui>>>` sentinels, and returns the parsed spec + the surrounding
 * text segments (before / after).
 *
 * Used by `message-item.tsx` to render GenUI blocks live as they stream in.
 * When the message is no longer streaming, the persisted `message.genui`
 * array is used instead (set by the agent runtime when the stream completes).
 *
 * PERF (PRD §4/§7 — GenUI flicker fix):
 *   1. SINGLE PASS — the old implementation parsed the full text THREE times
 *      per flush (processTextDelta + segmentText + buildSegments), each doing
 *      a sentinel scan + tolerant JSON repair + JSON.parse on the whole
 *      partial spec. Everything is now derived from ONE segment walk.
 *   2. DEFERRED COALESCING — the parse input runs through `useDeferredValue`,
 *      so when the store flushes ~33 text updates per second, React can drop
 *      intermediate parses and only commit the latest snapshot. Urgent
 *      updates (user input, UI events) are never blocked by GenUI parsing,
 *      and dozens of tiny chunks coalesce into one render per frame instead
 *      of one render per chunk.
 */

import * as React from "react";
import { useChatStore } from "@/stores";
import type { ChatMessage } from "@/types";
import type { GenUISpec, GenUINode } from "@/lib/genui/types";
import { parseTolerant } from "@/lib/genui/stream-parser";
import { validateSpec } from "@/lib/genui/validate";
import { genuiPerfLog } from "@/lib/genui/perf";

export interface UseGenUIStreamResult {
  /** Parsed + validated GenUI spec (merged from all blocks), or null. */
  genuiSpec: GenUISpec | null;
  /** Text outside sentinels that comes BEFORE the first GenUI block. */
  textBefore: string;
  /** Text outside sentinels that comes AFTER the last closed GenUI block. */
  textAfter: string;
  /** True if we're currently inside a `<<<genui>>>` block (no close yet). */
  inGenUI: boolean;
  /** Ordered segments — alternating text and GenUI blocks. Use this to
   *  render interleaved text + GenUI correctly (textBefore/spec/textAfter
   *  loses text between multiple GenUI blocks). */
  segments: TextSegment[];
}

/** A segment of the message — either text (markdown) or a GenUI block. */
export interface TextSegment {
  type: "text" | "genui";
  /** For text segments: the markdown to render. */
  text?: string;
  /** For genui segments: the validated spec (one or more nodes). */
  spec?: GenUISpec;
  /** True if this genui segment is still streaming (no close sentinel yet). */
  streaming?: boolean;
}

/** Sentinel markers wrapping a GenUI JSON block. */
const GENUI_OPEN = "<<<genui>>>";
const GENUI_CLOSE = "<<</genui>>>";

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

/**
 * While a block is still STREAMING, a node whose `type` is not a known kind
 * is almost always a MID-STREAM ARTIFACT — the type string itself is still
 * arriving ("c", "ca", "cal", "callout"…). Rendering those as the
 * unknown-type JSON fallback made the card flash raw JSON boxes while the
 * type completed. Drop them (recursively, from children too); a genuinely
 * unknown type on a CLOSED block still renders the fallback by design.
 */
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

/**
 * Build ordered segments (text / genui / text / genui / ...) from the full
 * text in a SINGLE walk — preserving interleaved text between multiple GenUI
 * blocks. This is the one and only parse pass (sentinel scan + tolerant
 * JSON parse per block + validation).
 *
 * LAST-GOOD FALLBACK (PRD §15 — the remaining flicker source): while the
 * block's JSON streams, the tolerant parse FAILS at every key/value
 * boundary of the growing document (e.g. `"ti"` — a key with no value
 * yet — is unparseable). The old behavior dropped the whole genui segment
 * on those flushes, unmounting the card and remounting it ~2 flushes later
 * — dozens of times per block, which read as "the UI disappears and
 * reappears until the code finishes". Now each block ordinal keeps its
 * LAST SUCCESSFULLY PARSED spec in `cache`; a failed parse re-renders the
 * cached spec instead of nothing, so the card keeps its DOM identity the
 * entire time and simply stops updating until the JSON parses again.
 */
function buildSegments(
  fullText: string,
  cache: Map<number, GenUISpec>,
): TextSegment[] {
  if (!fullText || !fullText.includes(GENUI_OPEN)) {
    if (cache.size > 0) cache.clear();
    return [];
  }
  const segments: TextSegment[] = [];
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
    const closeIdx = fullText.indexOf(GENUI_CLOSE, jsonStart);
    const isStreaming = closeIdx === -1;

    // Open block → parse the partial JSON; closed block → parse complete JSON.
    const jsonText = isStreaming
      ? fullText.slice(jsonStart)
      : fullText.slice(jsonStart, closeIdx);

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
          cache.set(blockOrdinal, spec);
          pushed = true;
        }
      }
    }
    if (!pushed && isStreaming) {
      // Parse failed or produced nothing — keep the last GOOD render for
      // this block (see the doc comment). The card never blanks.
      const cached = cache.get(blockOrdinal);
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
    if (!pushed) cache.delete(blockOrdinal);
    blockOrdinal++;
    cursor = closeIdx + GENUI_CLOSE.length;
  }

  // Drop cache entries for blocks that no longer exist (text changed above).
  if (cache.size > blockOrdinal) {
    for (const k of [...cache.keys()]) {
      if (k >= blockOrdinal) cache.delete(k);
    }
  }

  return segments;
}

/**
 * Derive the full legacy result shape from ONE segment walk (single parse).
 * `textBefore` = text before the first GenUI block, `textAfter` = text after
 * the last CLOSED block, `inGenUI` = last block is still open.
 */
function segmentsToResult(segments: TextSegment[]): UseGenUIStreamResult {
  let genuiSpec: GenUISpec | null = null;
  const allNodes: GenUINode[] = [];
  let inGenUI = false;
  for (const seg of segments) {
    if (seg.type !== "genui" || !seg.spec) continue;
    allNodes.push(...seg.spec.nodes);
    inGenUI = Boolean(seg.streaming);
  }
  if (allNodes.length > 0) {
    genuiSpec = { nodes: allNodes };
  }
  const firstGenui = segments.findIndex((s) => s.type === "genui");
  const lastClosedGenui = segments.findLastIndex(
    (s) => s.type === "genui" && !s.streaming,
  );
  const textBefore =
    firstGenui === -1
      ? ""
      : (segments
          .slice(0, firstGenui)
          .map((s) => s.text ?? "")
          .join("") ?? "");
  const textAfter =
    lastClosedGenui === -1
      ? ""
      : segments
          .slice(lastClosedGenui + 1)
          .map((s) => s.text ?? "")
          .join("");
  return { genuiSpec, textBefore, textAfter, inGenUI, segments };
}

/** Extract the full streaming text from a message (content + parts text). */
function getFullText(message: ChatMessage | undefined): string {
  if (!message) return "";
  // Prefer `content` (the flat aggregate the store keeps in sync with parts).
  if (message.content) return message.content;
  // Fallback: join text parts (legacy / parts-only messages).
  if (Array.isArray(message.parts)) {
    return message.parts
      .filter((p) => p.type === "text" && p.content)
      .map((p) => p.content ?? "")
      .join("\n\n");
  }
  return "";
}

/**
 * Subscribe to a streaming message and parse its text for GenUI blocks.
 *
 * Re-parses on text deltas, COALESCED by `useDeferredValue` — see the file
 * doc comment. Zustand's selector means we only re-render when THIS message
 * changes, not on every store update.
 *
 * @param messageId The message ID to watch. Pass `undefined` when the message
 *   isn't streaming (the hook returns nulls).
 * @param enabled When false, the hook returns nulls without subscribing.
 */
export function useGenUIStream(
  messageId: string | undefined,
  enabled: boolean = true,
): UseGenUIStreamResult {
  // Subscribe to the specific message — Zustand's selector means we only
  // re-render when THIS message changes, not on every store update.
  const message = useChatStore((s) =>
    enabled && messageId
      ? (s.messages.find((m) => m.id === messageId) ?? null)
      : null,
  );

  const fullText = React.useMemo(() => getFullText(message ?? undefined), [
    message,
  ]);

  // Coalesce rapid text flushes: urgent renders see the previous parse,
  // React schedules a low-priority re-render with the latest text, and
  // intermediate values are skipped instead of parsed.
  const deferredText = React.useDeferredValue(fullText);
  // Last-good spec per streaming block ordinal — see buildSegments. Held in
  // a lazily-created mutable container (never re-set): the map is a
  // render-time MEMOIZATION cache, not reactive state — its contents only
  // serve as the fallback spec when the tolerant parse transiently fails,
  // and every successful parse overwrites the entry.
  const [lastGood] = React.useState(() => new Map<number, GenUISpec>());

  return React.useMemo<UseGenUIStreamResult>(() => {
    genuiPerfLog("GenUI", "parse", { textLength: deferredText.length });
    return segmentsToResult(
      buildSegments(deferredText, lastGood),
    );
  }, [deferredText, lastGood]);
}

/**
 * Pure variant: parse GenUI from an arbitrary text string (no store
 * subscription). Used by `TextBubble` to split a single text part into
 * segments for inline rendering. The input is deferred the same way so
 * streaming chunks coalesce into one parse per frame, and the last-good
 * cache keeps the card mounted across mid-JSON parse failures.
 */
export function useGenUIFromText(text: string): UseGenUIStreamResult {
  const deferredText = React.useDeferredValue(text);
  // Last-good spec per streaming block ordinal — see buildSegments (same
  // mutable memoization-container pattern as useGenUIStream).
  const [lastGood] = React.useState(() => new Map<number, GenUISpec>());

  return React.useMemo<UseGenUIStreamResult>(() => {
    genuiPerfLog("GenUI", "parse", { textLength: deferredText.length });
    return segmentsToResult(
      buildSegments(deferredText, lastGood),
    );
  }, [deferredText, lastGood]);
}
