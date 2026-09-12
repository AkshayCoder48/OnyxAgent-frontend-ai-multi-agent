"use client";

// ============================================================================
// ScheduledTasksView — the management view: header (title + New Task + status
// chip), the scheduler status card, task cards with inline run history, the
// create/edit dialog, and the empty/not-configured states. Polls `status` +
// `list` on mount and every 30s.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CalendarClock, KeyRound, Loader2, Plus, RefreshCw } from "lucide-react";
import { Button, Skeleton } from "@/components/ui";
import { PageHeader } from "@/components/dashboard/page-header";
import { cn } from "@/lib/utils";
import type { SafeScheduledTask } from "@/lib/scheduler/types";
import { schedulerApi, useSchedulerKey } from "@/lib/scheduler/client";
import { conversationService } from "@/lib/services";
import { ROUTES } from "@/lib/constants";
import { TaskCard } from "./task-card";
import { TaskFormDialog } from "./task-form-dialog";
import { RunHistoryPanel } from "./run-history-panel";
import { SchedulerStatus } from "./scheduler-status";
import { formatRelativeAgo } from "./time-format";

export function ScheduledTasksView() {
  const t = useTranslations("scheduled");
  const { userId, state, refetch } = useSchedulerKey();

  const [tasks, setTasks] = useState<SafeScheduledTask[] | null>(null);
  /** Latest tasks mirror for refresh() (stable across closures). */
  const tasksRef = useRef<SafeScheduledTask[]>([]);
  useEffect(() => {
    tasksRef.current = tasks ?? [];
  }, [tasks]);
  const [statusInfo, setStatusInfo] = useState<{
    tasks: number;
    tick: {
      lastTickAt: number | null;
      nextDueAt: number | null;
      running: number;
      fired: number;
      finalized: number;
      tasks: number;
    } | null;
  } | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<SafeScheduledTask | null>(null);
  const [historyTaskId, setHistoryTaskId] = useState<string | null>(null);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const /** per-task in-flight action name ("pause" | "resume" | "run_now" | "delete") */
    [busy, setBusy] = useState<Record<string, string>>({});
  const /** task ids with a run currently in flight (from run-now + history) */
    [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  /** Conversation titles by id — resolves the cards' "💬 chat" chips (unknown
   *  ids fall back to the "Linked chat" label). Fetched batched by list. */
  const [chatTitles, setChatTitles] = useState<Record<string, string>>({});
  /** Freshly created/updated tasks kept locally until the server list
   *  converges (OnyxBase read lag — ids expire after 5 minutes). */
  const optimisticRef = useRef<Map<string, number>>(new Map());

  const ready = state === "ready";

  const refresh = useCallback(async () => {
    if (!userId) return;
    const [listRes, statusRes] = await Promise.all([
      schedulerApi(userId, "list"),
      schedulerApi(userId, "status"),
    ]);
    if (listRes.ok) {
      const serverTasks = listRes.tasks ?? [];
      const serverIds = new Set(serverTasks.map((t) => t.id));
      const now = Date.now();
      // Expire optimistic entries older than 5 minutes or already served.
      for (const [id, ts] of optimisticRef.current) {
        if (serverIds.has(id) || now - ts > 300_000) optimisticRef.current.delete(id);
      }
      // Re-attach optimistic tasks the server list hasn't converged on yet.
      const keep = tasksRef.current.filter(
        (t) => optimisticRef.current.has(t.id) && !serverIds.has(t.id),
      );
      setTasks([...serverTasks, ...keep]);
      setListError(null);
    } else if (listRes.error === "NOT_CONFIGURED") {
      setListError("NOT_CONFIGURED");
    } else {
      setListError(listRes.message ?? "Failed to load tasks");
    }
    if (statusRes.ok) {
      setStatusInfo({
        tasks: Number(statusRes.tasks ?? 0),
        tick: (statusRes.tick as never) ?? null,
      });
    }
  }, [userId]);

  // Initial load + 30s polling while configured.
  useEffect(() => {
    if (ready) void refresh();
  }, [ready, refresh, refetch]);

  useEffect(() => {
    if (!ready) return;
    const id = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(id);
  }, [ready, refresh]);

  // Resolve the linked conversations' titles (batched list → id→title map).
  // Refetched when the set of attached chats changes; silent on failure —
  // the cards fall back to the generic "Linked chat" chip.
  const chatIdKey = (tasks ?? []).map((t) => t.chatId ?? "-").join(",");
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await conversationService.list(userId, { limit: 100 });
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const c of list) {
          if (c.title) map[c.id] = c.title;
        }
        setChatTitles(map);
      } catch {
        /* silent — chips fall back */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, chatIdKey]);

  // ── Actions ─────────────────────────────────────────────────────────────

  const markRunning = (taskId: string, running: boolean) => {
    setRunningIds((prev) => {
      const next = new Set(prev);
      if (running) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  };

  async function act(task: SafeScheduledTask, action: "pause" | "resume" | "run_now" | "delete") {
    if (!userId) return;
    setBusy((b) => ({ ...b, [task.id]: action }));
    try {
      const res = await schedulerApi(userId, action, { id: task.id });
      if (!res.ok) {
        toast.error(res.message ?? `${action} failed`);
        return;
      }
      switch (action) {
        case "pause":
          toast.success(`Paused “${task.name}”`);
          break;
        case "resume":
          toast.success(`Resumed “${task.name}”`, {
            description: "The next run was recomputed from now.",
          });
          break;
        case "run_now":
          toast.success(`Run started — “${task.name}”`, {
            description: "It continues in the background; watch it live in the run history.",
          });
          markRunning(task.id, true);
          setHistoryTaskId(task.id);
          setHistoryRefreshKey((k) => k + 1);
          break;
        case "delete":
          toast.success(`Deleted “${task.name}”`, {
            description: "The schedule and its run history were removed.",
          });
          if (historyTaskId === task.id) setHistoryTaskId(null);
          break;
      }
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${action} failed`);
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[task.id];
        return next;
      });
    }
  }

  // ── Rendering states ────────────────────────────────────────────────────

  const lastTickRel = statusInfo?.tick?.lastTickAt
    ? formatRelativeAgo(statusInfo.tick.lastTickAt)
    : null;

  return (
    <>
      <PageHeader
        eyebrow="Automation"
        title={t("title")}
        description={t("description")}
        actions={
          <div className="flex items-center gap-2">
            {/* Scheduler status chip */}
            <span
              className={cn(
                "hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] sm:inline-flex",
                lastTickRel
                  ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400",
              )}
              title={lastTickRel ? `Scheduler live — last tick ${lastTickRel}` : "Scheduler has never ticked"}
            >
              <span
                aria-hidden
                className={cn("size-1.5 rounded-full", lastTickRel ? "bg-emerald-500" : "bg-amber-500")}
              />
              {lastTickRel ? `Live · ${lastTickRel}` : "Not ticked yet"}
            </span>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setEditingTask(null);
                setDialogOpen(true);
              }}
              className="h-11 min-w-[44px]"
              disabled={!ready}
            >
              <Plus className="size-4" aria-hidden />
              {t("newTask")}
            </Button>
          </div>
        }
      />

      {/* Not configured — the vault has no OnyxBase key */}
      {(state === "not_configured" || (ready && listError === "NOT_CONFIGURED")) && (
        <div className="flex flex-col items-center justify-center rounded-xl border bg-card px-6 py-14 text-center">
          <span
            aria-hidden
            className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted"
          >
            <KeyRound className="h-5 w-5 text-muted-foreground" />
          </span>
          <p className="text-sm font-medium text-foreground">Cloud scheduling isn&apos;t configured</p>
          <p className="mt-1 max-w-md text-[13px] leading-relaxed text-muted-foreground">
            Add your OnyxBase API key in Settings → Cloud Workspace — the same key that powers your
            persistent cloud workspace. Scheduled tasks, their history, and Telegram delivery all
            live in your own OnyxBase account.
          </p>
          <Button asChild variant="outline" size="sm" className="mt-4 h-11">
            <Link href={ROUTES.SETTINGS_CLOUD}>
              <KeyRound className="size-4" aria-hidden />
              Open Cloud Workspace settings
            </Link>
          </Button>
        </div>
      )}

      {/* Loading skeletons */}
      {(state === "loading" || (state === "ready" && tasks == null && !listError)) && (
        <div className="space-y-4">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-44 w-full rounded-xl" />
          <Skeleton className="h-44 w-full rounded-xl" />
        </div>
      )}

      {/* Ready */}
      {state === "ready" && tasks != null && listError !== "NOT_CONFIGURED" && (
        <div className="space-y-4">
          {/* List error (non-fatal) */}
          {listError && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-[13px] text-destructive">
              <span>{listError}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-11 min-w-[44px]"
                onClick={() => void refresh()}
              >
                <RefreshCw className="size-3.5" aria-hidden />
                Retry
              </Button>
            </div>
          )}

          {/* Scheduler status card */}
          <SchedulerStatus
            taskCount={statusInfo?.tasks ?? tasks.length}
            tick={statusInfo?.tick ?? null}
            userId={userId ?? ""}
            onTicked={() => void refresh()}
          />

          {/* Task list */}
          {tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border bg-card px-6 py-14 text-center">
              <span
                aria-hidden
                className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted"
              >
                <CalendarClock className="h-5 w-5 text-muted-foreground" />
              </span>
              <p className="text-sm font-medium text-foreground">{t("emptyTitle")}</p>
              <p className="mt-1 max-w-md text-[13px] leading-relaxed text-muted-foreground">
                {t("emptyDescription")}
              </p>
              <Button
                type="button"
                size="sm"
                className="mt-4 h-11"
                onClick={() => {
                  setEditingTask(null);
                  setDialogOpen(true);
                }}
              >
                <Plus className="size-4" aria-hidden />
                {t("newTask")}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {tasks.map((task) => (
                <div key={task.id}>
                  <TaskCard
                    task={task}
                    running={runningIds.has(task.id)}
                    chatTitle={task.chatId ? (chatTitles[task.chatId] ?? null) : undefined}
                    historyOpen={historyTaskId === task.id}
                    onToggleHistory={() => {
                      setHistoryTaskId((cur) => (cur === task.id ? null : task.id));
                      setHistoryRefreshKey((k) => k + 1);
                    }}
                    onEdit={() => {
                      setEditingTask(task);
                      setDialogOpen(true);
                    }}
                    onPauseResume={() => void act(task, task.enabled ? "pause" : "resume")}
                    onRunNow={() => void act(task, "run_now")}
                    onDelete={() => void act(task, "delete")}
                    busyAction={busy[task.id] ?? null}
                  />
                  {historyTaskId === task.id && (
                    <RunHistoryPanel
                      taskId={task.id}
                      userId={userId ?? ""}
                      refreshKey={historyRefreshKey}
                      onRunningChange={(running) => markRunning(task.id, running)}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Running indicator footer */}
          {(statusInfo?.tick?.running ?? 0) > 0 && (
            <p className="flex items-center justify-center gap-1.5 text-[12px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin text-amber-500" aria-hidden />
              {statusInfo?.tick?.running} run{statusInfo?.tick?.running === 1 ? "" : "s"} executing
              in background sandboxes — finalized results appear automatically.
            </p>
          )}
        </div>
      )}

      {/* Create / edit dialog */}
      <TaskFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        task={editingTask}
        userId={userId ?? ""}
        tasks={tasks ?? []}
        onSaved={(saved) => {
          // OPTIMISTIC MERGE — OnyxBase reads converge with a delay; a
          // freshly created task can be missing from the next `list` call
          // for a minute. Merge the saved record into the local state so the
          // user sees their task instantly (the list refresh reconciles).
          optimisticRef.current.set(saved.id, Date.now());
          setTasks((prev) => {
            const base = prev ?? [];
            const idx = base.findIndex((t) => t.id === saved.id);
            if (idx >= 0) {
              const next = [...base];
              next[idx] = saved;
              return next;
            }
            return [...base, saved];
          });
          void refresh();
        }}
      />
    </>
  );
}
