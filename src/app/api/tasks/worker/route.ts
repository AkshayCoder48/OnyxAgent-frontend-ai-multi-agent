// ============================================================================
// Background Task Execution Framework — POST /api/tasks/worker.
//
// The durable Trigger.dev worker's pull-based entry point (no push API
// dependency): the worker authenticates with WORKER_TOKEN and drives three
// actions —
//
//   claim  → atomically lease queued runs (updateMany on status:"queued" is
//            the cross-process claim; lockHolder "triggerdev:<id>" +
//            attempts++). Optional runId force-checks a single row.
//   report → stream progress back WITHOUT touching the lock (phase/sandboxId
//            error/progress-merge/chunk-append/artifact-create); a terminal
//            status also settles the row (finishedAt, lock released, phase
//            done) and drops the keyring entry.
//   sweep  → fire due schedules (worker modes only — self-hosted OR
//            Trigger.dev Cloud; the local loop owns firing otherwise).
//
// Disabled (503) unless a WORKER_TOKEN is available — the env var, or the
// token minted by the cloud connection (Settings → Cloud Tasks; stored
// sealed in TaskCloudConfig) when the operator connected a trigger.dev
// Cloud key. Token compare is constant-time. Body-logging discipline
// mirrors /api/chat-proxy: payloads, prompts and tokens are never logged.
// ============================================================================
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/tasks/prisma";
import { keyring, tokensEqual } from "@/lib/tasks/keyring";
import { clampTimeoutMs } from "@/lib/tasks/local-driver";
import { sweepSchedules } from "@/lib/tasks/cron-scheduler";
import { getOrchestrationMode } from "@/lib/tasks/orchestration-mode";
import { getEffectiveWorkerToken } from "@/lib/tasks/trigger-cloud";
import {
  appendChunksToRun,
  mergeProgressIntoRun,
  parseConfig,
  parsePayload,
  type PendingChunk,
} from "@/lib/tasks/run-store";
import {
  TASK_PAYLOAD_BUDGET,
  type TaskRunProgress,
  type WorkerArtifactInput,
  type WorkerClaimResponse,
  type WorkerClaimedRun,
  type WorkerReportRequest,
  type WorkerSweepResponse,
} from "@/lib/tasks/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Per-process worker lease identity (lockHolder prefix). */
const WORKER_ID = `triggerdev:${randomUUID().slice(0, 8)}`;

/** Max runs leased per claim tick. */
const CLAIM_LIMIT_MAX = 20;
const CLAIM_LIMIT_DEFAULT = 5;

const ARTIFACT_KINDS = new Set(["message", "file", "report", "attachment"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function bad(detail: string, status = 400): NextResponse {
  return NextResponse.json({ ok: false, error: detail }, { status });
}

function toInt(value: unknown, dflt: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : dflt;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // WORKER_TOKEN: env var first, else the token minted by the cloud
  // connection (Settings → Cloud Tasks) so connecting a key is enough to
  // enable the worker protocol — no .env edit needed.
  const envWorkerToken = process.env.WORKER_TOKEN?.trim();
  const workerToken =
    envWorkerToken ?? ((await getEffectiveWorkerToken()).token ?? "");
  if (!workerToken) {
    return bad("worker mode disabled", 503);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("invalid JSON body");
  }

  const token = typeof body.token === "string" ? body.token : "";
  if (!token || !tokensEqual(workerToken, token)) {
    return bad("invalid worker token", 401);
  }

  const action = typeof body.action === "string" ? body.action : "";
  switch (action) {
    case "claim":
      return handleClaim(request, body);
    case "report":
      return handleReport(body as unknown as WorkerReportRequest);
    case "sweep":
      return handleSweep();
    default:
      return bad("action must be one of claim, report, sweep");
  }
}

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

async function handleClaim(
  request: NextRequest,
  body: Record<string, unknown>,
): Promise<NextResponse> {
  const limit = Math.min(
    Math.max(Math.trunc(toInt(body.limit, CLAIM_LIMIT_DEFAULT)), 1),
    CLAIM_LIMIT_MAX,
  );

  // Candidate ids: a forced runId (targeted re-claim) or the oldest queued
  // rows up to the limit.
  let candidates: Array<{ id: string }> = [];
  const forcedRunId = typeof body.runId === "string" ? body.runId.trim() : "";
  if (forcedRunId) {
    const row = await prisma.taskRun.findUnique({
      where: { id: forcedRunId },
      select: { id: true, status: true },
    });
    if (row && row.status === "queued") candidates = [{ id: row.id }];
  } else {
    candidates = await prisma.taskRun.findMany({
      where: { status: "queued" },
      orderBy: { startedAt: "asc" },
      take: limit,
      select: { id: true },
    });
  }

  const runs: WorkerClaimedRun[] = [];
  const appUrl = process.env.APP_URL?.trim() || new URL(request.url).origin;

  for (const candidate of candidates) {
    // Atomic lease — a concurrently claimed row (local driver, another
    // worker tick) fails the guard and is skipped.
    const claimed = await prisma.taskRun.updateMany({
      where: { id: candidate.id, status: "queued" },
      data: {
        status: "running",
        lockHolder: WORKER_ID,
        lockedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    if (claimed.count === 0) continue;

    const row = await prisma.taskRun.findUnique({ where: { id: candidate.id } });
    if (!row) continue;

    const config = parseConfig(row.config);
    runs.push({
      runId: row.id,
      type: row.type as WorkerClaimedRun["type"],
      prompt: row.prompt,
      config,
      payload: parsePayload(row.payload),
      appUrl,
      startedAt: row.startedAt.toISOString(),
      timeoutMs: clampTimeoutMs(config.timeoutMs),
    });
    console.log(`[tasks] run ${row.id} claimed by worker`);
  }

  const res: WorkerClaimResponse = { ok: true, runs };
  return NextResponse.json(res);
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

async function handleReport(body: WorkerReportRequest): Promise<NextResponse> {
  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  if (!runId) return bad("runId is required");

  const row = await prisma.taskRun.findUnique({
    where: { id: runId },
    select: { id: true, status: true },
  });
  if (!row) return bad("run not found", 404);

  // Field merges — the lock (lockHolder/lockedAt) is NEVER touched: the
  // worker holds it for the life of the run.
  const base: Record<string, unknown> = {};
  if (typeof body.phase === "string") base.phase = body.phase;
  if (typeof body.sandboxId === "string") base.sandboxId = body.sandboxId;
  if (typeof body.error === "string") base.error = body.error.slice(0, 2000);
  if (Object.keys(base).length > 0) {
    await prisma.taskRun.update({ where: { id: runId }, data: base }).catch(() => {
      // row gone mid-report — the terminal updateMany below is a no-op then
    });
  }

  if (body.progress && typeof body.progress === "object") {
    await mergeProgressIntoRun(runId, body.progress as Partial<TaskRunProgress>);
  }

  if (Array.isArray(body.chunks) && body.chunks.length > 0) {
    // Chunks arrive WITHOUT seq — the store assigns monotonic ones.
    await appendChunksToRun(runId, body.chunks as PendingChunk[]);
  }

  if (Array.isArray(body.artifacts) && body.artifacts.length > 0) {
    await createWorkerArtifacts(runId, body.artifacts);
  }

  // Terminal settle: guarded on the live statuses so a late duplicate report
  // can never resurrect a terminal row. Also releases the lease and drops
  // the run's credentials (they die with the run).
  const status = body.status;
  if (typeof status === "string" && TERMINAL_STATUSES.has(status)) {
    await prisma.taskRun.updateMany({
      where: { id: runId, status: { in: ["queued", "running"] } },
      data: {
        status,
        phase: "done",
        finishedAt: new Date(),
        lockHolder: null,
      },
    });
    keyring.drop(runId);
    console.log(`[tasks] run ${runId} reported terminal: ${status}`);
  }

  return NextResponse.json({ ok: true });
}

/** WorkerArtifactInput[] → TaskArtifact rows (count-capped by budget). */
async function createWorkerArtifacts(
  runId: string,
  artifacts: WorkerArtifactInput[],
): Promise<void> {
  for (const a of artifacts.slice(0, TASK_PAYLOAD_BUDGET.maxArtifacts)) {
    if (!a || typeof a !== "object") continue;
    const content = typeof a.content === "string" ? a.content : "";
    if (!content) continue;
    const encoding = a.encoding === "base64" ? "base64" : "utf8";
    const size =
      encoding === "base64"
        ? Buffer.from(content, "base64").byteLength
        : Buffer.byteLength(content, "utf8");
    const kind = typeof a.kind === "string" && ARTIFACT_KINDS.has(a.kind) ? a.kind : "file";
    const name = (typeof a.name === "string" && a.name.trim() ? a.name : "artifact").slice(0, 200);
    const path = typeof a.path === "string" && a.path.trim() ? a.path : null;
    const mimeType =
      typeof a.mimeType === "string" && a.mimeType.trim()
        ? a.mimeType
        : encoding === "base64"
          ? "application/octet-stream"
          : "text/plain";
    await prisma.taskArtifact
      .create({
        data: {
          runId,
          kind,
          name,
          ...(path ? { path } : {}),
          mimeType,
          content,
          encoding,
          size,
          truncated: a.truncated === true,
        },
      })
      .catch(() => {
        // best-effort — one bad row must not lose the rest
      });
  }
}

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------

async function handleSweep(): Promise<NextResponse> {
  // Local mode owns firing (loop + sweep-on-read); the worker sweep is a
  // worker-mode concern (self-hosted OR Trigger.dev Cloud) — and it FORCES
  // the fire path (sweepSchedules self-gates to arm-only otherwise).
  const mode = await getOrchestrationMode();
  if (mode === "local") {
    const res: WorkerSweepResponse = { ok: true, fired: 0 };
    return NextResponse.json(res);
  }
  const fired = await sweepSchedules({ force: true });
  const res: WorkerSweepResponse = { ok: true, fired };
  return NextResponse.json(res);
}
