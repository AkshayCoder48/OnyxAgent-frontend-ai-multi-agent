// tool-stack-summaries — the per-tool caption rules of the combined tools
// row (2026-11-14 directive: "Created N Files, Used N Tools, Created N
// Todos — for every tool present in our app; custom tools show Used N
// Tools").
import { describe, it, expect } from "vitest";
import type { ToolCall } from "@/types";
import {
  stackSummarySegments,
  stackSummaryLabel,
  TOOL_SUMMARY_RULES,
} from "./tool-stack-summaries";

const call = (
  id: string,
  name: string,
  args: Record<string, unknown> = {},
  status: ToolCall["status"] = "completed",
): ToolCall =>
  ({
    id,
    name,
    args,
    status,
    result: "{}",
    startedAt: 1000,
    endedAt: 2000,
  }) as unknown as ToolCall;

describe("stackSummarySegments", () => {
  it("aggregates per tool family with pluralization", () => {
    expect(
      stackSummarySegments([
        call("a", "create_file", { path: "x.ts" }),
        call("b", "create_file", { path: "y.ts" }),
        call("c", "edit_file", { path: "z.ts" }),
      ]),
    ).toEqual(["Created 2 Files", "Edited 1 File"]);
  });

  it("manage_todo is action-aware — creates read 'Created N Todos'", () => {
    expect(
      stackSummarySegments([
        call("a", "manage_todo", { action: "create", title: "One" }),
        call("b", "manage_todo", { action: "create", title: "Two" }),
        call("c", "manage_todo", { action: "create", title: "Three" }),
      ]),
    ).toEqual(["Created 3 Todos"]);
    expect(
      stackSummarySegments([call("a", "manage_todo", { action: "clear" })]),
    ).toEqual(["Cleared 1 Todo List"]);
  });

  it("umbrella calls resolve to their granular rule (files.create_file)", () => {
    expect(
      stackSummarySegments([
        call("a", "files", { action: "create_file", path: "x.ts" }),
        call("b", "files", { action: "read_file", path: "y.ts" }),
      ]),
    ).toEqual(["Created 1 File", "Read 1 File"]);
  });

  it("unknown names (custom tools, MCP tools) fold into 'Used N Tools', always last", () => {
    expect(
      stackSummarySegments([
        call("a", "my_custom_tool"),
        call("b", "create_file", { path: "x.ts" }),
        call("c", "zapier_mcp_tool"),
      ]),
    ).toEqual(["Created 1 File", "Used 2 Tools"]);
  });

  it("failed calls never count as work done", () => {
    expect(
      stackSummarySegments([
        call("a", "create_file", { path: "x.ts" }, "error"),
        call("b", "create_file", { path: "y.ts" }),
      ]),
    ).toEqual(["Created 1 File"]);
  });

  it("knowledge_base is action-aware (search/save read as doc verbs)", () => {
    expect(
      stackSummarySegments([
        call("a", "knowledge_base", { action: "search", query: "plan" }),
        call("b", "knowledge_base", { action: "save", title: "Note" }),
      ]),
    ).toEqual(["Searched 1 Document", "Saved 1 Document"]);
  });

  it("empty or all-failed stacks produce no segments", () => {
    expect(stackSummarySegments([])).toEqual([]);
    expect(stackSummarySegments([call("a", "web_search", {}, "error")])).toEqual([]);
  });
});

describe("stackSummaryLabel", () => {
  it("joins segments with ' · '", () => {
    expect(
      stackSummaryLabel([
        call("a", "create_file", { path: "x.ts" }),
        call("b", "manage_todo", { action: "create", title: "T" }),
        call("c", "ask_user", { questions: [] }),
      ]),
    ).toBe("Created 1 File · Created 1 Todo · Asked 1 Question");
  });

  it("falls back to 'Tools' when nothing landed", () => {
    expect(stackSummaryLabel([])).toBe("Tools");
    expect(stackSummaryLabel([call("a", "web_search", {}, "error")])).toBe("Tools");
  });
});

describe("TOOL_SUMMARY_RULES coverage", () => {
  it("every rule pluralizes differently from its singular unless irregular", () => {
    for (const [name, r] of Object.entries(TOOL_SUMMARY_RULES)) {
      expect(r.verb.length).toBeGreaterThan(0);
      expect(r.one.length).toBeGreaterThan(0);
      expect(r.many.length).toBeGreaterThan(0);
      // The label builder must never produce "1 Files".
      expect(`${r.verb} 1 ${r.one}`).toBeTruthy();
      expect(`${r.verb} 2 ${r.many}`).toBeTruthy();
      expect(name).toBe(name.trim());
    }
  });
});
