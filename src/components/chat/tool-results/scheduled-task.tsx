"use client";

// ============================================================================
// Tool result cards for the 8 scheduling tools (create / update / delete /
// pause / resume / run_now / list / get_history).
//
// Style: the same warm glassmorphic surface as the workspace-sync card
// (onyx-ws-* classes in globals.css) with terracotta/amber status tints —
// never raw JSON for these payloads.
// ============================================================================

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CalendarClock,
  Check,
  Clock,
  History,
  Loader2,
  Pencil,
  Play,
  PauseCircle,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { ToolCall } from "@/types";
import { cn } from "@/lib/utils";
import { describeSchedule } from "@/lib/scheduler/tz-cron";
import type { SafeScheduledTask, ScheduledTaskRun } from "@/lib/scheduler/types";
import { ROUTES } from "@/lib/constants";
import { formatAbsolute, formatDuration } from "@/components/scheduled/time-format";

const SCHED_TOOL_NAMES = new Set([
  "create_scheduled_task",
  "update_scheduled_task",
  "delete_scheduled_task",
  "pause_scheduled_task",
  "resume_scheduled_task",
  "run_scheduled_task_now",
  "list_scheduled_tasks",
  "get_scheduled_task_history",
]);

export function isScheduledTaskTool(name: string): boolean {
  return SCHED_TOOL_NAMES.has(name);
}

interface SchedResult {
  ok?: boolean;
  action?: string;
  message?: string;
  error?: string;
  task?: SafeScheduledTask;
  tasks?: Array<{
    id?: string;
    name?: string;
    description?: string;
    schedule?: string;
    scheduleType?: string;
    timezone?: string;
    status?: string;
    nextRunAt?: number | null;
    lastRunAt?: string | null;
    lastRunStatus?: string | null;
    runCount?: number;
    workspaceId?: string;
    telegram?: boolean;
  }>;
  count?: number;
  run?: ScheduledTaskRun;
  runs?: Array<{
    runId?: string;
    scheduledFor?: string;
    startedAt?: string;
    completedAt?: string | null;
    status?: string;
    trigger?: string;
    durationMs?: number | null;
    toolCalls?: number;
    filesChanged?: string[];
    error?: string | null;
    result?: string | null;
    notifyStatus?: string;
  }>;
  summary?: string;
}

function parseSchedResult(toolCall: ToolCall): SchedResult | null {
  const r = toolCall.result;
  if (r == null) return null;
  if (typeof r === "object") return r as SchedResult;
  if (typeof r === "string") {
    try {
      const parsed: unknown = JSON.parse(r);
      if (typeof parsed === "object" && parsed !== null) return parsed as SchedResult;
    } catch {
      return null;
    }
  }
  return null;
}

function friendlyError(res: SchedResult): string {
  switch (res.error) {
    case "NOT_CONFIGURED":
      return "Cloud scheduling isn't configured. Add your OnyxBase API key in Settings → Cloud Workspace.";
    case "NO_PROVIDER":
      return "No AI provider is configured — scheduled tasks need one to run unattended (Settings → Config).";
    case "BAD_SCHEDULE":
      return "The schedule wasn't valid.";
    default:
      return res.message ?? res.error ?? "Something went wrong.";
  }
}

/** Status dot + label — terracotta/amber/green palette (no blue accents). */
function StatusDot({ status }: { status: "active" | "paused" | "running" | "failed" | "completed" | "done" }) {
  const label =
    status === "active"
      ? "Active"
      : status === "paused"
        ? "Paused"
        : status === "running"
          ? "Running"
          : status === "failed"
            ? "Failed"
            : status === "completed"
              ? "Completed"
              : status === "done"
                ? "Done"
                : status;
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px]">
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          status === "active" && "bg-emerald-500",
          status === "paused" && "bg-amber-500",
          status === "running" && "animate-pulse bg-amber-500",
          status === "failed" && "bg-red-500",
          (status === "completed" || status === "done") && "bg-muted-foreground/60",
        )}
      />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The card.
// ---------------------------------------------------------------------------

export function ScheduledTaskResult({ toolCall }: { toolCall: ToolCall }) {
  const router = useRouter();
  const isRunning = toolCall.status === "running" || toolCall.status === "pending";
  const isError = toolCall.status === "error";
  const parsed = useMemo(() => parseSchedResult(toolCall), [toolCall]);
  const name = toolCall.name;

  // ── Running: slim glass card with a live spinner.
  if (isRunning || !parsed) {
    const doing = name === "list_scheduled_tasks"
      ? "Listing scheduled tasks…"
      : name === "get_scheduled_task_history"
        ? "Fetching run history…"
        : name === "create_scheduled_task"
          ? "Creating scheduled task…"
          : name === "run_scheduled_task_now"
            ? "Starting the run…"
            : "Updating the task…";
    return (
      <div
        className="onyx-ws-card onyx-ws-enter mt-1 overflow-hidden rounded-xl"
        role="status"
        aria-label={doing}
      >
        <div className="flex items-center gap-2.5 px-4 py-3.5">
          <CalendarClock className="size-5 shrink-0 text-primary" aria-hidden />
          <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{doing}</p>
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  // ── Error / failed payloads.
  if (isError || parsed.ok === false) {
    return (
      <div className="onyx-ws-card onyx-ws-err onyx-ws-enter mt-1 overflow-hidden rounded-xl" role="alert">
        <div className="flex items-center gap-2.5 px-4 pb-2 pt-3.5">
          <AlertTriangle className="size-5 shrink-0 text-destructive" aria-hidden />
          <p className="text-[13.5px] font-semibold tracking-tight">
            {name === "create_scheduled_task"
              ? "Task not created"
              : name === "run_scheduled_task_now"
                ? "Run not started"
                : name === "delete_scheduled_task"
                  ? "Task not deleted"
                  : "Scheduler action failed"}
          </p>
        </div>
        <div className="px-4 pb-3 text-[13px] text-foreground/80">{friendlyError(parsed)}</div>
      </div>
    );
  }

  const task = parsed.task;

  // ── create / update → confirmation card (spec §18).
  if (name === "create_scheduled_task" || (name === "update_scheduled_task" && task)) {
    const created = name === "create_scheduled_task";
    return (
      <div className="onyx-ws-card onyx-ws-ok onyx-ws-enter mt-1 overflow-hidden rounded-xl" role="status">
        <div className="flex items-center gap-2.5 px-4 pb-1 pt-3.5">
          <Check className="size-5 shrink-0 text-emerald-500 dark:text-emerald-400" aria-hidden />
          <p className="text-[13.5px] font-semibold tracking-tight">
            {created ? "Scheduled Task Created" : "Task Updated"}
          </p>
        </div>
        {task && (
          <div className="space-y-1 px-4 py-2">
            <p className="text-[13px] font-medium text-foreground">{task.name}</p>
            <div className="flex items-center gap-1.5 text-[13px] text-foreground/80">
              <Clock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">
                {describeSchedule(task as never)} · {task.timezone}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-foreground/75">
              <span>
                Next run:{" "}
                {task.nextRunAt
                  ? formatAbsolute(task.nextRunAt, task.timezone)
                  : "—"}
              </span>
              <StatusDot status={task.enabled ? "active" : "paused"} />
            </div>
          </div>
        )}
        <div className="flex items-center justify-between gap-2 border-t border-border/40 px-4 py-2 text-[11.5px] text-muted-foreground">
          <button
            type="button"
            onClick={() => router.push(ROUTES.SCHEDULED_TASKS)}
            className="inline-flex min-h-[28px] items-center gap-1.5 rounded-md px-1 font-medium text-primary transition-colors hover:text-[#a8421f]"
          >
            <Pencil className="size-3" aria-hidden />
            Edit in Scheduled Tasks
          </button>
          {task?.runtime?.hasTelegram && (
            <span className="shrink-0">Telegram notifications on</span>
          )}
        </div>
      </div>
    );
  }

  // ── list → compact task rows.
  if (name === "list_scheduled_tasks") {
    const rows = parsed.tasks ?? [];
    return (
      <div className="onyx-ws-card onyx-ws-enter mt-1 overflow-hidden rounded-xl" role="status">
        <div className="flex items-center gap-2.5 px-4 pb-1 pt-3.5">
          <CalendarClock className="size-5 shrink-0 text-primary" aria-hidden />
          <p className="text-[13.5px] font-semibold tracking-tight">
            {parsed.count ?? rows.length} scheduled task{(parsed.count ?? rows.length) === 1 ? "" : "s"}
          </p>
        </div>
        <div className="scrollbar-thin max-h-72 overflow-y-auto px-4 py-1">
          {rows.length === 0 ? (
            <p className="py-2 text-[13px] text-muted-foreground">No scheduled tasks yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {rows.map((t, i) => (
                <li
                  key={t.id ?? i}
                  className="flex items-center justify-between gap-2 rounded-lg bg-foreground/[0.03] px-2.5 py-2 text-[12.5px]"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground/90">{t.name}</p>
                    <p className="truncate text-muted-foreground">
                      {t.schedule} · {t.timezone}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <StatusDot status={t.status === "Paused" ? "paused" : "active"} />
                    <p className="text-[11px] text-muted-foreground">
                      {t.nextRunAt ? formatAbsolute(t.nextRunAt, t.timezone) : "no next run"}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border/40 px-4 py-2 text-[11.5px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <CalendarClock className="size-3" aria-hidden />
            <button
              type="button"
              onClick={() => router.push(ROUTES.SCHEDULED_TASKS)}
              className="font-medium text-primary transition-colors hover:text-[#a8421f]"
            >
              Open Scheduled Tasks
            </button>
          </span>
        </div>
      </div>
    );
  }

  // ── get_history → run rows.
  if (name === "get_scheduled_task_history") {
    const runs = parsed.runs ?? [];
    return (
      <div className="onyx-ws-card onyx-ws-enter mt-1 overflow-hidden rounded-xl" role="status">
        <div className="flex items-center gap-2.5 px-4 pb-1 pt-3.5">
          <History className="size-5 shrink-0 text-primary" aria-hidden />
          <p className="text-[13.5px] font-semibold tracking-tight">
            {parsed.count ?? runs.length} run{(parsed.count ?? runs.length) === 1 ? "" : "s"}
          </p>
        </div>
        <div className="scrollbar-thin max-h-72 overflow-y-auto px-4 py-1">
          {runs.length === 0 ? (
            <p className="py-2 text-[13px] text-muted-foreground">No runs recorded yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {runs.map((r, i) => (
                <li
                  key={r.runId ?? i}
                  className="flex items-center justify-between gap-2 rounded-lg bg-foreground/[0.03] px-2.5 py-2 text-[12.5px]"
                >
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    {r.status === "completed" ? (
                      <Check className="size-3.5 shrink-0 text-emerald-500" aria-hidden />
                    ) : r.status === "failed" ? (
                      <AlertTriangle className="size-3.5 shrink-0 text-red-500" aria-hidden />
                    ) : (
                      <Loader2 className="size-3.5 shrink-0 animate-spin text-amber-500" aria-hidden />
                    )}
                    <span className="truncate text-foreground/85">
                      {r.startedAt ? formatAbsolute(r.startedAt) : "—"}
                      {r.trigger ? ` · ${r.trigger}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {formatDuration(r.durationMs ?? null)}
                    {r.toolCalls != null ? ` · ${r.toolCalls} tools` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  // ── pause / resume / run_now / delete / update-without-task → slim cards.
  const slim = (() => {
    switch (name) {
      case "pause_scheduled_task":
        return {
          icon: PauseCircle,
          title: "Task paused",
          text: parsed.message ?? "It will not run until resumed.",
        };
      case "resume_scheduled_task":
        return {
          icon: RefreshCw,
          title: "Task resumed",
          text:
            (task?.nextRunAt
              ? `Next run ${formatAbsolute(task.nextRunAt, task.timezone)}.`
              : null) ?? parsed.message ?? "It picks up its schedule from now.",
        };
      case "run_scheduled_task_now":
        return {
          icon: Play,
          title: "Run started",
          text: "It continues in the background — watch it live in Scheduled Tasks → run history.",
        };
      case "delete_scheduled_task":
        return {
          icon: Trash2,
          title: "Task deleted",
          text: parsed.message ?? "The schedule and its history were removed.",
        };
      default:
        return {
          icon: Check,
          title: "Task updated",
          text: parsed.message ?? "Changes saved.",
        };
    }
  })();

  const SlimIcon = slim.icon;
  return (
    <div className="onyx-ws-card onyx-ws-ok onyx-ws-enter mt-1 overflow-hidden rounded-xl" role="status">
      <div className="flex items-center gap-2.5 px-4 py-3">
        <SlimIcon className="size-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold tracking-tight">{slim.title}</p>
          <p className="truncate text-[12.5px] text-muted-foreground">{slim.text}</p>
        </div>
      </div>
      {(name === "run_scheduled_task_now" || name === "resume_scheduled_task") && (
        <div className="flex items-center justify-end gap-2 border-t border-border/40 px-4 py-2 text-[11.5px] text-muted-foreground">
          <button
            type="button"
            onClick={() => router.push(ROUTES.SCHEDULED_TASKS)}
            className="inline-flex min-h-[28px] items-center gap-1.5 rounded-md px-1 font-medium text-primary transition-colors hover:text-[#a8421f]"
          >
            <CalendarClock className="size-3" aria-hidden />
            View in Scheduled Tasks
          </button>
        </div>
      )}
    </div>
  );
}
