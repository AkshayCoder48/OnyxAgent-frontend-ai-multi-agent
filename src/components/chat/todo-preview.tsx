"use client";

import { useMemo } from "react";
import type { Todo, TodoStatus } from "@/types";
import { useResearchStore } from "@/stores";
import { TodoListBeta, type TodoBetaItem, type TodoBetaStatus } from "./todo-list-beta";

/**
 * TodoPreview — the agent's live task plan, attached to the `show_todo` /
 * `manage_todo` tool calls. Renders INLINE IN THE MAIN RESPONSE (directly
 * beneath the tool bar — NOT hidden inside the expandable disclosure).
 *
 * Beta V1.2: the old Terra "task plan table" (status pills, per-row IDs,
 * progress rail) is REPLACED by the Cursor-style To-do List — a collapsible
 * "To-dos" header with a rolling done/total count and a state icon
 * (list → dashed pie ring → filled check), and one row per step with
 * dashed / arrow / check glyphs. The old table's `todoStatusIcon` map stays
 * exported (other surfaces import it for their own chips).
 *
 * Data: live store first (statuses update in real time when manage_todo
 * changes them in a later round), result snapshot as fallback (survives when
 * the store bucket is missing, e.g. an old message).
 */

/** Map the agent's todo statuses onto the Beta V1.2 row states. */
function betaStatus(status: TodoStatus): TodoBetaStatus {
  switch (status) {
    case "done":
      return "done";
    case "in_progress":
      return "active";
    case "not_done":
      return "failed";
    default:
      return "pending";
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
  /** Show the header (kept for API compatibility — the Beta card always
   *  renders its own collapsible header). */
  showHeader?: boolean;
  className?: string;
}

export function TodoPreview({
  turnId,
  todoIds,
  fallbackTodos,
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

  const items: TodoBetaItem[] = useMemo(
    () =>
      todos.map((t) => ({
        id: t.id,
        text: t.title,
        status: betaStatus(t.status),
      })),
    [todos],
  );

  if (items.length === 0) return null;

  return (
    <div
      className={className}
      role="list"
      aria-label={`To-dos — ${items.length} item${items.length !== 1 ? "s" : ""}`}
    >
      <TodoListBeta items={items} title="To-dos" />
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
