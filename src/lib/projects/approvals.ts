"use client";

/**
 * Human-in-the-loop approval requests (PRD §13) — Dexie rows in the v4
 * `approval_requests` table.
 *
 * Lifecycle:
 *
 *   pending ──approve──▶ approved ──execute──▶ completed
 *       │                     └────fail─────▶ failed
 *       ├──reject──▶ rejected
 *       ├──cancel──▶ cancelled
 *       ├──15min──▶ expired   (sweepExpired also transitions lazily)
 *       └──params changed at execution time──▶ expired
 *
 * An approval is bound to the EXACT operation parameters via `params_hash`
 * (sha256 of the canonical JSON from `permissions.canonicalParamsHash`):
 * `resolveApproval` re-verifies the hash when the execution layer passes the
 * CURRENT params, so a stale approval can never authorize a modified
 * operation (PRD §13.6).
 */

import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import type { ApprovalRequest, ApprovalStatus } from "@/types";
import { canonicalParamsHash } from "./permissions";

/** Default pending-approval lifetime (PRD §13.5 — 15 minutes). */
export const APPROVAL_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateApprovalInput {
  conversation_id: string;
  /** null for general-chat approvals. */
  project_id?: string | null;
  tool_name: string;
  /** Human label, e.g. "Delete file". */
  operation_type: string;
  operation_parameters: Record<string, unknown>;
  risk_note?: string | null;
  /** Overrides APPROVAL_TTL_MS (tests use short TTLs). */
  ttl_ms?: number;
}

/** Create a PENDING approval request bound to the exact params hash. */
export async function createApprovalRequest(
  input: CreateApprovalInput,
): Promise<ApprovalRequest> {
  if (!input?.conversation_id) {
    throw new Error("A conversation id is required to create an approval request.");
  }
  if (!input?.tool_name) {
    throw new Error("A tool name is required to create an approval request.");
  }
  const parameters = input.operation_parameters ?? {};
  const paramsHash = await canonicalParamsHash(parameters);
  const ts = new Date();
  const approval: ApprovalRequest = {
    id: `apr_${nanoid(12)}`,
    project_id: input.project_id ?? null,
    conversation_id: input.conversation_id,
    operation_type: input.operation_type,
    tool_name: input.tool_name,
    operation_parameters: parameters,
    params_hash: paramsHash,
    status: "pending",
    risk_note: input.risk_note ?? null,
    result_summary: null,
    created_at: ts.toISOString(),
    expires_at: new Date(ts.getTime() + (input.ttl_ms ?? APPROVAL_TTL_MS)).toISOString(),
    resolved_at: null,
  };
  await db.approval_requests.add(approval);
  return approval;
}

// ---------------------------------------------------------------------------
// Resolve (user decision)
// ---------------------------------------------------------------------------

export type ApprovalDecision = "approved" | "rejected" | "cancelled";

export type ApprovalResolveReason =
  | "not_found"
  | "already_resolved"
  | "expired"
  | "params_changed";

export interface ResolveApprovalResult {
  ok: boolean;
  reason?: ApprovalResolveReason;
  approval?: ApprovalRequest;
}

function isExpiredAt(approval: ApprovalRequest, nowMs: number): boolean {
  if (!approval.expires_at) return false;
  const expires = Date.parse(approval.expires_at);
  return Number.isFinite(expires) && expires <= nowMs;
}

/**
 * Record the user's decision on a PENDING approval.
 *
 * Fails (ok: false) when the request doesn't exist, was already resolved,
 * has expired, or — when `currentParams` is provided — no longer matches the
 * params the approval was created for. A params mismatch ALSO transitions
 * the row to `expired`: the approval is invalid, not merely unconfirmed.
 */
export async function resolveApproval(
  id: string,
  decision: ApprovalDecision,
  currentParams?: Record<string, unknown>,
): Promise<ResolveApprovalResult> {
  const approval = await db.approval_requests.get(id);
  if (!approval) {
    return { ok: false, reason: "not_found" };
  }
  if (approval.status !== "pending") {
    return { ok: false, reason: "already_resolved", approval };
  }

  const now = new Date();
  if (isExpiredAt(approval, now.getTime())) {
    const expired = { ...approval, status: "expired" as const, resolved_at: now.toISOString() };
    await db.approval_requests.update(id, { status: "expired", resolved_at: expired.resolved_at });
    return { ok: false, reason: "expired", approval: expired };
  }

  // Params binding: the approval authorizes EXACTLY the hashed params.
  if (currentParams !== undefined) {
    const currentHash = await canonicalParamsHash(currentParams);
    if (currentHash !== approval.params_hash) {
      const invalidated = {
        ...approval,
        status: "expired" as const,
        resolved_at: now.toISOString(),
      };
      await db.approval_requests.update(id, {
        status: "expired",
        resolved_at: invalidated.resolved_at,
      });
      return { ok: false, reason: "params_changed", approval: invalidated };
    }
  }

  const resolved = { ...approval, status: decision, resolved_at: now.toISOString() };
  await db.approval_requests.update(id, {
    status: decision,
    resolved_at: resolved.resolved_at,
  });
  return { ok: true, approval: resolved };
}

// ---------------------------------------------------------------------------
// Sweep / list / complete
// ---------------------------------------------------------------------------

/**
 * Transition every PENDING approval whose expiry has passed to `expired`.
 * Safe to call repeatedly (the approval queue runs it before rendering).
 * Returns the number of swept rows.
 */
export async function sweepExpired(): Promise<number> {
  const nowMs = Date.now();
  const pending = await db.approval_requests.where("status").equals("pending").toArray();
  const stale = pending.filter((a) => isExpiredAt(a, nowMs));
  if (stale.length === 0) return 0;
  const resolvedAt = new Date().toISOString();
  await db.approval_requests.bulkPut(
    stale.map((a) => ({ ...a, status: "expired" as const, resolved_at: resolvedAt })),
  );
  return stale.length;
}

export interface ApprovalFilter {
  /** One status or several. */
  status?: ApprovalStatus | ApprovalStatus[];
  /** Project scope; `null` matches general-chat approvals (project_id null). */
  project_id?: string | null;
  conversation_id?: string;
}

/** Query approvals (newest first) for the approval queue UI. */
export async function listApprovals(
  filter?: ApprovalFilter,
): Promise<ApprovalRequest[]> {
  let rows: ApprovalRequest[];
  if (filter?.conversation_id) {
    rows = await db.approval_requests
      .where("conversation_id")
      .equals(filter.conversation_id)
      .toArray();
  } else if (filter?.status) {
    rows = Array.isArray(filter.status)
      ? await db.approval_requests.where("status").anyOf(filter.status).toArray()
      : await db.approval_requests.where("status").equals(filter.status).toArray();
  } else if (filter && filter.project_id !== undefined && filter.project_id !== null) {
    rows = await db.approval_requests.where("project_id").equals(filter.project_id).toArray();
  } else {
    rows = await db.approval_requests.toArray();
  }

  const statuses = filter?.status
    ? Array.isArray(filter.status)
      ? filter.status
      : [filter.status]
    : null;
  const out = rows.filter((a) => {
    if (statuses && !statuses.includes(a.status)) return false;
    if (filter?.conversation_id && a.conversation_id !== filter.conversation_id) return false;
    if (filter && filter.project_id !== undefined) {
      const matches =
        filter.project_id === null ? a.project_id == null : a.project_id === filter.project_id;
      if (!matches) return false;
    }
    return true;
  });
  out.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return out;
}

/**
 * Mark an APPROVED approval as completed (or failed) after execution, with
 * an honest result summary shown in the queue. Returns null when the id is
 * unknown or the row isn't in the approved state (e.g. the user rejected it
 * meanwhile — the execution layer must not run the operation then).
 */
export async function completeApproval(
  id: string,
  resultSummary: string,
  opts: { failed?: boolean } = {},
): Promise<ApprovalRequest | null> {
  const approval = await db.approval_requests.get(id);
  if (!approval || approval.status !== "approved") return null;
  const status: ApprovalStatus = opts.failed ? "failed" : "completed";
  await db.approval_requests.update(id, {
    status,
    result_summary: resultSummary,
  });
  return (await db.approval_requests.get(id)) ?? null;
}

export async function getApproval(id: string): Promise<ApprovalRequest | null> {
  const row = await db.approval_requests.get(id);
  return row ?? null;
}
