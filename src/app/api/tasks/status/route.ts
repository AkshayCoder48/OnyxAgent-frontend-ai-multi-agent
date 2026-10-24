// ============================================================================
// Background Task Execution Framework — GET /api/tasks/status (FR-3.1).
//
//   ?runId=<id>&cursor=<lastSeq>   single run (TaskStatusResponse):
//       · sweep-on-read housekeeping FIRST — adoptStaleRuns() (local mode
//         only; single indexed query when nothing is stale) + the throttled
//         schedule touch() + CLOUD self-heal (healStaleCloudRuns settles
//         runs the cloud worker never reported terminal for), so a
//         poll-driven session keeps runs alive, schedules firing and cloud
//         rows truthful even with the loop dead.
//       · chunks: only seq > cursor (cursor defaults -1), each content
//         truncated to 4000 chars ON READ (the row stores 16k for
//         artifact-grade consumers).
//   ?list=1&userId=<id>             latest 50 runs (TaskListResponse, no
//                                   chunks) for the client's mirror reconcile.
//
// Body-logging discipline mirrors /api/chat-proxy: run rows carry prompts and
// conversation slices — never logged.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import type { TaskRun } from "@prisma/client";
import { prisma } from "@/lib/tasks/prisma";
import { adoptStaleRuns } from "@/lib/tasks/local-driver";
import { startSchedulerLoop, touch } from "@/lib/tasks/cron-scheduler";
import { getOrchestrationMode } from "@/lib/tasks/orchestration-mode";
import { healStaleCloudRuns } from "@/lib/tasks/trigger-cloud";
import { buildProgressView, parseChunks } from "@/lib/tasks/run-store";
import type {
  BackgroundTaskType,
  TaskArtifactSummary,
  TaskListResponse,
  TaskPhase,
  TaskRunStatus,
  TaskStatusChunk,
  TaskStatusResponse,
  TaskStatusRun,
} from "@/lib/tasks/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Per-chunk content cap on READ (row stores more — see CHUNK_WRITE_MAX_CHARS). */
const CHUNK_READ_MAX_CHARS = 4_000;
/** List view page size. */
const LIST_LIMIT = 50;

function bad(detail: string, status = 400): NextResponse {
  return NextResponse.json({ ok: false, error: detail }, { status });
}

/** Row → TaskStatusRun (no chunks; the single-run view adds them). */
function toStatusRun(row: TaskRun, artifacts: TaskArtifactSummary[]): TaskStatusRun {
  return {
    runId: row.id,
    taskId: row.taskId,
    type: row.type as BackgroundTaskType,
    status: row.status as TaskRunStatus,
    phase: row.phase as TaskPhase,
    // "cloud" rows report as "triggerdev" — the frozen protocol union;
    // the per-run cloud id below is how clients distinguish/link them.
    orchestrator: row.orchestrator === "local" ? "local" : "triggerdev",
    title: row.title,
    prompt: row.prompt,
    progress: buildProgressView(row.progress, row.updatedAt),
    sandboxId: row.sandboxId,
    startedAt: row.startedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    error: row.error,
    artifacts,
    scheduleId: row.scheduleId,
    ...(row.externalRunId ? { cloudRunId: row.externalRunId } : {}),
  };
}

const ARTIFACT_SUMMARY_SELECT = {
  id: true,
  runId: true,
  kind: true,
  name: true,
  mimeType: true,
  size: true,
  truncated: true,
  createdAt: true,
} as const;

type ArtifactSummaryRow = {
  id: string;
  runId: string;
  kind: string;
  name: string;
  mimeType: string;
  size: number;
  truncated: boolean;
  createdAt: Date;
};

function toArtifactSummary(row: ArtifactSummaryRow): TaskArtifactSummary {
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    truncated: row.truncated,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;

  // ── list view ───────────────────────────────────────────────────────────
  if (params.get("list") === "1") {
    const userId = params.get("userId")?.trim();
    if (!userId) return bad("userId is required with list=1");
    const mode = await getOrchestrationMode();
    touch(); // throttled sweep-on-read (self-gates to arm-only in worker modes)
    startSchedulerLoop(); // idempotent — revives the loop after a restart
    // Cloud self-heal: fire-and-forget, throttled internally (settled rows
    // surface on the next poll — eventual consistency is fine for lists).
    if (mode === "cloud") void healStaleCloudRuns().catch(() => {});
    // Schedule-fired runs carry the synthetic "scheduled" user id (no
    // originating browser) — they are single-user-app-visible by design so
    // the strip can surface scheduled activity.
    const rows = await prisma.taskRun.findMany({
      where: { userId: { in: [userId, "scheduled"] } },
      orderBy: { startedAt: "desc" },
      take: LIST_LIMIT,
    });
    const artifactRows = rows.length
      ? await prisma.taskArtifact.findMany({
          where: { runId: { in: rows.map((r) => r.id) } },
          select: ARTIFACT_SUMMARY_SELECT,
          orderBy: { createdAt: "asc" },
        })
      : [];
    const byRun = new Map<string, TaskArtifactSummary[]>();
    for (const a of artifactRows) {
      const bucket = byRun.get(a.runId) ?? [];
      bucket.push(toArtifactSummary(a));
      byRun.set(a.runId, bucket);
    }
    const res: TaskListResponse = {
      ok: true,
      runs: rows.map((r) => toStatusRun(r, byRun.get(r.id) ?? [])),
    };
    return NextResponse.json(res);
  }

  // ── single-run view ─────────────────────────────────────────────────────
  const runId = params.get("runId")?.trim();
  if (!runId) return bad("runId is required (or list=1&userId=)");

  // Sweep-on-read housekeeping: adopt orphaned local runs (local mode only —
  // a single indexed query when nothing is stale) + fire due schedules
  // (throttled) + settle stale cloud rows from their cloud run state +
  // ensure the loop exists after a process restart.
  const mode = await getOrchestrationMode();
  if (mode === "local") {
    await adoptStaleRuns();
  }
  touch();
  startSchedulerLoop();

  let row = await prisma.taskRun.findUnique({ where: { id: runId } });
  if (!row) return bad("run not found", 404);

  // Cloud self-heal (awaited — a user watching a stuck run sees it settled
  // on THIS response): stale non-terminal cloud rows are checked against
  // api.trigger.dev and settled when the cloud run already ended.
  if (
    mode === "cloud" &&
    row.orchestrator === "cloud" &&
    (row.status === "queued" || row.status === "running")
  ) {
    const healed = await healStaleCloudRuns(runId).catch(() => false);
    if (healed) {
      row = (await prisma.taskRun.findUnique({ where: { id: runId } })) ?? row;
    }
  }

  const rawCursor = Number(params.get("cursor"));
  const cursor = Number.isFinite(rawCursor) ? Math.max(-1, Math.trunc(rawCursor)) : -1;

  const allChunks = parseChunks(row.chunks);
  const chunks: TaskStatusChunk[] = allChunks
    .filter((c) => typeof c.seq === "number" && c.seq > cursor)
    .map((c) => ({ ...c, content: String(c.content ?? "").slice(0, CHUNK_READ_MAX_CHARS) }));
  const lastSeq = allChunks.length > 0 ? allChunks[allChunks.length - 1] : undefined;
  const cursorOut = Math.max(row.chunkSeq, lastSeq ? lastSeq.seq : 0);

  const artifactRows = await prisma.taskArtifact.findMany({
    where: { runId },
    select: ARTIFACT_SUMMARY_SELECT,
    orderBy: { createdAt: "asc" },
  });

  const run: TaskStatusRun = {
    ...toStatusRun(row, artifactRows.map(toArtifactSummary)),
    chunks,
    cursor: cursorOut,
  };
  const res: TaskStatusResponse = { ok: true, run };
  return NextResponse.json(res);
}
