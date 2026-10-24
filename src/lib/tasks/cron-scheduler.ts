// ============================================================================
// Background Task Execution Framework — cron scheduler (FR-2.1).
//
// TaskSchedule rows in SQLite are the source of truth; this module is the
// SWEEP that fires them even when every browser is closed:
//
//   · sweepSchedules() — find active schedules with nextRunAt <= now (or
//     null), ATOMICALLY claim each via updateMany on the SAME nextRunAt
//     value (prevents double-fire across concurrent sweeps — local loop,
//     sweep-on-read), then create the TaskRun and dispatch it DIRECTLY to
//     the operator's Trigger.dev Cloud project.
//   · startSchedulerLoop() — a 60s interval (unref'd, idempotent singleton)
//     calling the sweep.
//   · touch() — throttled (5s) sweep-on-read invoked by the GET routes so
//     short-lived serverless instances still pick up due schedules.
// ============================================================================

import { randomBytes, randomUUID } from "node:crypto";
import type { TaskSchedule } from "@prisma/client";
import { nextCronRun, type BackgroundTaskType, type TaskRunConfig, type TaskScheduleRecord } from "./protocol";
import { getCloudConfig } from "./trigger-cloud";
import { dispatchCloudRun } from "./trigger-cloud";
import { prisma } from "./prisma";
import { keyring } from "./keyring";
import { parseConfig } from "./run-store";
import { EMPTY_PAYLOAD_JSON } from "./run-store";

const SWEEP_INTERVAL_MS = 60_000;
const TOUCH_THROTTLE_MS = 5_000;
const SWEEP_BATCH = 20;

/** Synthetic owner for schedule-fired runs (schedules are user-less in the
 *  frozen protocol; the client correlates them via run.scheduleId). */
const SCHEDULED_USER_ID = "scheduled";

/** Loop singleton (module-scoped + globalThis-guarded so dev HMR reloads
 *  never stack intervals). */
interface SchedulerGlobal {
  __onyxTaskSchedulerLoop?: ReturnType<typeof setInterval> | null;
  __onyxTaskSchedulerTouchAt?: number;
  __onyxTaskSchedulerTouching?: boolean;
}
const g = globalThis as unknown as SchedulerGlobal;
let loopTimer: ReturnType<typeof setInterval> | null = g.__onyxTaskSchedulerLoop ?? null;
let touchBusy = g.__onyxTaskSchedulerTouching ?? false;

// ---------------------------------------------------------------------------
// Arming
// ---------------------------------------------------------------------------

/**
 * Compute + persist the next fire time for a schedule. Returns the armed
 * Date, or null when the expression has no occurrence within the scan
 * window — in which case the schedule is deactivated (a cron that never
 * fires would otherwise sweep-loop forever).
 */
export async function armSchedule(schedule: TaskSchedule): Promise<Date | null> {
  const next = nextCronRun(schedule.cronExpr, schedule.timezone);
  try {
    await prisma.taskSchedule.update({
      where: { id: schedule.id },
      data: next
        ? { nextRunAt: next }
        : { nextRunAt: null, active: false },
    });
  } catch {
    // schedule deleted mid-arm — nothing to persist
  }
  return next;
}

/** Arm every active schedule that has no nextRunAt yet (fresh / recovered).
 *  Exported for the schedules routes' GET recovery pass (single indexed
 *  query when nothing needs arming). */
export async function armDueSchedules(): Promise<number> {
  const unarmed = await prisma.taskSchedule.findMany({
    where: { active: true, nextRunAt: null },
    take: SWEEP_BATCH,
  });
  let armed = 0;
  for (const s of unarmed) {
    if (await armSchedule(s)) armed += 1;
  }
  return armed;
}

// ---------------------------------------------------------------------------
// Sweep (the fire path)
// ---------------------------------------------------------------------------

/**
 * Fire every due schedule exactly once. Returns the number of runs created.
 * Safe to call concurrently from any number of processes — the claim is the
 * updateMany on the schedule's CURRENT nextRunAt value.
 *
 * Each fired run is dispatched DIRECTLY to the operator's Trigger.dev Cloud
 * project (the deployed agent-run task). Without a connected key nothing
 * fires (cloud-only execution by design).
 */
export async function sweepSchedules(): Promise<number> {
  const cloud = await getCloudConfig();
  if (!cloud) {
    // Nothing executes without the cloud — still keep nextRunAt fresh so a
    // later connect doesn't stampede a backlog all at once.
    await armDueSchedules().catch(() => {});
    return 0;
  }

  const now = new Date();
  const due = await prisma.taskSchedule.findMany({
    where: { active: true, OR: [{ nextRunAt: { lte: now } }, { nextRunAt: null }] },
    take: SWEEP_BATCH,
  });

  let fired = 0;
  for (const s of due) {
    // 1) Atomic claim: bump lastRunAt/runCount + advance nextRunAt. A
    //    concurrent sweeper holding the same row fails this updateMany and
    //    skips — exactly one process fires this occurrence.
    const next = nextCronRun(s.cronExpr, s.timezone, now);
    const claim = await prisma.taskSchedule.updateMany({
      where: { id: s.id, nextRunAt: s.nextRunAt ?? null },
      data: {
        lastRunAt: now,
        runCount: { increment: 1 },
        ...(next
          ? { nextRunAt: next }
          : { nextRunAt: null, active: false }),
      },
    });
    if (claim.count === 0) continue;

    // 2) Create the run (queued → dispatched below). The prompt comes from
    //    the schedule; the payload stays EMPTY — scheduled prompts are never
    //    duplicated into files (FR-1.1 serialization is a client concept).
    try {
      const run = await prisma.taskRun.create({
        data: {
          taskId: randomUUID(),
          userId: SCHEDULED_USER_ID,
          type: s.taskType,
          status: "queued",
          phase: "claim",
          orchestrator: "cloud",
          title: s.name,
          prompt: s.prompt,
          config: s.config || "{}",
          payload: EMPTY_PAYLOAD_JSON,
          scheduleId: s.id,
        },
      });

      // 3) Mint the run's bridge credential (server-side, keyring-only —
      //    scheduled tasks have no client to mint one). The LLM endpoint is
      //    the schedule's pinned provider gateway (config.chatUrl) or the
      //    app's keyless bridge; the E2B key comes from the server env.
      const appUrl = process.env.APP_URL?.trim() || "http://localhost:3000";
      if (!process.env.APP_URL?.trim()) {
        console.warn(
          "[tasks] APP_URL is not set — scheduled runs default the LLM bridge to http://localhost:3000, which is unreachable from an E2B sandbox. Set APP_URL to the public origin.",
        );
      }
      const scheduleConfig = parseConfig(s.config);
      keyring.set(run.id, {
        taskToken: randomBytes(32).toString("hex"),
        keyPool: [],
        ...(scheduleConfig.chatUrl ? { chatUrl: scheduleConfig.chatUrl } : {}),
        ...(scheduleConfig.model ? { model: scheduleConfig.model } : {}),
        e2bApiKey: "USE_SERVER_ENV",
        appUrl,
        createdAt: Date.now(),
      });

      // 4) Dispatch directly to the cloud.
      void dispatchCloudRun(run.id, appUrl).catch(() => {
        // dispatchCloudRun settles the row itself on failure.
      });
      fired += 1;
      console.log(`[tasks] schedule ${s.name} (${s.id}) fired → run ${run.id}`);
    } catch (err) {
      console.warn(`[tasks] schedule ${s.id} failed to create its run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return fired;
}

// ---------------------------------------------------------------------------
// Row → TaskScheduleRecord (shared by the schedules routes)
// ---------------------------------------------------------------------------

/** Map a TaskSchedule row to the protocol record shape: config JSON parsed
 *  (null when absent/unparseable), dates as ISO strings. */
export function toScheduleRecord(row: TaskSchedule): TaskScheduleRecord {
  let config: TaskRunConfig | null = null;
  try {
    const parsed = row.config ? JSON.parse(row.config) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as TaskRunConfig;
    }
  } catch {
    config = null;
  }
  return {
    id: row.id,
    name: row.name,
    cronExpr: row.cronExpr,
    timezone: row.timezone,
    taskType: row.taskType as BackgroundTaskType,
    prompt: row.prompt,
    config,
    active: row.active,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    runCount: row.runCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Loop + sweep-on-read
// ---------------------------------------------------------------------------

async function schedulerTick(): Promise<void> {
  try {
    await sweepSchedules();
  } catch (err) {
    console.warn(`[tasks] scheduler tick failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Start the 60s sweep loop (idempotent — repeated calls are no-ops). The
 *  timer is unref'd so it never keeps the process alive on its own. */
export function startSchedulerLoop(): void {
  if (loopTimer) return;
  loopTimer = setInterval(() => {
    void schedulerTick();
  }, SWEEP_INTERVAL_MS);
  loopTimer.unref?.();
  g.__onyxTaskSchedulerLoop = loopTimer;
  console.log(`[tasks] scheduler loop started (${SWEEP_INTERVAL_MS / 1000}s; cloud dispatch)`);
}

/** Stop the loop (test/teardown hook). */
export function stopSchedulerLoop(): void {
  if (!loopTimer) return;
  clearInterval(loopTimer);
  loopTimer = null;
  g.__onyxTaskSchedulerLoop = null;
  console.log("[tasks] scheduler loop stopped");
}

/**
 * Sweep-on-read: called by the GET routes so due schedules fire even when
 * only short-lived serverless instances exist. Throttled to one sweep per
 * 5s per process; fire-and-forget (never blocks the response).
 */
export function touch(): void {
  const now = Date.now();
  if (touchBusy || now - (g.__onyxTaskSchedulerTouchAt ?? 0) < TOUCH_THROTTLE_MS) return;
  g.__onyxTaskSchedulerTouchAt = now;
  touchBusy = true;
  g.__onyxTaskSchedulerTouching = true;
  void sweepSchedules()
    .catch(() => {
      // best-effort by contract
    })
    .finally(() => {
      touchBusy = false;
      g.__onyxTaskSchedulerTouching = false;
    });
}
