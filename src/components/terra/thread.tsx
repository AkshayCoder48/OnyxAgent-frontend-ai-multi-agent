"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, Feather } from "lucide-react";
import { EMPTY_STATE_SUGGESTIONS } from "./seed";
import { useTerra } from "./store";
import { AssistantTurn, UserCard } from "./turns";

function DateSeparator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3" role="separator" aria-label={label}>
      <span className="h-px flex-1 bg-hairline" aria-hidden />
      <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-muted">
        {label}
      </span>
      <span className="h-px flex-1 bg-hairline" aria-hidden />
    </div>
  );
}

function EmptyState({ onSuggest }: { onSuggest: (text: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 py-10 text-center">
      <span
        className="flex h-14 w-14 items-center justify-center rounded-full border border-terra-soft-border bg-terra-soft"
        aria-hidden
      >
        <Feather className="h-6 w-6 text-terra" />
      </span>
      <h2 className="font-serif text-[26px] font-semibold text-ink">How can I help today?</h2>
      <div className="flex max-w-md flex-wrap items-center justify-center gap-2.5">
        {EMPTY_STATE_SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onSuggest(suggestion)}
            className="rounded-full border border-hairline bg-background px-4 py-2 text-sm text-ink-soft transition-colors hover:border-terra-soft-border hover:bg-terra-soft hover:text-ink"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

/** One-frame shell while the localStorage snapshot is restored.
 *  Keeps first paint from flashing the seed data. */
function BootSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col gap-6 px-4 py-10 sm:px-6" aria-hidden>
      <div className="h-3 w-40 rounded-full bg-paper" />
      <div className="space-y-3 pt-4">
        <div className="ml-auto h-12 w-2/3 rounded-2xl rounded-tr-sm bg-terra-soft/60" />
        <div className="h-3 w-28 rounded-full bg-paper" />
        <div className="space-y-2 pt-3">
          <div className="h-3 w-full rounded-full bg-paper" />
          <div className="h-3 w-11/12 rounded-full bg-paper" />
          <div className="h-3 w-3/4 rounded-full bg-paper" />
        </div>
      </div>
    </div>
  );
}

/** Distance from the bottom (px) that still counts as "pinned to latest". */
const PIN_THRESHOLD = 140;

export function Thread() {
  const appMode = useTerra((s) => s.appMode);
  const active = useTerra((s) =>
    s.conversations.find((c) => c.id === (s.appMode === "code" ? s.activeCodeId : s.activeId)),
  );
  const booted = useTerra((s) => s.booted);
  const sending = useTerra((s) => s.sending);
  const send = useTerra((s) => s.send);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const prevRef = useRef<{
    id: string;
    count: number;
    sending: boolean;
    lastLength: string;
  } | null>(null);
  /** True while the view rides along with the latest message. The user
   *  scrolling up unpins it — streaming then grows the thread silently
   *  instead of yanking the viewport back down on every flush. */
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const activeId = active?.id;
  // OnyxCode tool cards get the workspace id so their actions work.
  const workspaceId = appMode === "code" && active?.mode === "code" ? active.id : undefined;
  const messageCount = active?.messages.length ?? 0;
  const lastMessage = active?.messages[messageCount - 1];
  // Track streaming growth so the thread follows the reply as it arrives.
  const lastLength = lastMessage ? `${lastMessage.role}:${lastMessage.text.length}:${lastMessage.reasoning?.length ?? 0}` : "";

  /* Locate the scrolling ancestor once per mount (agent page and OnyxCode
   * both wrap the thread in a .terra-scroll container). */
  useEffect(() => {
    const scroller =
      (topRef.current?.closest?.(".terra-scroll") as HTMLElement | null) ??
      (bottomRef.current?.closest?.(".terra-scroll") as HTMLElement | null);
    if (!scroller) return;
    scrollerRef.current = scroller;
    const onScroll = () => {
      const pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < PIN_THRESHOLD;
      pinnedRef.current = pinned;
      setShowJump(!pinned);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      scrollerRef.current = null;
    };
  }, []);

  const scrollToBottom = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // Instant (not smooth): during streaming this runs on every flush, and
    // restarting a smooth animation 12×/s is what made scrolling feel dead.
    // The scroll listener re-syncs the pinned state + jump pill on its own.
    pinnedRef.current = true;
    scroller.scrollTop = scroller.scrollHeight;
  };

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { id: activeId ?? "", count: messageCount, sending, lastLength };
    if (!prev) return;
    if (prev.id !== (activeId ?? "")) {
      // Switched conversation — snap to the top, then re-sync the pin state
      // from the settled scroll position (async, layout-dependent).
      pinnedRef.current = true;
      topRef.current?.scrollIntoView({ block: "start" });
      requestAnimationFrame(() => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        const pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < PIN_THRESHOLD;
        pinnedRef.current = pinned;
        setShowJump(!pinned);
      });
      return;
    }
    const grew = messageCount > prev.count;
    const startedTyping = !prev.sending && sending;
    const streamed = prev.lastLength !== lastLength;
    if (!(grew || startedTyping || streamed) || messageCount === 0) return;
    // The user's own new message always re-pins the view; assistant growth
    // only follows when the user is already at (or near) the bottom.
    if (grew && lastMessage?.role === "user") pinnedRef.current = true;
    if (pinnedRef.current) scrollToBottom();
  }, [activeId, messageCount, sending, lastLength]);

  if (!booted) return <BootSkeleton />;
  if (!active) return null;

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col px-4 py-8 sm:px-6">
      <div ref={topRef} aria-hidden className="scroll-mt-14" />
      {active.messages.length === 0 ? (
        <EmptyState onSuggest={(text) => void send(text)} />
      ) : (
        <div className="space-y-8">
          <DateSeparator label={active.separator} />
          {active.messages.map((message, index) =>
            message.role === "user" ? (
              <UserCard key={message.id} message={message} />
            ) : (
              <AssistantTurn
                key={message.id}
                message={message}
                isLast={index === active.messages.length - 1}
                workspaceId={workspaceId}
              />
            ),
          )}
          <div ref={bottomRef} aria-hidden className="scroll-mb-36" />
        </div>
      )}

      {/* Floating "back to latest" pill — appears once the user scrolls away
       *  from the live end of the thread. Sticks to the scroll viewport. */}
      <AnimatePresence>
        {showJump && active.messages.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className={`
              pointer-events-none sticky z-10 mt-2 flex justify-center
              ${appMode === "code" ? "bottom-4" : "bottom-32"}
            `.trim()}
          >
            <button
              type="button"
              onClick={scrollToBottom}
              className="pointer-events-auto inline-flex h-9 items-center gap-1.5 rounded-full border border-terra-soft-border bg-background/95 px-4 text-[12px] font-medium text-terra-deep shadow-[0_4px_16px_rgba(26,26,26,0.14)] backdrop-blur transition-colors hover:bg-terra-soft"
            >
              <ArrowDown className="h-3.5 w-3.5" aria-hidden />
              {sending ? "Jump to latest" : "Back to latest"}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
