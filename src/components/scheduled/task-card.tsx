"use client";

// ============================================================================
// TaskCard — one scheduled task, Terra editorial style: name + status dot,
// schedule description, next run (task-timezone aware), last run, created
// date, workspace id, telegram indicator, and the action row (Edit / Pause ⇄
// Resume / Run now / Delete-with-confirm / History).
// ============================================================================

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  CalendarClock,
  Clock,
  Globe,
  History,
  Loader2,
  MessageSquare,
  PauseCircle,
  Play,
  Pencil,
  Send,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { ROUTES } from "@/lib/constants";
import { describeSchedule } from "@/lib/scheduler/tz-cron";
import type { SafeScheduledTask } from "@/lib/scheduler/types";
import { formatNextRun, formatRelativeAgo } from "./time-format";

/** Status of the card as a whole: dot + tint (label via scheduled.status.*).
 *  Exported — the sidebar's Scheduled Tasks rows reuse the same mapping. */
export function statusOf(task: SafeScheduledTask): {
  key: "active" | "paused" | "running" | "failed" | "completed";
  dot: string;
} {
  if (!task.enabled) {
    return { key: "paused", dot: "bg-amber-500" };
  }
  if (task.lastRunStatus === "failed" && task.failureStreak > 0) {
    return { key: "failed", dot: "bg-red-500" };
  }
  if (task.nextRunAt == null && task.scheduleType === "once") {
    return { key: "completed", dot: "bg-muted-foreground/60" };
  }
  return { key: "active", dot: "bg-emerald-500" };
}

interface TaskCardProps {
  task: SafeScheduledTask;
  /** A run is in flight right now (from status polling) — amber pulse dot. */
  running?: boolean;
  /** Title of the attached conversation (chat mode) — resolved by the parent;
   *  null/undefined falls back to the "Linked chat" label. */
  chatTitle?: string | null;
  historyOpen: boolean;
  onToggleHistory: () => void;
  onEdit: () => void;
  onPauseResume: () => void;
  onRunNow: () => void;
  onDelete: () => void;
  /** Any action in flight — shows spinners on its button. */
  busyAction: string | null;
}

export function TaskCard({
  task,
  running,
  chatTitle,
  historyOpen,
  onToggleHistory,
  onEdit,
  onPauseResume,
  onRunNow,
  onDelete,
  busyAction,
}: TaskCardProps) {
  const t = useTranslations("scheduled");
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const status = statusOf(task);
  const display = running ? { key: "running" as const, dot: "animate-pulse bg-amber-500" } : status;
  const chatHref = task.chatId ? `${ROUTES.CHAT}?id=${encodeURIComponent(task.chatId)}` : null;
  const chatLabel = chatTitle?.trim() || t("linkedChat");

  return (
    <article
      className={cn(
        "rounded-xl border bg-card p-4 transition-colors sm:p-5",
        historyOpen ? "border-primary/40" : "border-border hover:border-primary/25",
      )}
      aria-label={`Scheduled task ${task.name}`}
    >
      {/* Header: name + status — the row becomes a link to the attached
          conversation when the task runs in a chat (the action row below
          stays non-navigating). */}
      <div
        {...(chatHref
          ? {
              role: "link",
              tabIndex: 0,
              onClick: () => router.push(chatHref),
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  router.push(chatHref);
                }
              },
            }
          : {})}
        className={cn(
          "flex items-start justify-between gap-3 rounded-md -mx-1.5 px-1.5 py-1 transition-colors",
          chatHref &&
            "group/head cursor-pointer hover:bg-foreground/[0.04] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/40",
        )}
        aria-label={chatHref ? `Scheduled task ${task.name} — open linked chat` : undefined}
      >
        <div className="min-w-0 flex-1">
          <h3
            className={cn(
              "truncate font-display text-[15px] font-semibold tracking-tight text-foreground",
              chatHref && "group-hover/head:text-primary transition-colors",
            )}
          >
            {task.name}
          </h3>
          {task.description && (
            <p className="mt-0.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">
              {task.description}
            </p>
          )}
          {chatHref && (
            <span
              className="mt-1.5 inline-flex max-w-full items-center gap-1 rounded-md border border-primary/25 bg-primary/5 px-1.5 py-0.5 text-[11px] font-medium text-primary"
              title="Open the linked conversation"
            >
              <MessageSquare className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{chatLabel}</span>
            </span>
          )}
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
            display.key === "active" && "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
            display.key === "paused" && "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400",
            display.key === "running" && "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
            display.key === "failed" && "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400",
            display.key === "completed" && "border-border bg-muted/50 text-muted-foreground",
          )}
        >
          <span aria-hidden className={cn("size-1.5 rounded-full", display.dot)} />
          {t(`status.${display.key}`)}
        </span>
      </div>

      {/* Schedule + timing rows */}
      <div className="mt-3 grid gap-2 text-[13px] sm:grid-cols-2">
        <p className="flex items-center gap-1.5 text-foreground/85">
          <CalendarClock className="size-3.5 shrink-0 text-primary/70" aria-hidden />
          <span className="truncate">{describeSchedule(task as never)}</span>
        </p>
        <p className="flex items-center justify-end gap-1.5 text-foreground/85 sm:justify-start">
          <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-mono text-[12px]">{task.timezone}</span>
        </p>
        <p className="flex items-center gap-1.5 text-foreground/85">
          <Clock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">
            {t("nextRun")}:{" "}
            <span className="font-medium text-foreground">
              {formatNextRun(task.nextRunAt, task.timezone)}
            </span>
          </span>
        </p>
        <p className="flex items-center justify-end gap-1.5 text-muted-foreground sm:justify-start">
          <History className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {task.lastRunAt
              ? `Last run ${formatRelativeAgo(task.lastRunAt)}${
                  task.lastRunStatus ? ` · ${task.lastRunStatus}` : ""
                }`
              : "Never run yet"}
          </span>
        </p>
      </div>

      {/* Meta footer: workspace id, created date, telegram, runtime */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/60 pt-3 text-[11.5px] text-muted-foreground">
        <span className="font-mono">{task.workspaceId}</span>
        <span aria-hidden>·</span>
        <span>Created {formatRelativeAgo(task.createdAt)}</span>
        {task.runCount > 0 && (
          <>
            <span aria-hidden>·</span>
            <span>{task.runCount} run{task.runCount === 1 ? "" : "s"}</span>
          </>
        )}
        <span
          className={cn(
            "ml-auto inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5",
            task.notificationConfig?.telegram
              ? "border-primary/25 bg-primary/5 text-primary"
              : "border-border text-muted-foreground/70",
          )}
          title={
            task.notificationConfig?.telegram
              ? "Result sent to Telegram after each run"
              : "Telegram notifications off"
          }
        >
          <Send className="size-3" aria-hidden />
          {task.notificationConfig?.telegram ? "Telegram on" : "Telegram off"}
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5",
            task.runtime?.hasProvider
              ? "border-emerald-500/25 text-emerald-600 dark:text-emerald-400"
              : "border-red-500/25 text-red-600 dark:text-red-400",
          )}
          title={
            task.runtime?.hasProvider
              ? `Unattended runs via ${task.runtime.providerModel ?? "provider"}`
              : "No provider snapshot — unattended runs will fail"
          }
        >
          <span aria-hidden className={cn("size-1.5 rounded-full", task.runtime?.hasProvider ? "bg-emerald-500" : "bg-red-500")} />
          {task.runtime?.hasProvider ? task.runtime.providerModel ?? "provider ready" : "no provider"}
        </span>
      </div>

      {/* Actions */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onEdit}
          className="h-11 min-w-[44px]"
          disabled={!!busyAction}
        >
          <Pencil className="size-4" aria-hidden />
          Edit
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onPauseResume}
          className="h-11 min-w-[44px]"
          disabled={!!busyAction || running}
        >
          {busyAction === "pause" || busyAction === "resume" ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : task.enabled ? (
            <PauseCircle className="size-4" aria-hidden />
          ) : (
            <Play className="size-4" aria-hidden />
          )}
          {task.enabled ? "Pause" : "Resume"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRunNow}
          className="h-11 min-w-[44px]"
          disabled={!!busyAction || running}
        >
          {busyAction === "run_now" ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Play className="size-4" aria-hidden />
          )}
          Run now
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onToggleHistory}
          className="h-11 min-w-[44px]"
          aria-expanded={historyOpen}
        >
          <History className="size-4" aria-hidden />
          History
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setConfirmDelete(true)}
          className="h-11 min-w-[44px] text-destructive hover:text-destructive"
          disabled={!!busyAction}
        >
          {busyAction === "delete" ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Trash2 className="size-4" aria-hidden />
          )}
          Delete
        </Button>
      </div>

      {/* Destructive confirm */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{task.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the task and its run history from the
              cloud. Your workspace files are not touched. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmDelete(false);
                onDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete task
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  );
}
