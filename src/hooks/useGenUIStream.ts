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
import {
  buildTextSegments,
  type TextSegmentUI,
} from "@/lib/genui/stream-parser";
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

// Re-export for callers that import the segment type from the hook module.
export type { TextSegmentUI };

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
 * COMPLETE-MODE (wrong-close-marker recovery): once the message stops
 * streaming, unterminated `<<<genui>>>` blocks are treated as CLOSED —
 * combined with the tolerant parser's trailing-garbage truncation, a spec
 * whose closing marker was written incorrectly still renders as a real
 * card (and its custom_html iframe mounts) instead of leaking raw JSON
 * text into the chat after a refresh.
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
  // COMPLETE-MODE: a message that is no longer streaming closes any
  // unterminated GenUI block (see the doc comment above).
  const complete = message ? !message.isStreaming : true;

  // Coalesce rapid text flushes: urgent renders see the previous parse,
  // React schedules a low-priority re-render with the latest text, and
  // intermediate values are skipped instead of parsed.
  const deferredText = React.useDeferredValue(fullText);
  // Last-good spec per streaming block ordinal — see buildTextSegments. Held
  // in a lazily-created mutable container (never re-set): the map is a
  // render-time MEMOIZATION cache, not reactive state — its contents only
  // serve as the fallback spec when the tolerant parse transiently fails,
  // and every successful parse overwrites the entry.
  const [lastGood] = React.useState(() => new Map<number, GenUISpec>());

  return React.useMemo<UseGenUIStreamResult>(() => {
    genuiPerfLog("GenUI", "parse", { textLength: deferredText.length });
    return segmentsToResult(
      buildTextSegments(deferredText, lastGood, complete),
    );
  }, [deferredText, lastGood, complete]);
}

/**
 * Pure variant: parse GenUI from an arbitrary text string (no store
 * subscription). Used by `TextBubble` to split a single text part into
 * segments for inline rendering. The input is deferred the same way so
 * streaming chunks coalesce into one parse per frame, and the last-good
 * cache keeps the card mounted across mid-JSON parse failures.
 *
 * `complete` — true (default) when the text belongs to a message that is
 * DONE streaming. Unterminated blocks then close at end-of-text instead of
 * waiting forever for a `<<</genui>>>` that the model may have written
 * incorrectly.
 */
export function useGenUIFromText(
  text: string,
  complete: boolean = true,
): UseGenUIStreamResult {
  const deferredText = React.useDeferredValue(text);
  // Last-good spec per streaming block ordinal — see buildTextSegments (same
  // mutable memoization-container pattern as useGenUIStream).
  const [lastGood] = React.useState(() => new Map<number, GenUISpec>());

  return React.useMemo<UseGenUIStreamResult>(() => {
    genuiPerfLog("GenUI", "parse", { textLength: deferredText.length });
    return segmentsToResult(
      buildTextSegments(deferredText, lastGood, complete),
    );
  }, [deferredText, lastGood, complete]);
}
