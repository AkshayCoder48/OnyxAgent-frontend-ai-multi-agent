// ============================================================================
// Background Task Execution Framework — GET /api/tasks/artifact/[id] (FR-4.2).
//
// Artifact extraction for the client sync-back: ?token=<taskToken> is
// verified as sha256(token) === run.taskTokenHash. Token-less runs
// (schedule-fired — the minted server-side token never left the triggering
// browser's process, and no browser token exists at all) are readable
// without one whenever the row has no hash to check against.
//
// The response carries the FULL stored content (already capped at write time
// by the driver's artifact budgets) — no read-time truncation.
//
// Body-logging discipline mirrors /api/chat-proxy: tokens are never logged.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/tasks/prisma";
import { sha256Hex, tokensEqual } from "@/lib/tasks/keyring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const token = request.nextUrl.searchParams.get("token") ?? "";

  const artifact = await prisma.taskArtifact.findUnique({
    where: { id },
    include: { run: { select: { taskTokenHash: true } } },
  });
  if (!artifact) {
    return NextResponse.json({ ok: false, error: "artifact not found" }, { status: 404 });
  }

  // Token required whenever the parent run minted one; hash-less runs
  // (schedule-fired) are the open-by-design exception.
  if (artifact.run.taskTokenHash) {
    if (!token || !tokensEqual(sha256Hex(token), artifact.run.taskTokenHash)) {
      return NextResponse.json(
        { ok: false, error: "invalid or missing artifact token" },
        { status: 401 },
      );
    }
  }

  return NextResponse.json({
    ok: true,
    artifact: {
      id: artifact.id,
      runId: artifact.runId,
      kind: artifact.kind,
      name: artifact.name,
      path: artifact.path,
      mimeType: artifact.mimeType,
      content: artifact.content,
      encoding: artifact.encoding,
      size: artifact.size,
      truncated: artifact.truncated,
      createdAt: artifact.createdAt.toISOString(),
    },
  });
}
