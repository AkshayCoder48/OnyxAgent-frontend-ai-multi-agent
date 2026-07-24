"use client";

import { useState, useEffect } from "react";
import { ChevronDown, Loader2, CheckCircle2, XCircle, Clock, AlertCircle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SubagentStatus, SubagentMessage, SubagentTaskStatus } from "@/types";

/**
 * SubagentPanel — renders live status + messages from subagents (background
 * AI tasks). Shown when subagent events arrive via the WS stream. Renders as
 * a compact glassmorphic panel that slides in from the left, with a mobile-
 * friendly full-width layout on small screens.
 *
 * The panel is driven by window events ("subagent_status" / "subagent_message")
 * so it can be mounted anywhere in the app without prop drilling. The agent
 * runtime dispatches these events when subagent tasks start/complete.
 */

interface SubagentTask extends SubagentStatus {
  messages: SubagentMessage[];
}

const STATUS_ICONS: Record<SubagentTaskStatus, typeof Loader2> = {
  pending: Clock,
  running: Loader2,
  waiting_for_answer: AlertCircle,
  completed: CheckCircle2,
  failed: XCircle,
  cancelled: XCircle,
  retrying: Loader2,
};

const STATUS_COLORS: Record<SubagentTaskStatus, string> = {
  pending: "text-muted-foreground",
  running: "text-primary",
  waiting_for_answer: "text-amber-500",
  completed: "text-emerald-500",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
  retrying: "text-primary",
};

export function SubagentPanel() {
  const [tasks, setTasks] = useState<Map<string, SubagentTask>>(new Map());
  const [dismissed, setDismissed] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const onStatus = (e: Event) => {
      const detail = (e as CustomEvent<SubagentStatus>).detail;
      if (!detail?.task_id) return;
      setTasks((prev) => {
        const next = new Map(prev);
        const existing = next.get(detail.task_id);
        next.set(detail.task_id, {
          ...detail,
          messages: existing?.messages ?? [],
        });
        return next;
      });
      setDismissed(false);
    };

    const onMessage = (e: Event) => {
      const detail = (e as CustomEvent<SubagentMessage>).detail;
      if (!detail?.task_id) return;
      setTasks((prev) => {
        const next = new Map(prev);
        const existing = next.get(detail.task_id);
        if (existing) {
          next.set(detail.task_id, {
            ...existing,
            messages: [...existing.messages, detail],
          });
        }
        return next;
      });
    };

    window.addEventListener("subagent_status", onStatus as EventListener);
    window.addEventListener("subagent_message", onMessage as EventListener);
    return () => {
      window.removeEventListener("subagent_status", onStatus as EventListener);
      window.removeEventListener("subagent_message", onMessage as EventListener);
    };
  }, []);

  // Auto-remove completed/failed tasks after 10 seconds.
  useEffect(() => {
    const interval = setInterval(() => {
      setTasks((prev) => {
        const next = new Map(prev);
        const now = Date.now();
        for (const [id, task] of next) {
          if (
            (task.status === "completed" || task.status === "failed" || task.status === "cancelled") &&
            task.messages.length > 0
          ) {
            const lastMsg = task.messages[task.messages.length - 1];
            if (lastMsg?.timestamp) {
              const age = now - new Date(lastMsg.timestamp).getTime();
              if (age > 10_000) next.delete(id);
            }
          }
        }
        return next;
      });
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const taskList = Array.from(tasks.values());
  if (taskList.length === 0 || dismissed) return null;

  const activeCount = taskList.filter(
    (t) => t.status === "running" || t.status === "pending" || t.status === "retrying",
  ).length;

  return (
    <div className="subagent-slide-in glass-card border-border rounded-xl border p-3">
      {/* Header — clickable to collapse/expand on mobile */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
          aria-label={collapsed ? "Expand subagent panel" : "Collapse subagent panel"}
        >
          <div className="relative shrink-0">
            <Loader2 className={cn("h-3.5 w-3.5", activeCount > 0 ? "animate-spin text-primary" : "text-muted-foreground")} />
          </div>
          <span className="text-xs font-semibold truncate">
            {activeCount > 0 ? `${activeCount} subagent${activeCount !== 1 ? "s" : ""} working` : "Subagents finished"}
          </span>
          <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", collapsed && "-rotate-90")} />
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="text-muted-foreground hover:text-foreground hover:bg-foreground/5 rounded p-1 transition-colors shrink-0"
          aria-label="Dismiss subagent panel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Task list — hidden when collapsed, scrollable when expanded */}
      {!collapsed && (
        <div className="max-h-64 space-y-2 overflow-y-auto scrollbar-glass mt-2">
        {taskList.map((task) => {
          const Icon = STATUS_ICONS[task.status] ?? Clock;
          const colorClass = STATUS_COLORS[task.status] ?? "text-muted-foreground";
          return (
            <div
              key={task.task_id}
              className="bg-background/40 rounded-lg border border-border/50 p-2.5"
            >
              {/* Task header */}
              <div className="flex items-center gap-2">
                <Icon
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    colorClass,
                    (task.status === "running" || task.status === "retrying") && "animate-spin",
                  )}
                />
                <span className="text-xs font-medium truncate flex-1">
                  {task.subagent_name}
                </span>
                <span className={cn("text-[10px] font-mono uppercase tracking-wider", colorClass)}>
                  {task.status.replace(/_/g, " ")}
                </span>
              </div>
              {/* Description */}
              {task.description && (
                <p className="mt-1 pl-5 text-[11px] text-muted-foreground line-clamp-2">
                  {task.description}
                </p>
              )}
              {/* Latest message (if any) */}
              {task.messages.length > 0 && (
                <div className="mt-1.5 pl-5 space-y-1">
                  {task.messages.slice(-2).map((msg, i) => (
                    <p
                      key={i}
                      className={cn(
                        "text-[11px] leading-relaxed",
                        msg.type === "error" && "text-destructive/80",
                        msg.type === "result" && "text-emerald-600 dark:text-emerald-400",
                        (msg.type === "info" || msg.type === "steering" || msg.type === "question") && "text-muted-foreground",
                      )}
                    >
                      {msg.type === "error" && "⚠ "}
                      {msg.type === "result" && "✓ "}
                      {msg.text}
                    </p>
                  ))}
                </div>
              )}
              {/* Error */}
              {task.error && (
                <p className="mt-1 pl-5 text-[11px] text-destructive/80 line-clamp-2">
                  {task.error}
                </p>
              )}
            </div>
          );
        })}
        </div>
      )}
    </div>
  );
}
