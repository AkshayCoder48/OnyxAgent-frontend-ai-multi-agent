"use client";

import * as React from "react";
import type { ChatMessage } from "@/types";
import { MessageItem } from "./message-item";
import { RESEARCH_TOOL_NAMES } from "./research-panel";
import { SelectionToolbar } from "@/components/assistant-ui/elements";
import { useQuoteStore } from "@/stores";

interface MessageListProps {
  messages: ChatMessage[];
  /** Wired to the INLINE todo plan panel's "Cut" button. */
  onTodoDismiss?: () => void;
  /** Message-action row (assistant-ui "Message actions"): re-run the turn
   *  that produced an assistant message. */
  onRegenerate?: (assistantMessageId: string) => void;
  /** User-message actions: edit a sent prompt + re-run the turn from it. */
  onEditUserMessage?: (userMessageId: string, newContent: string) => void;
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

/** True when a message carries a research/todo tool part. */
function hasResearchPart(message: ChatMessage): boolean {
  return (message.parts ?? []).some(
    (p) => p.type === "tool" && p.toolCall && RESEARCH_TOOL_NAMES.has(p.toolCall.name),
  );
}

// ── PROGRESSIVE THREAD MOUNT (tap-lag fix) ─────────────────────────────
// Opening a long conversation used to mount EVERY message in ONE React
// commit — an 80-message thread measured a 517ms main-thread long task just
// for the initial paint (markdown parse + syntax highlighting + tool cards;
// multi-SECOND on low-end mobile), which made every button tap feel frozen
// right after switching chats. The list now mounts the newest WINDOW
// instantly and admits older rows above it in idle-time chunks — the
// expensive parse work is spread across frames the user is already reading,
// never blocking the first paint or an in-flight tap.
const MOUNT_WINDOW_INITIAL = 12;
const MOUNT_CHUNK = 10;

/** requestIdleCallback with a Safari-safe fallback. */
function scheduleIdle(cb: () => void): () => void {
  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    const id = window.requestIdleCallback(cb, { timeout: 400 });
    return () => window.cancelIdleCallback(id);
  }
  const t = setTimeout(cb, 32);
  return () => clearTimeout(t);
}

function useProgressiveMount(
  messages: ChatMessage[],
): { visibleCount: number; total: number } {
  const total = messages.length;
  // Reset keyed on the thread's FIRST message id — a conversation switch (or
  // clear) changes it, while streaming appends/mutations keep it stable.
  const firstId = messages[0]?.id ?? "";
  const [state, setState] = React.useState<{ firstId: string; count: number }>(() => ({
    firstId,
    count: MOUNT_WINDOW_INITIAL,
  }));
  // RENDER-TIME RESET (React's "adjust state when a prop changes" pattern):
  // resetting in an effect would let the FIRST commit of a new thread run
  // with the PREVIOUS thread's mounted count — a switch 80→80 mounted all 80
  // rows of the new conversation in one blocking commit (the exact jank this
  // hook exists to remove). The render-time setState re-renders before the
  // commit, so the new thread's first paint is always just the window.
  if (state.firstId !== firstId) {
    setState({ firstId, count: MOUNT_WINDOW_INITIAL });
  }
  const mountedCount = state.firstId === firstId ? state.count : MOUNT_WINDOW_INITIAL;
  // Short threads mount whole — no progressive machinery at all.
  const visibleCount =
    total <= MOUNT_WINDOW_INITIAL + MOUNT_CHUNK ? total : Math.min(mountedCount, total);
  // Admit older rows in idle chunks until the whole thread is mounted.
  React.useEffect(() => {
    if (visibleCount >= total) return;
    return scheduleIdle(() => {
      setState((s) =>
        s.firstId !== firstId
          ? s
          : { firstId: s.firstId, count: Math.min(s.count + MOUNT_CHUNK, total) },
      );
    });
  }, [visibleCount, total, firstId]);
  return { visibleCount, total };
}

export function MessageList({ messages, onTodoDismiss, onRegenerate, onEditUserMessage }: MessageListProps) {
  const groupPositions = useGroupPositions(messages);
  const setQuote = useQuoteStore((s) => s.setQuote);
  // PROGRESSIVE MOUNT: the newest `visibleCount` rows render fully; older
  // rows (above the initial viewport) render cheap skeletons until idle
  // chunks admit them. Keeps the open-a-long-chat commit under a frame.
  const { visibleCount } = useProgressiveMount(messages);
  const hiddenCount = messages.length - visibleCount;

  // ENTRANCE-ANIMATION GATE (perf PRD): hydrated history must not replay
  // entrance animations — a 100-message thread used to mount with 100
  // concurrent animate-message-in transitions PLUS the per-message blur
  // bubble entrances on every conversation switch / reload (a visible
  // first-paint stall on low-end devices). Signal: `isTemporaryId` — only
  // messages created during a LIVE turn carry it; DB-hydrated rows arrive
  // with `false` (see conversation-to-chat.ts). This survives the switch
  // sequence (store paints the new conversation's history AFTER this list
  // mounts — an index/mount-time baseline would wrongly animate that
  // batch, an id-identity gate cannot either; the temp-id flag is exact).
  const shouldAnimate = (m: ChatMessage) => m.isTemporaryId === true;

  // Todo plan ownership — the LAST assistant message that ran the todo
  // tool owns the inline plan panel. The plan is a live, conversation-level
  // entity (keyed by conversation in the research store), so rendering it
  // at the position where that message's todo tool ran puts the checklist
  // exactly where it was generated — instead of a panel stuck at the bottom
  // of the thread. Older messages with research parts render nothing extra.
  const todoOwnerId = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (msg.role === "assistant" && hasResearchPart(msg)) return msg.id;
    }
    return null;
  }, [messages]);

  const visibleMessages = React.useMemo(
    () => messages.slice(hiddenCount),
    [messages, hiddenCount],
  );

  return (
    <div className="space-y-0">
      {/* QUOTE SELECTION TOOLBAR (assistant-ui "Quote" element): one
          instance for the whole transcript — it portals to body and appears
          above any text selected inside an assistant message
          ([data-quoteable]). Quoting carries the text into the composer. */}
      <SelectionToolbar onQuote={setQuote} />
      {hiddenCount > 0 &&
        // Skeletons for not-yet-admitted historical rows: fixed estimated
        // height + content-visibility — they cost nothing to keep, and the
        // idle chunks replace them with real content within a second or two.
        Array.from({ length: hiddenCount }, (_, i) => (
          <div
            key={`skeleton-${messages[i]?.id ?? i}`}
            className="mb-row-cv"
            style={{ minHeight: 96 }}
            aria-hidden="true"
          />
        ))}
      {visibleMessages.map((message, index) => {
        const groupPos = groupPositions.get(message.id);
        const prev = visibleMessages[index - 1];
        const animate = shouldAnimate(message);

        return (
          // STABLE RENDER KEY: the message's temp id survives the end-of-turn
          // `message_saved` id swap (see ChatMessage.renderKey), so finalizing
          // a turn never remounts the message subtree — GenUI cards keep
          // their DOM identity and iframes don't reload at completion.
          //
          // `.mb-row-cv` (content-visibility: auto): the browser skips
          // layout + paint for offscreen rows — long threads only pay for
          // the visible window (+ scroll anchoring). `auto` intrinsic-size
          // lets Chrome remember each row's real height after first paint.
          //
          // `msg-<id>` DOM anchor (Task 2-b): the global search dialog + the
          // project drawer's message hits scroll to + briefly highlight the
          // exact message via this id (revealMessageAnchor).
          <div key={message.renderKey ?? message.id} id={`msg-${message.id}`} className="mb-row-cv">
            {isNewDay(prev, message) && (
              <DateSeparator date={new Date(message.timestamp)} />
            )}
            <div className={animate ? "animate-message-in" : undefined}>
              <MessageItem
                message={message}
                groupPosition={groupPos}
                showTodoPanel={!!todoOwnerId && message.id === todoOwnerId}
                animateEntrance={animate}
                onTodoDismiss={onTodoDismiss}
                onRegenerate={onRegenerate}
                onEditUserMessage={onEditUserMessage}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
