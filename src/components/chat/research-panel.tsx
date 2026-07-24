"use client";

import { useEffect, useRef, useState } from "react";
import { useResearchStore } from "@/stores";
import type { ResearchTodo } from "@/types";
import { Card, Progress, Button } from "@/components/ui";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleDashed,
  Loader2,
  Scissors,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Deep-research / todo tool names that should be hidden from the message
 * transcript and surfaced in this panel instead. Mirrors the backend
 * `pydantic_ai_todo` toolset names.
 */
export const RESEARCH_TOOL_NAMES = new Set([
  "read_todos",
  "write_todos",
  "add_todo",
  "update_todo_status",
  "update_todo_statuses",
  "remove_todo",
  "add_subtask",
  "set_dependency",
  "get_available_tasks",
]);

const EMPTY_TODOS: ResearchTodo[] = [];

interface ResearchPanelProps {
  /** Optional turn id (defaults to the store's currentTurnId). */
  turnId?: string;
  /** Called when the user clicks the "Cut" button — the parent wires this to
   *  the WebSocket so the backend also knows to suppress further emits. */
  onDismiss?: () => void;
}

/**
 * Sticky plan panel rendered above the chat input — the same slot as
 * `QuestionPrompt`. Shows the live todo list the agent is working through,
 * with status icons, a progress bar, and a "Cut" button to dismiss the panel.
 *
 * The agent emits `todo_event` WS frames for every mutation (created /
 * updated / status_changed / completed / deleted); the `use-chat` hook
 * forwards them to `useResearchStore.applyTodoEvent`, which this panel reads.
 */
export function ResearchPanel({ turnId, onDismiss }: ResearchPanelProps) {
  const currentTurnId = useResearchStore((s) => s.currentTurnId);
  const activeTurnId = turnId ?? currentTurnId ?? "default";
  const turn = useResearchStore((s) => s.byTurn[activeTurnId]);
  const todos = turn?.todos ?? EMPTY_TODOS;
  const dismissed = turn?.dismissed ?? false;

  const todoTotal = todos.length;
  const todoDone = todos.filter((t) => t.status === "completed").length;
  const anyTodoActive = todos.some(
    (t) => t.status === "in_progress" || t.status === "pending",
  );
  const stopped = false;
  const done = stopped || (todoTotal > 0 && !anyTodoActive);
  const busy = !done;

  const [expanded, setExpanded] = useState(true);
  const wasDone = useRef(false);
  useEffect(() => {
    if (done && !wasDone.current) setExpanded(false);
    else if (!done && wasDone.current) setExpanded(true);
    wasDone.current = done;
  }, [done]);

  // Hide when there are no todos OR when the user has dismissed the panel
  // (the store re-arms `dismissed = false` on the next event).
  if (todoTotal === 0 || dismissed) return null;

  const counter = todoTotal > 0 ? `${todoDone}/${todoTotal} steps` : "Planning…";
  const pct = todoTotal > 0 ? Math.round((todoDone / todoTotal) * 100) : 0;
  const title = "Plan";

  return (
    <Card className="bg-muted/40 step-card-in overflow-hidden py-0">
      <div className="flex items-center gap-1 px-2 pt-2.5 pb-0.5">
        <span className="text-muted-foreground inline-flex items-center gap-1.5 font-mono text-[10px] tracking-wider uppercase">
          <Sparkles className="h-3 w-3" />
          {title}
        </span>
        <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
          {counter}
        </span>
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:bg-foreground/10 hover:text-foreground h-6 w-6"
          onClick={() => onDismiss?.()}
          title="Cut (dismiss plan panel)"
          aria-label="Dismiss plan panel"
        >
          <Scissors className="h-3.5 w-3.5" />
        </Button>
      </div>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="hover:bg-foreground/[0.03] flex w-full items-center gap-2 px-4 pb-2.5 pt-1 text-left transition-colors"
      >
        {busy ? (
          <Loader2 className="text-primary h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        )}
        {todoTotal > 0 && <Progress value={pct} className="mx-1 h-1.5 min-w-0 flex-1" />}
        <span className="flex-1" />
        {expanded ? (
          <ChevronUp className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronDown className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-4">
          <ResearchChecklist todos={todos} />
        </div>
      )}
    </Card>
  );
}

const TODO_STATUS_BORDER: Record<ResearchTodo["status"], string> = {
  pending: "border-border/50",
  in_progress: "border-primary",
  completed: "border-emerald-500/60",
  blocked: "border-amber-500",
};

function StatusIcon({ status }: { status: ResearchTodo["status"] }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />;
    case "in_progress":
      return <Loader2 className="text-primary h-3.5 w-3.5 shrink-0 animate-spin" />;
    case "blocked":
      return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />;
    default:
      return <Circle className="text-muted-foreground/40 h-3.5 w-3.5 shrink-0" />;
  }
}

function ResearchChecklist({ todos }: { todos: ResearchTodo[] }) {
  if (todos.length === 0) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <CircleDashed className="h-3.5 w-3.5 animate-spin" />
        Planning…
      </div>
    );
  }

  const roots = todos.filter((t) => !t.parent_id);
  const childrenOf = (id: string) => todos.filter((t) => t.parent_id === id);

  const renderTodo = (todo: ResearchTodo, depth: number, index: number) => (
    <div key={todo.id} style={{ animation: `todo-enter 0.22s ease-out ${index * 40}ms both` }}>
      <div
        className={cn(
          "flex items-start gap-2 rounded-md border-l-2 px-2 py-1 text-sm transition-colors duration-300",
          TODO_STATUS_BORDER[todo.status],
          todo.status === "in_progress" && "bg-primary/[0.05]",
          depth > 0 && "ml-5",
        )}
        style={depth > 1 ? { marginLeft: `${depth * 1.25}rem` } : undefined}
      >
        <span className="mt-0.5 shrink-0">
          <StatusIcon status={todo.status} />
        </span>
        <span
          className={cn(
            "min-w-0 leading-snug",
            todo.status === "completed" && "text-muted-foreground line-through",
            todo.status === "in_progress" && "text-foreground font-medium",
            todo.status === "blocked" && "text-amber-700 dark:text-amber-400",
            todo.status === "pending" && "text-muted-foreground",
          )}
        >
          {todo.status === "in_progress" && todo.active_form ? todo.active_form : todo.content}
        </span>
      </div>
      {childrenOf(todo.id).map((child, ci) => renderTodo(child, depth + 1, index * 10 + ci))}
    </div>
  );

  const completedCount = todos.filter((t) => t.status === "completed").length;
  const totalCount = todos.length;

  return (
    <div className="space-y-1">
      <div className="text-muted-foreground mb-2 flex items-center justify-between font-mono text-[10px] tracking-wider uppercase">
        <span>Plan</span>
        <span className="tabular-nums">
          {completedCount}/{totalCount}
        </span>
      </div>
      {roots.map((t, i) => renderTodo(t, 0, i))}
    </div>
  );
}

// Silence the unused-import warning for `X` (kept for future use).
void X;
