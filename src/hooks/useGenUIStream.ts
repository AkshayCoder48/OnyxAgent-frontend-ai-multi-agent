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
 */

import * as React from "react";
import { useChatStore } from "@/stores";
import type { ChatMessage } from "@/types";
import type { GenUISpec, GenUINode } from "@/lib/genui/types";
import { processTextDelta, segmentText, parseTolerant } from "@/lib/genui/stream-parser";
import { validateSpec } from "@/lib/genui/validate";

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
 * Build ordered segments (text / genui / text / genui / ...) from the full
 * text. This preserves interleaved text between multiple GenUI blocks,
 * which the old textBefore/spec/textAfter approach lost.
 *
 * Uses `segmentText` which returns { before, blocks[], after, inGenUI }.
 * We convert that into a flat array of segments:
 *   [text(before), genui(block1), text(between1-2), genui(block2), ..., text(after)]
 *
 * Text segments that are empty/whitespace-only are skipped.
 */
function buildSegments(fullText: string): TextSegment[] {
  if (!fullText) return [];
  const segments: TextSegment[] = [];

  // Manually walk the text to build ordered segments:
  //   [text(before), genui(block1), text(between1-2), genui(block2), ..., text(after)]
  // This preserves interleaved text between multiple GenUI blocks.
  const GENUI_OPEN = "<<<genui>>>";
  const GENUI_CLOSE = "<<</genui>>>";
  let cursor = 0;

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

    if (closeIdx === -1) {
      // Open block — parse partial JSON
      const partial = fullText.slice(jsonStart);
      const raw = parseTolerant(partial);
      if (raw) {
        let nodes: unknown[] | null = null;
        if (Array.isArray((raw as Record<string, unknown>).nodes)) {
          nodes = (raw as Record<string, unknown>).nodes as unknown[];
        } else if (Array.isArray(raw)) {
          nodes = raw;
        } else if (typeof (raw as Record<string, unknown>).type === "string") {
          nodes = [raw];
        }
        if (nodes && nodes.length > 0) {
          const spec = validateSpec({ nodes: nodes as GenUINode[] });
          if (spec.nodes.length > 0) {
            segments.push({ type: "genui", spec, streaming: true });
          }
        }
      }
      break;
    }

    // Closed block — parse complete JSON
    const jsonText = fullText.slice(jsonStart, closeIdx);
    const raw = parseTolerant(jsonText);
    if (raw) {
      let nodes: unknown[] | null = null;
      if (Array.isArray((raw as Record<string, unknown>).nodes)) {
        nodes = (raw as Record<string, unknown>).nodes as unknown[];
      } else if (Array.isArray(raw)) {
        nodes = raw;
      } else if (typeof (raw as Record<string, unknown>).type === "string") {
        nodes = [raw];
      }
      if (nodes && nodes.length > 0) {
        const spec = validateSpec({ nodes: nodes as GenUINode[] });
        if (spec.nodes.length > 0) {
          segments.push({ type: "genui", spec, streaming: false });
        }
      }
    }

    cursor = closeIdx + GENUI_CLOSE.length;
  }

  return segments;
}

/**
 * Subscribe to a streaming message and parse its text for GenUI blocks.
 *
 * Re-parses on every text delta (the store updates ~33x/sec during streaming,
 * which is fine — `processTextDelta` is O(n) on short text).
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

  return React.useMemo<UseGenUIStreamResult>(() => {
    if (!enabled || !fullText) {
      return { genuiSpec: null, textBefore: "", textAfter: "", inGenUI: false, segments: [] };
    }
    const result = processTextDelta(fullText, "");
    const seg = segmentText(fullText);
    const validated = result.genuiSpec
      ? validateSpec(result.genuiSpec)
      : null;
    const segments = buildSegments(fullText);
    return {
      genuiSpec: validated && validated.nodes.length > 0 ? validated : null,
      textBefore: result.beforeText,
      textAfter: seg.after,
      inGenUI: result.inGenUI,
      segments,
    };
  }, [enabled, fullText]);
}

/**
 * Pure variant: parse GenUI from an arbitrary text string (no store
 * subscription). Used by `TextBubble` to split a single text part into
 * before / spec / after for inline rendering.
 */
export function useGenUIFromText(text: string): UseGenUIStreamResult {
  return React.useMemo<UseGenUIStreamResult>(() => {
    if (!text) {
      return { genuiSpec: null, textBefore: "", textAfter: "", inGenUI: false, segments: [] };
    }
    const result = processTextDelta(text, "");
    const seg = segmentText(text);
    const validated = result.genuiSpec
      ? validateSpec(result.genuiSpec)
      : null;
    const segments = buildSegments(text);
    return {
      genuiSpec: validated && validated.nodes.length > 0 ? validated : null,
      textBefore: result.beforeText,
      textAfter: seg.after,
      inGenUI: result.inGenUI,
      segments,
    };
  }, [text]);
}
