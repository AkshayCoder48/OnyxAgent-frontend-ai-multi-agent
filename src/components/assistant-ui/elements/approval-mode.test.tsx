// @vitest-environment jsdom
/**
 * Approval Mode (user directive 2026-11-05) — the preset helpers in
 * permissions.ts and the ApprovalCard's [Always for this tool] decision.
 *
 * Pins:
 *  - the preset covers exactly the destructive / external / expensive /
 *    powerful tools, all REGISTERED tool names, with no reads inside;
 *  - buildApprovalModeEntries: ON gates every preset tool, OFF REMOVES the
 *    entries (null) so tools fall back to their argument-aware defaults;
 *  - approvalModeGatedCount counts only gated preset tools;
 *  - the ApprovalCard renders [Allow once] [Always for this tool] [Deny];
 *    "Always" writes {tool: "allowed"} to the global policy and THEN
 *    responds approved — a failed policy write never approves.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import {
  APPROVAL_MODE_TOOL_NAMES,
  APPROVAL_MODE_TOOLS,
  approvalModeGatedCount,
  buildApprovalModeEntries,
} from "@/lib/projects/permissions";

// The card's external deps — mocked so the test never touches IndexedDB or
// the auth store.
vi.mock("@/lib/agent/approval-gate", () => ({
  respondToApproval: vi.fn(),
  selectPendingForToolCall: (_s: unknown, toolCallId: string) =>
    toolCallId === "call-1"
      ? {
          approval_id: "apr_1",
          tool_call_id: "call-1",
          tool_name: "delete_file",
          operation_type: "Delete file",
          operation_parameters: { path: "uploads/report.pdf" },
          risk_note: "Permanently removes the file.",
          expires_at: null,
          project_id: null,
          conversation_id: "c1",
          source: "chat" as const,
          opened_at: Date.now(),
        }
      : null,
  usePendingApprovals: (sel: (s: unknown) => unknown) =>
    sel({ byId: {} }),
}));

const { setGlobalPolicyMock } = vi.hoisted(() => ({
  setGlobalPolicyMock: vi.fn(),
}));
vi.mock("@/lib/projects/permissions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/projects/permissions")>();
  return { ...actual, setGlobalPolicy: setGlobalPolicyMock };
});

import { ApprovalCard } from "./tool-call";

/** Every built-in tool registers at app boot (side-effect import, same as
 *  the settings page does). Returns the preset tools that did NOT register.
 *  Uses getTool — the EXECUTOR surface — because umbrella consolidation
 *  hides several preset tools (delete_file, run_terminal, …) from the
 *  model-visible listTools(). */
async function unresolvedPresetTools(): Promise<string[]> {
  await import("@/lib/tools");
  const { getTool } = await import("@/lib/tools/registry");
  return APPROVAL_MODE_TOOL_NAMES.filter((t) => getTool(t) === undefined);
}

describe("Approval Mode preset (permissions.ts)", () => {
  it("every preset tool is a REGISTERED tool name", async () => {
    const missing = await unresolvedPresetTools();
    expect(missing, `not registered: ${missing.join(", ")}`).toEqual([]);
  });

  it("the destructive category contains the known delete tools", () => {
    expect(APPROVAL_MODE_TOOLS.destructive).toContain("delete_file");
    expect(APPROVAL_MODE_TOOLS.destructive).toContain("delete_folder");
    expect(APPROVAL_MODE_TOOLS.external).toContain("composio_execute_tool");
    expect(APPROVAL_MODE_TOOLS.expensive).toContain("media_generation");
    // generate_image is deliberately NOT gated: it is free + unlimited
    // (Perchance) — gating it would ask without protecting anything.
    expect(APPROVAL_MODE_TOOLS.expensive).not.toContain("generate_image");
    expect(APPROVAL_MODE_TOOLS.powerful).toContain("run_terminal");
  });

  it("no read-only tools are in the preset (reads must never be gated)", () => {
    const reads = ["read_file", "list_folder", "list_uploaded_files", "env_get", "kv_get", "storage_read", "list_scheduled_tasks"];
    const overlap = APPROVAL_MODE_TOOL_NAMES.filter((t) => reads.includes(t));
    expect(overlap).toEqual([]);
  });

  it("ON gates every preset tool; OFF removes the entries (null)", () => {
    const on = buildApprovalModeEntries(true);
    expect(Object.keys(on)).toHaveLength(APPROVAL_MODE_TOOL_NAMES.length);
    for (const v of Object.values(on)) expect(v).toBe("approval_required");

    const off = buildApprovalModeEntries(false);
    expect(Object.keys(off)).toHaveLength(APPROVAL_MODE_TOOL_NAMES.length);
    for (const v of Object.values(off)) expect(v).toBeNull();
  });

  it("approvalModeGatedCount counts only gated preset tools", () => {
    const policy = { delete_file: "approval_required", run_terminal: "approval_required", read_file: "approval_required" };
    expect(approvalModeGatedCount(policy)).toBe(2);
    expect(approvalModeGatedCount({})).toBe(0);
  });
});

describe("ApprovalCard — the three decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders [Allow once] [Always for this tool] [Deny]", () => {
    render(<ApprovalCard toolCallId="call-1" toolName="delete_file" />);
    expect(screen.getByRole("button", { name: "Allow once" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Always for this tool" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });

  it("[Always for this tool] writes the policy THEN approves this call", async () => {
    setGlobalPolicyMock.mockResolvedValue({ delete_file: "allowed" });
    const { respondToApproval } = await import("@/lib/agent/approval-gate");
    render(<ApprovalCard toolCallId="call-1" toolName="delete_file" />);
    fireEvent.click(screen.getByRole("button", { name: "Always for this tool" }));
    await waitFor(() => expect(setGlobalPolicyMock).toHaveBeenCalledTimes(1));
    expect(setGlobalPolicyMock).toHaveBeenCalledWith({ delete_file: "allowed" });
    await waitFor(() =>
      expect(respondToApproval).toHaveBeenCalledWith("apr_1", "approved"),
    );
  });

  it("a failed policy write NEVER approves — the card re-arms", async () => {
    setGlobalPolicyMock.mockRejectedValue(new Error("disk on fire"));
    const { respondToApproval } = await import("@/lib/agent/approval-gate");
    render(<ApprovalCard toolCallId="call-1" toolName="delete_file" />);
    fireEvent.click(screen.getByRole("button", { name: "Always for this tool" }));
    await waitFor(() => expect(setGlobalPolicyMock).toHaveBeenCalledTimes(1));
    expect(respondToApproval).not.toHaveBeenCalled();
    // Re-armed: the buttons are enabled again.
    expect(screen.getByRole("button", { name: "Allow once" })).toBeEnabled();
  });

  it("[Deny] responds rejected without touching the policy", async () => {
    const { respondToApproval } = await import("@/lib/agent/approval-gate");
    render(<ApprovalCard toolCallId="call-1" toolName="delete_file" />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(respondToApproval).toHaveBeenCalledWith("apr_1", "rejected");
    expect(setGlobalPolicyMock).not.toHaveBeenCalled();
  });
});
