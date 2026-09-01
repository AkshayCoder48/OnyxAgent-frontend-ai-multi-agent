"use client";

import { useState } from "react";
import { useResearchStore } from "@/stores";
import type { ResearchTodo } from "@/types";
import { TodoList, type TodoItem } from "@/components/assistant-ui/elements";
import { CheckCircle2, Loader2, Scissors } from "lucide-react";

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

/** Map the agent's todo statuses onto the TodoList element's three states. */
function todoItemStatus(status: ResearchTodo["status"]): TodoItem["status"] {
  switch (status) {
    case "completed":
      return "done";
    case "in_progress":
      return "active";
    default:
      return "pending";
  }
}

/**
 * Live plan panel for the todo tool, rendered INLINE IN THE MESSAGE THREAD
 * (on the assistant's response flow — NOT a stuck card above the prompt
 * box). Built on the assistant-ui "TodoList" element: a "Todos n/m · rev r"
 * header, one row per step with a checked box (done), spinner (active), or
 * empty outlined box (pending); done rows dim and strike through, subtasks
 * indent under their parent.
 *
 * The agent emits `todo_event` WS frames for every mutation (created /
 * updated / status_changed / completed / deleted); the `use-chat` hook
 * forwards them to `useResearchStore.applyTodoEvent`, which this panel
 * reads. The header row carries a progress bar and the "Cut" (dismiss)
 * affordance.
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
  const done = todoTotal > 0 && !anyTodoActive;
  const busy = !done;

  // Collapse the panel when the plan finishes and re-expand when new active
  // todos appear. Uses the render-time "adjust state when derived values
  // change" pattern from the React docs (no effect → no cascading render).
  const [expanded, setExpanded] = useState(true);
  const [prevDone, setPrevDone] = useState(done);
  if (done !== prevDone) {
    setPrevDone(done);
    setExpanded(!done);
  }

  // Hide when there are no todos OR when the user has dismissed the panel
  // (the store re-arms `dismissed = false` on the next event).
  if (todoTotal === 0 || dismissed) return null;

  const pct = Math.round((todoDone / todoTotal) * 100);

  // Flatten the todo tree into TodoList rows — subtasks carry their depth so
  // they indent under their parent. Revision is derived from the plan state
  // (done count + total + statuses hash) as a light proxy for the
  // reference's `rev` counter.
  const revision = todos.length
    ? todoDone * 1000 + todoTotal + todos.filter((t) => t.status === "in_progress").length * 7
    : undefined;
  const rows: TodoItem[] = [];
  const walk = (list: ResearchTodo[], depth: number) => {
    for (const t of list) {
      rows.push({
        id: t.id,
        text: t.status === "in_progress" && t.active_form ? t.active_form : t.content,
        status: todoItemStatus(t.status),
        depth,
      });
      walk(
        todos.filter((c) => c.parent_id === t.id),
        depth + 1,
      );
    }
  };
  walk(
    todos.filter((t) => !t.parent_id),
    0,
  );

  return (
    <div className="step-card-in my-2 min-w-0 max-w-full">
      {/* Header row — live status, progress, and the Cut affordance */}
      <div className="flex items-center gap-2 px-1 pb-1.5">
        <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          {busy ? (
            <Loader2 className="text-primary h-3 w-3 animate-spin" aria-hidden />
          ) : (
            <CheckCircle2 className="text-primary h-3 w-3" aria-hidden />
          )}
          Plan
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-foreground/70">
          {todoDone}/{todoTotal} steps
        </span>
        <div
          className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/10"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Plan progress"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="text-muted-foreground hover:bg-foreground/10 hover:text-foreground shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] transition-colors"
          title={expanded ? "Collapse plan" : "Expand plan"}
        >
          {expanded ? "hide" : "show"}
        </button>
        <button
          type="button"
          className="text-muted-foreground hover:bg-foreground/10 hover:text-foreground inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors"
          onClick={() => onDismiss?.()}
          title="Cut (dismiss plan panel)"
          aria-label="Dismiss plan panel"
        >
          <Scissors className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* The TodoList element — assistant-ui recipe. Subtask rows indent by
          their depth (optional field on TodoItem). */}
      {expanded ? (
        <TodoList items={rows} revision={revision} className="max-w-none" />
      ) : (
        <div className="px-1 pb-1">
          <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
            {todoDone}/{todoTotal} steps · {pct}%
          </span>
        </div>
      )}
    </div>
  );
}
