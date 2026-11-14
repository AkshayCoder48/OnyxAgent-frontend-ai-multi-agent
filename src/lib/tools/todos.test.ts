// @vitest-environment jsdom
// manage_todo / show_todo — the agent Todo system's tool layer.
//
// History: the operator-reported bug rendered in the chat as
//   {"success":false,"output":null,"error":"Unknown action: "}
// whenever the model called manage_todo with {"operation":"create",...}
// (models mix "action" and "operation" — media_generation and use_browser
// gate on "operation"). The handler now accepts BOTH keys, plus
// todoId/todoId/id aliases, and the schema declares them so strict
// providers don't strip the arguments.
import { describe, expect, it, beforeEach } from "vitest";
import "./index"; // side-effect: registers every built-in tool
import { getTool } from "./registry";
import type { ToolContext } from "./registry";

const ctx = (conversationId: string): ToolContext =>
  ({ conversationId, emit: () => {} }) as unknown as ToolContext;

const run = async (name: string, args: Record<string, unknown>, conv: string) => {
  const tool = getTool(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.handler(args, ctx(conv));
};

describe("manage_todo · action/operation alias (the 'Unknown action: ' bug)", () => {
  beforeEach(async () => {
    await run("manage_todo", { action: "clear" }, "alias-conv");
  });

  it("operation: create works — the exact reported failure", async () => {
    const res = await run(
      "manage_todo",
      { operation: "create", title: "Web dev todo" },
      "alias-conv",
    );
    expect(res.success).toBe(true);
    expect(res.output).toMatchObject({ todo: { title: "Web dev todo", status: "not_planned" } });
  });

  it("action: create still works (the primary key)", async () => {
    const res = await run(
      "manage_todo",
      { action: "create", title: "Primary key todo" },
      "alias-conv",
    );
    expect(res.success).toBe(true);
  });

  it("update/delete accept todo_id, todoId and id aliases", async () => {
    const created = await run(
      "manage_todo",
      { operation: "create", title: "Alias target" },
      "alias-conv",
    );
    const id = (created.output as { todo: { id: string } }).todo.id;

    const byTodoId = await run(
      "manage_todo",
      { action: "update", todo_id: id, status: "done" },
      "alias-conv",
    );
    expect(byTodoId.success).toBe(true);

    const byCamel = await run(
      "manage_todo",
      { operation: "update", todoId: id, status: "in_progress" },
      "alias-conv",
    );
    expect(byCamel.success).toBe(true);

    const byId = await run("manage_todo", { action: "delete", id }, "alias-conv");
    expect(byId.success).toBe(true);
  });

  it("a truly unknown action still reports a clear error", async () => {
    const res = await run("manage_todo", { action: "explode" }, "alias-conv");
    expect(res.success).toBe(false);
    expect(res.error).toBe("Unknown action: explode");
  });

  it("the schema declares the aliases (strict providers keep the args)", () => {
    const tool = getTool("manage_todo");
    const props = (tool?.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["action", "operation", "title", "content", "todo_id", "todoId", "id", "status"]),
    );
  });
});

describe("manage_todo · list / clear", () => {
  it("lists the todos created in the conversation", async () => {
    await run("manage_todo", { operation: "clear" }, "list-conv");
    await run("manage_todo", { operation: "create", title: "One" }, "list-conv");
    await run("manage_todo", { operation: "create", title: "Two" }, "list-conv");
    const res = await run("manage_todo", { action: "list" }, "list-conv");
    expect(res.success).toBe(true);
    expect((res.output as { todos: unknown[] }).todos.length).toBe(2);
  });
});

describe("manage_todo · simplified calling (action inferred from the payload)", () => {
  beforeEach(async () => {
    await run("manage_todo", { action: "clear" }, "infer-conv");
  });

  it("{id, status} updates — the exact reported failure shape", async () => {
    const created = await run(
      "manage_todo",
      { operation: "create", title: "Inferred update" },
      "infer-conv",
    );
    const id = (created.output as { todo: { id: string } }).todo.id;
    const res = await run("manage_todo", { id, status: "pending" }, "infer-conv");
    expect(res.success).toBe(true);
    expect(res.output).toMatchObject({ todo: { id, status: "not_planned" } });
  });

  it("{title} alone creates", async () => {
    const res = await run("manage_todo", { title: "Web dev todo" }, "infer-conv");
    expect(res.success).toBe(true);
    expect(res.output).toMatchObject({ todo: { title: "Web dev todo", status: "not_planned" } });
  });

  it("{id} alone deletes", async () => {
    const created = await run("manage_todo", { title: "Doomed" }, "infer-conv");
    const id = (created.output as { todo: { id: string } }).todo.id;
    const res = await run("manage_todo", { id }, "infer-conv");
    expect(res.success).toBe(true);
    expect(res.output).toMatchObject({ deleted: { id } });
  });

  it("{} lists", async () => {
    await run("manage_todo", { title: "Listed" }, "infer-conv");
    const res = await run("manage_todo", {}, "infer-conv");
    expect(res.success).toBe(true);
    expect((res.output as { todos: unknown[] }).todos.length).toBe(1);
  });

  it("update with only a title matches the existing todo by title", async () => {
    await run("manage_todo", { title: "Match me" }, "infer-conv");
    const res = await run(
      "manage_todo",
      { title: "Match me", status: "completed" },
      "infer-conv",
    );
    expect(res.success).toBe(true);
    expect(res.output).toMatchObject({ todo: { title: "Match me", status: "done" } });
  });

  it("verb aliases map to canonical actions (add → create, set_status → update)", async () => {
    const res = await run("manage_todo", { action: "add", title: "Aliased" }, "infer-conv");
    expect(res.success).toBe(true);
    const id = (res.output as { todo: { id: string } }).todo.id;
    const upd = await run(
      "manage_todo",
      { action: "set_status", id, status: "done" },
      "infer-conv",
    );
    expect(upd.success).toBe(true);
    expect(upd.output).toMatchObject({ todo: { status: "done" } });
  });
});

describe("clear_todo · the one-shot wipe sub-tool", () => {
  it("clears every todo with no arguments", async () => {
    await run("manage_todo", { action: "clear" }, "clear-tool-conv");
    await run("manage_todo", { title: "One" }, "clear-tool-conv");
    await run("manage_todo", { title: "Two" }, "clear-tool-conv");
    const res = await run("clear_todo", {}, "clear-tool-conv");
    expect(res.success).toBe(true);
    expect(res.output).toMatchObject({ cleared: true });
    const list = await run("manage_todo", { action: "list" }, "clear-tool-conv");
    expect((list.output as { todos: unknown[] }).todos.length).toBe(0);
  });

  it("is registered next to manage_todo", () => {
    expect(getTool("clear_todo")).toBeDefined();
  });
});

describe("show_todo", () => {
  it("all: true returns the full list", async () => {
    await run("manage_todo", { operation: "clear" }, "show-conv");
    await run("manage_todo", { operation: "create", title: "Visible step" }, "show-conv");
    const res = await run("show_todo", { all: true }, "show-conv");
    expect(res.success).toBe(true);
    expect((res.output as { todos: { title: string }[] }).todos[0]!.title).toBe("Visible step");
  });
});
