"use client";

// ============================================================================
// RunHistoryPanel — a task's execution history, rendered inline under its card
// while open. Rows: status icon + date/time + duration + tool calls + trigger
// badge. Clicking a run expands its detail (result, error, filesChanged chips,
// mono logs, notifyStatus). While any run is pending/running the panel polls
// get_history every 10s; an expanded RUNNING run is live-refreshed via get_run.
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clock,
  FileText,
  History,
  Loader2,
  MinusCircle,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { Button, Skeleton } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { ScheduledTaskRun } from "@/lib/scheduler/types";
import { schedulerApi } from "@/lib/scheduler/client";
import { formatAbsolute, formatDuration } from "./time-format";

function RunIcon({ status }: { status: string }) {
  if (status === "completed") return <Check className="size-4 text-emerald-500" aria-hidden />;
  if (status === "failed") return <AlertTriangle className="size-4 text-red-500" aria-hidden />;
  if (status === "skipped") return <MinusCircle className="size-4 text-muted-foreground" aria-hidden />;
  return <Loader2 className="size-4 animate-spin text-amber-500" aria-hidden />;
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide",
        status === "completed" && "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        status === "failed" && "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400",
        status === "running" && "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
        status === "pending" && "border-amber-500/25 bg-amber-500/5 text-amber-700 dark:text-amber-400",
        status === "skipped" && "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      {status}
    </span>
  );
}

interface RunHistoryPanelProps {
  taskId: string;
  userId: string;
  /** Re-fetch immediately when the parent fires a run / resumes, etc. */
  refreshKey: number;
  onRunningChange?: (running: boolean) => void;
}

export function RunHistoryPanel({ taskId, userId, refreshKey, onRunningChange }: RunHistoryPanelProps) {
  const [runs, setRuns] = useState<ScheduledTaskRun[] | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [liveRun, setLiveRun] = useState<ScheduledTaskRun | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const anyRunning = !!runs?.some((r) => r.status === "running" || r.status === "pending");

  const loadHistory = useCallback(async () => {
    if (!userId) return;
    setRefreshing(true);
    try {
      const res = await schedulerApi(userId, "get_history", { id: taskId, limit: 25 });
      if (res.ok) {
        setRuns(res.runs ?? []);
      }
    } catch {
      // silent — the list stays stale, next poll retries
    } finally {
      setRefreshing(false);
    }
  }, [userId, taskId]);

  // Initial load + reload when the parent nudges refreshKey.
  useEffect(() => {
    void loadHistory();
  }, [loadHistory, refreshKey]);

  // Poll every 10s while any run is in flight.
  useEffect(() => {
    if (!anyRunning) return;
    const id = window.setInterval(() => void loadHistory(), 10_000);
    return () => window.clearInterval(id);
  }, [anyRunning, loadHistory]);

  useEffect(() => {
    onRunningChange?.(anyRunning);
  }, [anyRunning, onRunningChange]);

  // Live updates for the expanded RUNNING run (get_run).
  const expanded = runs?.find((r) => r.id === expandedRunId) ?? null;
  const expandedRunning = !!expanded && (expanded.status === "running" || expanded.status === "pending");
  useEffect(() => {
    if (!expandedRunning || !expandedRunId) {
      setLiveRun(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      const res = await schedulerApi(userId, "get_run", { id: taskId, runId: expandedRunId });
      if (!cancelled && res.ok && res.run) {
        setLiveRun(res.run);
      }
    };
    void poll();
    const interval = window.setInterval(poll, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [expandedRunning, expandedRunId, taskId, userId]);

  const detail = liveRun ?? expanded;

  return (
    <div className="mt-3 rounded-xl border border-primary/30 bg-muted/20 p-3" aria-label="Run history">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <p className="flex items-center gap-1.5 text-[13px] font-semibold tracking-tight">
          <History className="size-4 text-primary" aria-hidden />
          Run history
          {runs != null && (
            <span className="font-normal text-muted-foreground">
              ({runs.length})
            </span>
          )}
          {anyRunning && (
            <Loader2 className="size-3.5 animate-spin text-amber-500" aria-label="Runs in flight" />
          )}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-11 w-11 p-0"
          onClick={() => void loadHistory()}
          aria-label="Refresh run history"
          disabled={refreshing}
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden />
        </Button>
      </div>

      {/* List */}
      {runs == null ? (
        <div className="space-y-2 px-1 pb-1">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-full rounded-lg" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <p className="px-1 pb-2 text-[13px] text-muted-foreground">
          No runs yet — the first run appears here (and in Telegram, if enabled) once the task fires.
        </p>
      ) : (
        <ul className="scrollbar-thin max-h-72 space-y-1 overflow-y-auto px-1 pb-1">
          {runs.map((run) => {
            const open = expandedRunId === run.id;
            return (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => {
                    setExpandedRunId(open ? null : run.id);
                    setLiveRun(null);
                  }}
                  aria-expanded={open}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] transition-colors",
                    open ? "bg-primary/10" : "bg-foreground/[0.03] hover:bg-foreground/[0.06]",
                  )}
                >
                  <ChevronRight
                    className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
                    aria-hidden
                  />
                  <RunIcon status={run.status} />
                  <span className="min-w-0 flex-1 truncate text-foreground/85">
                    {formatAbsolute(run.startedAt)}
                    {run.trigger && (
                      <span className="ml-1.5 rounded border border-border px-1 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
                        {run.trigger}
                      </span>
                    )}
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-2 text-muted-foreground">
                    <span className="inline-flex items-center gap-1" title="Tool calls">
                      <Wrench className="size-3" aria-hidden />
                      {run.toolCalls}
                    </span>
                    <span className="inline-flex items-center gap-1 tabular-nums" title="Duration">
                      <Clock className="size-3" aria-hidden />
                      {formatDuration(run.durationMs)}
                    </span>
                    <StatusBadge status={run.status} />
                  </span>
                </button>

                {/* Expanded detail */}
                {open && detail && (
                  <div className="mt-1 space-y-2.5 rounded-lg border border-border/70 bg-background/60 p-3 text-[13px]">
                    {detail.result && (
                      <div>
                        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          Result
                        </p>
                        <p className="scrollbar-thin max-h-56 overflow-y-auto whitespace-pre-wrap break-words text-foreground/85">
                          {detail.result}
                        </p>
                      </div>
                    )}
                    {detail.error && (
                      <div>
                        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-destructive/80">
                          Error
                        </p>
                        <p className="whitespace-pre-wrap break-words text-destructive/90">{detail.error}</p>
                      </div>
                    )}
                    {detail.filesChanged?.length ? (
                      <div>
                        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          Files changed
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {detail.filesChanged.map((f) => (
                            <span
                              key={f}
                              className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80"
                            >
                              <FileText className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                              <span className="truncate">{f}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {detail.logs?.length ? (
                      <div>
                        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          Logs
                        </p>
                        <div className="scrollbar-thin max-h-44 overflow-y-auto rounded-md bg-[#262019] p-2.5 font-mono text-[11px] leading-relaxed text-[#c9b78e]">
                          {detail.logs.map((line, i) => (
                            <p key={i} className="whitespace-pre-wrap break-words">
                              {line}
                            </p>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
                      <span>Scheduled for {formatAbsolute(detail.scheduledFor)}</span>
                      {detail.completedAt && <span>Completed {formatAbsolute(detail.completedAt)}</span>}
                      {detail.sandboxId && <span className="font-mono text-[10.5px]">sandbox {detail.sandboxId}</span>}
                      {detail.notifyStatus && <span>notify: {detail.notifyStatus}</span>}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
