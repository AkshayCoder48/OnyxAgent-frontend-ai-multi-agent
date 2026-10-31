// ============================================================================
// Background Task Execution Framework — /api/tasks/schedules/[id] (FR-2.1).
//
//   PATCH  → partial update {name?, cronExpr?, timezone?, taskType?, prompt?,
//            config?, active?}; changed fields validated with the same rules
//            as POST. cron/timezone/active changes re-arm nextRunAt (from NOW
//            — the claim protocol keeps an in-flight due occurrence safe);
//            deactivation clears nextRunAt; unrelated edits never touch the
//            armed fire time.
//   DELETE → unlink the schedule's runs (scheduleId → null, history kept),
//            then delete the row.
//
// Next 16 dynamic-route handler signature: params is a Promise.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/tasks/prisma";
import { armSchedule, toScheduleRecord } from "@/lib/tasks/cron-scheduler";
import { deleteCloudSchedule, getCloudConfig, sealSecret, upsertCloudSchedule } from "@/lib/tasks/trigger-cloud";
import { isAbsoluteHttpUrl, isAppBridgeUrl, NO_PROVIDER_CREDENTIALS_ERROR } from "@/lib/tasks/run-credentials";
import { isLegacyClassicUrl } from "@/lib/agent/provider-url";
import {
  BACKGROUND_TASK_TYPES,
  TASK_PAYLOAD_BUDGET,
  validateCron,
  type TaskRunConfig,
  type TaskScheduleInput,
} from "@/lib/tasks/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ id: string }>;
}

function bad(detail: string): NextResponse {
  return NextResponse.json({ ok: false, error: detail }, { status: 400 });
}

function notFound(): NextResponse {
  return NextResponse.json({ ok: false, error: "schedule not found" }, { status: 404 });
}

/** Validate an IANA timezone; null when invalid (PATCH must REJECT, not
 *  silently rewrite, a bad zone — unlike POST's UTC default). */
function validTimezone(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw.trim() });
    return raw.trim();
  } catch {
    return null;
  }
}

/** Durable-cron mirror helpers (Trigger.dev PRD §3.4) — best-effort, never
 *  block or fail the HTTP response; the in-app sweep loop is the fallback. */
async function mirrorScheduleToCloud(
  scheduleId: string,
  cron: string,
  timezone: string,
): Promise<void> {
  const cloud = await getCloudConfig().catch(() => null);
  if (!cloud) return;
  try {
    await upsertCloudSchedule(cloud, { scheduleId, cron, timezone });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[tasks] cloud cron update failed for schedule ${scheduleId} (in-app loop carries it): ${message.slice(0, 160)}`,
    );
  }
}

async function removeScheduleFromCloud(scheduleId: string): Promise<void> {
  const cloud = await getCloudConfig().catch(() => null);
  if (!cloud) return;
  try {
    await deleteCloudSchedule(cloud, scheduleId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[tasks] cloud cron removal failed for schedule ${scheduleId}: ${message.slice(0, 160)}`,
    );
  }
}

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  const { id } = await ctx.params;

  let body: Partial<TaskScheduleInput>;
  try {
    body = (await request.json()) as Partial<TaskScheduleInput>;
  } catch {
    return bad("invalid JSON body");
  }

  const existing = await prisma.taskSchedule.findUnique({ where: { id } });
  if (!existing) return notFound();

  const data: Record<string, unknown> = {};
  const changed = { cron: false, timezone: false, active: false };

  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 1 || name.length > 80) return bad("name must be 1–80 characters");
    data.name = name;
  }
  if (body.cronExpr !== undefined) {
    const cronExpr = typeof body.cronExpr === "string" ? body.cronExpr.trim() : "";
    if (!cronExpr) return bad("cronExpr must be a non-empty string");
    const cronError = validateCron(cronExpr);
    if (cronError) return bad(`cronExpr is invalid: ${cronError}`);
    if (cronExpr !== existing.cronExpr) changed.cron = true;
    data.cronExpr = cronExpr;
  }
  if (body.timezone !== undefined) {
    const tz = validTimezone(body.timezone);
    if (!tz) return bad("timezone must be a valid IANA timezone");
    if (tz !== existing.timezone) changed.timezone = true;
    data.timezone = tz;
  }
  if (body.taskType !== undefined) {
    if (
      typeof body.taskType !== "string" ||
      !(BACKGROUND_TASK_TYPES as readonly string[]).includes(body.taskType)
    ) {
      return bad(`taskType must be one of ${BACKGROUND_TASK_TYPES.join(", ")}`);
    }
    data.taskType = body.taskType;
  }
  if (body.prompt !== undefined) {
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return bad("prompt must be a non-empty string");
    if (prompt.length > TASK_PAYLOAD_BUDGET.maxPromptChars) {
      return bad(`prompt exceeds ${TASK_PAYLOAD_BUDGET.maxPromptChars} chars`);
    }
    data.prompt = prompt;
  }
  if (body.config !== undefined) {
    if (typeof body.config !== "object" || body.config === null || Array.isArray(body.config)) {
      return bad("config must be an object");
    }
    data.config = JSON.stringify(body.config as TaskRunConfig);
  }
  // BYOK (user directive 2026-10-31): the schedule's own provider key —
  // re-sealed on every patch that carries one (plaintext only in transit;
  // never logged, never returned). An explicit empty string CLEARS the
  // sealed key (keyless gateway); omitting the field keeps the stored one.
  if (body.apiKey !== undefined) {
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (apiKey.length > 512) return bad("apiKey exceeds 512 characters");
    data.encryptedApiKey = apiKey ? sealSecret(apiKey) : null;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") return bad("active must be a boolean");
    if (body.active !== existing.active) changed.active = true;
    data.active = body.active;
  }

  if (Object.keys(data).length === 0) {
    return bad("no updatable fields provided");
  }

  // terminal_command integrity after the merge (patched taskType/config).
  const nextTaskType = (data.taskType as string | undefined) ?? existing.taskType;
  if (nextTaskType === "terminal_command") {
    let config: TaskRunConfig | null = null;
    try {
      config = data.config
        ? (JSON.parse(data.config as string) as TaskRunConfig)
        : (JSON.parse(existing.config) as TaskRunConfig);
    } catch {
      config = null;
    }
    if (!config || typeof config.command !== "string" || !config.command.trim()) {
      return bad("terminal_command schedules require config.command");
    }
  }

  // ── BYOK GATE (user directive 2026-10-31) ────────────────────────────────
  // agent_run schedules MUST keep a pinned user gateway across the merge —
  // scheduled runs execute on the USER's credentials, never the app's own
  // model. A patch that would strip the gateway (or pin a legacy/bridge
  // URL) is rejected with the actionable message.
  if (nextTaskType !== "terminal_command") {
    let nextConfig: TaskRunConfig | null = null;
    try {
      nextConfig = data.config
        ? (JSON.parse(data.config as string) as TaskRunConfig)
        : (JSON.parse(existing.config) as TaskRunConfig);
    } catch {
      nextConfig = null;
    }
    const chatUrl =
      typeof nextConfig?.chatUrl === "string" ? nextConfig.chatUrl.trim() : "";
    if (!isAbsoluteHttpUrl(chatUrl) || isAppBridgeUrl(chatUrl)) {
      return bad(NO_PROVIDER_CREDENTIALS_ERROR);
    }
    if (isLegacyClassicUrl(chatUrl)) {
      return bad(
        "The pinned provider gateway is the retired text.pollinations.ai (Classic) endpoint — reselect your provider in Settings → Agent Settings → AI Providers and re-save the schedule. (code: legacy_endpoint_pin)",
      );
    }
  }

  try {
    let row = await prisma.taskSchedule.update({ where: { id }, data });

    // Re-arm ONLY on scheduling-relevant changes: deactivation clears the
    // cursor; (re)activation or a cron/timezone change re-computes nextRunAt
    // from now. Unrelated edits keep the armed fire time untouched.
    const rearm = changed.cron || changed.timezone || changed.active;
    if (rearm) {
      if (!row.active) {
        row = await prisma.taskSchedule.update({
          where: { id },
          data: { nextRunAt: null },
        });
        // Deactivated → drop its durable cloud cron mirror (PRD §3.4).
        await removeScheduleFromCloud(id).catch(() => undefined);
      } else {
        await armSchedule(row);
        row = (await prisma.taskSchedule.findUnique({ where: { id } })) ?? row;
        // Activated / cron / timezone changed → refresh the cloud mirror.
        await mirrorScheduleToCloud(id, row.cronExpr, row.timezone).catch(() => undefined);
      }
    }
    return NextResponse.json({ ok: true, schedule: toScheduleRecord(row) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[tasks] schedule update failed: ${message.slice(0, 200)}`);
    return NextResponse.json({ ok: false, error: "failed to update the schedule" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const existing = await prisma.taskSchedule.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return notFound();

  try {
    // Unlink runs first (keep run history), then drop the schedule.
    await prisma.taskRun.updateMany({
      where: { scheduleId: id },
      data: { scheduleId: null },
    });
    await prisma.taskSchedule.delete({ where: { id } });
    // Drop its durable cloud cron mirror too (PRD §3.4) — best-effort.
    await removeScheduleFromCloud(id).catch(() => undefined);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[tasks] schedule delete failed: ${message.slice(0, 200)}`);
    return NextResponse.json({ ok: false, error: "failed to delete the schedule" }, { status: 500 });
  }
}
