"use client";

/**
 * Scheduled-task tools — the AI's management surface for automation.
 *
 * 8 SEPARATE tools (per the single-tool-management spec — no god-tool):
 *   create_scheduled_task, update_scheduled_task, delete_scheduled_task,
 *   pause_scheduled_task, resume_scheduled_task, run_scheduled_task_now,
 *   list_scheduled_tasks, get_scheduled_task_history
 *
 * SECURITY MODEL (same as push_workspace): the OnyxBase key is resolved from
 * the encrypted vault HERE, at execution time, and sent to /api/scheduler/*
 * as a request header — it is never part of any tool schema, argument,
 * prompt, or result. The provider API key is likewise resolved client-side
 * from the settings store and attached to the CREATE payload only (the
 * server stores it in the user's own KV so unattended runs can authenticate
 * — the model never sees either credential).
 */

import { registerTool, type ToolContext } from "./registry";
import { resolveProviderSnapshot } from "@/lib/scheduler/client";
import type {
  CreateTaskPayload,
  SafeScheduledTask,
  ScheduledTaskRun,
  TaskSchedule,
} from "@/lib/scheduler/types";
import { describeSchedule } from "@/lib/scheduler/tz-cron";

const NOT_CONFIGURED =
  "Cloud scheduling isn't configured yet. Add your OnyxBase API key in Settings → Cloud Workspace (the same key that powers the cloud workspace).";

interface SchedulerCallResult<T> {
  ok: boolean;
  error?: string;
  message?: string;
  result?: T;
}

async function schedulerCall<T>(
  ctx: ToolContext,
  action: string,
  payload: Record<string, unknown>,
): Promise<SchedulerCallResult<T>> {
  // Resolve the OnyxBase key from the encrypted vault (execution-time only).
  let key: string | null = null;
  try {
    const { settingsService } = await import("@/lib/services");
    const { useAuthStore } = await import("@/stores");
    const userId = ctx.userId || useAuthStore.getState().user?.id;
    if (userId) {
      key = await settingsService.getDecryptedOnyxBaseApiKey(userId);
    }
  } catch {
    key = null;
  }
  if (!key || !key.trim()) {
    return { ok: false, error: "NOT_CONFIGURED", message: NOT_CONFIGURED };
  }
  try {
    const res = await fetch("/api/scheduler/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OnyxBase-Key": key },
      body: JSON.stringify({ action, ...payload }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error: String(data.error ?? "ACTION_FAILED"),
        message: String(data.message ?? `Scheduler action "${action}" failed (${res.status})`),
      };
    }
    return { ok: true, result: data as T };
  } catch (e) {
    return { ok: false, error: "NETWORK", message: e instanceof Error ? e.message : "network error" };
  }
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function taskSummary(t: SafeScheduledTask): string {
  const next = t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : "—";
  const last = t.lastRunAt ? `${new Date(t.lastRunAt).toLocaleString()} (${t.lastRunStatus ?? "?"})` : "never";
  return [
    `${t.name} [id: ${t.id}]`,
    `  schedule: ${describeSchedule(t as never)} · ${t.timezone}`,
    `  status: ${t.enabled ? "Active" : "Paused"} · next run: ${next} · last run: ${last}`,
    `  workspace: ${t.workspaceId}${t.runtime?.hasTelegram ? " · telegram notifications: on" : ""}`,
    `  instructions: ${t.instructions.slice(0, 120)}${t.instructions.length > 120 ? "…" : ""}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// create_scheduled_task
// ---------------------------------------------------------------------------

registerTool(
  "create_scheduled_task",
  "Create an autonomous SCHEDULED TASK that runs a full agent job (research, coding, file generation, Telegram delivery…) on a schedule — even when this app is closed. The task runs in an isolated E2B sandbox with the web/file/terminal/python/telegram tools, the persistent workspace restored before and synced after each run, and its result saved + (optionally) sent to the user's Telegram. SCHEDULE object: { type: 'daily'|'weekly'|'monthly'|'interval'|'once'|'cron', expression, time, timezone, startAt?, endAt? }. expression: daily='HH:MM'; weekly=weekday numbers 0-6 (0=Sunday, comma list); monthly=day-of-month 1-31; interval=SECONDS (>=60); once=ISO datetime; cron=5-field expression. time='HH:MM' for weekly/monthly. timezone: IANA name (Asia/Kolkata, America/New_York…); default is the user's local timezone — only set another when the user explicitly names it. Convert natural language ('every weekday at 8:30 AM', 'every 30 minutes', 'tomorrow at 5 PM') into these fields. instructions = the COMPLETE agent job in full detail — it is executed verbatim by an autonomous agent with no user available, so make it self-contained (what to research/do, which files to write and their names, what to send on Telegram). Ask a clarifying question ONLY when the time is genuinely ambiguous ('schedule this daily' with no time anywhere); otherwise create the task directly.",
  {
    type: "object",
    properties: {
      name: { type: "string", description: "Short task name (e.g. 'Daily Railway Research')" },
      description: { type: "string", description: "One-line description of what the task does" },
      instructions: {
        type: "string",
        description:
          "The COMPLETE agent job executed at run time: what to do, sources to check, files to create/update (with paths), what to send on Telegram. Written for an autonomous agent with NO user available.",
      },
      schedule: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["once", "interval", "daily", "weekly", "monthly", "cron"] },
          expression: {
            type: "string",
            description: "daily: 'HH:MM' · weekly: '1,3,5' weekdays · monthly: '15' day · interval: seconds · once: ISO datetime · cron: 5-field",
          },
          time: { type: "string", description: "'HH:MM' for weekly + monthly schedules" },
          timezone: { type: "string", description: "IANA timezone (default: the user's local timezone)" },
          startAt: { type: "string", description: "ISO datetime — earliest allowed run (optional)" },
          endAt: { type: "string", description: "ISO datetime — task completes after this (optional)" },
        },
        required: ["type"],
        additionalProperties: false,
      },
      notifyTelegram: {
        type: "boolean",
        description: "Send run results to the user's connected Telegram (default true when connected)",
      },
      enabled: { type: "boolean", description: "Start active (default true)" },
    },
    required: ["name", "instructions", "schedule"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    // Provider snapshot — resolved client-side, never model-visible.
    const provider = await resolveProviderSnapshot();
    if (!provider) {
      return {
        ok: false,
        error: "NO_PROVIDER",
        message:
          "No AI provider is configured. Add one in Settings → Config first — scheduled tasks need a provider to run unattended.",
      };
    }
    const schedule = args.schedule as TaskSchedule | undefined;
    if (!schedule) {
      return { ok: false, error: "BAD_SCHEDULE", message: "The schedule object is required." };
    }
    const payload: CreateTaskPayload = {
      name: String(args.name ?? ""),
      description: args.description ? String(args.description) : undefined,
      instructions: String(args.instructions ?? ""),
      schedule: {
        ...schedule,
        timezone: schedule.timezone || browserTimezone(),
      },
      enabled: args.enabled !== false,
      notifyTelegram: args.notifyTelegram !== false,
      runtime: { provider },
    };
    const r = await schedulerCall<{ task: SafeScheduledTask }>(ctx, "create", payload as unknown as Record<string, unknown>);
    if (!r.ok) return { ok: false, error: r.error, message: r.message ?? "creation failed" };
    const t = (r.result as { task?: SafeScheduledTask })?.task;
    void ctx;
    return {
      ok: true,
      action: "created",
      task: t,
      message: t
        ? `Scheduled task created: ${t.name} — ${describeSchedule(t as never)} · ${t.timezone} · next run ${t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : "—"}`
        : "Task created.",
    };
  },
  false,
  "automation",
);

// ---------------------------------------------------------------------------
// update_scheduled_task
// ---------------------------------------------------------------------------

registerTool(
  "update_scheduled_task",
  "Modify an existing scheduled task — name, description, instructions, schedule (time/type/timezone), enabled state, or Telegram notifications. Find the task id first with list_scheduled_tasks. The schedule object follows the same shape as create_scheduled_task (partial updates allowed — only the fields you send change).",
  {
    type: "object",
    properties: {
      id: { type: "string", description: "Task id from list_scheduled_tasks" },
      name: { type: "string" },
      description: { type: "string" },
      instructions: { type: "string", description: "Replacement agent job (full replacement, not a patch)" },
      schedule: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["once", "interval", "daily", "weekly", "monthly", "cron"] },
          expression: { type: "string" },
          time: { type: "string", description: "'HH:MM' for weekly/monthly" },
          timezone: { type: "string" },
          startAt: { type: "string" },
          endAt: { type: "string" },
        },
        additionalProperties: false,
      },
      enabled: { type: "boolean", description: "true = active, false = paused" },
      notifyTelegram: { type: "boolean" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const payload: Record<string, unknown> = { id: String(args.id ?? "") };
    for (const k of ["name", "description", "instructions", "notifyTelegram"] as const) {
      if (args[k] !== undefined) payload[k] = args[k];
    }
    if (args.enabled !== undefined) payload.enabled = args.enabled === true;
    if (args.schedule) {
      payload.schedule = args.schedule;
      // Refresh the provider snapshot with the schedule change so unattended
      // runs keep working after provider changes.
      const provider = await resolveProviderSnapshot();
      if (provider) payload.runtime = { provider };
    }
    const r = await schedulerCall<{ task: SafeScheduledTask }>(ctx, "update", payload);
    if (!r.ok) return { ok: false, error: r.error, message: r.message ?? "update failed" };
    const t = (r.result as { task?: SafeScheduledTask })?.task;
    return {
      ok: true,
      action: "updated",
      task: t,
      message: t
        ? `Task updated: ${t.name} — ${describeSchedule(t as never)} · ${t.timezone} · next run ${t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : "—"}`
        : "Task updated.",
    };
  },
  false,
  "automation",
);

// ---------------------------------------------------------------------------
// delete_scheduled_task
// ---------------------------------------------------------------------------

registerTool(
  "delete_scheduled_task",
  "Permanently delete a scheduled task and its run history. The user's workspace files are NOT touched — only the schedule is removed. Find the id with list_scheduled_tasks when the user references a task by name.",
  {
    type: "object",
    properties: { id: { type: "string", description: "Task id from list_scheduled_tasks" } },
    required: ["id"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const r = await schedulerCall(ctx, "delete", { id: String(args.id ?? "") });
    return r.ok
      ? { ok: true, action: "deleted", message: "Scheduled task deleted." }
      : { ok: false, error: r.error, message: r.message ?? "delete failed" };
  },
  false,
  "automation",
);

// ---------------------------------------------------------------------------
// pause / resume
// ---------------------------------------------------------------------------

registerTool(
  "pause_scheduled_task",
  "Pause a scheduled task — executions stop immediately, but the task, its schedule, and its run history are kept intact. Resume later with resume_scheduled_task.",
  {
    type: "object",
    properties: { id: { type: "string", description: "Task id from list_scheduled_tasks" } },
    required: ["id"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const r = await schedulerCall(ctx, "pause", { id: String(args.id ?? "") });
    return r.ok
      ? { ok: true, action: "paused", message: "Task paused — it will not run until resumed." }
      : { ok: false, error: r.error, message: r.message ?? "pause failed" };
  },
  false,
  "automation",
);

registerTool(
  "resume_scheduled_task",
  "Resume a paused scheduled task — it picks up its schedule and computes the next run from now.",
  {
    type: "object",
    properties: { id: { type: "string", description: "Task id from list_scheduled_tasks" } },
    required: ["id"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const r = await schedulerCall(ctx, "resume", { id: String(args.id ?? "") });
    const t = (r.result as { task?: SafeScheduledTask } | undefined)?.task;
    return r.ok
      ? {
          ok: true,
          action: "resumed",
          task: t,
          message: t
            ? `Task resumed — next run ${t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : "—"}`
            : "Task resumed.",
        }
      : { ok: false, error: r.error, message: r.message ?? "resume failed" };
  },
  false,
  "automation",
);

// ---------------------------------------------------------------------------
// run_scheduled_task_now
// ---------------------------------------------------------------------------

registerTool(
  "run_scheduled_task_now",
  "Immediately execute a scheduled task (same job, same workspace) WITHOUT waiting for its schedule or changing future runs. The run happens in an isolated background sandbox — the user can watch it live in Scheduled Tasks → Run history.",
  {
    type: "object",
    properties: { id: { type: "string", description: "Task id from list_scheduled_tasks" } },
    required: ["id"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const r = await schedulerCall<{ run: ScheduledTaskRun }>(ctx, "run_now", { id: String(args.id ?? "") });
    if (!r.ok) return { ok: false, error: r.error, message: r.message ?? "run failed to start" };
    const run = (r.result as { run?: ScheduledTaskRun })?.run;
    return {
      ok: true,
      action: "started",
      run,
      message: run
        ? `Run started (${run.id}) in sandbox ${run.sandboxId} — it continues in the background; the result lands in the task's run history.`
        : "Run started.",
    };
  },
  false,
  "automation",
);

// ---------------------------------------------------------------------------
// list_scheduled_tasks
// ---------------------------------------------------------------------------

registerTool(
  "list_scheduled_tasks",
  "List the user's scheduled tasks with id, name, schedule, timezone, status (Active/Paused), next run, last run, and whether Telegram notifications are on. Use this to find task ids before update/delete/pause/resume, or to answer 'what automations do I have?'.",
  {
    type: "object",
    properties: {
      filter: {
        type: "string",
        enum: ["all", "active", "paused", "failed", "upcoming"],
        description: "'all' (default), 'active', 'paused', 'failed' (last run failed), 'upcoming' (has a next run)",
      },
    },
    additionalProperties: false,
  },
  async (args, ctx) => {
    const r = await schedulerCall<{ tasks: SafeScheduledTask[] }>(ctx, "list", {});
    if (!r.ok) return { ok: false, error: r.error, message: r.message ?? "list failed" };
    const tasks = (r.result as { tasks?: SafeScheduledTask[] })?.tasks ?? [];
    const filter = String(args.filter ?? "all");
    const filtered = tasks.filter((t) => {
      if (filter === "active") return t.enabled;
      if (filter === "paused") return !t.enabled;
      if (filter === "failed") return t.lastRunStatus === "failed";
      if (filter === "upcoming") return t.enabled && t.nextRunAt != null;
      return true;
    });
    return {
      ok: true,
      count: filtered.length,
      tasks: filtered.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        schedule: describeSchedule(t as never),
        scheduleType: t.scheduleType,
        timezone: t.timezone,
        status: t.enabled ? "Active" : "Paused",
        nextRunAt: t.nextRunAt,
        lastRunAt: t.lastRunAt,
        lastRunStatus: t.lastRunStatus,
        runCount: t.runCount,
        workspaceId: t.workspaceId,
        telegram: !!t.runtime?.hasTelegram,
      })),
      summary: filtered.length
        ? filtered.map(taskSummary).join("\n\n")
        : "No scheduled tasks yet.",
    };
  },
  false,
  "automation",
);

// ---------------------------------------------------------------------------
// get_scheduled_task_history
// ---------------------------------------------------------------------------

registerTool(
  "get_scheduled_task_history",
  "Get a scheduled task's execution history: each run's time, duration, status, error, final result, files changed, and tool-call count. Use it to answer 'did my task run?', 'what did it produce?', or 'why did it fail?'.",
  {
    type: "object",
    properties: {
      id: { type: "string", description: "Task id from list_scheduled_tasks" },
      limit: { type: "number", description: "Max runs to return (default 10, max 25)" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const r = await schedulerCall<{ runs: ScheduledTaskRun[] }>(ctx, "get_history", {
      id: String(args.id ?? ""),
      limit: Math.min(25, Math.max(1, Number(args.limit) || 10)),
    });
    if (!r.ok) return { ok: false, error: r.error, message: r.message ?? "history failed" };
    const runs = (r.result as { runs?: ScheduledTaskRun[] })?.runs ?? [];
    return {
      ok: true,
      count: runs.length,
      runs: runs.map((run) => ({
        runId: run.id,
        scheduledFor: new Date(run.scheduledFor).toISOString(),
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        status: run.status,
        trigger: run.trigger,
        durationMs: run.durationMs,
        toolCalls: run.toolCalls,
        filesChanged: run.filesChanged,
        error: run.error,
        result: run.result ? run.result.slice(0, 600) : null,
        notifyStatus: run.notifyStatus,
      })),
    };
  },
  false,
  "automation",
);

export {};
