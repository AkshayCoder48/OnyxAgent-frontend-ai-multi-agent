// ============================================================================
// Background Task Execution Framework — POST /api/tasks/sync (FR-4.2 / PRD
// §4.1 client sync-back state machine).
//
// Marks a terminal run's clientSyncState as "synced" (artifacts extracted to
// Dexie/OPFS) or "conflicted" (local conversation/workspace changed after the
// task started — artifacts stay pending). The transition is one-directional
// from "pending" (idempotent: re-syncing an already-settled run is a no-op
// that still answers ok). Authorized by the client-minted task token against
// the stored sha256 hash.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/tasks/prisma";
import { sha256Hex, tokensEqual } from "@/lib/tasks/keyring";
import type { ClientSyncState } from "@/lib/tasks/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const SYNC_STATES: readonly ClientSyncState[] = ["synced", "conflicted"];

function unauthorized(): NextResponse {
  return NextResponse.json({ ok: false, error: "invalid runId or taskToken" }, { status: 401 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { runId?: unknown; taskToken?: unknown; state?: unknown };
  try {
    body = (await request.json()) as { runId?: unknown; taskToken?: unknown; state?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  const taskToken = typeof body.taskToken === "string" ? body.taskToken : "";
  const state = body.state;
  if (!runId || !taskToken) {
    return NextResponse.json(
      { ok: false, error: "runId and taskToken are required" },
      { status: 400 },
    );
  }
  if (typeof state !== "string" || !(SYNC_STATES as readonly string[]).includes(state)) {
    return NextResponse.json(
      { ok: false, error: "state must be \"synced\" or \"conflicted\"" },
      { status: 400 },
    );
  }

  const row = await prisma.taskRun.findUnique({
    where: { id: runId },
    select: { taskTokenHash: true },
  });
  if (!row) {
    return NextResponse.json({ ok: false, error: "run not found" }, { status: 404 });
  }
  if (!row.taskTokenHash || !tokensEqual(sha256Hex(taskToken), row.taskTokenHash)) {
    return unauthorized();
  }

  // One-directional pending → synced|conflicted; an already-settled run
  // answers ok without rewriting (idempotent client short-circuit).
  await prisma.taskRun.updateMany({
    where: { id: runId, clientSyncState: "pending" },
    data: { clientSyncState: state as ClientSyncState },
  });

  return NextResponse.json({ ok: true });
}
