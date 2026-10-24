// ============================================================================
// Background Task Execution Framework — LOCAL driver (in-process orchestrator).
//
// The DEFAULT execution engine: drives a claimed TaskRun through the full
// sandbox lifecycle INSIDE the Next.js server process —
//
//   claim → init (sandbox create / re-attach) → mount (FR-4.1 manifest) →
//   verify → start (headless runner | terminal command) → monitor (5s poll,
//   chunked progress FR-3.2) → finalize (artifacts FR-2.3/4.2) → settle.
//
// Atomic recovery (PRD §4.1, local mode): the Python loop runs nohup'd INSIDE
// the E2B sandbox and the TaskRun row carries the resume cursor, so a server
// crash/restart never loses the run — adoptStaleRuns() (the status route's
// sweep-on-read) CAS-adopts rows whose local lock went stale (>60s without a
// heartbeat) and re-attaches to the still-running sandbox, resuming the
// monitor from persisted progress.
//
// Trigger.dev mode (TRIGGER_DEV_URL + TRIGGER_DEV_TOKEN configured) never
// reaches this module's fire path: runs stay queued and the deployed worker
// claims them over /api/tasks/worker. This driver mirrors that worker
// (trigger-worker/src/e2b-driver.ts + src/tasks/agent-run.ts) step for step
// so both orchestrators behave identically against the same runner protocol.
//
// SECURITY (PRD §4.2 credential sandbox): the E2B key + provider pool live
// ONLY in the in-memory keyring and the sandbox's chmod-600 run.json — never
// in logs, never in the database (the row stores just the sha256 of the task
// token).
// ============================================================================

import { randomUUID } from "node:crypto";
import { Sandbox } from "@e2b/code-interpreter";
import type { TaskRun } from "@prisma/client";
import { prisma } from "./prisma";
import { keyring, type KeyringEntry } from "./keyring";
import { buildRunnerConfig } from "./runner-config";
import {
  appendChunksToRun,
  mergeProgressIntoRun,
  parseConfig,
  parsePayload,
  setPhase,
  type PendingChunk,
} from "./run-store";
import {
  buildManifest,
  MANIFEST_ABS_PATH,
  toSandboxPath,
  verifyMount,
} from "./manifest";
import {
  HEADLESS_RUNNER_PY,
  RUNNER_PATH,
  RUN_CONFIG_PATH,
  AGENT_STATUS_PATH,
  BACKGROUND_LOG_PATH,
} from "@/lib/e2b/headless-agent";
import {
  TASK_ARTIFACT_EXCLUDES,
  TASK_DEFAULT_DURATION_MS,
  TASK_MAX_DURATION_MS,
  TASK_PAYLOAD_BUDGET,
  type OnyxAgentFilesManifest,
  type TaskPayload,
  type WorkerArtifactInput,
} from "./protocol";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sandbox workspace root (matches the app's chat-sandbox layout). */
const HOME = "/home/user";
/** Terminal-command scratch dir (same paths the worker uses). */
const TASK_DIR = `${HOME}/.onyx/task`;

/** Monitor poll cadence (matches the worker). */
const POLL_INTERVAL_MS = 5_000;
/** Boot grace before a missing status file counts as failure. */
const BOOT_GRACE_MS = 90_000;
/** Stall guard — no status progress for this long = failed. */
const STALL_LIMIT_MS = 10 * 60 * 1000;
/** A local lock older than this (no heartbeat) is adoptable by this process. */
const LOCK_STALE_MS = 60_000;
/** Claim + adoption budget — beyond this the run settles failed. */
const MAX_ATTEMPTS = 3;

/** Sentinel the client sends in place of a real E2B key when the server has
 *  E2B_API_KEY configured (mirrors src/lib/e2b/env-key.ts — a "use client"
 *  module, so the constant is redefined here rather than imported). */
const ENV_KEY_SENTINEL = "USE_SERVER_ENV";

// Module-scoped driver identity + in-flight set, globalThis-guarded so dev
// HMR reloads never stack monitors or strand a live loop's dedup entry.
interface DriverGlobal {
  __onyxTaskDriverId?: string;
  __onyxTaskDriverInFlight?: Set<string>;
}
const g = globalThis as unknown as DriverGlobal;
const LOCAL_ID: string =
  g.__onyxTaskDriverId ?? (g.__onyxTaskDriverId = `local:${randomUUID().slice(0, 8)}`);
const inFlight: Set<string> =
  g.__onyxTaskDriverInFlight ?? (g.__onyxTaskDriverInFlight = new Set<string>());

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a run window into [1 min, TASK_MAX_DURATION_MS] — the PRD §4.2
 * 30-minute hard cap (mirrors the worker's clampTimeoutMs).
 */
export function clampTimeoutMs(timeoutMs: unknown): number {
  const raw =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? timeoutMs
      : TASK_DEFAULT_DURATION_MS;
  return Math.min(Math.max(Math.round(raw), 60_000), TASK_MAX_DURATION_MS);
}

/**
 * Fire-and-forget local dispatch of a queued run (trigger route +
 * cron-scheduler fire path). The DB claim inside driveRun is the
 * cross-process fence — a concurrently claimed row simply exits.
 */
export function startLocalRun(runId: string): void {
  void driveRun(runId, "claim").catch((err) => {
    // Last-resort guard — driveRun settles its own failures internally.
    console.warn(
      `[tasks] run ${runId} local driver crashed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

/**
 * Best-effort sandbox kill for a run (cancel route). Never throws — a dead
 * sandbox or a missing key is silently accepted (the 30-min window reaps it).
 */
export async function killSandboxForRun(runId: string): Promise<void> {
  try {
    const row = await prisma.taskRun.findUnique({
      where: { id: runId },
      select: { sandboxId: true },
    });
    const sandboxId = row?.sandboxId;
    if (!sandboxId) return;
    const key = resolveE2BKey(keyring.get(runId));
    if (!key) return;
    const sandbox = await Sandbox.connect(sandboxId, { apiKey: key });
    await sandbox.kill();
    console.log(`[tasks] run ${runId} sandbox ${sandboxId} killed`);
  } catch {
    // best-effort by contract — never fails the cancel response
  }
}

/**
 * Adopt orphaned local runs (status-route sweep-on-read, local mode only):
 * rows still "running" whose local lock went stale (>60s without a
 * heartbeat — the driving process crashed/restarted). One indexed query
 * when nothing is stale; each adoption is a compare-and-swap take followed
 * by a fresh driveRun that re-attaches to the still-running sandbox.
 */
export async function adoptStaleRuns(): Promise<number> {
  const staleBefore = new Date(Date.now() - LOCK_STALE_MS);
  const stale = await prisma.taskRun.findMany({
    where: {
      status: "running",
      orchestrator: "local",
      lockHolder: { startsWith: "local:" },
      lockedAt: { lt: staleBefore },
    },
    take: 10,
    select: { id: true, attempts: true, sandboxId: true },
  });
  if (stale.length === 0) return 0;

  let adopted = 0;
  for (const s of stale) {
    if (inFlight.has(s.id)) continue; // this process still drives it

    if (s.attempts >= MAX_ATTEMPTS) {
      await settleRun(
        s.id,
        "failed",
        `run abandoned after ${s.attempts} attempts (repeated driver restarts) — re-trigger to continue`,
      );
      continue;
    }
    // A restartable run needs either its sandbox (re-attach needs only the
    // E2B key) or its keyring entry (fresh start needs the runner config).
    if (!s.sandboxId && !keyring.get(s.id)) {
      await settleRun(
        s.id,
        "failed",
        "task credentials expired (server restart) — re-trigger the task",
      );
      continue;
    }

    // CAS take — only when the lock is STILL the stale one we saw.
    const took = await prisma.taskRun.updateMany({
      where: { id: s.id, status: "running", lockedAt: { lt: staleBefore } },
      data: { lockHolder: LOCAL_ID, lockedAt: new Date(), attempts: { increment: 1 } },
    });
    if (took.count === 0) continue;

    adopted += 1;
    console.log(`[tasks] run ${s.id} adopted after stale lock`);
    void driveRun(s.id, "adopt").catch((err) => {
      console.warn(
        `[tasks] run ${s.id} adoption crashed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
  return adopted;
}

// ---------------------------------------------------------------------------
// Drive loop — the full lifecycle
// ---------------------------------------------------------------------------

type DriveMode = "claim" | "adopt";

/** Monitor outcome. "lost" = lock lost (cancelled / re-adopted elsewhere) —
 *  the caller must NOT settle and must NOT kill the sandbox. */
type MonitorResult =
  | { kind: "completed" }
  | { kind: "failed"; error: string }
  | { kind: "lost" };

async function driveRun(runId: string, mode: DriveMode): Promise<void> {
  if (inFlight.has(runId)) return; // already driven by this process
  inFlight.add(runId);

  let sandbox: Sandbox | null = null;
  let keepSandbox = false; // "lost" — another owner may be attached

  try {
    // ── Phase: claim / adopt ─────────────────────────────────────────────
    if (mode === "claim") {
      const claimed = await prisma.taskRun.updateMany({
        where: { id: runId, status: "queued" },
        data: {
          status: "running",
          lockHolder: LOCAL_ID,
          lockedAt: new Date(),
          attempts: { increment: 1 },
        },
      });
      if (claimed.count === 0) return; // another process won the claim
    }

    const row = await prisma.taskRun.findUnique({ where: { id: runId } });
    if (!row) return;
    if (row.status !== "running" || row.lockHolder !== LOCAL_ID) return;
    if (row.attempts > MAX_ATTEMPTS) {
      await settleRun(runId, "failed", `run abandoned after ${row.attempts} attempts`);
      return;
    }

    const entry = keyring.get(runId);
    const config = parseConfig(row.config);
    const payload = parsePayload(row.payload);
    const timeoutMs = clampTimeoutMs(config.timeoutMs);
    // The window is anchored at the ORIGINAL start — an adopted run resumes
    // with whatever remains of its budget.
    const deadline = row.startedAt.getTime() + timeoutMs;

    await mergeProgressIntoRun(runId, { stage: "claimed", lastUpdate: Date.now() });

    // ── Phase: init — create the sandbox OR re-attach after adoption ────
    let resume = false;
    if (mode === "adopt" && row.sandboxId) {
      const key = resolveE2BKey(entry);
      if (!key) {
        await settleRun(
          runId,
          "failed",
          "E2B key unavailable for re-attach (server restart) — re-trigger the task",
        );
        return;
      }
      try {
        sandbox = await Sandbox.connect(row.sandboxId, { apiKey: key });
        resume = true; // the nohup'd runner inside survived the restart
      } catch {
        // Dead/paused-unreachable sandbox — fall through to a fresh create.
      }
    }
    if (!sandbox) {
      const key = resolveE2BKey(entry);
      if (!key) {
        await settleRun(
          runId,
          "failed",
          "No E2B sandbox key configured. Add one in Settings → E2B (or set E2B_API_KEY on the server) to run background tasks.",
        );
        return;
      }
      await setPhase(runId, "init");
      sandbox = await Sandbox.create({
        apiKey: key,
        timeoutMs,
        metadata: {
          "onyx-app": "onyx",
          "onyx-scope": "background-task",
          "onyx-task": runId,
        },
      });
      await prisma.taskRun
        .update({ where: { id: runId }, data: { sandboxId: sandbox.sandboxId } })
        .catch(() => {
          // row deleted mid-flight — the settle below no-ops
        });
    }
    const box = sandbox;
    await mergeProgressIntoRun(runId, { stage: "sandbox-ready", lastUpdate: Date.now() });

    // ── Mount + verify + start (skipped on resume — the sandbox kept them) ──
    let manifest: OnyxAgentFilesManifest;
    if (resume) {
      manifest = await readManifestFromSandbox(box, runId);
      await setPhase(runId, "monitor");
    } else {
      await setPhase(runId, "mount");
      manifest = await mountPayload(box, runId, payload);
      await mergeProgressIntoRun(runId, { stage: "files-mounted", lastUpdate: Date.now() });

      await setPhase(runId, "verify");
      const report = await verifyMount(box, manifest);
      await mergeProgressIntoRun(runId, {
        stage: "mount-verified",
        mountReport: report,
        lastUpdate: Date.now(),
      });
      if (report.missing.length > 0) {
        console.warn(
          `[tasks] run ${runId} mount verification: ${report.missing.length} file(s) missing`,
        );
      }

      await setPhase(runId, "start");
      if (row.type === "terminal_command") {
        await startTerminalCommand(box, config.command ?? "", config.cwd);
      } else {
        if (!entry) {
          await settleRun(
            runId,
            "failed",
            "task credentials expired (server restart) — re-trigger the task",
          );
          return;
        }
        await startAgentRunner(box, row, entry);
      }
      await mergeProgressIntoRun(runId, { stage: "launched", lastUpdate: Date.now() });

      await setPhase(runId, "monitor");
    }

    // ── Phase: monitor — chunked progress (FR-3.2) ───────────────────────
    const terminal = await monitorLoop(box, row, payload, deadline, resume);
    if (terminal.kind === "lost") {
      // Cancelled by the client (cancel route settles + kills) or re-adopted
      // by another process (it re-attaches to this same sandbox) — hands off.
      keepSandbox = true;
      return;
    }

    // ── Phase: finalize — artifacts (FR-2.3 / FR-4.2) ────────────────────
    await setPhase(runId, "finalize");
    const artifacts = await collectArtifacts(box, row, payload, manifest);
    await persistArtifacts(runId, artifacts);
    await mergeProgressIntoRun(runId, {
      stage: terminal.kind === "failed" ? "failed" : "completed",
      lastUpdate: Date.now(),
    });

    // ── Phase: done — settle + drop credentials ──────────────────────────
    await settleRun(
      runId,
      terminal.kind === "failed" ? "failed" : "completed",
      terminal.kind === "failed" ? terminal.error : undefined,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await settleRun(runId, "failed", message).catch(() => {
      // settleRun is no-throw, but never let cleanup mask the return
    });
  } finally {
    inFlight.delete(runId);
    if (sandbox && !keepSandbox) await killQuiet(sandbox);
  }
}

// ---------------------------------------------------------------------------
// Monitor loop — 5s file-protocol polls → progress + chunks
// ---------------------------------------------------------------------------

async function monitorLoop(
  sandbox: Sandbox,
  row: TaskRun,
  payload: TaskPayload,
  deadline: number,
  resume: boolean,
): Promise<MonitorResult> {
  const runId = row.id;
  const seedCount = payload.conversation?.messages?.length ?? 0;
  let lastHistoryCount = seedCount;
  let lastRound = 0;
  let lastProgressAt = Date.now();
  const startedAt = Date.now();

  // On resume, fast-forward the cursors — entries produced before the crash
  // were already chunked; only post-reattach activity is new.
  if (resume && row.type !== "terminal_command") {
    const history = await readAgentHistory(sandbox);
    if (history && history.length > lastHistoryCount) lastHistoryCount = history.length;
    const st = await readAgentStatus(sandbox);
    if (st && typeof st.round === "number") lastRound = st.round;
  }

  while (true) {
    const now = Date.now();
    if (now > deadline) {
      return { kind: "failed", error: "execution window exceeded (PRD §4.2 30-minute cap)" };
    }

    // Heartbeat + lock check — a silent cancel or foreign adoption exits
    // WITHOUT settling (the other side owns the row now).
    const beat = await prisma.taskRun.updateMany({
      where: { id: runId, lockHolder: LOCAL_ID },
      data: { lockedAt: new Date() },
    });
    if (beat.count === 0) {
      const cur = await prisma.taskRun.findUnique({
        where: { id: runId },
        select: { status: true },
      });
      keyring.drop(runId); // credentials die with our ownership
      if (cur && cur.status !== "running") {
        console.log(`[tasks] run ${runId} monitor exit: row is ${cur.status}`);
      } else {
        console.warn(`[tasks] run ${runId} lost its lock — another driver took over`);
      }
      return { kind: "lost" };
    }

    if (row.type === "terminal_command") {
      const st = await readTerminalStatus(sandbox);
      if (st.exited) {
        return st.exitCode === 0
          ? { kind: "completed" }
          : { kind: "failed", error: `command exited with code ${st.exitCode}` };
      }
      await mergeProgressIntoRun(runId, {
        stage: "running",
        currentTool: "terminal",
        logTail: st.output.slice(-4000),
        lastUpdate: now,
      });
    } else {
      const st = await readAgentStatus(sandbox);
      if (st) {
        lastProgressAt = now;
        const chunks: PendingChunk[] = [];
        const round = typeof st.round === "number" ? st.round : 0;
        if (round > lastRound) {
          chunks.push({ kind: "round", round, content: `round ${round}`, ts: now });
          lastRound = round;
        }

        // New history entries → text / tool chunks (FR-3.2 chunked blocks).
        const history = await readAgentHistory(sandbox);
        if (history && history.length > lastHistoryCount) {
          for (const entry of history.slice(lastHistoryCount)) {
            translateHistoryEntry(entry, round, now, chunks);
          }
          lastHistoryCount = history.length;
        }

        await mergeProgressIntoRun(runId, {
          round,
          totalRounds: typeof st.total_rounds === "number" ? st.total_rounds : 0,
          stage: st.stage ?? "running",
          currentTool: st.current_tool ?? null,
          logTail: (await readLogTail(sandbox)).slice(-4000),
          lastUpdate: now,
        });
        if (chunks.length > 0) await appendChunksToRun(runId, chunks);

        if (st.status === "completed") return { kind: "completed" };
        if (st.status === "failed" || st.status === "stopped") {
          return { kind: "failed", error: st.error ?? `runner ${st.status}` };
        }
      } else if (now - startedAt > BOOT_GRACE_MS) {
        return {
          kind: "failed",
          error: "runner status file missing after boot grace",
        };
      }

      if (now - lastProgressAt > STALL_LIMIT_MS) {
        return { kind: "failed", error: "runner stalled for 10 minutes" };
      }
    }

    await sleepMs(POLL_INTERVAL_MS);
  }
}

/**
 * Translate one runner history entry into status chunks. Handles the runner's
 * ACTUAL OpenAI wire format (assistant tool_calls: {id, function:{name,
 * arguments}}; tool results: separate {role:"tool", name, content} entries)
 * plus the legacy {name, args, result} shape the worker tolerates.
 */
function translateHistoryEntry(
  entry: HistoryEntry,
  round: number,
  ts: number,
  out: PendingChunk[],
): void {
  const toolCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
  if (toolCalls.length > 0) {
    for (const tc of toolCalls) {
      const fn = tc.function;
      const name =
        (typeof fn?.name === "string" && fn.name) ||
        (typeof tc.name === "string" && tc.name) ||
        "tool";
      const args =
        typeof fn?.arguments === "string"
          ? fn.arguments
          : tc.args !== undefined
            ? JSON.stringify(tc.args)
            : "";
      out.push({
        kind: "tool_call",
        round,
        name,
        content: String(args).slice(0, 2000),
        ts,
      });
    }
    return; // results arrive as their own role:"tool" entries
  }
  if (entry.role === "tool") {
    out.push({
      kind: "tool_result",
      round,
      name: typeof entry.name === "string" && entry.name ? entry.name : "tool",
      content: String(entry.content ?? "").slice(0, 2000),
      ts,
    });
    return;
  }
  if (entry.role === "assistant" && typeof entry.content === "string" && entry.content.trim()) {
    out.push({ kind: "text", round, content: entry.content.slice(0, 4000), ts });
  }
}

// ---------------------------------------------------------------------------
// Sandbox file protocol (mirrors trigger-worker/src/e2b-driver.ts)
// ---------------------------------------------------------------------------

interface AgentStatus {
  status?: string;
  stage?: string;
  round?: number;
  total_rounds?: number;
  current_tool?: string | null;
  last_update?: number;
  error?: string | null;
}

interface HistoryEntry {
  role?: string;
  content?: string;
  name?: string;
  tool_calls?: Array<{
    id?: string;
    name?: string;
    args?: unknown;
    result?: unknown;
    function?: { name?: string; arguments?: string };
  }>;
}

interface TerminalStatus {
  exited: boolean;
  exitCode: number | null;
  output: string;
  error: string;
}

async function readJson<T>(sandbox: Sandbox, path: string): Promise<T | null> {
  try {
    const text = await sandbox.files.read(path, { format: "text" });
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function readAgentStatus(sandbox: Sandbox): Promise<AgentStatus | null> {
  return readJson<AgentStatus>(sandbox, `${HOME}/agent_status.json`);
}

async function readAgentHistory(sandbox: Sandbox): Promise<HistoryEntry[] | null> {
  const parsed = await readJson<{ messages?: HistoryEntry[] } | HistoryEntry[]>(
    sandbox,
    `${HOME}/chat_history.json`,
  );
  if (!parsed) return null;
  return Array.isArray(parsed) ? parsed : (parsed.messages ?? []);
}

async function readTerminalStatus(sandbox: Sandbox): Promise<TerminalStatus> {
  const exitCode = await readJson<number>(sandbox, `${TASK_DIR}/exit_code`).catch(() => null);
  const output = await sandbox.files
    .read(`${TASK_DIR}/output.log`, { format: "text" })
    .catch(() => "");
  const error = await sandbox.files
    .read(`${TASK_DIR}/error.log`, { format: "text" })
    .catch(() => "");
  return {
    exited: exitCode !== null && exitCode !== undefined,
    exitCode: typeof exitCode === "number" ? exitCode : null,
    output,
    error,
  };
}

async function readLogTail(sandbox: Sandbox, bytes = 4096): Promise<string> {
  try {
    const log = await sandbox.files.read(BACKGROUND_LOG_PATH, { format: "text" });
    return log.slice(-bytes);
  } catch {
    return "";
  }
}

/** Read the FR-4.1 manifest back from the sandbox (adoption resume — the
 *  artifact diff needs the pristine-input list). Falls back to empty. */
async function readManifestFromSandbox(
  sandbox: Sandbox,
  runId: string,
): Promise<OnyxAgentFilesManifest> {
  const parsed = await readJson<OnyxAgentFilesManifest>(sandbox, MANIFEST_ABS_PATH);
  if (parsed && parsed.version === 1 && Array.isArray(parsed.files)) return parsed;
  return { version: 1, runId, createdAt: new Date().toISOString(), files: [] };
}

// ---------------------------------------------------------------------------
// Mount / start
// ---------------------------------------------------------------------------

/** Mount the payload workspace + write the manifest (FR-4.1). Write failures
 *  propagate — a partial mount must fail the run, not pass silently. */
async function mountPayload(
  sandbox: Sandbox,
  runId: string,
  payload: TaskPayload,
): Promise<OnyxAgentFilesManifest> {
  const files = Array.isArray(payload.files) ? payload.files : [];
  for (const file of files) {
    const target = toSandboxPath(file.path);
    if (!target) throw new Error(`payload file path escapes the workspace: ${file.path}`);
    if (file.encoding === "base64") {
      const bytes = Buffer.from(file.content, "base64");
      const arrayBuffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      await sandbox.files.write(target, arrayBuffer);
    } else {
      await sandbox.files.write(target, file.content);
    }
  }
  const manifest = buildManifest(runId, files);
  await sandbox.files.write(MANIFEST_ABS_PATH, JSON.stringify(manifest));
  return manifest;
}

/** Launch the headless agent runner (mirrors /api/sandbox agent_start). */
async function startAgentRunner(
  sandbox: Sandbox,
  row: TaskRun,
  entry: KeyringEntry,
): Promise<void> {
  // 1. Runner source (stdlib-only Python, v2 — key-pool rotation).
  await sandbox.files.write(RUNNER_PATH, HEADLESS_RUNNER_PY);

  // 2. Run config — credentials live ONLY here (chmod 600) and in the
  //    keyring. NEVER log the payload.
  await sandbox.files.write(RUN_CONFIG_PATH, JSON.stringify(buildRunnerConfig(row, entry)));
  await sandbox.commands.run(`chmod 600 ${RUN_CONFIG_PATH}`, { timeoutMs: 10_000 }).catch(() => {});

  // 3. Durable starting status BEFORE launch.
  const now = Date.now();
  await sandbox.files.write(
    AGENT_STATUS_PATH,
    JSON.stringify({
      status: "starting",
      run_id: row.id,
      stage: "boot",
      round: 0,
      total_rounds: 0,
      current_tool: null,
      last_update: now,
      started_at: now,
    }),
  );

  // 4. Detached launch — the runner owns the loop from here (it survives
  //    this process dying; adoptStaleRuns re-attaches later if needed).
  await sandbox.commands.run(
    `cd ${HOME} && nohup python3 ${RUNNER_PATH} > ${BACKGROUND_LOG_PATH} 2>&1 & echo started`,
    { timeoutMs: 10_000 },
  );
}

/** Launch a terminal command with output/exit-code capture (FR-3.3). */
async function startTerminalCommand(
  sandbox: Sandbox,
  command: string,
  cwd?: string,
): Promise<void> {
  const cmd = command.trim();
  if (!cmd) throw new Error("terminal_command run is missing config.command");
  const dir = cwd?.trim() || HOME;
  const script = ["#!/bin/bash", `cd ${dir}`, cmd].join("\n");
  await sandbox.files.write(`${TASK_DIR}/cmd.sh`, script);
  await sandbox.commands.run(
    `nohup bash -c 'bash ${TASK_DIR}/cmd.sh > ${TASK_DIR}/output.log 2> ${TASK_DIR}/error.log; echo $? > ${TASK_DIR}/exit_code' > /dev/null 2>&1 &`,
    { timeoutMs: 10_000 },
  );
}

// ---------------------------------------------------------------------------
// Artifacts (FR-2.3 / FR-4.2 — final message, changed/new files, reports)
// ---------------------------------------------------------------------------

/** Recursively walk the sandbox filesystem from `dir` (bounded). */
async function walkFiles(
  sandbox: Sandbox,
  dir = HOME,
  depth = 0,
  out: Array<{ path: string; size: number }> = [],
): Promise<Array<{ path: string; size: number }>> {
  if (depth > 8 || out.length > 500) return out;
  const entries = await sandbox.files.list(dir).catch(() => []);
  for (const entry of entries) {
    const entryPath = entry.path ?? `${dir}/${entry.name}`;
    const type = String(entry.type ?? "");
    if (type === "dir" || type === "directory" || type === "FILE_TYPE_DIRECTORY") {
      await walkFiles(sandbox, entryPath, depth + 1, out);
    } else {
      out.push({ path: entryPath, size: entry.size ?? 0 });
    }
  }
  return out;
}

function isExcluded(path: string): boolean {
  const rel = path.startsWith(`${HOME}/`) ? path.slice(HOME.length + 1) : path;
  return TASK_ARTIFACT_EXCLUDES.some((excl) => rel === excl || rel.startsWith(`${excl}/`));
}

function guessMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    txt: "text/plain", md: "text/markdown", json: "application/json",
    csv: "text/csv", html: "text/html", css: "text/css", js: "text/javascript",
    ts: "text/typescript", tsx: "text/typescript", py: "text/x-python",
    sh: "text/x-shellscript", yml: "text/yaml", yaml: "text/yaml",
    svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg",
    jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    pdf: "application/pdf", zip: "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Collect artifacts: the final agent message (past the seed), every
 *  new/changed sandbox file vs the mount manifest, and terminal reports —
 *  all under the protocol budget caps. */
async function collectArtifacts(
  sandbox: Sandbox,
  row: TaskRun,
  payload: TaskPayload,
  manifest: OnyxAgentFilesManifest,
): Promise<WorkerArtifactInput[]> {
  const artifacts: WorkerArtifactInput[] = [];
  let totalBytes = 0;
  const pushCapped = (input: WorkerArtifactInput, size: number) => {
    if (artifacts.length >= TASK_PAYLOAD_BUDGET.maxArtifacts) return;
    if (totalBytes + size > TASK_PAYLOAD_BUDGET.maxTotalArtifactBytes) return;
    artifacts.push(input);
    totalBytes += size;
  };

  // Final assistant message (agent runs).
  if (row.type !== "terminal_command") {
    const history = await readAgentHistory(sandbox);
    const seedCount = payload.conversation?.messages?.length ?? 0;
    const after = history ? history.slice(seedCount) : [];
    const finalText = [...after]
      .reverse()
      .find((e) => e.role === "assistant" && typeof e.content === "string" && e.content.trim());
    if (finalText?.content) {
      pushCapped(
        {
          kind: "message",
          name: "result.md",
          mimeType: "text/markdown",
          content: finalText.content.slice(0, TASK_PAYLOAD_BUDGET.maxArtifactBytes),
          encoding: "utf8",
          truncated: finalText.content.length > TASK_PAYLOAD_BUDGET.maxArtifactBytes,
        },
        finalText.content.length,
      );
    }
  }

  // Changed/new files vs the mount manifest (FR-4.2 direct-write sync layer).
  const manifestByPath = new Map(
    manifest.files.map((f) => {
      const abs = toSandboxPath(f.path);
      return abs ? ([abs, f.size] as const) : null;
    }).filter((x): x is [string, number] => x !== null),
  );
  for (const entry of await walkFiles(sandbox)) {
    if (isExcluded(entry.path)) continue;
    const mountedSize = manifestByPath.get(entry.path);
    if (mountedSize !== undefined && mountedSize === entry.size) continue; // unchanged input
    if (entry.size > TASK_PAYLOAD_BUDGET.maxArtifactBytes) {
      pushCapped(
        {
          kind: "file",
          name: entry.path.split("/").pop() ?? entry.path,
          path: entry.path,
          mimeType: guessMime(entry.path),
          content: "",
          encoding: "base64",
          truncated: true,
        },
        0,
      );
      continue;
    }
    try {
      const bytes = await sandbox.files.read(entry.path, { format: "bytes" });
      const content = Buffer.from(bytes).toString("base64");
      pushCapped(
        {
          kind: "file",
          name: entry.path.split("/").pop() ?? entry.path,
          path: entry.path,
          mimeType: guessMime(entry.path),
          content,
          encoding: "base64",
        },
        entry.size,
      );
    } catch {
      // Unreadable file — skip silently.
    }
  }

  // Terminal reports.
  if (row.type === "terminal_command") {
    const terminal = await readTerminalStatus(sandbox);
    if (terminal.output) {
      pushCapped(
        {
          kind: "report",
          name: "output.log",
          mimeType: "text/plain",
          content: terminal.output.slice(0, 200_000),
          encoding: "utf8",
          truncated: terminal.output.length > 200_000,
        },
        terminal.output.length,
      );
    }
    if (terminal.error) {
      pushCapped(
        {
          kind: "report",
          name: "error.log",
          mimeType: "text/plain",
          content: terminal.error.slice(0, 100_000),
          encoding: "utf8",
          truncated: terminal.error.length > 100_000,
        },
        terminal.error.length,
      );
    }
  }

  return artifacts;
}

/** WorkerArtifactInput[] → TaskArtifact rows (mirrors the worker report
 *  path's createWorkerArtifacts — per-row best-effort, count-capped). */
async function persistArtifacts(runId: string, artifacts: WorkerArtifactInput[]): Promise<void> {
  for (const a of artifacts.slice(0, TASK_PAYLOAD_BUDGET.maxArtifacts)) {
    if (!a || typeof a !== "object") continue;
    const content = typeof a.content === "string" ? a.content : "";
    if (!content) continue;
    const encoding = a.encoding === "base64" ? "base64" : "utf8";
    const size =
      encoding === "base64"
        ? Buffer.from(content, "base64").byteLength
        : Buffer.byteLength(content, "utf8");
    const kind =
      a.kind === "message" || a.kind === "file" || a.kind === "report" || a.kind === "attachment"
        ? a.kind
        : "file";
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
// Settle + small helpers
// ---------------------------------------------------------------------------

/** Terminal settle — guarded on the live statuses so a late duplicate can
 *  never resurrect a terminal row; releases the lease and drops credentials
 *  (they die with the run, PRD §4.2). */
async function settleRun(
  runId: string,
  status: "completed" | "failed",
  error?: string,
): Promise<void> {
  await prisma.taskRun
    .updateMany({
      where: { id: runId, status: { in: ["queued", "running"] } },
      data: {
        status,
        phase: "done",
        finishedAt: new Date(),
        lockHolder: null,
        ...(error ? { error: error.slice(0, 2000) } : {}),
      },
    })
    .catch(() => {
      // row gone — nothing to settle
    });
  keyring.drop(runId);
  console.log(`[tasks] run ${runId} ${status}${error ? `: ${error.slice(0, 120)}` : ""}`);
}

/** Resolve the E2B key for a run: the keyring entry's real key, else the
 *  server env (the USE_SERVER_ENV sentinel resolves here). NEVER logged. */
function resolveE2BKey(entry: KeyringEntry | null): string | null {
  const fromEntry = entry?.e2bApiKey?.trim();
  if (fromEntry && fromEntry !== ENV_KEY_SENTINEL) return fromEntry;
  return process.env.E2B_API_KEY?.trim() || null;
}

/** Best-effort kill — never throws (finalize must not fail on cleanup). */
async function killQuiet(sandbox: Sandbox | null): Promise<void> {
  if (!sandbox) return;
  try {
    await sandbox.kill();
  } catch {
    // Already dead / network blip — nothing to do.
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
