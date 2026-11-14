"use client";

import { useState } from "react";
import { useResearchStore } from "@/stores";
import type { Todo, TodoStatus } from "@/types";
import { TodoList, type TodoItem } from "@/components/assistant-ui/elements";
import { CheckCircle2, Loader2, Scissors } from "lucide-react";

/**
 * Deep-research / legacy todo tool names that should be hidden from the
 * message transcript and surfaced in this panel instead. Mirrors the backend
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

const EMPTY_TODOS: Todo[] = [];

interface ResearchPanelProps {
  /** Optional turn id (defaults to the store's currentTurnId). */
  turnId?: string;
  /** Called when the user clicks the "Cut" button — the parent wires this to
   *  the WebSocket so the backend also knows to suppress further emits. */
  onDismiss?: () => void;
}

/** Map the agent todo statuses onto the TodoList element's three states. */
function todoItemStatus(status: TodoStatus): TodoItem["status"] {
  switch (status) {
    case "done":
      return "done";
    case "in_progress":
      return "active";
    default:
      return "pending";
  }
}

/**
 * Live todo panel, rendered INLINE IN THE MESSAGE THREAD (on the assistant's
 * response flow — NOT a stuck card above the prompt box). ONE data source
 * with the Todos dock: both read the same `byTurn[turnId].agentTodos`
 * bucket (the single todo pipeline — manage_todo / show_todo snapshots and
 * mapped legacy todo_events all land there), so this panel and the dock
 * above the composer are always in sync. It mounts where a legacy research
 * todo tool ran inside the message flow.
 */
export function ResearchPanel({ turnId, onDismiss }: ResearchPanelProps) {
  const currentTurnId = useResearchStore((s) => s.currentTurnId);
  const activeTurnId = turnId ?? currentTurnId ?? "default";
  const turn = useResearchStore((s) => s.byTurn[activeTurnId]);
  const todos = turn?.agentTodos ?? EMPTY_TODOS;
  const dismissed = turn?.dismissed ?? false;

  const todoTotal = todos.length;
  const todoDone = todos.filter((t) => t.status === "done").length;
  const anyTodoActive = todos.some(
    (t) => t.status === "in_progress" || t.status === "not_planned" || t.status === "not_done",
  );
  const done = todoTotal > 0 && !anyTodoActive;
  const busy = !done;

  // Collapse the panel when the todos finish and re-expand when new active
  // items appear. Uses the render-time "adjust state when derived values
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

  const revision =
    todoDone * 1000 + todoTotal + todos.filter((t) => t.status === "in_progress").length * 7;
  const rows: TodoItem[] = todos.map((t) => ({
    id: t.id,
    text: t.title,
    status: todoItemStatus(t.status),
    depth: 0,
  }));

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
          Todos
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
          aria-label="Todo progress"
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
          title={expanded ? "Collapse todos" : "Expand todos"}
        >
          {expanded ? "hide" : "show"}
        </button>
        <button
          type="button"
          className="text-muted-foreground hover:bg-foreground/10 hover:text-foreground inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors"
          onClick={() => onDismiss?.()}
          title="Cut (dismiss todo panel)"
          aria-label="Dismiss todo panel"
        >
          <Scissors className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* The TodoList element — assistant-ui recipe. */}
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
