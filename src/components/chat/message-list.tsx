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

/** Terra date separator: "TODAY · 2:14 PM" flanked by hairlines. */
function DateSeparator({ date }: { date: Date }) {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = Math.floor(
    (startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000,
  );
  const dayLabel =
    dayDiff <= 0
      ? "Today"
      : dayDiff === 1
        ? "Yesterday"
        : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const timeLabel = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return (
    <div className="flex items-center gap-3 py-3 first:pt-0" role="separator" aria-label={`${dayLabel}, ${timeLabel}`}>
      <span className="border-border flex-1 border-t" />
      <span className="text-muted-foreground/70 font-mono text-[10px] font-medium tracking-[0.16em] uppercase">
        {dayLabel} · {timeLabel}
      </span>
      <span className="border-border flex-1 border-t" />
    </div>
  );
}

/** True when two messages fall on different calendar days (or first in list). */
function isNewDay(prev: ChatMessage | undefined, current: ChatMessage): boolean {
  if (!prev) return true;
  const a = new Date(prev.timestamp);
  const b = new Date(current.timestamp);
  return (
    a.getFullYear() !== b.getFullYear() ||
    a.getMonth() !== b.getMonth() ||
    a.getDate() !== b.getDate()
  );
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
        const prev = messages[index - 1];

        return (
          <div key={message.id}>
            {isNewDay(prev, message) && (
              <DateSeparator date={new Date(message.timestamp)} />
            )}
            <div className="animate-message-in">
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
          </div>
        );
      })}
    </div>
  );
}
