// manage_todos — create/update/delete/list todos. Emits todo_event for real-time UI.
import { registerTool } from "./registry";
import type { ToolContext } from "./registry";
import type { ToolResult } from "@/types";
import { db } from "@/lib/db";
import { v4 as uuid } from "uuid";

interface Todo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export async function emitTodos(ctx: ToolContext, todos: Todo[]): Promise<void> {
  ctx.emit({
    type: "todo_event",
    data: { event_type: "snapshot", todo: null, all_todos: todos },
    timestamp: new Date().toISOString(),
  } as never);
}

registerTool(
  "manage_todos",
  "Create, update, delete, or list todos for the current task. Emits real-time UI updates so the user sees a live checklist. Actions: 'list' (return all), 'create' (add a todo), 'update' (change status/content), 'delete' (remove by id), 'clear' (remove all).",
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "create", "update", "delete", "clear"],
        description: "The action to perform.",
      },
      content: {
        type: "string",
        description: "Todo content text (for 'create' or 'update' with new content).",
      },
      todo_id: {
        type: "string",
        description: "The todo ID (for 'update' or 'delete').",
      },
      status: {
        type: "string",
        enum: ["pending", "in_progress", "completed"],
        description: "New status (for 'update').",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    // In-memory todos per conversation (could persist to Dexie if needed)
    // We use a module-level Map keyed by conversationId
    const convId = ctx.conversationId ?? "";
    if (!todosByConv.has(convId)) todosByConv.set(convId, []);

    const todos = todosByConv.get(convId)!;
    const action = args.action as string;

    switch (action) {
      case "list": {
        return { success: true, output: { todos } };
      }
      case "create": {
        const content = args.content as string;
        if (!content) return { success: false, output: null, error: "content is required for create" };
        const todo: Todo = { id: uuid(), content, status: "pending" };
        todos.push(todo);
        await emitTodos(ctx, todos);
        return { success: true, output: { todo, total: todos.length } };
      }
      case "update": {
        const id = args.todo_id as string;
        const idx = todos.findIndex((t) => t.id === id);
        if (idx === -1) return { success: false, output: null, error: "todo not found" };
        if (args.content) todos[idx]!.content = args.content as string;
        if (args.status) todos[idx]!.status = args.status as Todo["status"];
        await emitTodos(ctx, todos);
        return { success: true, output: { todo: todos[idx] } };
      }
      case "delete": {
        const id = args.todo_id as string;
        const idx = todos.findIndex((t) => t.id === id);
        if (idx === -1) return { success: false, output: null, error: "todo not found" };
        const removed = todos.splice(idx, 1)[0];
        await emitTodos(ctx, todos);
        return { success: true, output: { deleted: removed } };
      }
      case "clear": {
        todos.length = 0;
        await emitTodos(ctx, todos);
        return { success: true, output: { cleared: true } };
      }
      default:
        return { success: false, output: null, error: `Unknown action: ${action}` };
    }
  },
);

// Module-level in-memory todo store keyed by conversationId
const todosByConv = new Map<string, Todo[]>();
