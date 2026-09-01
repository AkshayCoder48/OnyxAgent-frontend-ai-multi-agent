// Agent Todo system (PRD "Agent Todo System, Round-Based Reasoning & Stacked
// Tool UI"). Two tools:
//
//   manage_todo — create / update / delete / list todos. Returns a stable
//                 short ID (`todo_8f42`) the model reuses in later calls
//                 across rounds. Persists to Dexie so todos survive refresh.
//   show_todo   — display one, several, or all todos to the USER. The UI
//                 renders its result as a compact todo table preview directly
//                 beneath the tool-call bar (specialized renderer).
//
// Statuses (exactly four, user-facing):
//   not_planned | in_progress | done | not_done
//
// Both tools emit `todo_event` snapshots so the live store (and any mounted
// TodoPreview) updates immediately on every mutation.

import { registerTool } from "./registry";
import type { ToolContext } from "./registry";
import type { ToolResult, Todo, TodoStatus } from "@/types";
import { getDB } from "@/lib/db";

// ---------------------------------------------------------------------------
// Persistence — module cache + Dexie todo_lists table (one row per
// conversation). Falls back to memory-only when IndexedDB is unavailable.
// ---------------------------------------------------------------------------

const memoryByConv = new Map<string, Todo[]>();

function stableTodoId(): string {
  // `todo_` + 4 hex chars — short, stable, readable in a table row.
  let id = "";
  do {
    id = `todo_${Math.random().toString(16).slice(2, 6).padStart(4, "0")}`;
  } while (id.length !== 9); // "todo_" (5) + 4 hex
  return id;
}

async function loadTodos(convId: string): Promise<Todo[]> {
  try {
    const db = getDB();
    const row = await db.todo_lists.get(convId);
    if (row) return row.todos ?? [];
  } catch {
    // IndexedDB unavailable — memory fallback.
  }
  return memoryByConv.get(convId) ?? [];
}

async function saveTodos(convId: string, todos: Todo[]): Promise<void> {
  memoryByConv.set(convId, todos);
  try {
    const db = getDB();
    await db.todo_lists.put({
      conversation_id: convId,
      todos,
      updated_at: new Date().toISOString(),
    });
  } catch {
    // Memory fallback already updated.
  }
}

/** Hydrate the live todo store for a conversation after a page refresh /
 *  conversation restore. Exported for use-chat's load effect. */
export async function restoreTodos(convId: string): Promise<Todo[]> {
  return loadTodos(convId);
}

const VALID_STATUSES: readonly TodoStatus[] = [
  "not_planned",
  "in_progress",
  "done",
  "not_done",
];

function normalizeStatus(raw: unknown): TodoStatus | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((VALID_STATUSES as readonly string[]).includes(s)) return s as TodoStatus;
  // Friendly aliases the model might emit.
  switch (s) {
    case "pending":
    case "planned":
    case "todo":
      return "not_planned";
    case "active":
    case "working":
    case "doing":
      return "in_progress";
    case "completed":
    case "complete":
    case "finished":
      return "done";
    case "failed":
    case "incomplete":
    case "cancelled":
    case "canceled":
      return "not_done";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Event emission — a snapshot event per mutation keeps the live store and
// every mounted TodoPreview in sync.
// ---------------------------------------------------------------------------

async function emitTodoEvent(
  ctx: ToolContext,
  todos: Todo[],
  eventType: string,
): Promise<void> {
  ctx.emit({
    type: "todo_event",
    data: { event_type: eventType, todo: null, all_todos: todos },
    timestamp: new Date().toISOString(),
  } as never);
}

// ---------------------------------------------------------------------------
// Shared handler — registered under BOTH "manage_todo" and "manage_todos"
// (the model may call either singular or plural; both must work).
// ---------------------------------------------------------------------------

const MANAGE_DESCRIPTION = `Manage the todo list for the current task.
Actions:
- create: add a todo (requires title). Returns the todo with its stable ID, e.g. {"success":true,"todo":{"id":"todo_8f42","title":"...","status":"not_planned"}}. ALWAYS quote this ID in later calls.
- update: change status/content of a todo by its ID (requires todo_id). status must be one of: not_planned, in_progress, done, not_done.
- delete: remove a todo by its ID.
- list: return all todos with their IDs.
- clear: remove all todos.
Statuses: "not_planned" (not started), "in_progress" (actively working), "done" (completed), "not_done" (attempted but not completed).`;

const MANAGE_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["create", "update", "delete", "list", "clear"],
      description: "The action to perform.",
    },
    title: {
      type: "string",
      description: "Todo title text (for 'create', or to rename on 'update').",
    },
    content: {
      type: "string",
      description: "Alias for title (accepted for compatibility).",
    },
    description: {
      type: "string",
      description: "Optional longer description (for 'create'/'update').",
    },
    todo_id: {
      type: "string",
      description: "The todo ID, e.g. todo_8f42 (for 'update' or 'delete').",
    },
    status: {
      type: "string",
      enum: ["not_planned", "in_progress", "done", "not_done"],
      description: "New status (for 'update').",
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

async function manageTodoHandler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const convId = ctx.conversationId ?? "";
  const action = String(args.action ?? "").toLowerCase();

  let todos = await loadTodos(convId);

  switch (action) {
    case "list": {
      return { success: true, output: { todos } };
    }

    case "create": {
      const title = String(args.title ?? args.content ?? "").trim();
      if (!title) {
        return { success: false, output: null, error: "title is required for create" };
      }
      const now = Date.now();
      const todo: Todo = {
        id: stableTodoId(),
        title,
        description: args.description ? String(args.description) : undefined,
        status: "not_planned",
        createdAt: now,
        updatedAt: now,
      };
      todos = [...todos, todo];
      await saveTodos(convId, todos);
      await emitTodoEvent(ctx, todos, "created");
      return { success: true, output: { todo, total: todos.length } };
    }

    case "update": {
      const id = String(args.todo_id ?? "");
      const idx = todos.findIndex((t) => t.id === id);
      if (idx === -1) {
        return { success: false, output: null, error: `todo not found: ${id || "(missing todo_id)"}` };
      }
      const prev = todos[idx]!;
      const next: Todo = { ...prev, updatedAt: Date.now() };
      const newTitle = String(args.title ?? args.content ?? "").trim();
      if (newTitle) next.title = newTitle;
      if (args.description !== undefined) next.description = String(args.description);
      const status = normalizeStatus(args.status);
      if (args.status !== undefined) {
        if (!status) {
          return {
            success: false,
            output: null,
            error: `invalid status "${String(args.status)}" — use not_planned | in_progress | done | not_done`,
          };
        }
        next.status = status;
      }
      todos = [...todos];
      todos[idx] = next;
      await saveTodos(convId, todos);
      await emitTodoEvent(ctx, todos, "status_changed");
      return { success: true, output: { todo: next, previous: prev } };
    }

    case "delete": {
      const id = String(args.todo_id ?? "");
      const idx = todos.findIndex((t) => t.id === id);
      if (idx === -1) {
        return { success: false, output: null, error: `todo not found: ${id || "(missing todo_id)"}` };
      }
      const removed = todos[idx]!;
      todos = todos.filter((t) => t.id !== id);
      await saveTodos(convId, todos);
      await emitTodoEvent(ctx, todos, "deleted");
      return { success: true, output: { deleted: removed } };
    }

    case "clear": {
      todos = [];
      await saveTodos(convId, todos);
      await emitTodoEvent(ctx, todos, "reset");
      return { success: true, output: { cleared: true } };
    }

    default:
      return { success: false, output: null, error: `Unknown action: ${action}` };
  }
}

registerTool("manage_todo", MANAGE_DESCRIPTION, MANAGE_SCHEMA, manageTodoHandler);
registerTool("manage_todos", MANAGE_DESCRIPTION, MANAGE_SCHEMA, manageTodoHandler);

// ---------------------------------------------------------------------------
// show_todo — display todos to the user. Accepts specific todo IDs (the
// stable IDs returned by manage_todo creation) or `all: true` / an empty
// ID list to show everything. The frontend renders the returned list as a
// todo table preview attached to this tool call.
// ---------------------------------------------------------------------------

registerTool(
  "show_todo",
  `Display todos to the user as a visual todo table preview in the chat.
Pass todo IDs (from manage_todo results, e.g. ["todo_8f42","todo_91ac"]) to show specific todos, or all=true (or an empty list) to show every todo.
Use after creating or updating todos so the user can see the current plan and statuses (Not planned / In progress / Done / Not done).`,
  {
    type: "object",
    properties: {
      todo_ids: {
        type: "array",
        items: { type: "string" },
        description: "Todo IDs to display, e.g. [\"todo_8f42\"]. Empty array (or all=true) shows all todos.",
      },
      todoIds: {
        type: "array",
        items: { type: "string" },
        description: "Alias for todo_ids.",
      },
      all: {
        type: "boolean",
        description: "Show all todos (ignores todo_ids).",
      },
    },
    additionalProperties: false,
  } as const,
  async (args: Record<string, unknown>, ctx): Promise<ToolResult> => {
    const convId = ctx.conversationId ?? "";
    const todos = await loadTodos(convId);

    const rawIds =
      (Array.isArray(args.todo_ids) && args.todo_ids) ||
      (Array.isArray(args.todoIds) && args.todoIds) ||
      [];
    const ids = rawIds.map((v) => String(v));
    const wantAll = args.all === true || ids.length === 0;

    if (wantAll) {
      if (todos.length === 0) {
        return { success: true, output: { todos: [], note: "no todos yet" } };
      }
      await emitTodoEvent(ctx, todos, "snapshot");
      return { success: true, output: { todos } };
    }

    // Validate the requested IDs — invalid ones are reported, not fatal.
    const found: Todo[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const hit = todos.find((t) => t.id === id);
      if (hit) found.push(hit);
      else missing.push(id);
    }
    if (found.length === 0) {
      return {
        success: false,
        output: null,
        error: `todo not found: ${missing.join(", ") || "(none)"}`,
      };
    }
    await emitTodoEvent(ctx, todos, "snapshot");
    return {
      success: true,
      output: {
        todos: found,
        ...(missing.length > 0 ? { not_found: missing } : {}),
      },
    };
  },
);
