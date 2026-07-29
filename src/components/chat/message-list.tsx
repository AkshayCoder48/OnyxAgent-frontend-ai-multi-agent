"use client";

import * as React from "react";
import type { ChatMessage } from "@/types";
import { MessageItem } from "./message-item";

interface MessageListProps {
  messages: ChatMessage[];
  onRegenerate?: (messageId: string) => void;
}

/**
 * PERF: Pre-compute group positions in a SINGLE O(n) pass using a Map.
 * Previously `getGroupPosition(message)` called `messages.filter()` for
 * EVERY message on EVERY render — an O(n²) operation that became the
 * dominant cost on long conversations (100+ messages = 10,000 filter
 * calls per render, which happened every 30ms during streaming).
 *
 * Now we walk the messages array once, grouping by `groupId` and recording
 * each message's position (first / middle / last / single) in a Map. The
 * render pass then does an O(1) lookup per message.
 *
 * Also memoized with `useMemo` on `[messages]` so it only recomputes when
 * the messages array reference changes (which the store guarantees happens
 * only when content actually changes, not on unrelated re-renders).
 */
function useGroupPositions(messages: ChatMessage[]): Map<string, "first" | "middle" | "last" | "single" | undefined> {
  return React.useMemo(() => {
    const positions = new Map<string, "first" | "middle" | "last" | "single" | undefined>();

    // First pass: collect indices for each groupId.
    const groupIndices = new Map<string, number[]>();
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (!msg.groupId) continue;
      const arr = groupIndices.get(msg.groupId);
      if (arr) {
        arr.push(i);
      } else {
        groupIndices.set(msg.groupId, [i]);
      }
    }

    // Second pass: assign positions.
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (!msg.groupId) {
        continue; // undefined position
      }
      const indices = groupIndices.get(msg.groupId)!;
      if (indices.length <= 1) {
        positions.set(msg.id, "single");
      } else if (i === indices[0]) {
        positions.set(msg.id, "first");
      } else if (i === indices[indices.length - 1]) {
        positions.set(msg.id, "last");
      } else {
        positions.set(msg.id, "middle");
      }
    }

    return positions;
  }, [messages]);
}

export function MessageList({ messages, onRegenerate }: MessageListProps) {
  const groupPositions = useGroupPositions(messages);

  // PERF: Find the last assistant message index once (O(n) single pass)
  // instead of on every render's map callback.
  const lastAssistantIndex = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") return i;
    }
    return -1;
  }, [messages]);

  return (
    <div className="space-y-0">
      {messages.map((message, index) => {
        const groupPos = groupPositions.get(message.id);
        const isLastInGroup = !groupPos || groupPos === "last" || groupPos === "single";

        return (
          <div key={message.id} className="animate-message-in">
            <MessageItem
              message={message}
              groupPosition={groupPos}
              showFooter={isLastInGroup}
              onRegenerate={
                onRegenerate && index === lastAssistantIndex && !message.isStreaming
                  ? () => onRegenerate(message.id)
                  : undefined
              }
            />
          </div>
        );
      })}
    </div>
  );
}
