"use client";

/**
 * Business Mode — chat view (Task 4-b).
 *
 * Full-height transcript: scrolling message column (auto-follows the stream
 * only while the user is near the bottom, with a jump-to-latest pill when
 * they scroll away), a slim progress strip + Stop control while a swarm turn
 * runs, and the composer with @mention support. Sends are fire-and-forget —
 * sendBusinessMessage resolves when the whole turn finishes.
 */

import * as React from "react";
import { ArrowDown, Loader2, Square } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useBusinessStore } from "@/stores/business-store";
import { bt } from "@/lib/business/ui-text";
import { cancelBusinessTurn, sendBusinessMessage } from "@/lib/business/orchestrator";
import { AgentLogo } from "./agent-logos";
import { BusinessChatInput } from "./business-chat-input";
import { BusinessMessageItem } from "./business-message-item";

/** Distance from the bottom (px) that still counts as "following". */
const NEAR_BOTTOM_PX = 120;
/** Goals shown as starter chips. */
const MAX_GOAL_CHIPS = 3;

export function BusinessChat() {
  const businessId = useBusinessStore((s) => s.activeBusinessId);
  const business = useBusinessStore((s) => s.activeBusiness);
  const messages = useBusinessStore((s) => s.chatMessages);
  const turnRunning = useBusinessStore((s) => s.turnRunning);
  const tasks = useBusinessStore((s) => s.tasks);

  const reduceMotion = useReducedMotion();
  const entrance = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 6 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.2, ease: [0.32, 0.72, 0, 1] as const },
      };

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const atBottomRef = React.useRef(true);
  const [showJump, setShowJump] = React.useState(false);

  // Follow the stream only while the user is near the bottom.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el || !atBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    atBottomRef.current = nearBottom;
    setShowJump(!nearBottom);
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = true;
    setShowJump(false);
    el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
  };

  /** Send — resolves when the whole swarm turn finishes (fire-and-forget). */
  const send = React.useCallback(
    async (content: string) => {
      const id = businessId;
      if (!id || !content.trim() || turnRunning) return;
      try {
        await sendBusinessMessage(id, content);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [businessId, turnRunning],
  );

  const stop = React.useCallback(async () => {
    const id = businessId;
    if (!id) return;
    try {
      await cancelBusinessTurn(id);
      toast(bt("toast.turnCancelled"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [businessId]);

  // Empty-state starter chips: first active/proposed goals + a backlog task.
  const goalChips = (business?.goals ?? [])
    .filter((g) => g.status === "active" || g.status === "proposed")
    .slice(0, MAX_GOAL_CHIPS);
  const backlogTask = tasks.find((t) => t.status === "backlog");

  const hasMessages = messages.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Transcript */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="scrollbar-thin relative h-full overflow-y-auto"
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
            {hasMessages ? (
              messages.map((message) => (
                <motion.div key={message.id} {...entrance}>
                  <BusinessMessageItem message={message} />
                </motion.div>
              ))
            ) : (
              <motion.div
                {...entrance}
                className="flex flex-col items-center justify-center px-2 py-12 text-center"
              >
                <AgentLogo logo="orb" label={bt("ws.mainAgent")} className="size-14 p-2.5" />
                <h2 className="mt-4 text-base font-semibold">{bt("chat.emptyTitle")}</h2>
                <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
                  {bt("chat.emptyHint")}
                </p>
                {(goalChips.length > 0 || backlogTask) && (
                  <div className="mt-6 flex max-w-md flex-wrap justify-center gap-2">
                    {goalChips.map((goal) => (
                      <button
                        key={goal.id}
                        type="button"
                        disabled={turnRunning}
                        onClick={() => void send(`Help me make progress on: ${goal.title}`)}
                        className="max-w-[280px] truncate rounded-full border bg-card px-3.5 py-2 text-xs font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {goal.title}
                      </button>
                    ))}
                    {backlogTask && (
                      <button
                        key={backlogTask.id}
                        type="button"
                        disabled={turnRunning}
                        onClick={() => void send(`Work on: ${backlogTask.title}`)}
                        className="max-w-[280px] truncate rounded-full border bg-card px-3.5 py-2 text-xs font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {backlogTask.title}
                      </button>
                    )}
                  </div>
                )}
              </motion.div>
            )}
          </div>
        </div>

        {/* Jump-to-latest pill — only while scrolled away from the bottom */}
        {showJump && hasMessages && (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label="Scroll to latest messages"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border bg-background/95 p-2 text-muted-foreground shadow-md transition-colors hover:text-foreground"
          >
            <ArrowDown className="size-4" aria-hidden />
          </button>
        )}
      </div>

      {/* Input area */}
      <div className="border-t bg-background">
        <div className="mx-auto w-full max-w-3xl px-4 py-3">
          {turnRunning && (
            <div className="mb-2.5 flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
              <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{bt("chat.turnRunning")}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void stop()}
                className="h-8 shrink-0 gap-1.5 px-2.5 text-destructive hover:text-destructive"
              >
                <Square className="size-3 fill-current" aria-hidden />
                {bt("chat.stop")}
              </Button>
            </div>
          )}
          <BusinessChatInput
            disabled={turnRunning}
            running={turnRunning}
            onSend={(content) => void send(content)}
            onStop={() => void stop()}
          />
        </div>
      </div>
    </div>
  );
}
