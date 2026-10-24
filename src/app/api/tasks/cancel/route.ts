// ============================================================================
// Background Task Execution Framework — POST /api/tasks/cancel (FR-3.3).
//
// Authorizes via the client-minted task token (sha256 against the stored
// TaskRun.taskTokenHash — the plaintext never touches the server disk), then:
//   · atomically moves queued/running → cancelled (never clobbers terminal
//     states),
//   · best-effort cancels the backing run on Trigger.dev Cloud (cloud
//     runs carry a cloud run id in TaskRun.externalRunId; the deployed
//     worker's E2B sandbox dies with its run),
//   · drops the in-memory keyring entry (credentials die with the run).
//
// Body-logging discipline mirrors /api/chat-proxy: tokens are never logged.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/tasks/prisma";
import { keyring, sha256Hex, tokensEqual } from "@/lib/tasks/keyring";
import { cancelCloudRunById, getCloudConfig } from "@/lib/tasks/trigger-cloud";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function unauthorized(): NextResponse {
  return NextResponse.json({ ok: false, error: "invalid runId or taskToken" }, { status: 401 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { runId?: unknown; taskToken?: unknown };
  try {
    body = (await request.json()) as { runId?: unknown; taskToken?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  const taskToken = typeof body.taskToken === "string" ? body.taskToken : "";
  if (!runId || !taskToken) {
    return NextResponse.json(
      { ok: false, error: "runId and taskToken are required" },
      { status: 400 },
    );
  }

  const row = await prisma.taskRun.findUnique({
    where: { id: runId },
    select: {
      taskTokenHash: true,
      status: true,
      sandboxId: true,
      orchestrator: true,
      externalRunId: true,
    },
  });
  if (!row) {
    return NextResponse.json({ ok: false, error: "run not found" }, { status: 404 });
  }
  if (!row.taskTokenHash || !tokensEqual(sha256Hex(taskToken), row.taskTokenHash)) {
    return unauthorized();
  }

  // Atomic cancel — only from the live states; a terminal row is left alone.
  const cancelled = await prisma.taskRun.updateMany({
    where: { id: runId, status: { in: ["queued", "running"] } },
    data: { status: "cancelled", finishedAt: new Date() },
  });

  // Free the execution substrate when this process owns it. Cloud runs:
  // cancel the backing run on api.trigger.dev (the deployed worker's
  // sandbox dies with its run). Best-effort by contract — never fails the
  // response.
  if (cancelled.count > 0 && row.externalRunId) {
    const cloud = await getCloudConfig();
    if (cloud) {
      await cancelCloudRunById(cloud, row.externalRunId).catch(() => {
        // best-effort — the row is already cancelled locally
      });
    }
  }

  // Credentials die with the run (PRD §4.2) — idempotent with the driver's
  // own finally-drop.
  keyring.drop(runId);

  return NextResponse.json({ ok: true });
}
