// ============================================================================
// Background Task Execution Framework — TaskRun row store helpers.
//
// Single source of truth for decoding TaskRun's JSON-stringified columns
// (config / payload / progress / chunks) and for the append-only mutations
// the driver and the Trigger.dev worker both perform (phase transitions,
// chunk appends with server-side seq assignment, progress merges).
//
// Keeping these OUT of local-driver.ts lets the worker route append chunks
// without pulling the E2B SDK into its module graph.
// ============================================================================

import { prisma } from "./prisma";
import {
  TASK_DEFAULT_MAX_ROUNDS,
  type TaskPayload,
  type TaskPhase,
  type TaskRunConfig,
  type TaskRunProgress,
  type TaskStatusChunk,
} from "./protocol";

/** The empty-payload constant — MUST stay byte-identical to the TaskRun
 *  column default (prisma/schema.prisma). */
export const EMPTY_PAYLOAD_JSON =
  '{"version":1,"conversation":{"id":null,"title":null,"messages":[]},"files":[]}';

/** Per-chunk content cap at WRITE time (the status route truncates to 4000
 *  chars on read; storing a little more preserves tool-result detail for
 *  artifact-grade consumers without unbounded row growth). */
export const CHUNK_WRITE_MAX_CHARS = 16_000;

/** A chunk before the store assigns its monotonic seq. */
export type PendingChunk = Omit<TaskStatusChunk, "seq">;

// ---------------------------------------------------------------------------
// JSON column parsing (defensive — a malformed column never 500s a poll)
// ---------------------------------------------------------------------------

export function parseConfig(raw: string | null | undefined): TaskRunConfig {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as TaskRunConfig)
      : {};
  } catch {
    return {};
  }
}

export function parsePayload(raw: string | null | undefined): TaskPayload {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.files)) {
      return parsed as TaskPayload;
    }
  } catch {
    // fall through to the empty payload
  }
  return JSON.parse(EMPTY_PAYLOAD_JSON) as TaskPayload;
}

export function parseProgress(
  raw: string | null | undefined,
): Partial<TaskRunProgress> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Partial<TaskRunProgress>)
      : {};
  } catch {
    return {};
  }
}

export function parseChunks(raw: string | null | undefined): TaskStatusChunk[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TaskStatusChunk[]) : [];
  } catch {
    return [];
  }
}

/** Materialize a full TaskRunProgress view (with defaults) for API
 *  responses — never null fields. */
export function buildProgressView(
  raw: string | null | undefined,
  updatedAt: Date,
): TaskRunProgress {
  const p = parseProgress(raw);
  return {
    round: typeof p.round === "number" ? p.round : 0,
    totalRounds:
      typeof p.totalRounds === "number" ? p.totalRounds : TASK_DEFAULT_MAX_ROUNDS,
    stage: typeof p.stage === "string" ? p.stage : "queued",
    currentTool: typeof p.currentTool === "string" ? p.currentTool : null,
    ...(p.mountReport ? { mountReport: p.mountReport } : {}),
    ...(p.logTail !== undefined ? { logTail: p.logTail } : {}),
    lastUpdate:
      typeof p.lastUpdate === "number" ? p.lastUpdate : updatedAt.getTime(),
  };
}

// ---------------------------------------------------------------------------
// Mutations (driver + worker report path)
// ---------------------------------------------------------------------------

/** Persist a phase transition. Best-effort: a deleted row must not crash
 *  the pipeline. Phase transitions are safe to log (no payload/secrets). */
export async function setPhase(runId: string, phase: TaskPhase): Promise<void> {
  try {
    await prisma.taskRun.update({ where: { id: runId }, data: { phase } });
    console.log(`[tasks] run ${runId} → phase ${phase}`);
  } catch {
    // row gone — nothing to transition
  }
}

/**
 * Append chunks to the run's append-only JSON array, assigning each a
 * monotonic seq (chunkSeq = max assigned seq). Callers send chunks WITHOUT
 * seq (PendingChunk) — both the local driver monitor and the worker report
 * action land here, which is what keeps the cursor protocol consistent.
 */
export async function appendChunksToRun(
  runId: string,
  chunks: PendingChunk[],
): Promise<void> {
  if (!chunks.length) return;
  try {
    const run = await prisma.taskRun.findUnique({
      where: { id: runId },
      select: { chunks: true, chunkSeq: true },
    });
    if (!run) return;
    const existing = parseChunks(run.chunks);
    // Guarded indexed access (strict noUncheckedIndexedAccess): the last
    // element of a non-empty array is still typed possibly-undefined.
    const last = existing.length > 0 ? existing[existing.length - 1] : undefined;
    let seq = Math.max(run.chunkSeq, last ? last.seq : 0);
    for (const c of chunks) {
      seq += 1;
      existing.push({
        ...c,
        seq,
        content: String(c.content ?? "").slice(0, CHUNK_WRITE_MAX_CHARS),
      });
    }
    await prisma.taskRun.update({
      where: { id: runId },
      data: { chunks: JSON.stringify(existing), chunkSeq: seq },
    });
  } catch (err) {
    console.warn(`[tasks] chunk append failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Shallow-merge a progress patch into the run's progress JSON
 *  (read-modify-write — the driver/worker for a run is single-writer by
 *  construction of the claim protocol). */
export async function mergeProgressIntoRun(
  runId: string,
  patch: Partial<TaskRunProgress>,
): Promise<void> {
  try {
    const run = await prisma.taskRun.findUnique({
      where: { id: runId },
      select: { progress: true },
    });
    if (!run) return;
    const merged = { ...parseProgress(run.progress), ...patch };
    await prisma.taskRun.update({
      where: { id: runId },
      data: { progress: JSON.stringify(merged) },
    });
  } catch (err) {
    console.warn(`[tasks] progress merge failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
