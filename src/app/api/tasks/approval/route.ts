// ============================================================================
// Background Task Execution Framework — POST /api/tasks/approval
// (Trigger.dev PRD §3.3 — Human-in-the-Loop).
//
// Resumes (or cancels) a cloud run SUSPENDED on a Trigger.dev waitpoint
// token. The worker's agent-run task published the approval request into
// its run metadata (`onyx.approval`) while parked on wait.forToken(); the
// status sync mirrored it into the TaskRun's progress JSON; the UI rendered
// the high-priority Approve/Deny banner (PRD §5.1 PAUSED mapping). This
// route is what the banner's buttons call.
//
//   body: { runId, taskToken, approved }
//
// Auth mirrors /api/tasks/cancel: the client-minted task token, compared
// constant-time against the stored sha256 hash. The decision itself is
// delivered to trigger.dev via POST /api/v1/waitpoints/tokens/:id/complete
// using the operator's environment secret key — the same authority that
// dispatched the run.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/tasks/prisma";
import { keyring, sha256Hex, tokensEqual } from "@/lib/tasks/keyring";
import { mergeProgressIntoRun } from "@/lib/tasks/run-store";
import { getCloudConfig, completeCloudWaitpoint } from "@/lib/tasks/trigger-cloud";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function bad(detail: string, status = 400): NextResponse {
  return NextResponse.json({ ok: false, error: detail }, { status });
}

interface ApprovalRequestBody {
  runId?: unknown;
  taskToken?: unknown;
  approved?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: ApprovalRequestBody;
  try {
    body = (await request.json()) as ApprovalRequestBody;
  } catch {
    return bad("invalid JSON body");
  }

  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  const taskToken = typeof body.taskToken === "string" ? body.taskToken.trim() : "";
  if (!runId || !taskToken) return bad("runId and taskToken are required");
  if (typeof body.approved !== "boolean") return bad("approved must be a boolean");

  const row = await prisma.taskRun.findUnique({
    where: { id: runId },
    select: {
      taskTokenHash: true,
      status: true,
      orchestrator: true,
      progress: true,
    },
  });
  if (!row) return bad("run not found", 404);
  if (!row.taskTokenHash || !tokensEqual(sha256Hex(taskToken), row.taskTokenHash)) {
    return bad("invalid task token", 401);
  }
  if (!["queued", "running"].includes(row.status)) {
    return bad(`run is already ${row.status} — no approval is pending`);
  }
  if (row.orchestrator !== "cloud") {
    return bad("approval is only supported for cloud-orchestrated runs");
  }

  // Locate the pending approval request in the row's progress mirror.
  interface MirroredApproval {
    token?: unknown;
    reason?: unknown;
    createdAt?: unknown;
    state?: unknown;
  }
  let approval: MirroredApproval | null = null;
  try {
    const parsed = JSON.parse(row.progress || "{}") as Record<string, unknown>;
    const raw = parsed.approval;
    if (raw && typeof raw === "object") {
      approval = raw as MirroredApproval;
    }
  } catch {
    approval = null;
  }
  if (!approval || typeof approval.token !== "string" || !approval.token) {
    return bad("no approval request is pending for this run");
  }
  if (approval.state === "approved" || approval.state === "denied") {
    return bad(`approval was already ${approval.state}`);
  }
  const waitpointId = approval.token;

  const cloud = await getCloudConfig();
  if (!cloud) {
    return bad("Trigger.dev Cloud is not connected — the suspended run cannot be resumed", 503);
  }

  try {
    // Deliver the decision — this RESUMES (or, on deny, lets the task settle
    // as cancelled) the parked cloud run.
    await completeCloudWaitpoint(cloud, waitpointId, body.approved);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[tasks] approval delivery failed for run ${runId}: ${message.slice(0, 200)}`);
    return bad("could not deliver the approval to Trigger.dev Cloud — retry in a moment", 502);
  }

  // Mirror the decision locally so the banner settles instantly (the next
  // status poll would also learn it from the resumed run's metadata).
  await mergeProgressIntoRun(runId, {
    approval: {
      token: waitpointId,
      reason: typeof approval.reason === "string" ? approval.reason : "",
      createdAt: typeof approval.createdAt === "number" ? approval.createdAt : Date.now(),
      state: body.approved ? "approved" : "denied",
    },
  } as unknown as Record<string, unknown>).catch(() => undefined);

  console.log(`[tasks] run ${runId} approval delivered: ${body.approved ? "APPROVED" : "DENIED"}`);
  return NextResponse.json({ ok: true, approved: body.approved });
}
