"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Download,
  Layers,
  ScrollText,
  Server,
  Square,
  Type,
  Wrench,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores";
import { qk } from "@/lib/query-keys";
import { useBackgroundTask, useBackgroundTasks } from "@/hooks";
import {
  backgroundTaskService,
  cancelTask,
  fetchArtifact,
  syncRunToConversation,
  type TaskArtifactContent,
} from "@/lib/tasks/client";
import type {
  BackgroundTaskType,
  ClientSyncState,
  TaskArtifactSummary,
  TaskRunStatus,
  TaskStatusChunk,
  TaskStatusRun,
} from "@/lib/tasks/protocol";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

// ---------------------------------------------------------------------------
// Constants + small helpers.
// ---------------------------------------------------------------------------

/** Terminal runs stay on the strip for 10 minutes (recent-unsynced window). */
const RECENT_TERMINAL_MS = 10 * 60 * 1000;

function isLive(run: TaskStatusRun): boolean {
  return run.status === "queued" || run.status === "running";
}

/** "2m 05s" style elapsed label. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function excerpt(s: string, n: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t;
}

function statusPillClass(status: TaskRunStatus): string {
  switch (status) {
    case "queued":
      return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
    case "running":
    case "completed":
      return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    case "failed":
      return "bg-destructive/10 text-destructive";
    default:
      return "bg-foreground/[0.06] text-muted-foreground";
  }
}

const TYPE_BADGES: Record<BackgroundTaskType, string> = {
  agent_run: "agent",
  scheduled_business: "business",
  terminal_command: "terminal",
};

const CHUNK_ICONS: Record<TaskStatusChunk["kind"], React.ComponentType<{ className?: string }>> = {
  round: Layers,
  text: Type,
  tool_call: Wrench,
  tool_result: CheckCircle2,
  log: ScrollText,
  error: AlertTriangle,
};

/** Downloadable artifact kinds (message/report/file — attachments are files). */
function isDownloadableKind(kind: string): boolean {
  return kind === "message" || kind === "report" || kind === "file" || kind === "attachment";
}

function base64ToBlob(b64: string, mimeType: string): Blob {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || "application/octet-stream" });
}

function artifactFilename(art: TaskArtifactContent): string {
  return art.name?.split("/").filter(Boolean).pop() || "artifact";
}

function downloadArtifact(art: TaskArtifactContent): void {
  const blob =
    art.encoding === "base64"
      ? base64ToBlob(art.content, art.mimeType)
      : new Blob([art.content], { type: art.mimeType || "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = artifactFilename(art);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

// ---------------------------------------------------------------------------
// Expanded detail row — the last-3-chunks tail (only mounts while expanded,
// so only expanded rows poll the FR-3.2 chunk feed).
// ---------------------------------------------------------------------------

function ChunkLine({ chunk }: { chunk: TaskStatusChunk }) {
  const Icon = CHUNK_ICONS[chunk.kind] ?? ScrollText;
  return (
    <div className="flex min-w-0 items-start gap-1.5" title={chunk.content}>
      <Icon
        className={cn(
          "mt-0.5 size-3 shrink-0",
          chunk.kind === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      />
      <p
        className={cn(
          "min-w-0 flex-1 truncate font-mono text-[11px]",
          chunk.kind === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {chunk.name ? `${chunk.name}: ` : ""}
        {chunk.content}
      </p>
    </div>
  );
}

function RunDetailChunks({
  runId,
  currentTool,
  error,
}: {
  runId: string;
  currentTool: string | null;
  error: string | null;
}) {
  const { chunks } = useBackgroundTask(runId);
  const tail = chunks.slice(-3);
  return (
    <div className="bg-foreground/[0.04] mt-2 space-y-1 rounded-lg px-2.5 py-2">
      {currentTool && (
        <p className="truncate font-mono text-[11px] text-foreground/70" title={currentTool}>
          tool: {currentTool}
        </p>
      )}
      {tail.map((c) => (
        <ChunkLine key={c.seq} chunk={c} />
      ))}
      {tail.length === 0 && !currentTool && !error && (
        <p className="text-muted-foreground font-mono text-[11px]">waiting for progress…</p>
      )}
      {error && (
        <p className="truncate font-mono text-[11px] text-destructive" title={error}>
          {excerpt(error, 200)}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One run card.
// ---------------------------------------------------------------------------

interface RunCardProps {
  run: TaskStatusRun;
  now: number;
  expanded: boolean;
  busy: boolean;
  downloadingId: string | null;
  onToggle: () => void;
  onStop: () => void;
  onSync: () => void;
  onDownload: (artifact: TaskArtifactSummary) => void;
}

function RunCard({
  run,
  now,
  expanded,
  busy,
  downloadingId,
  onToggle,
  onStop,
  onSync,
  onDownload,
}: RunCardProps) {
  const live = isLive(run);
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const elapsed =
    Number.isFinite(start) && end > start ? formatElapsed(end - start) : null;
  const progress = run.progress;
  const roundLabel =
    progress && progress.totalRounds > 0
      ? `round ${progress.round}/${progress.totalRounds}`
      : null;
  const stageLabel = progress?.stage ? progress.stage : null;
  const title = run.title?.trim() || excerpt(run.prompt, 60) || "Background task";
  const downloadable = run.artifacts.filter((a) => isDownloadableKind(a.kind));

  return (
    <Collapsible open={expanded} onOpenChange={() => onToggle()}>
      <div className="border-border/70 rounded-xl border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase",
              statusPillClass(run.status),
            )}
          >
            {run.status === "running" && (
              <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
            )}
            {run.status}
          </span>
          <span className="inline-flex shrink-0 items-center rounded-full bg-foreground/[0.06] px-2 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
            {TYPE_BADGES[run.type]}
          </span>
          <p className="text-foreground min-w-0 flex-1 truncate text-[13px] font-medium" title={title}>
            {title}
          </p>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              aria-label={expanded ? "Hide the run details" : "Show the run details"}
              className="text-muted-foreground hover:text-foreground inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors"
            >
              <ChevronDown
                className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")}
              />
            </button>
          </CollapsibleTrigger>
        </div>

        <p className="text-muted-foreground mt-1.5 truncate font-mono text-[11px] tracking-wide">
          {[roundLabel, stageLabel, elapsed].filter(Boolean).join(" · ") || "…"}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {live && (
            <button
              type="button"
              onClick={onStop}
              disabled={busy}
              className="text-destructive hover:bg-destructive/10 inline-flex h-7 items-center gap-1.5 rounded-full border border-destructive/25 px-2.5 font-mono text-[11px] tracking-wider uppercase transition-colors disabled:opacity-50"
            >
              <Square className="h-3 w-3" />
              stop
            </button>
          )}
          {run.status === "completed" && (
            <button
              type="button"
              onClick={onSync}
              disabled={busy}
              className="text-muted-foreground hover:text-foreground hover:border-foreground/25 inline-flex h-7 items-center gap-1.5 rounded-full border border-transparent px-2.5 font-mono text-[11px] tracking-wider uppercase transition-colors disabled:opacity-50"
            >
              <CheckCircle2 className="h-3 w-3" />
              sync to chat
            </button>
          )}
          {downloadable.map((artifact) => (
            <button
              key={artifact.id}
              type="button"
              onClick={() => onDownload(artifact)}
              disabled={downloadingId === artifact.id}
              title={`Download ${artifact.name} (${artifact.kind})`}
              className="text-muted-foreground hover:text-foreground hover:border-foreground/25 inline-flex h-7 max-w-[180px] items-center gap-1.5 rounded-full border border-transparent px-2.5 font-mono text-[11px] tracking-wider lowercase transition-colors disabled:opacity-50"
            >
              <Download className="h-3 w-3 shrink-0" />
              <span className="truncate">{artifact.name}</span>
            </button>
          ))}
        </div>

        <CollapsibleContent>
          <RunDetailChunks
            runId={run.runId}
            currentTool={run.progress?.currentTool ?? null}
            error={run.status === "failed" ? run.error : null}
          />
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// The strip.
// ---------------------------------------------------------------------------

/**
 * BACKGROUND TASKS STRIP — the live status card for durable background task
 * runs (Epic 3 UX), mounted above the chat input next to the detached-run
 * strip. Shows every live run plus terminal runs from the last 10 minutes
 * that have not been synced yet; renders null when there is nothing to show.
 * Poll cadence comes entirely from useBackgroundTasks (4s live / 15s idle).
 */
export function BackgroundTasksStrip() {
  const userId = useAuthStore((s) => s.user?.id);
  const { runs, isLoading } = useBackgroundTasks();
  const qc = useQueryClient();

  const [open, setOpen] = React.useState(true);
  const [expandedRunId, setExpandedRunId] = React.useState<string | null>(null);
  const [busyRunId, setBusyRunId] = React.useState<string | null>(null);
  const [downloadingId, setDownloadingId] = React.useState<string | null>(null);
  const [syncStates, setSyncStates] = React.useState<Record<string, ClientSyncState>>({});
  // Display clock for elapsed labels — ticks every 5s while anything runs.
  const [now, setNow] = React.useState(() => Date.now());

  const anyLive = runs.some(isLive);
  React.useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [anyLive]);

  // Read the Dexie mirror's sync states whenever the run set changes (no
  // polling of our own — this rides the hook's list query).
  const runIdsKey = React.useMemo(() => runs.map((r) => r.runId).join(","), [runs]);
  React.useEffect(() => {
    let cancelled = false;
    const ids = runIdsKey ? runIdsKey.split(",") : [];
    void Promise.all(
      ids.map(async (id) => {
        const row = await backgroundTaskService.get(id);
        return [id, (row?.sync_state ?? "pending") as ClientSyncState] as const;
      }),
    )
      .then((entries) => {
        if (!cancelled) setSyncStates(Object.fromEntries(entries));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [runIdsKey]);

  const visibleRuns = React.useMemo(() => {
    const cutoff = Date.now() - RECENT_TERMINAL_MS;
    return runs.filter((r) => {
      if (isLive(r)) return true;
      if (syncStates[r.runId] === "synced") return false;
      const end = r.finishedAt ? Date.parse(r.finishedAt) : Date.parse(r.updatedAt);
      return Number.isFinite(end) && end > cutoff;
    });
  }, [runs, syncStates]);

  const invalidate = React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: qk.tasks.all() });
  }, [qc]);

  if (isLoading) return null;
  if (visibleRuns.length === 0) return null;

  const liveCount = visibleRuns.filter(isLive).length;
  const doneCount = visibleRuns.length - liveCount;

  async function handleStop(runId: string) {
    setBusyRunId(runId);
    try {
      await cancelTask(runId);
      toast.success("Background task stop requested");
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to stop the background task");
    } finally {
      setBusyRunId(null);
    }
  }

  async function handleSync(runId: string) {
    if (!userId) return;
    setBusyRunId(runId);
    try {
      const result = await syncRunToConversation(runId, userId);
      if (result === "synced") {
        toast.success("Synced to conversation");
      } else if (result === "conflicted") {
        toast.warning("Local changes detected — artifacts kept for manual download");
      } else {
        toast.info("Nothing to sync — this run has no linked conversation in this browser.");
      }
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to sync the background task");
    } finally {
      setBusyRunId(null);
    }
  }

  async function handleDownload(runId: string, artifact: TaskArtifactSummary) {
    setDownloadingId(artifact.id);
    try {
      const row = await backgroundTaskService.get(runId);
      const token = row?.task_token;
      if (!token) {
        toast.error(
          "This run was not started from this browser — its artifacts cannot be downloaded here.",
        );
        return;
      }
      const art = await fetchArtifact(artifact.id, token);
      downloadArtifact(art);
      toast.success(`Downloaded ${artifactFilename(art)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to download the artifact");
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="glass-card border-border mb-2 rounded-2xl border p-3 sm:p-4"
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-foreground">
            <Server className={cn("h-4 w-4", anyLive && "animate-pulse")} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-foreground truncate text-sm font-semibold">
              {anyLive
                ? "Background tasks running — you can close this app"
                : "Background tasks"}
            </p>
            <p className="text-muted-foreground truncate font-mono text-[11px] tracking-wide">
              {anyLive
                ? [
                    liveCount > 0 ? `${liveCount} running` : null,
                    doneCount > 0 ? `${doneCount} recent` : null,
                    "up to 30 min",
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : `${doneCount} recent · hides after a few minutes`}
            </p>
          </div>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              aria-label={open ? "Hide background tasks" : "Show background tasks"}
              className="text-muted-foreground hover:text-foreground inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors"
            >
              <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
            </button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div className="mt-3 space-y-2">
            {visibleRuns.map((run) => (
              <RunCard
                key={run.runId}
                run={run}
                now={now}
                expanded={expandedRunId === run.runId}
                busy={busyRunId === run.runId}
                downloadingId={downloadingId}
                onToggle={() =>
                  setExpandedRunId((cur) => (cur === run.runId ? null : run.runId))
                }
                onStop={() => void handleStop(run.runId)}
                onSync={() => void handleSync(run.runId)}
                onDownload={(artifact) => void handleDownload(run.runId, artifact)}
              />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export default BackgroundTasksStrip;

// ---------------------------------------------------------------------------
// The invisible lander (USER DIRECTIVE: no strips above the composer).
// ---------------------------------------------------------------------------

/**
 * BACKGROUND TASKS LANDER — the invisible replacement for the strip: no UI
 * at all, but it keeps the React-Query polling alive (useBackgroundTasks)
 * and AUTO-LANDS every finished Trigger.dev Cloud run that belongs to a
 * conversation of this browser: the finished result is appended straight
 * into that conversation's chat bubbles + a toast reports the outcome.
 * Runs landed in-place by use-chat's cloud-handoff adoption (which marks
 * the mirror row "synced") are skipped here — no duplicates.
 */
export function BackgroundTasksLander() {
  const userId = useAuthStore((s) => s.user?.id);
  const { runs } = useBackgroundTasks();
  const landedRef = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      for (const run of runs) {
        if (cancelled || isLive(run)) continue;
        if (landedRef.current.has(run.runId)) continue;
        landedRef.current.add(run.runId); // claim first — never double-land
        try {
          const row = await backgroundTaskService.get(run.runId);
          // Only auto-land runs linked to a conversation in THIS browser
          // whose mirror is not already synced (or landed in place).
          if (!row?.conversation_id || row.sync_state === "synced") continue;
          const result = await syncRunToConversation(run.runId, userId);
          if (result === "synced") {
            if (run.status === "completed") {
              toast.success("Background run finished", {
                description: "The result landed in its conversation's chat.",
              });
            } else {
              toast.warning("Background run ended", {
                description: run.error ? String(run.error).slice(0, 160) : `Status: ${run.status}.`,
              });
            }
          }
        } catch {
          landedRef.current.delete(run.runId); // allow a retry on a later poll
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runs, userId]);

  return null;
}
