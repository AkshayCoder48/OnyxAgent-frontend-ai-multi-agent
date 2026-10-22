"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  RefreshCw,
  Server,
  Square,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores";
import { useDetachedRunStore } from "@/stores/detached-run-store";
import {
  pollDetachedRunStatus,
  stopDetachedRun,
  syncDetachedRun,
} from "@/lib/agent/detached-run";

/** Poll cadence while a detached run is live and the tab is visible. */
const POLL_INTERVAL_MS = 5_000;

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function stageLabel(stage: string | undefined, currentTool: string | null | undefined): string {
  switch (stage) {
    case "starting":
      return "Starting the sandbox agent…";
    case "thinking":
      return "Thinking…";
    case "tool":
      return currentTool ? `Running ${currentTool}…` : "Running tools…";
    case "done":
      return "Finishing up…";
    case "error":
      return "Failed";
    default:
      return "Working…";
  }
}

/**
 * DETACHED RUN STRIP — the live status card for the sandbox-resident agent
 * run ("close and resume"). Rendered above the chat input whenever the
 * current conversation has an active (or not-yet-synced) detached run.
 *
 * While the tab is open it polls the sandbox every 5s (status + round +
 * current tool + log tail). When the run reaches a terminal state it
 * automatically syncs the finished work back into the conversation as a
 * native assistant message. When the user returns after hours, the mount
 * effect performs the same sync immediately — the results land without any
 * interaction.
 */
export function DetachedRunStrip({ conversationId }: { conversationId: string | null }) {
  const run = useDetachedRunStore((s) =>
    conversationId ? s.runs[conversationId] ?? null : null,
  );
  const [expanded, setExpanded] = useState(false);
  const [logTail, setLogTail] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const tickingRef = useRef(false);

  const live = run?.status === "running" || run?.status === "starting";

  /** One poll/sync cycle. Reads the LATEST run state from the store so it
   *  never races its own closure. */
  const tick = useCallback(async () => {
    if (!conversationId || tickingRef.current) return;
    const uid = useAuthStore.getState().user?.id;
    if (!uid) return;
    const r = useDetachedRunStore.getState().runs[conversationId];
    // NOTE: no sandboxId requirement — pagehide handoff runs may carry ""
    // (the beacon resolves/creates the sandbox server-side); the poll goes
    // through the shared E2B client which resolves the sandbox itself.
    if (!r) return;
    tickingRef.current = true;
    try {
      const isLive = r.status === "running" || r.status === "starting";
      if (isLive) {
        const res = await pollDetachedRunStatus(uid, r.sandboxId);
        if (!res) return;
        setLogTail(res.logTail);
        const st = res.status;
        useDetachedRunStore.getState().patchRun(conversationId, {
          stage: st?.stage,
          round: st?.round,
          totalRounds: st?.total_rounds,
          currentTool: st?.current_tool ?? null,
          error: st?.error ?? null,
        });
        if (st && (st.status === "completed" || st.status === "failed" || st.status === "stopped")) {
          setSyncing(true);
          try {
            await syncDetachedRun(uid, conversationId);
          } finally {
            setSyncing(false);
          }
        }
      } else if (r.status === "completed" || r.status === "failed") {
        // Terminal but unsynced (e.g. the reload beat the sync) — settle it.
        setSyncing(true);
        try {
          await syncDetachedRun(uid, conversationId);
        } finally {
          setSyncing(false);
        }
      }
    } finally {
      tickingRef.current = false;
    }
  }, [conversationId]);

  // Immediate check on mount / run change + interval while live + a poll
  // burst whenever the tab regains visibility (the "user came back" case).
  useEffect(() => {
    if (!run || !conversationId) return;
    void tick();
    if (!live) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void tick();
    }, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [run?.runId, run?.sandboxId, live, conversationId, tick]);

  const handleStop = useCallback(async () => {
    if (!conversationId) return;
    const uid = useAuthStore.getState().user?.id;
    if (!uid) return;
    setStopping(true);
    try {
      await stopDetachedRun(uid, conversationId);
      await syncDetachedRun(uid, conversationId);
    } finally {
      setStopping(false);
    }
  }, [conversationId]);

  if (!run || !conversationId) return null;

  const failed = run.status === "failed";
  const elapsed = formatElapsed(Date.now() - (run.startedAt || Date.now()));
  const roundLabel =
    run.round != null && run.totalRounds ? `round ${run.round}/${run.totalRounds}` : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="glass-card border-border mb-2 rounded-2xl border p-3 sm:p-4"
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
            failed
              ? "bg-destructive/10 text-destructive"
              : live
                ? "bg-foreground/[0.06] text-foreground"
                : "bg-foreground/[0.06] text-foreground/70",
          )}
        >
          {failed ? (
            <AlertTriangle className="h-4 w-4" />
          ) : live ? (
            <Server className="h-4 w-4 animate-pulse" />
          ) : (
            <CheckCircle2 className="h-4 w-4" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-foreground truncate text-sm font-semibold">
            {live
              ? "Sandbox run in progress — you can close this app"
              : failed
                ? "Sandbox run failed"
                : "Sandbox run finished — syncing results…"}
          </p>
          <p className="text-muted-foreground truncate font-mono text-[11px] tracking-wide">
            {failed && run.error
              ? run.error
              : live
                ? [stageLabel(run.stage, run.currentTool), roundLabel, elapsed]
                    .filter(Boolean)
                    .join(" · ")
                : "syncing the finished work into this chat"}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => void tick()}
            disabled={syncing || stopping}
            className="text-muted-foreground hover:text-foreground hover:border-foreground/25 inline-flex h-8 items-center gap-1.5 rounded-full border border-transparent px-2.5 font-mono text-[11px] tracking-wider uppercase transition-colors disabled:opacity-50"
            aria-label="Check the run now"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} />
            <span className="hidden sm:inline">check</span>
          </button>
          {live && (
            <button
              type="button"
              onClick={() => void handleStop()}
              disabled={stopping}
              className="text-destructive hover:bg-destructive/10 inline-flex h-8 items-center gap-1.5 rounded-full border border-destructive/25 px-2.5 font-mono text-[11px] tracking-wider uppercase transition-colors disabled:opacity-50"
              aria-label="Stop the sandbox run"
            >
              <Square className="h-3 w-3" />
              <span className="hidden sm:inline">stop</span>
            </button>
          )}
          {logTail && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="text-muted-foreground hover:text-foreground inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors"
              aria-label={expanded ? "Hide the run log" : "Show the run log"}
            >
              <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} />
            </button>
          )}
        </div>
      </div>

      {expanded && logTail && (
        <pre className="bg-foreground/[0.04] border-border/60 text-muted-foreground scrollbar-thin mt-2 max-h-40 overflow-y-auto rounded-xl border p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {logTail}
        </pre>
      )}
    </div>
  );
}
