"use client";

// ============================================================================
// RunningExecutionsSection — the sidebar's live "Running" list (spec §13:
// "Global Running Executions"). Reads the ExecutionHub registry (module-
// level agent runtime): every row is a REAL agent execution that keeps
// streaming in the background — switching chats, opening settings, or
// navigating anywhere never aborts it. Clicking a row selects its
// conversation, which re-subscribes the chat UI to the execution's store
// (missed events are already in it — no restart, no duplicate run).
// ============================================================================

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { Conversation } from "@/types";
import { useRunningExecutions } from "@/lib/agent/execution-hub";

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

export function RunningExecutionsSection({
  conversations,
  currentConversationId,
  onSelect,
}: {
  conversations: Conversation[];
  currentConversationId: string | null;
  onSelect: (id: string) => void;
}) {
  const running = useRunningExecutions();
  // 1s ticker while anything runs (elapsed badges). `now` stays null until
  // the first effect tick (render purity: Date.now never runs in render).
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const t0 = setTimeout(update, 0);
    const iv = running.length > 0 ? setInterval(update, 1000) : null;
    return () => {
      clearTimeout(t0);
      if (iv) clearInterval(iv);
    };
  }, [running.length]);

  if (running.length === 0) return null;

  return (
    <div className="px-3 pb-2" data-testid="running-executions">
      <div className="text-foreground/40 px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider">
        Running
      </div>
      <div className="max-h-40 overflow-y-auto">
        {running.map((exec) => {
          const title =
            conversations.find((c) => c.id === exec.conversationId)?.title?.trim() ||
            "Working…";
          const active = exec.conversationId === currentConversationId;
          return (
            <button
              key={exec.id}
              type="button"
              onClick={() => exec.conversationId && onSelect(exec.conversationId)}
              aria-label={`Open running chat: ${title}`}
              className={`group flex min-h-[40px] w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors ${
                active ? "bg-foreground/[0.06]" : "hover:bg-foreground/5"
              }`}
            >
              <Loader2
                className="h-4 w-4 shrink-0 animate-spin text-primary"
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate text-left text-foreground/80">
                {title}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-foreground/40">
                {now === null ? "" : formatElapsed(now - exec.startedAt)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
