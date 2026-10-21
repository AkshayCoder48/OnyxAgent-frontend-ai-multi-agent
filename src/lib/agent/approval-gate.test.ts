/**
 * Approval gate — PURE-LOGIC tests (no Dexie, no window). The verdict matrix
 * of `decideGateAction` is the security core of Task 2-d (PRD §8.2/§13.2):
 * allowed → execute; denied → never executes; approval_required →
 * interactive gate.
 */
import { describe, expect, it } from "vitest";
import {
  decideGateAction,
  operationLabelFor,
  permissionDeniedResult,
  riskNoteFor,
  selectPendingForToolCall,
  usePendingApprovals,
  type PendingApproval,
} from "./approval-gate";

describe("decideGateAction — the verdict matrix", () => {
  it("allowed → execute", () => {
    expect(decideGateAction("allowed", "web_search")).toEqual({ kind: "execute" });
  });

  it("denied → deny with the corrective string, never executes", () => {
    const action = decideGateAction("denied", "delete_file");
    expect(action.kind).toBe("deny");
    if (action.kind === "deny") {
      expect(action.toolResult).toContain("Permission denied:");
      expect(action.toolResult).toContain("delete_file");
      expect(action.toolResult).toContain("NOT executed");
      expect(action.toolResult).toContain("Project settings");
    }
  });

  it("approval_required → request_approval (the interactive wait)", () => {
    expect(decideGateAction("approval_required", "manage_env_var")).toEqual({
      kind: "request_approval",
    });
  });
});

describe("denial result copy", () => {
  it("names the tool and tells the model how to proceed", () => {
    const msg = permissionDeniedResult("composio_execute_tool");
    expect(msg).toContain("composio_execute_tool");
    expect(msg).toContain("Settings → Tools");
  });
});

describe("operationLabelFor — argument-aware human labels", () => {
  it("labels env-var writes vs reads", () => {
    expect(operationLabelFor("manage_env_var", { action: "add" })).toBe("Modify environment variables");
    expect(operationLabelFor("manage_env_var", { action: "delete" })).toBe("Delete environment variable");
    expect(operationLabelFor("manage_env_var", { action: "list" })).toBe("Read environment variables");
  });

  it("labels the sensitive built-ins", () => {
    expect(operationLabelFor("composio_execute_tool")).toBe("Run connector action");
    expect(operationLabelFor("delete_file")).toBe("Delete sandbox file");
    expect(operationLabelFor("delete_folder")).toBe("Delete sandbox folder");
  });

  it("falls back to a prettified tool name", () => {
    expect(operationLabelFor("web_search")).toBe("Web search");
  });
});

describe("riskNoteFor", () => {
  it("gives every gated category a note", () => {
    for (const tool of [
      "composio_execute_tool",
      "manage_env_var",
      "delete_file",
      "run_terminal",
      "some_custom_tool",
    ]) {
      expect(riskNoteFor(tool).length).toBeGreaterThan(10);
    }
  });
});

describe("pending-approvals store", () => {
  const make = (id: string, toolCallId: string | null): PendingApproval => ({
    approval_id: id,
    tool_call_id: toolCallId,
    tool_name: "manage_env_var",
    operation_type: "Modify environment variables",
    operation_parameters: { action: "add", name: "TEST" },
    risk_note: "note",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    project_id: null,
    conversation_id: "c1",
    source: "chat",
    opened_at: Date.now(),
  });

  it("upserts and removes; the tool-call selector finds only its own approval", () => {
    const store = usePendingApprovals.getState();
    store.upsert(make("apr_1", "call_1"));
    store.upsert(make("apr_2", "call_2"));
    expect(selectPendingForToolCall(usePendingApprovals.getState(), "call_1")?.approval_id).toBe("apr_1");
    expect(selectPendingForToolCall(usePendingApprovals.getState(), "call_2")?.approval_id).toBe("apr_2");
    expect(selectPendingForToolCall(usePendingApprovals.getState(), "call_x")).toBeNull();
    expect(selectPendingForToolCall(usePendingApprovals.getState(), null)).toBeNull();

    usePendingApprovals.getState().remove("apr_1");
    expect(selectPendingForToolCall(usePendingApprovals.getState(), "call_1")).toBeNull();
    usePendingApprovals.getState().remove("apr_2");
  });

  it("upsert is idempotent per approval id (gate + event-processor double publish)", () => {
    usePendingApprovals.getState().upsert(make("apr_x", "call_x"));
    usePendingApprovals.getState().upsert(make("apr_x", "call_x"));
    const state = usePendingApprovals.getState();
    expect(Object.keys(state.byId)).toEqual(["apr_x"]);
    usePendingApprovals.getState().remove("apr_x");
  });
});
