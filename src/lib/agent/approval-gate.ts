"use client";

/**
 * HITL APPROVAL GATE (Task 2-d — PRD §8.2 resource permissions + §13
 * human-in-the-loop approvals).
 *
 * ONE gate function — `maybeGateToolCall` — is called at EVERY tool dispatch
 * site before a handler runs:
 *
 *   - foreground runtime (runtime.ts per-tool execute loop)
 *   - both subagent dispatch sites (subagent-runtime.ts)
 *
 * The wait mechanism copies ask-user-wait.ts exactly: the gate emits the
 * `approval_request` WSEvent (payload from the ApprovalRequest row it just
 * created, bound to the EXACT params via params_hash), sets the orb
 * `awaiting_approval` override, then waits for a window CustomEvent
 * `agent:approval-response` with detail `{ approval_id, decision }` — raced
 * against a wall-clock expiry timer (expires_at) and the turn's abort
 * signal. `resolveApproval` is the ONLY writer of the decision and it
 * re-verifies the params hash at execution time (PRD §13.6: an approval
 * authorizes exactly the proposed operation — model text never counts, and
 * a changed-params approval is invalidated, not reused).
 */

import { create } from "zustand";
import type { ResourcePermission } from "@/types";
import type { WSEvent } from "@/types";
import { db } from "@/lib/db";
import {
  resolvePermission,
  resolveToolPermission,
  type GlobalPolicyEntries,
} from "@/lib/projects/permissions";
import {
  APPROVAL_TTL_MS,
  createApprovalRequest,
  resolveApproval,
  completeApproval,
} from "@/lib/projects/approvals";
import { setOrbOverrideState } from "@/stores/orb-personality-store";
import { logWarn } from "@/lib/client-logger";

// ---------------------------------------------------------------------------
// Response event (the ask-user-wait pattern, mirrored exactly)
// ---------------------------------------------------------------------------

/** Window CustomEvent the UI dispatches with the user's decision. */
export const APPROVAL_RESPONSE_EVENT = "agent:approval-response";

export type ApprovalResponseDecision = "approved" | "rejected" | "cancelled";

/** Dispatch the user's decision to a waiting gate (chat card + queue use this). */
export function respondToApproval(
  approvalId: string,
  decision: ApprovalResponseDecision,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(APPROVAL_RESPONSE_EVENT, {
      detail: { approval_id: approvalId, decision },
    }),
  );
}

// ---------------------------------------------------------------------------
// Pending-approvals store — the live link between gates and the UI cards
// ---------------------------------------------------------------------------

/** What a waiting approval card needs (mirrors ApprovalRequestEvent + the
 *  tool_call_id correlation so the chat card can find ITS approval). */
export interface PendingApproval {
  approval_id: string;
  /** The tool_call card this approval belongs to. */
  tool_call_id?: string | null;
  tool_name: string;
  operation_type: string;
  operation_parameters: Record<string, unknown>;
  risk_note: string | null;
  expires_at: string | null;
  project_id: string | null;
  conversation_id: string;
  /** Where the gated call came from — cards render differently per source. */
  source: "chat" | "subagent";
  /** Epoch ms when the store entry landed (UI ordering). */
  opened_at: number;
}

interface PendingApprovalsState {
  byId: Record<string, PendingApproval>;
  upsert: (payload: PendingApproval) => void;
  remove: (approvalId: string) => void;
  clear: () => void;
}

/** Live pending approvals — populated by the gate AND (idempotently) by the
 *  event-processor's approval_request case. Not persisted: a reload kills
 *  the waiting gate anyway). */
export const usePendingApprovals = create<PendingApprovalsState>()((set) => ({
  byId: {},
  upsert: (payload) =>
    set((s) => ({ byId: { ...s.byId, [payload.approval_id]: payload } })),
  remove: (approvalId) =>
    set((s) => {
      const next = { ...s.byId };
      delete next[approvalId];
      return { byId: next };
    }),
  clear: () => set({ byId: {} }),
}));

/** The pending approval for one tool call, if any (chat card lookup). */
export function selectPendingForToolCall(
  state: PendingApprovalsState,
  toolCallId: string | null | undefined,
): PendingApproval | null {
  if (!toolCallId) return null;
  for (const p of Object.values(state.byId)) {
    if (p.tool_call_id === toolCallId) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Human labels + risk notes (PRD §13.4 — the card explains the operation)
// ---------------------------------------------------------------------------

const writeEnvActions: ReadonlySet<string> = new Set(["add", "set", "edit", "delete"]);

/** Argument-aware human label for the approval card / queue. */
export function operationLabelFor(
  toolName: string,
  args?: Record<string, unknown> | null,
): string {
  if (toolName === "manage_env_var" || /_env_var$/.test(toolName)) {
    const action = typeof args?.action === "string" ? args.action : "";
    if (action === "delete" || toolName === "delete_env_var") return "Delete environment variable";
    if (toolName === "list_env_vars" || toolName === "get_env_var" || action === "list" || action === "get") {
      return "Read environment variables";
    }
    return "Modify environment variables";
  }
  if (toolName === "composio_execute_tool") return "Run connector action";
  if (toolName === "delete_file") return "Delete sandbox file";
  if (toolName === "delete_folder") return "Delete sandbox folder";
  if (toolName === "run_terminal") return "Run terminal command";
  if (toolName === "manage_chats") return "Manage conversations";
  // Generic: "manage_todo" → "Manage todo".
  const pretty = toolName
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
  return pretty || toolName;
}

/** Short risk note shown on the card (why this action is gated). */
export function riskNoteFor(toolName: string): string {
  if (toolName === "composio_execute_tool") {
    return "Executes an action in an external app (messages, emails, records, payments) on your behalf.";
  }
  if (toolName === "manage_env_var" || /_env_var$/.test(toolName)) {
    return "Writes or deletes environment variables, which often hold credentials for your sandbox.";
  }
  if (toolName === "delete_file" || toolName === "delete_folder") {
    return "Permanently removes files or folders from the workspace — this cannot be undone.";
  }
  if (toolName === "run_terminal") {
    return "Runs shell commands inside the sandbox with real side effects.";
  }
  return "This action is marked as sensitive by your approval policy.";
}

// ---------------------------------------------------------------------------
// Pure decision core (unit-tested without Dexie)
// ---------------------------------------------------------------------------

export const PERMISSION_DENIED_PREFIX = "Permission denied:";

/** The corrective result for a permission-DENIED tool (never executes). */
export function permissionDeniedResult(toolName: string): string {
  return (
    `${PERMISSION_DENIED_PREFIX} ${toolName} is not allowed here. ` +
    "The action was NOT executed. Ask the user to change the project's resource access " +
    "(Project settings → Resources) or the global approval policy (Settings → Tools) " +
    "if they want this action to run."
  );
}

export type GateAction =
  | { kind: "execute" }
  | { kind: "deny"; toolResult: string }
  | { kind: "request_approval" };

/**
 * The pure permission → action mapping:
 *
 *   allowed           → execute
 *   denied            → deny with the corrective string (PRD §8.2 — a denied
 *                       tool must NEVER execute)
 *   approval_required → interactive gate (the human-in-the-loop wait).
 */
export function decideGateAction(
  permission: ResourcePermission,
  toolName: string,
): GateAction {
  if (permission === "allowed") return { kind: "execute" };
  if (permission === "denied") {
    return { kind: "deny", toolResult: permissionDeniedResult(toolName) };
  }
  return { kind: "request_approval" };
}

// ---------------------------------------------------------------------------
// Conversation → project resolution
// ---------------------------------------------------------------------------

/**
 * The project a conversation belongs to (null = general chat / unknown id —
 * subagent session ids and orphaned ids resolve to null → global policy
 * only, which is the correct scoping for both).
 */
export async function resolveProjectIdForConversation(
  conversationId: string | null | undefined,
): Promise<string | null> {
  if (!conversationId) return null;
  try {
    const row = await db.conversations.get(conversationId);
    return row?.project_id ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface GateInput {
  toolName: string;
  args: Record<string, unknown>;
  /** Correlates the approval card with THIS tool call's chat card. */
  toolCallId?: string | null;
  conversationId: string | null;
  /** The conversation's project — resolved via Dexie when omitted. */
  projectId?: string | null;
  emit: (event: WSEvent) => void;
  signal?: AbortSignal;
  /** Where the call came from (card copy / queue labels). */
  source?: "chat" | "subagent";
}

export type GateOutcome =
  | { verdict: "allowed"; approvalId?: string }
  | { verdict: "denied"; reason: string }
  | { verdict: "executed"; result: string; status: "error" | "completed" };

/**
 * Gate ONE tool call. Call BEFORE the tool handler runs; on any non-allowed
 * verdict feed `reason`/`result` through the normal tool-result protocol and
 * NEVER execute the handler. On `allowed` WITH `approvalId`, execute
 * normally and then call `recordApprovalOutcome` with the real result.
 */
export async function maybeGateToolCall(input: GateInput): Promise<GateOutcome> {
  // 1. Resolve the effective permission (global policy + project rules —
  //    strictest wins). A resolution FAILURE fails open to the argument-aware
  //    defaults (resolveToolPermission already degrades to defaults when
  //    signed out); a hard failure here would brick every tool call.
  let projectId: string | null | undefined = input.projectId;
  if (projectId === undefined) {
    projectId = await resolveProjectIdForConversation(input.conversationId);
  }
  let permission: ResourcePermission;
  try {
    permission = await resolveToolPermission(input.toolName, input.args, projectId);
  } catch (err) {
    logWarn("agent", `Approval gate: permission resolution failed for ${input.toolName} — defaulting to argument-aware policy`, {
      context: { tool: input.toolName, error: err instanceof Error ? err.message : String(err) },
    });
    permission = resolvePermission(input.toolName, input.args, {});
  }

  const action = decideGateAction(permission, input.toolName);
  if (action.kind === "execute") return { verdict: "allowed" };
  if (action.kind === "deny") {
    return { verdict: "denied", reason: action.toolResult };
  }

  // 2. approval_required (interactive) — but a request row needs a
  //    conversation to hang off. Without one there is no honest way to seek
  //    a decision → block with an explicit message.
  if (!input.conversationId) {
    return {
      verdict: "executed",
      result:
        `${input.toolName} requires approval, but this call has no conversation context to ` +
        "attach an approval request to, so it was not executed.",
      status: "error",
    };
  }

  // 3. Create the ApprovalRequest row (params-hash bound, 15-min TTL).
  let approvalId: string;
  let expiresAt: string | null;
  try {
    const approval = await createApprovalRequest({
      conversation_id: input.conversationId,
      project_id: projectId,
      tool_name: input.toolName,
      operation_type: operationLabelFor(input.toolName, input.args),
      operation_parameters: input.args ?? {},
      risk_note: riskNoteFor(input.toolName),
    });
    approvalId = approval.id;
    expiresAt = approval.expires_at ?? null;
  } catch (err) {
    return {
      verdict: "executed",
      result:
        `${input.toolName} requires approval, but creating the approval request failed ` +
        `(${err instanceof Error ? err.message : String(err)}), so it was not executed.`,
      status: "error",
    };
  }

  const payload: PendingApproval = {
    approval_id: approvalId,
    tool_call_id: input.toolCallId ?? null,
    tool_name: input.toolName,
    operation_type: operationLabelFor(input.toolName, input.args),
    operation_parameters: input.args ?? {},
    risk_note: riskNoteFor(input.toolName),
    expires_at: expiresAt,
    project_id: projectId,
    conversation_id: input.conversationId,
    source: input.source ?? "chat",
    opened_at: Date.now(),
  };

  // 4. Publish: live store (cards) + WSEvent (protocol/replay) + card status
  //    + orb override. The store upsert is idempotent with the
  //    event-processor's approval_request case (same approval_id key).
  usePendingApprovals.getState().upsert(payload);
  try {
    input.emit({
      type: "approval_request",
      data: {
        approval_id: payload.approval_id,
        tool_name: payload.tool_name,
        operation_type: payload.operation_type,
        operation_parameters: payload.operation_parameters,
        risk_note: payload.risk_note,
        expires_at: payload.expires_at,
        ...(payload.tool_call_id ? { tool_call_id: payload.tool_call_id } : {}),
      },
      timestamp: new Date().toISOString(),
    });
    if (input.toolCallId) {
      // Flip the tool card to the awaiting-approval state (the processor's
      // tool_call update path threads `status` through — additive).
      input.emit({
        type: "tool_call",
        data: {
          tool_name: input.toolName,
          args: input.args ?? {},
          tool_call_id: input.toolCallId,
          status: "awaiting_approval",
        },
        timestamp: new Date().toISOString(),
      });
    }
  } catch {
    // The wait below still works — the queue can resolve the row even if the
    // event pipeline hiccuped.
  }
  setOrbOverrideState("awaiting_approval");

  try {
    // 5. WAIT: CustomEvent decision vs wall-clock expiry vs abort signal.
    const decision = await waitForApprovalDecision(approvalId, expiresAt, input.signal);

    // 6. resolveApproval is the ONLY decision writer — it re-verifies the
    //    params hash against the CURRENT args, so a decision can only ever
    //    authorize exactly the proposed operation (PRD §13.6).
    const recorded = await resolveApproval(
      approvalId,
      decision === "approved" || decision === "rejected" ? decision : "cancelled",
      input.args,
    );

    if (recorded.ok && decision === "approved") {
      // Approved + hash-verified → the site executes normally now.
      return { verdict: "allowed", approvalId };
    }
    if (recorded.ok && decision === "rejected") {
      return {
        verdict: "executed",
        result:
          "User rejected this action. It was not executed. Do not retry it — ask the user " +
          "what they would like changed first.",
        status: "error",
      };
    }
    if (recorded.ok && decision === "cancelled") {
      return {
        verdict: "executed",
        result: "The action was cancelled before a decision (the turn was stopped).",
        status: "error",
      };
    }
    // Not ok — honest failure from the recorded reason.
    return { verdict: "executed", result: resolveFailureMessage(decision, recorded.reason), status: "error" };
  } finally {
    // The orb override + live card state clear no matter how the gate ends.
    setOrbOverrideState(null);
    usePendingApprovals.getState().remove(approvalId);
  }
}

function resolveFailureMessage(
  decision: ApprovalResponseDecision | null,
  reason?: string,
): string {
  if (reason === "params_changed") {
    return (
      "The approval no longer matches the operation's parameters (they changed after the " +
      "request was created), so it was invalidated and the action did not run."
    );
  }
  if (reason === "already_resolved") {
    return "The approval request was already resolved by another decision — the action did not run.";
  }
  if (decision === null || reason === "expired") {
    return (
      "The approval request expired (15-minute lifetime) without a decision, so the action " +
      "did not run. Ask the user and try again if it is still needed."
    );
  }
  return "The approval could not be recorded, so the action did not run.";
}

/**
 * The wait — copies ask-user-wait's CustomEvent pattern, plus:
 *   - per-approval matching (many gates can wait concurrently — parallel
 *     tool calls each with their own approval),
 *   - a wall-clock timer that fires at expires_at (+grace) so the wait can
 *     never hang past the request's lifetime,
 *   - abort-signal resolution as cancelled.
 */
function waitForApprovalDecision(
  approvalId: string,
  expiresAt: string | null,
  signal?: AbortSignal,
): Promise<ApprovalResponseDecision | null> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") {
      resolve(null);
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abortListener: (() => void) | null = null;
    const cleanup = () => {
      window.removeEventListener(APPROVAL_RESPONSE_EVENT, handler);
      if (timer !== null) clearTimeout(timer);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
    };
    const finish = (value: ApprovalResponseDecision | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const handler = (event: Event) => {
      const ce = event as CustomEvent<{ approval_id?: string; decision?: string }>;
      if (ce.detail?.approval_id !== approvalId) return; // another gate's decision
      const d = ce.detail.decision;
      if (d === "approved" || d === "rejected" || d === "cancelled") finish(d);
    };
    window.addEventListener(APPROVAL_RESPONSE_EVENT, handler);

    if (signal) {
      abortListener = () => finish("cancelled");
      signal.addEventListener("abort", abortListener);
    }

    // Wall-clock expiry race — always armed (hard cap when expires_at is
    // unparseable so a bogus row can never hang the gate forever).
    const expiresMs = expiresAt ? Date.parse(expiresAt) : NaN;
    const untilExpiry = Number.isFinite(expiresMs)
      ? Math.max(0, expiresMs - Date.now()) + 750 // grace so resolveApproval sees it expired first
      : APPROVAL_TTL_MS + 60_000;
    timer = setTimeout(() => finish(null), untilExpiry);
  });
}

// ---------------------------------------------------------------------------
// Outcome recording (PRD §13.6 — record the outcome)
// ---------------------------------------------------------------------------

/** After an APPROVED tool executes, mark the approval row completed/failed
 *  with an honest summary (best-effort, never throws). */
export async function recordApprovalOutcome(
  approvalId: string,
  result: unknown,
  failed?: boolean,
): Promise<void> {
  try {
    let summary: string;
    if (typeof result === "string") {
      summary = result;
    } else {
      try {
        summary = JSON.stringify(result);
      } catch {
        summary = String(result);
      }
    }
    if (summary.length > 200) summary = `${summary.slice(0, 200)}…`;
    await completeApproval(approvalId, summary, { failed });
  } catch {
    // best-effort — the queue shows the row as approved without a summary
  }
}

/** Exported for the settings UI (one write surface for the global policy). */
export type { GlobalPolicyEntries };
