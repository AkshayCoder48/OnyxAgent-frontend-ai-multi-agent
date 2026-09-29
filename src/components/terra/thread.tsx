"use client";

import { useEffect, useRef } from "react";
import { Feather } from "lucide-react";
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

export function Thread() {
  const active = useTerra((s) => s.conversations.find((c) => c.id === s.activeId));
  const booted = useTerra((s) => s.booted);
  const sending = useTerra((s) => s.sending);
  const send = useTerra((s) => s.send);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevRef = useRef<{
    id: string;
    count: number;
    sending: boolean;
    lastLength: string;
  } | null>(null);

  const activeId = active?.id;
  const messageCount = active?.messages.length ?? 0;
  const lastMessage = active?.messages[messageCount - 1];
  // Track streaming growth so the thread follows the reply as it arrives.
  const lastLength = lastMessage ? `${lastMessage.role}:${lastMessage.text.length}:${lastMessage.reasoning?.length ?? 0}` : "";

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { id: activeId ?? "", count: messageCount, sending, lastLength };
    if (!prev) return;
    if (prev.id !== (activeId ?? "")) {
      topRef.current?.scrollIntoView({ block: "start" });
      return;
    }
    const grew = messageCount > prev.count;
    const startedTyping = !prev.sending && sending;
    const streamed = prev.lastLength !== lastLength;
    if ((grew || startedTyping || streamed) && messageCount > 0) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
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
              />
            ),
          )}
          <div ref={bottomRef} aria-hidden className="scroll-mb-36" />
        </div>
      )}
    </div>
  );
}
