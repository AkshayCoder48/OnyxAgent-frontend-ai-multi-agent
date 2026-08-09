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
import type { GenUISpec } from "@/lib/genui/types";
import { processTextDelta, segmentText } from "@/lib/genui/stream-parser";
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
      return { genuiSpec: null, textBefore: "", textAfter: "", inGenUI: false };
    }
    const result = processTextDelta(fullText, "");
    const seg = segmentText(fullText);
    const validated = result.genuiSpec
      ? validateSpec(result.genuiSpec)
      : null;
    return {
      genuiSpec: validated && validated.nodes.length > 0 ? validated : null,
      textBefore: result.beforeText,
      textAfter: seg.after,
      inGenUI: result.inGenUI,
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
      return { genuiSpec: null, textBefore: "", textAfter: "", inGenUI: false };
    }
    const result = processTextDelta(text, "");
    const seg = segmentText(text);
    const validated = result.genuiSpec
      ? validateSpec(result.genuiSpec)
      : null;
    return {
      genuiSpec: validated && validated.nodes.length > 0 ? validated : null,
      textBefore: result.beforeText,
      textAfter: seg.after,
      inGenUI: result.inGenUI,
    };
  }, [text]);
}
