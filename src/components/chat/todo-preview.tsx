"use client";

import { useMemo } from "react";
import type { Todo, TodoStatus } from "@/types";
import { TODO_STATUS_LABELS } from "@/types";
import { useResearchStore } from "@/stores";
import { Check, Circle, CircleX, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * TodoPreview — compact todo table attached to the `show_todo` tool call
 * (PRD §5–7): the preview renders directly below the tool-call bar so the
 * tool call + preview read as ONE combined result.
 *
 * Data: live store first (statuses update in real time when manage_todo
 * changes them in a later round), result snapshot as fallback (survives when
 * the store bucket is missing, e.g. an old message).
 *
 * Responsive: a real table on ≥sm, stacked cards below (never horizontal
 * overflow). Long IDs/titles truncate; the full values stay inspectable in
 * the tool call's expanded raw result.
 */

export function todoStatusIcon(status: TodoStatus): {
  icon: typeof Check;
  className: string;
  label: string;
} {
  switch (status) {
    case "done":
      return { icon: Check, className: "text-emerald-600", label: TODO_STATUS_LABELS.done };
    case "in_progress":
      return { icon: Loader2, className: "text-primary animate-spin", label: TODO_STATUS_LABELS.in_progress };
    case "not_done":
      return { icon: CircleX, className: "text-destructive", label: TODO_STATUS_LABELS.not_done };
    default:
      return { icon: Circle, className: "text-muted-foreground", label: TODO_STATUS_LABELS.not_planned };
  }
}

interface TodoPreviewProps {
  /** Turn/conversation key for the live todo store. */
  turnId?: string | null;
  /** IDs to display (from the show_todo call). Empty/undefined = all. */
  todoIds?: string[];
  /** Snapshot todos parsed from the tool result — fallback when the live
   *  store has no bucket for this conversation. */
  fallbackTodos?: Todo[];
  /** Show the header row ("Todo · N items"). */
  showHeader?: boolean;
  className?: string;
}

export function TodoPreview({
  turnId,
  todoIds,
  fallbackTodos,
  showHeader = true,
  className,
}: TodoPreviewProps) {
  const liveTodos = useResearchStore((s) => (turnId ? s.byTurn[turnId]?.agentTodos : undefined));

  const todos = useMemo(() => {
    const byId = new Map<string, Todo>();
    for (const t of fallbackTodos ?? []) if (t && t.id) byId.set(t.id, t);
    for (const t of liveTodos ?? []) if (t && t.id) byId.set(t.id, t);
    if (todoIds && todoIds.length > 0) {
      return todoIds
        .map((id) => byId.get(id))
        .filter((t): t is Todo => Boolean(t));
    }
    return [...byId.values()];
  }, [fallbackTodos, liveTodos, todoIds]);

  if (todos.length === 0) return null;

  return (
    <div
      className={cn(
        "step-card-in my-1 w-full min-w-0 overflow-hidden rounded-xl border bg-accent/20",
        className,
      )}
      role="table"
      aria-label={`Todo preview — ${todos.length} item${todos.length !== 1 ? "s" : ""}`}
    >
      {showHeader && (
        <div className="flex items-center gap-1.5 border-b px-3 py-1.5">
          <span className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
            Todo
          </span>
          <span className="font-mono text-[10px] tabular-nums text-foreground/60">
            {todos.length} item{todos.length !== 1 ? "s" : ""}
          </span>
        </div>
      )}

      {/* Desktop: real table (ID | Todo | Status). */}
      <table className="hidden w-full table-fixed text-sm sm:table">
        <thead>
          <tr className="border-b text-left">
            <th scope="col" className="w-[92px] px-3 py-1.5 font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
              ID
            </th>
            <th scope="col" className="px-3 py-1.5 font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
              Task
            </th>
            <th scope="col" className="w-[132px] px-3 py-1.5 font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {todos.map((todo) => {
            const s = todoStatusIcon(todo.status);
            const Icon = s.icon;
            return (
              <tr key={todo.id} className="border-b last:border-b-0">
                <td className="truncate px-3 py-1.5 font-mono text-[11px] text-foreground/70" title={todo.id}>
                  {todo.id}
                </td>
                <td className="truncate px-3 py-1.5 text-[13px] text-foreground/90" title={todo.title}>
                  {todo.title}
                </td>
                <td className="px-3 py-1.5">
                  <span className={cn("inline-flex items-center gap-1.5 text-[12px] font-medium", s.className)}>
                    <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    {s.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Mobile: stacked cards (no horizontal overflow, PRD §27). */}
      <div className="divide-y sm:hidden">
        {todos.map((todo) => {
          const s = todoStatusIcon(todo.status);
          const Icon = s.icon;
          return (
            <div key={todo.id} className="px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[10px] text-muted-foreground">{todo.id}</span>
                <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium", s.className)}>
                  <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {s.label}
                </span>
              </div>
              <p className="mt-0.5 text-[13px] leading-snug break-words text-foreground/90">{todo.title}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Parse the todos payload out of a show_todo / manage_todo tool result.
 *  Accepts a JSON string, a bare list, or the ToolResult wrapper. */
export function parseTodoResult(
  result: unknown,
): { todos: Todo[]; todoIds?: string[] } | null {
  if (result == null) return null;
  let obj: unknown = result;
  if (typeof result === "string") {
    try {
      obj = JSON.parse(result);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  // ToolResult wrapper { success, output: { todos, ... } }.
  const output =
    rec.output && typeof rec.output === "object"
      ? (rec.output as Record<string, unknown>)
      : rec;
  const rawTodos = output.todos ?? rec.todos;
  if (!Array.isArray(rawTodos)) return null;
  const todos: Todo[] = [];
  for (const t of rawTodos) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    if (typeof r.id !== "string") continue;
    todos.push({
      id: r.id,
      title: String(r.title ?? r.content ?? ""),
      description: r.description ? String(r.description) : undefined,
      status: normalizePreviewStatus(r.status),
      createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
      updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : Date.now(),
    });
  }
  return { todos };
}

function normalizePreviewStatus(raw: unknown): TodoStatus {
  if (typeof raw !== "string") return "not_planned";
  switch (raw) {
    case "in_progress":
      return "in_progress";
    case "done":
      return "done";
    case "not_done":
      return "not_done";
    default:
      return "not_planned";
  }
}
