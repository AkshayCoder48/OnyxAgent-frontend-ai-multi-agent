/**
 * The scheduler ENGINE — server-side, persistent, authoritative.
 *
 * Responsibilities:
 *  - task CRUD over OnyxBase KV (single tasks record + per-task run history)
 *  - `tick()` — the authoritative heartbeat: finalize finished runs, fire due
 *    tasks (idempotent, catch-up), reschedule, persist everything
 *  - `fireRun()` — create an isolated E2B sandbox (metadata-tagged so the
 *    interactive sandbox-rotation NEVER kills scheduled runs), restore the
 *    cloud workspace into it, launch the bg-agent runner as a background
 *    command (the agent loop runs INSIDE E2B — browser closed is fine)
 *  - `finalizeRun()` — reconnect to the run's sandbox, harvest the result +
 *    execution timeline, push workspace changes back to the cloud, send the
 *    Telegram notification, persist the run record
 *
 * Duplicate-execution protection: run ids are DETERMINISTIC
 * (run_<taskId>_<occurrenceMs>) — before starting, the engine checks the run
 * record for that occurrence; server restarts, double ticks and network
 * duplication can never launch the same occurrence twice.
 *
 * Retry policy: transient launch failures (E2B/network) back off
 * exponentially (5min → 10min → 20min, max 3 retries); run-level failures
 * are recorded, never blindly retried.
 */

import { Sandbox } from "@e2b/code-interpreter";
import { ONYX_MD } from "@/lib/agent/onyx-md";
import { BG_AGENT_SCRIPT, BG_SCRIPT_PATH, BG_RUNS_PREFIX, BG_STATE_PATH } from "@/lib/e2b/bg-agent-script";
import type { SchedulerKV } from "./server-kv";
import { computeNextRun, describeSchedule } from "./tz-cron";
import {
  MAX_RUNS_PER_TASK,
  MAX_RUN_RESULT,
  MAX_RUN_LOG_LINES,
  MAX_TASK_INSTRUCTIONS,
  SCHED_RUNS_PREFIX,
  SCHED_TICK_KEY,
  SCHED_TELEGRAM_KEY,
  toSafeTask,
  type CreateTaskPayload,
  type SafeScheduledTask,
  type ScheduledTask,
  type ScheduledTaskRun,
  type TickResult,
  type UpdateTaskPayload,
} from "./types";
import { serverPushWorkspace, serverRestoreWorkspace } from "./ws-sync";
import {
  telegramSendDocument,
  telegramSendMessage,
} from "./telegram";

const HOME = "/home/user";
/** Max concurrent scheduled runs (E2B Hobby = limited concurrency). */
const MAX_CONCURRENT_RUNS = 2;
/** A run older than this while still "running" is declared failed. */
const RUN_STALE_MS = 55 * 60_000;
/** Consecutive unreachable finalization checks before declaring failure. */
const MAX_UNREACHABLE_CHECKS = 5;
/** Tick lock window — overlapping triggers (cron + heartbeat) collapse. */
const TICK_LOCK_MS = 20_000;
/** One-time catch-up grace: a "once" occurrence fires late within 24h. */
const ONCE_CATCHUP_GRACE_MS = 24 * 60 * 60_000;
/** Retry backoff base for transient launch failures. */
const RETRY_BASE_MS = 5 * 60_000;
const MAX_LAUNCH_RETRIES = 3;

// ---------------------------------------------------------------------------
// KV persistence helpers
//
// DURABILITY DESIGN (learned from live data loss — 2026-09-12): the scheduler
// originally kept ALL task definitions in ONE `schedule:tasks` record; that
// record VANISHED on OnyxBase's multi-instance mirror (single critical
// record + read-modify-write lost updates). Now every task is its OWN
// `schedule:task:<id>` record:
//   - no shared record to lose (one lost key = one lost task, never all)
//   - no read-modify-write of a shared array (no lost-update class at all)
//   - writes are VERIFIED by read-back with one rewrite sweep (the probe
//     pattern from the workspace-sync engine — a write that acked 200 but
//     can't be read yet gets rewritten once before we trust it)
// Loading = a robust prefix list (2 passes unioned — list is also
// instance-roulette) + parallel per-task gets.
// ---------------------------------------------------------------------------

/** Versioned task records — the durability fix for OnyxBase's mirror.
 *
 * LIVE-DEBUGGED FAILURE MODES (2026-09-12, production):
 *  1. A write acked 200 but was never visible anywhere (stranded mirror SEND).
 *  2. An update converged fleet-wide, then REVERTED — instances rebuild their
 *     index from the Telegram mirror on recycle, and a failed mirror EDIT
 *     leaves the old message → the new value evaporates. Mutable keys are
 *     therefore UNSAFE for data that must survive.
 *
 * The workspace-sync engine's answer is content-addressed, immutable chunks.
 * The scheduler uses the same trick: every task mutation writes a NEW
 * immutable version record (a new Telegram message — sends are far more
 * reliable than edits, and a failed send is detectable + retryable with a
 * fresh key). Reads resolve the latest surviving version via the key list.
 *
 *   schedule:tv:<taskId>:<versionTs36>   — immutable task snapshot
 *   schedule:tv:<taskId>:del            — tombstone (task deleted)
 */
function taskVersionKey(id: string, version: string): string {
  return `schedule:tv:${id}:${version}`;
}

/** Legacy mutable keys — still written as a fast-path/readable hint and
 *  cleaned up opportunistically (old deployments may hold them). */
function taskKey(id: string): string {
  return `schedule:task:${id}`;
}

function taskReplicaKey(id: string): string {
  return `schedule:taskr:${id}`;
}

/** Robust prefix list — OnyxBase's list endpoint IGNORES the prefix query
 *  param (returns the whole collection; filter client-side) and can hit a
 *  stale instance showing only part of the namespace. Two passes with a
 *  settle delay, results unioned. */
async function listKeysRobust(kv: SchedulerKV, _prefix: string): Promise<string[]> {
  const union = new Set<string>();
  let sawAny = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const keys = await kv.listKeys("schedule:");
      if (keys.length > 0) sawAny = true;
      for (const k of keys) union.add(k);
    } catch {
      /* retry */
    }
    if (attempt === 1 && sawAny) break;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1000));
  }
  return [...union];
}

interface TaskVersionEntry {
  id: string;
  version: string;
  tombstoned: boolean;
}

/** Parse the schedule: key namespace into per-task version entries. */
function parseVersionKeys(keys: string[]): TaskVersionEntry[] {
  const out: TaskVersionEntry[] = [];
  for (const k of keys) {
    if (!k.startsWith("schedule:tv:")) continue;
    const rest = k.slice("schedule:tv:".length);
    const sep = rest.indexOf(":");
    if (sep < 0) continue;
    const id = rest.slice(0, sep);
    const version = rest.slice(sep + 1);
    if (!id || !version) continue;
    out.push({ id, version, tombstoned: version === "del" });
  }
  return out;
}

/** Latest version entry per task id (tombstones included so deletes win). */
function latestVersionPerTask(entries: TaskVersionEntry[]): Map<string, TaskVersionEntry> {
  const latest = new Map<string, TaskVersionEntry>();
  for (const e of entries) {
    const cur = latest.get(e.id);
    if (!cur) {
      latest.set(e.id, e);
      continue;
    }
    // Tombstone always beats a version; otherwise lexicographic version
    // compare (base36 timestamps sort correctly).
    const eWins =
      e.tombstoned && !cur.tombstoned ? true : !e.tombstoned && !cur.tombstoned && e.version > cur.version ? true : false;
    if (eWins) latest.set(e.id, e);
  }
  return latest;
}

/** Read one task by id — resolve the latest surviving version (direct key
 *  reads of the version record, with rolls). */
async function readTask(kv: SchedulerKV, id: string): Promise<ScheduledTask | null> {
  const keys = await listKeysRobust(kv, "schedule:tv:");
  const entries = parseVersionKeys(keys).filter((e) => e.id === id);
  const latest = entries.length ? latestVersionPerTask(entries).get(id) ?? null : null;
  if (latest && latest.tombstoned) return null;
  const keysToTry: string[] = latest?.version
    ? [taskVersionKey(id, latest.version)]
    : // Legacy fallback (pre-versioned records) — mutable keys.
      [taskKey(id), taskReplicaKey(id), taskVersionKey(id, "del")];
  for (const key of keysToTry) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await kv.get(key);
        if (raw) {
          const parsed = JSON.parse(raw) as { id?: string; deleted?: boolean };
          if (parsed && parsed.deleted) return null;
          if (parsed && parsed.id === id) return parsed as unknown as ScheduledTask;
          return null;
        }
      } catch {
        /* retry */
      }
      if (attempt < 1) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return null;
}

/** Verified write — a NEW immutable version key (new Telegram message, not
 *  an edit): write → probe → on strand, write a FRESH version key (new
 *  mirror attempt) → probe. Also refreshes the legacy mutable keys as a
 *  hint (best-effort; the version keys are the source of truth). */
async function writeTaskVerified(
  kv: SchedulerKV,
  task: ScheduledTask,
): Promise<{ warning?: string }> {
  const value = JSON.stringify(task);
  const equal = (back: string | null): boolean => {
    if (back === value) return true;
    if (!back) return false;
    try {
      return JSON.stringify(JSON.parse(back)) === JSON.stringify(JSON.parse(value));
    } catch {
      return false;
    }
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const version = Date.now().toString(36) + (attempt > 0 ? "r" : "");
    const key = taskVersionKey(task.id, version);
    try {
      await kv.set(key, value);
    } catch {
      continue;
    }
    try {
      if (equal(await kv.get(key))) {
        // Durable — refresh legacy mutable hints (best-effort).
        try {
          await kv.set(taskKey(task.id), value);
          await kv.set(taskReplicaKey(task.id), value);
        } catch {
          /* hints only */
        }
        // Version GC — keep at most the 2 newest records per task.
        void gcTaskVersions(kv, task.id, version).catch(() => {});
        return {};
      }
    } catch {
      /* probe failed — try a fresh version key */
    }
  }
  return {
    warning:
      `Task "${task.name}" was written but OnyxBase hasn't confirmed it durable — it may take a minute to appear. Re-check before recreating it.`,
  };
}

/** Best-effort garbage collection of superseded version records. */
async function gcTaskVersions(kv: SchedulerKV, taskId: string, keepVersion: string): Promise<void> {
  const keys = await kv.listKeys("schedule:");
  const versions = keys
    .filter((k) => k.startsWith(`schedule:tv:${taskId}:`) && k !== `schedule:tv:${taskId}:${keepVersion}`)
    .filter((k) => !k.endsWith(":del"))
    .sort();
  // Keep the second-newest (crash-recovery margin), delete the rest.
  const toDelete = versions.slice(0, -1);
  for (const k of toDelete) {
    try {
      await kv.delete(k);
    } catch {
      /* best-effort */
    }
  }
}

export async function loadTasks(kv: SchedulerKV): Promise<ScheduledTask[]> {
  const keys = await listKeysRobust(kv, "schedule:tv:");
  const latest = latestVersionPerTask(parseVersionKeys(keys));
  const out: ScheduledTask[] = [];
  const jobs: Array<[string, TaskVersionEntry]> = [];
  const versionedIds = new Set<string>();
  for (const [id, entry] of latest) {
    versionedIds.add(id);
    if (entry.tombstoned) continue;
    jobs.push([id, entry]);
  }
  // LEGACY MIGRATION — tasks written before the versioned format live at
  // schedule:task:<id> / schedule:taskr:<id> (mutable keys). Read them as a
  // fallback; the next mutation upgrades them to version records.
  const legacyIds = new Set<string>();
  for (const k of keys) {
    if (k.startsWith("schedule:task:")) {
      const id = k.slice("schedule:task:".length);
      if (id && !versionedIds.has(id) && !id.includes(":")) legacyIds.add(id);
    } else if (k.startsWith("schedule:taskr:")) {
      const id = k.slice("schedule:taskr:".length);
      if (id && !versionedIds.has(id) && !id.includes(":")) legacyIds.add(id);
    }
  }
  for (const id of legacyIds) jobs.push([id, { id, version: "", tombstoned: false }]);
  if (jobs.length === 0) return [];
  let next = 0;
  const workers = Array.from({ length: Math.min(4, jobs.length) }, async () => {
    for (;;) {
      const i = next++;
      const job = jobs[i];
      if (!job || i >= jobs.length) return;
      const [id, entry] = job;
      const keysToTry = entry.version
        ? [taskVersionKey(id, entry.version)]
        : [taskKey(id), taskReplicaKey(id)];
      let resolved = false;
      for (const key of keysToTry) {
        if (resolved) break;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const raw = await kv.get(key);
            if (raw) {
              const parsed = JSON.parse(raw) as ScheduledTask;
              if (parsed && parsed.id === id) {
                out.push(parsed);
                resolved = true;
              }
              resolved = true;
              break;
            }
          } catch {
            /* retry */
          }
          if (attempt < 1) await new Promise((r) => setTimeout(r, 800));
        }
      }
    }
  });
  await Promise.all(workers);
  return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

/** Load ONE task by id with retries (fresh-write convergence). */
async function loadTaskById(kv: SchedulerKV, taskId: string, rolls = 4): Promise<ScheduledTask | null> {
  for (let attempt = 0; attempt < rolls; attempt++) {
    const t = await readTask(kv, taskId);
    if (t) return t;
    await new Promise((r) => setTimeout(r, 1200));
  }
  return null;
}

/** Run-record envelope with a write timestamp — lets readers pick the NEWEST
 *  surviving copy across the mutable keys AND the immutable version records. */
interface RunsEnvelope {
  w: number;
  runs: ScheduledTaskRun[];
}

function parseRunsValue(raw: string | null): RunsEnvelope | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RunsEnvelope | ScheduledTaskRun[];
    if (Array.isArray(parsed)) return { w: 0, runs: parsed }; // legacy shape
    if (parsed && Array.isArray(parsed.runs) && typeof parsed.w === "number") return parsed;
    return null;
  } catch {
    return null;
  }
}

async function readEnvelope(kv: SchedulerKV, key: string): Promise<RunsEnvelope | null> {
  try {
    return parseRunsValue(await kv.get(key));
  } catch {
    return null;
  }
}

export async function loadRuns(kv: SchedulerKV, taskId: string): Promise<ScheduledTaskRun[]> {
  // Candidates: mutable main + replica (fast path) and the NEWEST immutable
  // version record (schedule:rvh:<taskId>:<ts36> — new Telegram messages,
  // immune to the mirror-EDIT reversion that strands mutable updates). The
  // highest write-timestamp wins.
  let best: RunsEnvelope | null = await readEnvelope(kv, SCHED_RUNS_PREFIX + taskId);
  const replica = await readEnvelope(kv, `schedule:runsr:${taskId}`);
  if (replica && (!best || replica.w > best.w)) best = replica;
  try {
    const keys = await kv.listKeys("schedule:");
    const versions = keys
      .filter((k) => k.startsWith(`schedule:rvh:${taskId}:`))
      .map((k) => k.slice(`schedule:rvh:${taskId}:`.length))
      .filter(Boolean)
      .sort();
    const latest = versions[versions.length - 1];
    if (latest) {
      const v = await readEnvelope(kv, `schedule:rvh:${taskId}:${latest}`);
      if (v && (!best || v.w > best.w)) best = v;
    }
  } catch {
    /* version lookup best-effort */
  }
  return best?.runs ?? [];
}

export async function saveRuns(kv: SchedulerKV, taskId: string, runs: ScheduledTaskRun[]): Promise<void> {
  const capped = runs.slice(-MAX_RUNS_PER_TASK);
  const env: RunsEnvelope = { w: Date.now(), runs: capped };
  const value = JSON.stringify(env);
  // Mutable fast path (main + replica)…
  await kv.set(SCHED_RUNS_PREFIX + taskId, value);
  await kv.set(`schedule:runsr:${taskId}`, value);
  // …AND an immutable version record — a NEW Telegram message per save.
  // Mutable mirror-EDITs have been observed to strand AND to revert after
  // instance recycle; version keys are the durable source of truth.
  const version = env.w.toString(36);
  const versionKey = `schedule:rvh:${taskId}:${version}`;
  await kv.set(versionKey, value);
  // Verify the version record (the durable copy); rewrite with a fresh key
  // when it strands.
  try {
    const back = await kv.get(versionKey);
    if (back !== value) {
      const retryEnv = { w: Date.now(), runs: capped };
      await kv.set(`schedule:rvh:${taskId}:${retryEnv.w.toString(36)}`, JSON.stringify(retryEnv));
    }
  } catch {
    /* best-effort */
  }
  // Version GC — keep the 2 newest (best-effort).
  try {
    const keys = await kv.listKeys("schedule:");
    const old = keys
      .filter((k) => k.startsWith(`schedule:rvh:${taskId}:`) && !k.endsWith(`:${version}`))
      .sort()
      .slice(0, -1);
    for (const k of old) {
      try {
        await kv.delete(k);
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

async function loadRunsConverged(kv: SchedulerKV, taskId: string, runId?: string): Promise<ScheduledTaskRun[]> {
  let runs = await loadRuns(kv, taskId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const found = runId ? runs.some((r) => r.id === runId) : runs.length > 0;
    if (found) return runs;
    await new Promise((r) => setTimeout(r, 2500));
    runs = await loadRuns(kv, taskId);
  }
  return runs;
}

function e2bKey(): string | null {
  const k = (process.env.E2B_API_KEY ?? "").trim();
  return k || null;
}

function newTaskId(): string {
  return "task_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

/** Read the stored telegram connection (schedule:telegram) — server-side
 *  credential resolution so tokens never cross the client boundary. */
async function readTelegramCreds(kv: SchedulerKV): Promise<{ botToken: string; chatId: string } | null> {
  try {
    const raw = await kv.get(SCHED_TELEGRAM_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as { botToken?: string; chatId?: string | null };
    if (cfg?.botToken && cfg.chatId) return { botToken: cfg.botToken, chatId: String(cfg.chatId) };
    return null;
  } catch {
    return null;
  }
}

export function runIdFor(taskId: string, occurrence: number, seq = 0): string {
  return seq > 0
    ? `run_${taskId}_${occurrence}_r${seq}`
    : `run_${taskId}_${occurrence}`;
}

// ---------------------------------------------------------------------------
// Task CRUD
// ---------------------------------------------------------------------------

export async function createTask(kv: SchedulerKV, payload: CreateTaskPayload): Promise<{ task: SafeScheduledTask; warning?: string }> {
  const name = (payload.name ?? "").trim();
  const instructions = (payload.instructions ?? "").trim();
  if (!name) throw new Error("Task name is required");
  if (!instructions) throw new Error("Task instructions are required (the complete agent job)");
  if (instructions.length > MAX_TASK_INSTRUCTIONS) {
    throw new Error(`Instructions too long (${instructions.length} chars, max ${MAX_TASK_INSTRUCTIONS})`);
  }
  const schedule = payload.schedule;
  if (!schedule || !schedule.type) throw new Error("Schedule is required");

  // Telegram creds: server-side resolution from schedule:telegram (the
  // client NEVER handles the token — masked reads only).
  let telegram: { botToken: string; chatId: string } | null = payload.runtime?.telegram ?? null;
  if (!telegram && payload.notifyTelegram !== false) {
    telegram = await readTelegramCreds(kv);
  }

  const now = new Date();
  const task: ScheduledTask = {
    id: newTaskId(),
    userId: "local",
    name,
    description: (payload.description ?? "").trim(),
    instructions,
    scheduleType: schedule.type,
    scheduleExpression: (schedule.expression ?? "").trim(),
    scheduleMeta: {
      time: (schedule.time ?? (schedule as { time?: string }).time)?.trim() || undefined,
      weekdays: undefined,
      dayOfMonth: undefined,
      intervalSec: undefined,
    },
    timezone: schedule.timezone || "UTC",
    startAt: schedule.startAt,
    endAt: schedule.endAt,
    enabled: payload.enabled !== false,
    workspaceId: payload.workspaceId || "workspace_default",
    notificationConfig: {
      telegram: payload.notifyTelegram !== false,
      inApp: true,
    },
    runtime: {
      provider: payload.runtime?.provider ?? null,
      telegram: telegram ?? null,
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    runCount: 0,
    failureStreak: 0,
  };

  // Normalize the schedule meta per type.
  const { normalizeSchedule } = await import("./tz-cron");
  const norm = normalizeSchedule(schedule);
  task.scheduleExpression = norm.expression;
  task.scheduleMeta = norm.meta as ScheduledTask["scheduleMeta"];
  if (norm.type === "once" && !task.startAt) task.startAt = norm.expression;

  const next = computeNextRun(taskScheduleOf(task), task.scheduleMeta, Date.now());
  if (next == null) {
    throw new Error(
      `Schedule cannot produce a future occurrence (type=${schedule.type}, expression="${task.scheduleExpression}", timezone=${task.timezone}). Fix the schedule and retry.`,
    );
  }
  task.nextRunAt = next;

  const verified = await writeTaskVerified(kv, task);
  return { task: toSafeTask(task), warning: verified.warning };
}

export async function updateTask(kv: SchedulerKV, payload: UpdateTaskPayload): Promise<{ task: SafeScheduledTask; warning?: string }> {
  const task = await loadTaskById(kv, payload.id);
  if (!task) throw new Error(`Scheduled task not found: ${payload.id}`);

  if (payload.name !== undefined) task.name = payload.name.trim();
  if (payload.description !== undefined) task.description = payload.description.trim();
  if (payload.instructions !== undefined) {
    if (payload.instructions.length > MAX_TASK_INSTRUCTIONS) {
      throw new Error(`Instructions too long (max ${MAX_TASK_INSTRUCTIONS})`);
    }
    task.instructions = payload.instructions.trim();
  }
  if (payload.workspaceId !== undefined) task.workspaceId = payload.workspaceId;
  if (payload.enabled !== undefined) {
    task.enabled = payload.enabled;
    if (payload.enabled && task.nextRunAt == null) {
      task.nextRunAt = computeNextRun(taskScheduleOf(task), task.scheduleMeta, Date.now());
      task.failureStreak = 0;
      delete task.nextRetryAt;
    }
  }
  if (payload.notifyTelegram !== undefined) task.notificationConfig.telegram = payload.notifyTelegram;
  if (payload.notifyTelegram === true || (payload.notifyTelegram === undefined && task.notificationConfig.telegram)) {
    const creds = payload.runtime?.telegram ?? (await readTelegramCreds(kv));
    if (creds) task.runtime.telegram = creds;
  }
  if (payload.runtime?.provider !== undefined) task.runtime.provider = payload.runtime.provider;
  if (payload.runtime?.telegram !== undefined) task.runtime.telegram = payload.runtime.telegram;

  if (payload.schedule) {
    const { normalizeSchedule } = await import("./tz-cron");
    const norm = normalizeSchedule(payload.schedule);
    task.scheduleType = norm.type as ScheduledTask["scheduleType"];
    task.scheduleExpression = norm.expression;
    task.scheduleMeta = norm.meta as ScheduledTask["scheduleMeta"];
    task.timezone = payload.schedule.timezone || task.timezone;
    task.startAt = payload.schedule.startAt ?? task.startAt;
    task.endAt = payload.schedule.endAt ?? task.endAt;
    if (norm.type === "once" && !task.startAt) task.startAt = norm.expression;
    const next = computeNextRun(taskScheduleOf(task), task.scheduleMeta, Date.now());
    if (next == null) {
      throw new Error("The new schedule cannot produce a future occurrence — task NOT updated.");
    }
    task.nextRunAt = next;
    task.failureStreak = 0;
    delete task.nextRetryAt;
  }

  task.updatedAt = new Date().toISOString();
  const verified = await writeTaskVerified(kv, task);
  return { task: toSafeTask(task), warning: verified.warning };
}

export async function deleteTask(kv: SchedulerKV, taskId: string): Promise<void> {
  const task = await loadTaskById(kv, taskId);
  if (!task) throw new Error(`Scheduled task not found: ${taskId}`);
  // TOMBSTONE — a new immutable record wins over every version (deletes via
  // KV delete are mirror-edits and unreliable; tombstones are durable).
  const tomb = taskVersionKey(taskId, "del");
  await kv.set(tomb, JSON.stringify({ id: taskId, deleted: true, deletedAt: new Date().toISOString() }));
  // Probe the tombstone; a second write on strand.
  try {
    const back = await kv.get(tomb);
    if (!back) await kv.set(tomb, JSON.stringify({ id: taskId, deleted: true, deletedAt: new Date().toISOString() }));
  } catch {
    /* best-effort */
  }
  // Legacy mutable keys + run history — best-effort cleanup.
  try {
    await kv.delete(taskKey(taskId));
    await kv.delete(taskReplicaKey(taskId));
    await kv.delete(SCHED_RUNS_PREFIX + taskId);
    await kv.delete(`schedule:runsr:${taskId}`);
    const all = await kv.listKeys("schedule:");
    for (const k of all) {
      if (k.startsWith(`schedule:rvh:${taskId}:`)) {
        try {
          await kv.delete(k);
        } catch {
          /* best-effort */
        }
      }
    }
  } catch {
    /* best-effort */
  }
}

export async function setTaskEnabled(kv: SchedulerKV, taskId: string, enabled: boolean): Promise<{ task: SafeScheduledTask; warning?: string }> {
  return updateTask(kv, { id: taskId, enabled });
}

// ---------------------------------------------------------------------------
// The system prompt for an autonomous scheduled run
// ---------------------------------------------------------------------------

function taskScheduleOf(t: ScheduledTask): { type: string; expression: string; time?: string; timezone: string; startAt?: string; endAt?: string } {
  return {
    type: t.scheduleType,
    expression: t.scheduleExpression,
    time: t.scheduleMeta?.time,
    timezone: t.timezone,
    startAt: t.startAt,
    endAt: t.endAt,
  };
}

function buildScheduledSystemPrompt(task: ScheduledTask): string {
  const tzNote = `Timezone for all timestamps in this task: ${task.timezone}.`;
  const telegramNote = task.runtime.telegram?.botToken
    ? "The telegram_send_message / telegram_send_document tools are available and pre-configured with the user's connected Telegram account — use them to deliver results to the user."
    : "Telegram is not connected; deliver results as files in the workspace and in your final message.";
  // COMPACT prompt (the full Onyx.md is a FILE in the sandbox — read_file it
  // for the complete tool compendium + GenUI reference). Small models reject
  // 39KB system prompts outright; even large ones work better compact.
  return `You are ONYX — an autonomous AI operator with a Linux sandbox
(/home/user is your workspace) and real tools.

## SCHEDULED TASK EXECUTION MODE

You are running as an AUTONOMOUS SCHEDULED AGENT (no user is watching this
session live). Facts about this run:
- Task name: "${task.name}"
- Schedule: ${describeSchedule(task)} (${tzNote})
- Workspace: ${task.workspaceId} — its files were RESTORED into this sandbox before you started. All file changes you make will be synchronized back to the user's persistent cloud workspace when the run finishes.
- ${telegramNote}

RULES FOR THIS RUN:
1. Do the COMPLETE job described in the user message — this is a real agent
   job (research, code, file generation, data processing), not a reminder.
2. There is NO user to answer questions — never call ask_user. If something
   is ambiguous, make the most sensible choice and continue.
3. Browser-side tools (chats, memories, skills management, subagents) have
   no browser connected — they will time out. Use the sandbox-native tools
   (files, terminal, python, web_fetch, web_search, charts, datetime, …).
4. Save all deliverables as FILES in the workspace (e.g. reports as .md).
   The final workspace state is what the user keeps.
5. End with a clear final message summarizing: what you did, files created
   or updated (with paths), key findings, and anything that failed. That
   message becomes the run result and is sent to the user as a
   notification, so make it self-contained and useful.
6. Work autonomously until the job is done. Do not stop early to "report
   progress" — finish the work, then summarize.

## Available tools (sandbox-native)
- Files: analyze_workspace, list_folder, read_file, read_file_section,
  create_file, write_file, edit_file, delete_file, create_folder,
  delete_folder, move_file, verify_path, create_file_chunk, send_file,
  send_folder, search_documents
- Execution: run_python (60s), run_terminal (120s)
- Web: web_search, web_fetch, image_search, video_search
- Data/media: create_chart, preview_image, ocr_document, counterfactual,
  current_datetime
- Planning: manage_todo, show_todo
- Telegram: telegram_send_message, telegram_send_document,
  telegram_send_photo, telegram_get_updates, telegram_get_chat
(always function-calling — never "Thought:/Action:" text)

READ /home/user/Onyx.md FIRST (read_file) — it documents every tool in
detail plus the GenUI spec, execution policies, and the workspace rules
that apply to you.

## Workspace rules
- E2B is temporary; the cloud workspace is permanent. Your file changes are
  synced back automatically at the end of this run — write deliverables as
  real files.
- Files >50MB, .env/secrets, node_modules/.git/build dirs are never synced.
- Never fabricate results: if a step fails, say so in your final message.`;
}

// ---------------------------------------------------------------------------
// Fire a run (E2B sandbox + bg-agent launch)
// ---------------------------------------------------------------------------

export async function fireRun(
  kv: SchedulerKV,
  task: ScheduledTask,
  occurrence: number,
  trigger: ScheduledTaskRun["trigger"],
): Promise<{ run: ScheduledTaskRun; alreadyRan: boolean; error?: string }> {
  // Idempotency: an execution record for this occurrence already exists?
  const runs = await loadRuns(kv, task.id);
  const existing = runs.find((r) => r.scheduledFor === occurrence && r.trigger !== "retry");
  if (existing && (existing.status === "running" || existing.status === "completed" || existing.status === "pending")) {
    return { run: existing, alreadyRan: true };
  }

  const retrySeq = runs.filter((r) => r.scheduledFor === occurrence).length;
  const run: ScheduledTaskRun = {
    id: runIdFor(task.id, occurrence, retrySeq),
    taskId: task.id,
    scheduledFor: occurrence,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: "pending",
    trigger,
    sandboxId: null,
    e2bRunId: null,
    result: null,
    error: null,
    durationMs: null,
    filesChanged: [],
    toolCalls: 0,
    logs: [`[scheduler] ${trigger} trigger — occurrence ${new Date(occurrence).toISOString()}`],
    unreachableChecks: 0,
  };
  runs.push(run);
  await saveRuns(kv, task.id, runs.slice(-MAX_RUNS_PER_TASK));

  const apiKey = e2bKey();
  if (!apiKey) {
    run.status = "failed";
    run.error = "E2B_UNAVAILABLE: the server has no E2B_API_KEY configured — scheduled runs cannot start.";
    run.completedAt = new Date().toISOString();
    await saveRuns(kv, task.id, runs.slice(-MAX_RUNS_PER_TASK));
    return { run, alreadyRan: false, error: run.error ?? undefined };
  }
  if (!task.runtime.provider?.baseUrl) {
    run.status = "failed";
    run.error =
      "No AI provider configuration stored on this task. Open the task and re-save it while your provider is configured (the runtime snapshot is refreshed on save), or update it via the AI.";
    run.completedAt = new Date().toISOString();
    await saveRuns(kv, task.id, runs.slice(-MAX_RUNS_PER_TASK));
    return { run, alreadyRan: false, error: run.error ?? undefined };
  }

  // 1. Isolated sandbox for this run — metadata-tagged so the interactive
  //    single-sandbox rotation NEVER kills scheduled runs.
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.create({
      apiKey,
      timeoutMs: 3_600_000,
      envs: {},
      metadata: { "onyx-scheduled": task.id, "onyx-task": task.name.slice(0, 60) },
      lifecycle: { onTimeout: "pause", autoResume: true },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    run.status = "failed";
    run.error = `E2B sandbox creation failed: ${msg}`;
    run.completedAt = new Date().toISOString();
    run.logs.push(`[error] sandbox create failed: ${msg}`);
    await saveRuns(kv, task.id, runs.slice(-MAX_RUNS_PER_TASK));
    return { run, alreadyRan: false, error: run.error };
  }
  run.sandboxId = sandbox.sandboxId;
  run.logs.push(`[sandbox] ${sandbox.sandboxId} created`);
  await saveRuns(kv, task.id, runs.slice(-MAX_RUNS_PER_TASK));

  // 2. Onyx.md (identity + tool compendium) — the agent's documentation.
  try {
    await sandbox.files.write(`${HOME}/Onyx.md`, ONYX_MD);
  } catch {
    /* best-effort */
  }

  // 3. Restore the persistent workspace BEFORE the agent runs.
  try {
    const restore = await serverRestoreWorkspace(sandbox, kv);
    run.logs.push(
      restore.ok
        ? `[workspace] restored ${restore.restoredFiles} file(s) (${Math.round(restore.bytes / 1024)} KB) from cloud`
        : `[workspace] restore warning: ${restore.error ?? restore.warnings.join("; ")}`,
    );
    await saveRuns(kv, task.id, runs.slice(-MAX_RUNS_PER_TASK));
  } catch (e) {
    run.logs.push(`[workspace] restore failed: ${e instanceof Error ? e.message : String(e)}`);
    await saveRuns(kv, task.id, runs.slice(-MAX_RUNS_PER_TASK));
  }

  // 4. Write the runner + run state, then launch as a background command.
  try {
    await sandbox.files.write(BG_SCRIPT_PATH, BG_AGENT_SCRIPT);
    const e2bRunId = "run_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    const runDir = BG_RUNS_PREFIX + e2bRunId;
    const state = {
      provider: {
        baseUrl: task.runtime.provider.baseUrl,
        apiKey: task.runtime.provider.apiKey,
        model: task.runtime.provider.model,
        toolsEnabled: task.runtime.provider.toolsEnabled !== false,
        noPrefix: task.runtime.provider.noPrefix ?? false,
        disabledParams: task.runtime.provider.disabledParams ?? [],
      },
      toolsEnabled: task.runtime.provider.toolsEnabled !== false,
      messages: [
        { role: "system", content: buildScheduledSystemPrompt(task) },
        { role: "user", content: task.instructions },
      ],
      ...(task.runtime.telegram?.botToken
        ? { telegram: { botToken: task.runtime.telegram.botToken, chatId: task.runtime.telegram.chatId } }
        : {}),
      scheduledTask: { taskId: task.id, runId: run.id, name: task.name },
      maxRounds: 30,
      status: "starting",
      content: "",
      startedAt: new Date().toISOString(),
    };
    await sandbox.files.write(`${runDir}/state.json`, JSON.stringify(state));
    await sandbox.files.write(`${runDir}/events.jsonl`, "");
    const handle = await sandbox.commands.run(
      `node ${BG_SCRIPT_PATH} ${e2bRunId} > ${HOME}/.onyx/bg-agent.log 2>&1`,
      { background: true, timeoutMs: 0, cwd: HOME },
    );
    run.e2bRunId = e2bRunId;
    run.status = "running";
    run.logs.push(`[runner] bg-agent launched (pid ${handle.pid}, e2b run ${e2bRunId})`);
    await saveRuns(kv, task.id, runs.slice(-MAX_RUNS_PER_TASK));
    return { run, alreadyRan: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    run.status = "failed";
    run.error = `Failed to launch the agent runner: ${msg}`;
    run.completedAt = new Date().toISOString();
    run.logs.push(`[error] launch failed: ${msg}`);
    await saveRuns(kv, task.id, runs.slice(-MAX_RUNS_PER_TASK));
    try {
      await sandbox.kill();
    } catch {
      /* best-effort */
    }
    return { run, alreadyRan: false, error: run.error };
  }
}

// ---------------------------------------------------------------------------
// Finalize a run (harvest result, sync workspace, notify, persist)
// ---------------------------------------------------------------------------

interface HarvestedEvents {
  toolCalls: number;
  logs: string[];
}

async function harvestEvents(sandbox: Sandbox, e2bRunId: string): Promise<HarvestedEvents> {
  const logs: string[] = [];
  let toolCalls = 0;
  try {
    const raw = await sandbox.files.read(`${BG_RUNS_PREFIX}${e2bRunId}/events.jsonl`);
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const ev = JSON.parse(t) as { t?: string; name?: string; id?: string; round?: number };
        if (ev.t === "tool_call") {
          toolCalls++;
          logs.push(`tool: ${ev.name}`);
        } else if (ev.t === "status" && ev.round) {
          // keep noise low
        } else if (ev.t === "error") {
          logs.push("runner error event");
        }
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* events log missing/unreadable */
  }
  return { toolCalls, logs: logs.slice(-MAX_RUN_LOG_LINES) };
}

async function notifyTelegram(task: ScheduledTask, run: ScheduledTaskRun): Promise<string | undefined> {
  const creds = task.runtime.telegram;
  if (!task.notificationConfig.telegram || !creds?.botToken || !creds.chatId) return undefined;
  const tz = task.timezone || "UTC";
  const completedAt = run.completedAt ? new Date(run.completedAt) : new Date();
  const timeLabel = `${completedAt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: tz })} ${tzShort(tz)}`;
  if (run.status === "completed") {
    const header =
      `✓ <b>Scheduled task completed</b>\n<b>${escapeHtml(task.name)}</b>\n` +
      `Completed at ${timeLabel} · ${run.durationMs ? Math.round(run.durationMs / 1000) : "?"}s · ${run.toolCalls} tool calls\n` +
      (run.filesChanged.length ? `Files updated: ${run.filesChanged.slice(0, 12).map(escapeHtml).join(", ")}${run.filesChanged.length > 12 ? " …" : ""}\n` : "");
    const body = (run.result ?? "(no final message)").slice(0, 3200);
    const r1 = await telegramSendMessage(creds.botToken, creds.chatId, `${header}\n${escapeHtml(body)}`);
    if (r1.ok && (run.result ?? "").length > 3200) {
      await telegramSendDocument(
        creds.botToken,
        creds.chatId,
        `${task.name.replace(/[^\w.-]/g, "_")}-result.md`,
        run.result ?? "",
        "Full run result",
      );
    }
    return r1.ok ? "sent" : `failed: ${r1.error}`;
  }
  const msg =
    `⚠ <b>Scheduled task failed</b>\n<b>${escapeHtml(task.name)}</b>\n` +
    `Failed at ${timeLabel}\n${escapeHtml((run.error ?? "unknown error").slice(0, 1500))}\n` +
    `Open Scheduled Tasks in the app to view the logs.`;
  const r = await telegramSendMessage(creds.botToken, creds.chatId, msg);
  return r.ok ? "sent" : `failed: ${r.error}`;
}

function tzShort(tz: string): string {
  const m = /\b([A-Z]{2,5})$/.exec(tz);
  if (m) return m[1] ?? "";
  return tz.split("/").pop()?.slice(0, 6).toUpperCase() ?? tz;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Check + finish one running run. Returns true when the run reached a
 *  terminal state this call. */
export async function finalizeRun(kv: SchedulerKV, task: ScheduledTask, run: ScheduledTaskRun): Promise<boolean> {
  if ((!run.sandboxId) || (run.status !== "running" && run.status !== "pending")) return false;
  const apiKey = e2bKey();
  if (!apiKey) return false;

  const startedMs = Date.parse(run.startedAt);
  const ageMs = Date.now() - startedMs;

  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.connect(run.sandboxId, { apiKey });
  } catch {
    run.unreachableChecks = (run.unreachableChecks ?? 0) + 1;
    if (run.unreachableChecks >= MAX_UNREACHABLE_CHECKS || ageMs > RUN_STALE_MS + 5 * 60_000) {
      run.status = "failed";
      run.error =
        ageMs > RUN_STALE_MS
          ? `Run exceeded ${Math.round(RUN_STALE_MS / 60000)} minutes and the sandbox is unreachable — declared failed.`
          : `E2B sandbox unreachable after ${run.unreachableChecks} checks — the run crashed or was killed.`;
      run.completedAt = new Date().toISOString();
      run.durationMs = Date.now() - startedMs;
      await persistFinal(kv, task, run);
      return true;
    }
    return false; // try again next tick
  }
  run.unreachableChecks = 0;

  // Recover the e2b run id when the launch-time save stranded (the sandbox's
  // bg-state pointer is the source of truth).
  if (!run.e2bRunId) {
    try {
      const ptrRaw = await sandbox.files.read(BG_STATE_PATH);
      const ptr = JSON.parse(ptrRaw) as { activeRun?: string };
      if (ptr?.activeRun) run.e2bRunId = ptr.activeRun;
    } catch {
      /* pointer unreadable */
    }
  }

  // Read the runner's state mirror.
  let runnerStatus = "running";
  let content = "";
  let runnerError: string | null = null;
  try {
    if (run.e2bRunId) {
      const raw = await sandbox.files.read(`${BG_RUNS_PREFIX}${run.e2bRunId}/state.json`);
      const st = JSON.parse(raw) as { status?: string; content?: string; error?: string | null };
      runnerStatus = st.status ?? "running";
      content = st.content ?? "";
      runnerError = st.error ?? null;
    }
  } catch {
    /* unreadable — treat as still running until stale */
  }

  if (runnerStatus === "running") {
    if (ageMs > RUN_STALE_MS) {
      try {
        await sandbox.commands.run("pkill -f bg-agent.mjs", { timeoutMs: 10_000 });
      } catch {
        /* best-effort */
      }
      run.status = "failed";
      run.error = `Run exceeded the ${Math.round(RUN_STALE_MS / 60000)}-minute budget — stopped.`;
      run.completedAt = new Date().toISOString();
      run.durationMs = Date.now() - startedMs;
      await persistFinal(kv, task, run);
      return true;
    }
    return false; // still running — wait for the next tick
  }

  // Terminal on the runner side — harvest.
  const harvested = run.e2bRunId ? await harvestEvents(sandbox, run.e2bRunId) : { toolCalls: 0, logs: [] };
  run.toolCalls = harvested.toolCalls;
  run.logs = [...run.logs, ...harvested.logs].slice(-MAX_RUN_LOG_LINES);

  if (runnerStatus === "done") {
    run.status = "completed";
    run.result = (content || "(no final message)").slice(0, MAX_RUN_RESULT);
  } else {
    run.status = "failed";
    run.error = (runnerError ?? "The agent runner ended with an error.").slice(0, MAX_RUN_RESULT);
    run.result = content ? content.slice(0, MAX_RUN_RESULT) : null;
  }
  run.completedAt = new Date().toISOString();
  run.durationMs = Date.now() - startedMs;

  // Workspace sync — the run's file changes persist to the cloud.
  try {
    const push = await serverPushWorkspace(sandbox, kv);
    run.logs.push(
      push.ok
        ? `[workspace] synced ${push.syncedFiles} file(s) back to cloud (${Math.round(push.uploadedBytes / 1024)} KB uploaded)`
        : `[workspace] sync skipped: ${push.error ?? "unknown"}`,
    );
    if (push.ok) {
      // Diff vs the pre-run manifest for the changed-file list.
      try {
        const files = await import("./ws-sync").then((m) => m.walkSandboxFiles(sandbox));
        run.filesChanged = files.map((f) => f.path).slice(0, 60);
      } catch {
        /* best-effort */
      }
    }
  } catch (e) {
    run.logs.push(`[workspace] sync failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Kill the sandbox — the workspace is safely in the cloud.
  try {
    await sandbox.kill();
  } catch {
    /* best-effort — E2B reaps it */
  }

  await persistFinal(kv, task, run);
  return true;
}

async function persistFinal(kv: SchedulerKV, task: ScheduledTask, run: ScheduledTaskRun): Promise<void> {
  const notifyStatus = await notifyTelegram(task, run);
  if (notifyStatus) run.notifyStatus = notifyStatus;

  const runs = await loadRuns(kv, task.id);
  const idx = runs.findIndex((r) => r.id === run.id);
  if (idx >= 0) runs[idx] = run;
  else runs.push(run);
  await saveRuns(kv, task.id, runs.slice(-MAX_RUNS_PER_TASK));

  // Task bookkeeping — per-task record (verified write; a failed bookkeeping
  // write never loses the run record above).
  const t = await readTask(kv, task.id);
  if (t) {
    t.lastRunAt = run.completedAt;
    t.lastRunStatus = run.status;
    t.runCount = (t.runCount ?? 0) + 1;
    if (run.status === "completed") t.failureStreak = 0;
    else t.failureStreak = (t.failureStreak ?? 0) + 1;
    t.updatedAt = new Date().toISOString();
    try {
      await writeTaskVerified(kv, t);
    } catch {
      // bookkeeping is best-effort here — the run record is already saved
    }
  }
}

// ---------------------------------------------------------------------------
// THE TICK — the authoritative scheduler heartbeat
// ---------------------------------------------------------------------------

interface TickOptions {
  trigger: string;
  force?: boolean;
}

export async function tick(kv: SchedulerKV, opts: TickOptions): Promise<TickResult> {
  const result: TickResult = {
    ok: true,
    ticked: false,
    fired: 0,
    finalized: 0,
    tasks: 0,
    running: 0,
    nextDueAt: null,
    lastTickAt: null,
    trigger: opts.trigger,
    errors: [],
  };

  // Tick lock — overlapping triggers collapse into one evaluation.
  try {
    const raw = await kv.get(SCHED_TICK_KEY);
    const rec = raw ? (JSON.parse(raw) as { lastTickAt?: number }) : null;
    if (rec?.lastTickAt && typeof rec.lastTickAt === "number") {
      result.lastTickAt = rec.lastTickAt;
      if (!opts.force && Date.now() - rec.lastTickAt < TICK_LOCK_MS) {
        result.skipped = "recent-tick";
        return result;
      }
    }
    await kv.set(SCHED_TICK_KEY, JSON.stringify({ lastTickAt: Date.now(), trigger: opts.trigger }));
  } catch (e) {
    result.errors.push(`tick lock failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const tasks = await loadTasks(kv);
  result.tasks = tasks.length;

  // 1. Finalize finished runs (max 3 per tick to bound the work).
  let finalChecks = 0;
  const runningTaskIds = new Set<string>();
  for (const task of tasks) {
    if (finalChecks >= 3) break;
    const runs = await loadRuns(kv, task.id);
    const running = runs.filter((r) => r.status === "running" || r.status === "pending");
    for (const run of running) {
      if (finalChecks >= 3) break;
      runningTaskIds.add(task.id);
      if (run.status === "pending" && !run.sandboxId && Date.now() - Date.parse(run.startedAt) > 10 * 60_000) {
        // Stuck pending with NO sandbox (launch crashed mid-write) — failed.
        run.status = "failed";
        run.error = "Launch never completed (stuck pending > 10 min).";
        run.completedAt = new Date().toISOString();
        const idx = runs.findIndex((r) => r.id === run.id);
        if (idx >= 0) runs[idx] = run;
        await saveRuns(kv, task.id, runs.slice(-MAX_RUNS_PER_TASK));
        result.finalized++;
        continue;
      }
      // A run with a sandboxId is LIVE whether its status says pending or
      // running (the "running" save can strand on OnyxBase — the sandbox is
      // the source of truth, the record is bookkeeping).
      if (run.status !== "running" && !(run.status === "pending" && run.sandboxId)) continue;
      finalChecks++;
      try {
        const done = await finalizeRun(kv, task, run);
        if (done) result.finalized++;
      } catch (e) {
        result.errors.push(`finalize ${task.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  result.running = runningTaskIds.size;

  // 2.5 RUN RECOVERY — E2B is the source of truth for LIVE scheduled
  //     sandboxes. A stranded run-record save must never orphan a run (the
  //     live sandbox with its finished state would be lost — observed live:
  //     a completed run stuck "pending" because its status saves never
  //     mirrored). List scheduled-tagged sandboxes; any one WITHOUT a live
  //     run record (or with an already-terminal record) gets recovered:
  //     e2bRunId resolved from the sandbox's bg-state pointer, then
  //     finalized through the normal path.
  try {
    const apiKey = e2bKey();
    if (apiKey) {
      const paginator = Sandbox.list({ apiKey, limit: 50 });
      const page = await paginator.nextItems();
      const scheduled = page.filter((s) => {
        const m = (s as { metadata?: Record<string, string> }).metadata;
        return !!m && typeof m === "object" && "onyx-scheduled" in m;
      });
      for (const sb of scheduled) {
        const meta = (sb as { metadata?: Record<string, string> }).metadata ?? {};
        const taskId = String(meta["onyx-scheduled"] ?? "");
        if (!taskId) continue;
        // Known live run for this sandbox? (record-based tracking above)
        const task = tasks.find((t) => t.id === taskId) ?? (await loadTaskById(kv, taskId));
        if (!task) continue;
        const runs = await loadRuns(kv, taskId);
        const existing = runs.find((r) => r.sandboxId === sb.sandboxId);
        if (existing && (existing.status === "running" || existing.status === "pending")) {
          continue; // handled by the loop above
        }
        if (existing) {
          continue; // already terminal — never re-finalize
        }
        const rawStart = (sb as unknown as { startedAt?: string | Date }).startedAt;
        const startedAt =
          rawStart instanceof Date
            ? rawStart.toISOString()
            : typeof rawStart === "string"
              ? rawStart
              : new Date().toISOString();
        const recovered: ScheduledTaskRun = {
          id: runIdFor(taskId, Date.parse(startedAt) || Date.now()),
          taskId,
          scheduledFor: Date.parse(startedAt) || Date.now(),
          startedAt,
          completedAt: null,
          status: "running",
          trigger: "schedule",
          sandboxId: sb.sandboxId,
          e2bRunId: null,
          result: null,
          error: null,
          durationMs: null,
          filesChanged: [],
          toolCalls: 0,
          logs: ["[recovery] live scheduled sandbox without a run record — recovered"],
          unreachableChecks: 0,
        };
        finalChecks++;
        try {
          const done = await finalizeRun(kv, task, recovered);
          if (done) result.finalized++;
        } catch (e) {
          result.errors.push(`recover ${taskId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  } catch {
    /* recovery best-effort */
  }

  // 2. Fire due tasks (at most ONE new launch per tick; global concurrency cap).
  const freshTasks = await loadTasks(kv); // re-load (finalize updates them)
  let newRuns = 0;
  for (const task of freshTasks) {
    if (newRuns >= 1) break;
    if (result.running >= MAX_CONCURRENT_RUNS) break;
    if (!task.enabled || task.nextRunAt == null) continue;
    if (task.nextRetryAt && Date.now() < task.nextRetryAt) continue;
    const now = Date.now();
    if (task.nextRunAt > now) continue;

    // One-time tasks: fire within the catch-up grace, else complete silently.
    const occurrence = task.nextRunAt;
    const isOnce = task.scheduleType === "once";
    if (isOnce && now - occurrence > ONCE_CATCHUP_GRACE_MS) {
      task.enabled = false;
      task.nextRunAt = null;
      task.updatedAt = new Date().toISOString();
      await writeTaskVerified(kv, task).catch(() => {});
      continue;
    }

    try {
      const fired = await fireRun(kv, task, occurrence, "schedule");
      if (!fired.alreadyRan) {
        newRuns++;
        result.fired++;
        result.running++;
      }
    } catch (e) {
      result.errors.push(`fire ${task.id}: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Reschedule (occurrence consumed) — per-task verified write.
    const updated = freshTasks.find((t) => t.id === task.id) ?? task;
    if (isOnce) {
      updated.enabled = false;
      updated.nextRunAt = null;
    } else {
      const next = computeNextRun(taskScheduleOf(updated), updated.scheduleMeta, Date.now());
      if (next == null) {
        updated.enabled = false; // schedule can never fire again
        updated.nextRunAt = null;
      } else {
        updated.nextRunAt = next;
      }
    }
    // Transient launch failure → exponential retry (max 3).
    if (updated.failureStreak != null && updated.failureStreak > 0 && updated.failureStreak <= MAX_LAUNCH_RETRIES) {
      const backoff = RETRY_BASE_MS * 2 ** (updated.failureStreak - 1);
      const retryAt = Date.now() + backoff;
      if (updated.scheduleType !== "once" && updated.enabled) {
        updated.nextRetryAt = retryAt;
        updated.nextRunAt = Math.max(updated.nextRunAt ?? 0, retryAt);
      }
    }
    updated.updatedAt = new Date().toISOString();
    try {
      await writeTaskVerified(kv, updated);
    } catch (e) {
      result.errors.push(`reschedule ${task.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 3. Persist tick record + compute next-due summary.
  const finalTasks = await loadTasks(kv);
  result.tasks = finalTasks.length;
  const nextDue = finalTasks
    .filter((t) => t.enabled && t.nextRunAt != null)
    .map((t) => t.nextRunAt as number)
    .sort((a, b) => a - b);
  result.nextDueAt = nextDue[0] ?? null;
  try {
    await kv.set(
      SCHED_TICK_KEY,
      JSON.stringify({
        lastTickAt: Date.now(),
        trigger: opts.trigger,
        fired: result.fired,
        finalized: result.finalized,
        tasks: result.tasks,
        running: result.running,
        nextDueAt: result.nextDueAt,
      }),
    );
  } catch {
    /* best-effort */
  }
  result.ticked = true;
  return result;
}

// ---------------------------------------------------------------------------
// Manual "run now"
// ---------------------------------------------------------------------------

export async function runTaskNow(kv: SchedulerKV, taskId: string): Promise<ScheduledTaskRun> {
  const task = await loadTaskById(kv, taskId);
  if (!task) throw new Error(`Scheduled task not found: ${taskId}`);
  if (!task.enabled) throw new Error("Task is paused — resume it before running.");
  const occurrence = Date.now();
  const fired = await fireRun(kv, task, occurrence, "manual");
  return fired.run;
}

// ---------------------------------------------------------------------------
// History / listing
// ---------------------------------------------------------------------------

export async function listTasksSafe(kv: SchedulerKV): Promise<SafeScheduledTask[]> {
  const tasks = await loadTasks(kv);
  return tasks.map(toSafeTask);
}

export async function getTaskHistory(kv: SchedulerKV, taskId: string, limit = 20): Promise<ScheduledTaskRun[]> {
  const runs = await loadRunsConverged(kv, taskId);
  return runs.slice(-limit).reverse();
}

export async function getRun(kv: SchedulerKV, taskId: string, runId: string): Promise<ScheduledTaskRun | null> {
  const runs = await loadRunsConverged(kv, taskId, runId);
  return runs.find((r) => r.id === runId) ?? null;
}
