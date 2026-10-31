// ============================================================================
// Background Task Execution Framework — /api/tasks/schedules (FR-2.1).
//
//   GET  → arm any active schedule missing nextRunAt (recovery pass — a
//          single indexed query when nothing needs arming), then list all
//          schedules newest-first as TaskScheduleRecord[].
//   POST → validate TaskScheduleInput (cron via protocol.validateCron, name
//          1–80, prompt non-empty + budget-capped, taskType allow-list,
//          timezone validated through Intl with UTC fallback), create, and
//          arm nextRunAt (a cron with no occurrence in the scan window
//          deactivates the schedule — armSchedule's contract).
//
// Body-logging discipline mirrors /api/chat-proxy.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/tasks/prisma";
import { armDueSchedules, armSchedule, toScheduleRecord } from "@/lib/tasks/cron-scheduler";
import { getCloudConfig, upsertCloudSchedule } from "@/lib/tasks/trigger-cloud";
import {
  BACKGROUND_TASK_TYPES,
  TASK_PAYLOAD_BUDGET,
  validateCron,
  type BackgroundTaskType,
  type TaskRunConfig,
  type TaskScheduleInput,
} from "@/lib/tasks/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function bad(detail: string): NextResponse {
  return NextResponse.json({ ok: false, error: detail }, { status: 400 });
}

/** Validate an IANA timezone by constructing a formatter (throws on invalid
 *  ids). Invalid/absent input falls back to "UTC". */
function normalizeTimezone(raw: unknown): string {
  const candidate = typeof raw === "string" ? raw.trim() : "";
  if (!candidate) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return "UTC";
  }
}

/** Validate the config object (when present); terminal_command schedules
 *  must carry their command now — the sweep fires headless. */
function validateConfig(raw: unknown, taskType: string): { error: string } | { value: TaskRunConfig | null } {
  if (raw === undefined || raw === null) {
    if (taskType === "terminal_command") {
      return { error: "terminal_command schedules require config.command" };
    }
    return { value: null };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "config must be an object" };
  const config = raw as TaskRunConfig;
  if (taskType === "terminal_command" && (typeof config.command !== "string" || !config.command.trim())) {
    return { error: "terminal_command schedules require config.command" };
  }
  return { value: config };
}

/** Durable-cron mirror (Trigger.dev PRD §3.4): register the row's cron on
 *  the operator's Trigger.dev Cloud so it fires even when no browser polls
 *  and the Next.js server is asleep. Best-effort — the in-app sweep loop
 *  remains the fallback; NEVER blocks or fails the HTTP response. */
async function mirrorScheduleToCloud(
  scheduleId: string,
  cron: string,
  timezone: string,
  active: boolean,
): Promise<void> {
  if (!active) return; // deactivation is handled by the caller's remove path
  const cloud = await getCloudConfig().catch(() => null);
  if (!cloud) return;
  try {
    await upsertCloudSchedule(cloud, { scheduleId, cron, timezone });
    console.log(`[tasks] cloud cron registered for schedule ${scheduleId} (${cron} ${timezone})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[tasks] cloud cron registration failed for schedule ${scheduleId} (in-app loop carries it): ${message.slice(0, 160)}`,
    );
  }
}

export async function GET(): Promise<NextResponse> {
  // Recovery pass: arm fresh/recovered schedules that never got a nextRunAt
  // (cheap when nothing needs it), then list.
  await armDueSchedules().catch(() => {
    // arming is best-effort — the list must still answer
  });

  const rows = await prisma.taskSchedule.findMany({
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ ok: true, schedules: rows.map(toScheduleRecord) });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Partial<TaskScheduleInput>;
  try {
    body = (await request.json()) as Partial<TaskScheduleInput>;
  } catch {
    return bad("invalid JSON body");
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 1 || name.length > 80) return bad("name must be 1–80 characters");

  const cronExpr = typeof body.cronExpr === "string" ? body.cronExpr.trim() : "";
  if (!cronExpr) return bad("cronExpr is required");
  const cronError = validateCron(cronExpr);
  if (cronError) return bad(`cronExpr is invalid: ${cronError}`);

  const taskType = body.taskType;
  if (
    typeof taskType !== "string" ||
    !(BACKGROUND_TASK_TYPES as readonly string[]).includes(taskType)
  ) {
    return bad(`taskType must be one of ${BACKGROUND_TASK_TYPES.join(", ")}`);
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return bad("prompt must be a non-empty string");
  if (prompt.length > TASK_PAYLOAD_BUDGET.maxPromptChars) {
    return bad(`prompt exceeds ${TASK_PAYLOAD_BUDGET.maxPromptChars} chars`);
  }

  const timezone = normalizeTimezone(body.timezone);
  const checkedConfig = validateConfig(body.config, taskType);
  if ("error" in checkedConfig) return bad(checkedConfig.error);
  const active = typeof body.active === "boolean" ? body.active : true;

  try {
    const created = await prisma.taskSchedule.create({
      data: {
        name,
        cronExpr,
        timezone,
        taskType: taskType as BackgroundTaskType,
        prompt,
        config: checkedConfig.value ? JSON.stringify(checkedConfig.value) : "{}",
        active,
      },
    });

    // Arm immediately so the record answers with a concrete nextRunAt (an
    // inactive schedule stays unarmed; an expression with no occurrence
    // deactivates itself — armSchedule's contract).
    let row = created;
    if (created.active) {
      await armSchedule(created);
      row =
        (await prisma.taskSchedule.findUnique({ where: { id: created.id } })) ?? created;
      // Durable cloud mirror (PRD §3.4) — best-effort, never blocks creation.
      await mirrorScheduleToCloud(row.id, row.cronExpr, row.timezone, row.active).catch(() => undefined);
    }
    return NextResponse.json({ ok: true, schedule: toScheduleRecord(row) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[tasks] schedule create failed: ${message.slice(0, 200)}`);
    return NextResponse.json({ ok: false, error: "failed to create the schedule" }, { status: 500 });
  }
}
