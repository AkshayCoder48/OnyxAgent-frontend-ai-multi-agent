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

/** Persist a todo snapshot (e.g. a live todo_event from the BACKGROUND
 *  runner) into the same Dexie table the in-browser tools write — so the
 *  plan survives page refreshes identically on both paths (PRD FR-1). */
export async function persistTodos(
  convId: string,
  todos: Todo[],
): Promise<void> {
  await saveTodos(convId, todos);
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
// Mutation lock — the runtime executes sibling tool calls of ONE round in
// parallel (results stream as each finishes). manage_todo is a
// load → mutate → save cycle, so two parallel calls (e.g. create + create,
// or update + create + show_todo) each load the SAME base list and the last
// save silently erases the other's write. Serialize all todo handlers per
// conversation: each handler runs only after the previous one settles, in
// the order the tool_calls were emitted.
// ---------------------------------------------------------------------------

const convQueues = new Map<string, Promise<unknown>>();

function withTodoLock<T>(convId: string, fn: () => Promise<T>): Promise<T> {
  const prev = convQueues.get(convId) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run regardless of the previous outcome
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  convQueues.set(convId, tail);
  // Drop the queue entry once the tail settles so the map never grows.
  tail.then(() => {
    if (convQueues.get(convId) === tail) convQueues.delete(convId);
  });
  return run;
}

// ---------------------------------------------------------------------------
// Shared handler — registered under BOTH "manage_todo" and "manage_todos"
// (the model may call either singular or plural; both must work).
// ---------------------------------------------------------------------------

// SIMPLIFIED CALLING CONTRACT (2026-11-14 directive — "simplify the todo
// tool"): `action` is OPTIONAL. The handler infers the intent from the
// payload shape, so every natural call the model emits just works:
//
//   { "id": "todo_cccc", "status": "pending" }   → update that todo's status
//   { "title": "Web dev todo" }                  → create
//   { "id": "todo_cccc" }                        → delete
//   { "action": "list" } / {}                    → list
//
// Explicit `action`/`operation` still wins when present. No call ever fails
// with "Unknown action" again — the only errors left are the honest ones
// (missing title, todo not found, invalid status).
const MANAGE_DESCRIPTION = `Manage the todo list for the current task. SIMPLEST CALLING — the action is INFERRED from what you pass, you rarely need to name it:
- {"title": "..."} → CREATE a todo (returns a stable ID like {"id":"todo_8f42"} — quote it in later calls).
- {"id": "todo_8f42", "status": "..."} → UPDATE that todo's status (or title). status: not_planned | in_progress | done | not_done (plain words like "pending"/"completed" are auto-mapped).
- {"id": "todo_8f42"} → DELETE that todo.
- {} → LIST all todos with their IDs.
- {"action":"clear"} (or the clear_todo tool) → remove ALL todos.
After creating or updating the FULL todo list, ALWAYS call show_todo with all: true so the user sees the live todo panel.`;

const MANAGE_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["create", "update", "delete", "list", "clear"],
      description:
        "Optional — inferred from the payload when omitted: id+status/title → update, title only → create, id only → delete, nothing → list.",
    },
    operation: {
      type: "string",
      enum: ["create", "update", "delete", "list", "clear"],
      description: "Alias for action (accepted for compatibility).",
    },
    title: {
      type: "string",
      description: "Todo title text (creates a todo, or renames on update).",
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
      description: "The todo ID, e.g. todo_8f42 (to update or delete).",
    },
    todoId: {
      type: "string",
      description: "Alias for todo_id.",
    },
    id: {
      type: "string",
      description: "Alias for todo_id.",
    },
    status: {
      type: "string",
      description:
        "New status (for update). not_planned | in_progress | done | not_done — common words (pending, completed, …) are auto-mapped.",
    },
  },
  required: [],
  additionalProperties: false,
} as const;

async function manageTodoHandler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  return withTodoLock(ctx.conversationId ?? "", () =>
    manageTodoLocked(args, ctx),
  );
}

/** Action-key aliases the model might reach for. */
const ACTION_ALIASES: Record<string, string> = {
  add: "create",
  new: "create",
  make: "create",
  insert: "create",
  set: "update",
  set_status: "update",
  mark: "update",
  rename: "update",
  change: "update",
  edit: "update",
  complete: "update",
  remove: "delete",
  destroy: "delete",
  get: "list",
  show: "list",
  read: "list",
  all: "list",
  reset: "clear",
  clear_all: "clear",
  clear_todos: "clear",
  delete_all: "clear",
  wipe: "clear",
};

/**
 * Derive the action from the payload — the heart of the simplified calling
 * contract. Explicit `action`/`operation` wins; otherwise the SHAPE of the
 * call decides, so the model never has to remember a verb:
 *   id + (status | title | description) → update
 *   id only                            → delete
 *   title (no id)                      → create
 *   nothing recognizable               → list
 */
function inferAction(args: Record<string, unknown>): string {
  const explicit = String(args.action ?? args.operation ?? args.op ?? args.mode ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (explicit) return ACTION_ALIASES[explicit] ?? explicit;

  const hasId = Boolean(String(args.todo_id ?? args.todoId ?? args.id ?? "").trim());
  const hasTitle = Boolean(String(args.title ?? args.content ?? "").trim());
  const hasDescription = args.description !== undefined;
  if (hasId && (args.status !== undefined || hasTitle || hasDescription)) return "update";
  if (hasId) return "delete";
  // title + status, no id → an update-by-title (the update handler matches
  // the title); title alone is a create.
  if (hasTitle && args.status !== undefined) return "update";
  if (hasTitle) return "create";
  return "list";
}

async function manageTodoLocked(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const convId = ctx.conversationId ?? "";
  const action = inferAction(args);
  const todoId = () => String(args.todo_id ?? args.todoId ?? args.id ?? "");

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
      let id = todoId();
      let idx = id ? todos.findIndex((t) => t.id === id) : -1;
      // No id (or an id that matches nothing) + a title → fall back to
      // matching the title, so {"title":"Fix bug","status":"done"} also
      // updates instead of failing or duplicating.
      if (idx === -1) {
        const byTitle = String(args.title ?? args.content ?? "").trim().toLowerCase();
        if (byTitle) {
          const matches = todos.filter((t) => t.title.toLowerCase() === byTitle);
          if (matches.length === 1) {
            id = matches[0]!.id;
            idx = todos.findIndex((t) => t.id === id);
          }
        }
      }
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
      const id = todoId();
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
      await emitTodoEvent(ctx, todos, "cleared");
      return { success: true, output: { cleared: true } };
    }

    default:
      return { success: false, output: null, error: `Unknown action: ${action}` };
  }
}

// MERGE/DEDUP NOTE (tool-count cap): `manage_todos` used to be registered as
// an exact alias of manage_todo (same schema + handler) — a duplicate entry
// in Settings → Tools AND a wasted tool slot against the model's tool-count
// cap. Removed; `manage_todo` is the one true name.
registerTool("manage_todo", MANAGE_DESCRIPTION, MANAGE_SCHEMA, manageTodoHandler);

// ---------------------------------------------------------------------------
// clear_todo — the dedicated one-shot "wipe the list" sub-tool of the
// manage_todo family (2026-11-14 directive: "add a sub tool inside manage
// todo called clear todo to clear from ui with a vanish animation"). It
// needs NO arguments at all — the model can't get it wrong — and the
// `cleared` todo_event it emits drives the vanish-with-motion-blur exit of
// the composer todo panel.
// ---------------------------------------------------------------------------

registerTool(
  "clear_todo",
  `Clear the ENTIRE todo list for this conversation in one shot — every todo vanishes from the user's todo panel with a dismiss animation. Takes NO arguments; just call it. Use it when the user says "clear the todos", when a plan is finished and the panel should be dismissed, or when starting fresh. (Equivalent to manage_todo action "clear".)`,
  {
    type: "object",
    properties: {},
    additionalProperties: false,
  } as const,
  async (_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> =>
    manageTodoHandler({ action: "clear" }, ctx),
);

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
ALWAYS call this with all: true right after you finish creating or updating the full todo list — and after meaningful status changes — so the user can see the live todo panel with every step (Not planned / In progress / Done / Not done).`,
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
    // Serialized against manage_todo mutations (see withTodoLock) so a
    // show_todo emitted in the SAME round as create/update calls reads the
    // list AFTER those writes land — not the stale pre-round snapshot.
    return withTodoLock(ctx.conversationId ?? "", () =>
      showTodoLocked(args, ctx),
    );
  },
);

async function showTodoLocked(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
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
  }
