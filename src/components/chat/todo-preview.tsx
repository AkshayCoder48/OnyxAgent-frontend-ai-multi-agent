"use client";

import { useMemo } from "react";
import type { Todo, TodoStatus } from "@/types";
import { TODO_STATUS_LABELS } from "@/types";
import { useResearchStore } from "@/stores";
import { Check, Circle, CircleX, Loader2, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * TodoPreview — the agent's live task plan, attached to the `show_todo` /
 * `manage_todo` tool calls. Renders INLINE IN THE MAIN RESPONSE (directly
 * beneath the tool bar — NOT hidden inside the expandable disclosure), so
 * the plan reads as part of the answer. Expanding the tool bar shows the
 * raw parsed JSON instead.
 *
 * Data: live store first (statuses update in real time when manage_todo
 * changes them in a later round), result snapshot as fallback (survives when
 * the store bucket is missing, e.g. an old message).
 *
 * Design (Terra): a quiet plan card — terracotta progress rail, per-status
 * glyphs (idle ring → spinning loader → filled check → crossed circle),
 * done rows dim + strike, in-progress rows carry a soft terracotta wash and
 * a pulsing left rail so the eye lands on the active step. Responsive: real
 * table on ≥sm, stacked rows below (never horizontal overflow).
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
      return { icon: Circle, className: "text-muted-foreground/60", label: TODO_STATUS_LABELS.not_planned };
  }
}

/** Tailwind bundle per row status — drives wash, rail, and text treatment. */
function rowClasses(status: TodoStatus): string {
  switch (status) {
    case "done":
      return "opacity-55";
    case "in_progress":
      return "bg-primary/[0.055]";
    case "not_done":
      return "opacity-75";
    default:
      return "";
  }
}

/** Left rail color per status — the vertical thread through the plan. */
function railClasses(status: TodoStatus): string {
  switch (status) {
    case "done":
      return "bg-emerald-500/50";
    case "in_progress":
      return "bg-primary animate-pulse-soft";
    case "not_done":
      return "bg-destructive/50";
    default:
      return "bg-foreground/10";
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
  /** Show the header row ("Task plan · n · x%"). */
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

  const doneCount = todos.filter((t) => t.status === "done").length;
  const activeCount = todos.filter((t) => t.status === "in_progress").length;
  const pct = Math.round((doneCount / todos.length) * 100);
  const allDone = doneCount === todos.length;

  return (
    <div
      className={cn(
        "step-card-in my-1 w-full min-w-0 overflow-hidden rounded-xl border border-foreground/10 bg-foreground/[0.02]",
        className,
      )}
      role="table"
      aria-label={`Task plan — ${todos.length} item${todos.length !== 1 ? "s" : ""}, ${doneCount} done`}
    >
      {/* Plan header — label, live counts, progress rail, status chip. */}
      {showHeader && (
        <div className="flex items-center gap-2.5 border-b border-foreground/10 px-3.5 py-2.5">
          <span
            className={cn(
              "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
              allDone
                ? "bg-emerald-500/12 text-emerald-600"
                : "bg-primary/10 text-primary",
            )}
            aria-hidden
          >
            {allDone ? (
              <Check className="h-3.5 w-3.5" />
            ) : activeCount > 0 ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ListChecks className="h-3.5 w-3.5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-foreground/90 truncate text-[13px] font-semibold tracking-tight">
                Task plan
              </span>
              <span className="text-muted-foreground shrink-0 font-mono text-[10px] tabular-nums">
                {doneCount}/{todos.length}
                {activeCount > 0 ? ` · ${activeCount} active` : ""}
              </span>
              <span
                className={cn(
                  "ml-auto shrink-0 font-mono text-[10px] font-semibold tabular-nums",
                  allDone ? "text-emerald-600" : "text-foreground/60",
                )}
              >
                {pct}%
              </span>
            </div>
            {/* Progress rail — terracotta fill, eased width. */}
            <div
              className="bg-foreground/10 mt-1.5 h-[3px] w-full overflow-hidden rounded-full"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Plan progress"
            >
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-500 ease-out",
                  allDone ? "bg-emerald-500" : "bg-primary",
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Plan rows — one per todo. Desktop table, mobile stacked (the same
          row markup works for both via flex). */}
      <div role="rowgroup">
        {todos.map((todo, idx) => {
          const s = todoStatusIcon(todo.status);
          const Icon = s.icon;
          const last = idx === todos.length - 1;
          return (
            <div
              key={todo.id}
              role="row"
              className={cn(
                "relative flex items-center gap-3 border-b border-foreground/[0.06] px-3.5 py-2 last:border-b-0 transition-colors",
                rowClasses(todo.status),
              )}
            >
              {/* Status rail — colored thread down the left edge. */}
              <span
                aria-hidden
                className={cn(
                  "absolute top-0 bottom-0 left-0 w-[3px]",
                  railClasses(todo.status),
                  todo.status !== "in_progress" && "opacity-70",
                  last && "bottom-0 rounded-bl-xl",
                  idx === 0 && "top-0 rounded-tl-xl",
                  !showHeader && idx === 0 && "rounded-tl-xl",
                )}
              />
              {/* Status glyph */}
              <span className={cn("shrink-0", s.className)} aria-hidden>
                <Icon className="h-4 w-4" />
              </span>
              {/* Title + id */}
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-foreground/90 truncate text-[13px] leading-snug break-words",
                    todo.status === "done" && "line-through decoration-foreground/30",
                  )}
                  title={todo.title}
                >
                  {todo.title}
                </p>
                <p
                  className="text-muted-foreground/70 mt-0.5 font-mono text-[9.5px] tracking-wide"
                  title={todo.id}
                >
                  {todo.id}
                </p>
              </div>
              {/* Status pill */}
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide whitespace-nowrap",
                  todo.status === "done" && "bg-emerald-500/10 text-emerald-600",
                  todo.status === "in_progress" && "bg-primary/10 text-primary",
                  todo.status === "not_done" && "bg-destructive/10 text-destructive",
                  todo.status === "not_planned" && "bg-foreground/[0.05] text-muted-foreground",
                )}
              >
                {s.label}
              </span>
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
