"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  MonitorPlay,
  Play,
  RefreshCw,
  Square,
  StopCircle,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { PreviewSessionView } from "@/components/terra/types";

/**
 * OnyxCode Preview tab — THE app's live preview. One Code chat = one app
 * project = one preview (no session picker, no "which project?" concept).
 *
 * Entering the tab auto-rehydrates the runtime: a running session is adopted
 * as-is, otherwise it starts from the persisted workspace files (silently
 * doing nothing when there is no real page to serve). The agent re-publishing
 * files bumps the revision and the embedded page live-reloads itself.
 */
export function PreviewPanel({ workspaceId, active = true }: { workspaceId: string; active?: boolean }) {
  const [session, setSession] = useState<PreviewSessionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [copied, setCopied] = useState(false);
  // Tracks the served snapshot — when the agent re-publishes (revision bump)
  // or the entry/url changes, the iframe reloads itself.
  const servedRef = useRef<string>("");

  const refresh = useCallback(
    (silent = false) => {
      if (!workspaceId) return;
      if (!silent) setLoading(true);
      fetch(`/api/code/preview?workspace=${encodeURIComponent(workspaceId)}`, { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
        .then((data: { session?: PreviewSessionView | null }) => {
          setSession(data.session ?? null);
        })
        .catch(() => {
          /* transient — the poll retries */
        })
        .finally(() => setLoading(false));
    },
    [workspaceId],
  );

  /** Rehydrate the runtime (idempotent): adopt running, else start from the
   *  persisted workspace when a real page exists. Silent when nothing is
   *  previewable — a fresh scaffold-only workspace shows its empty state. */
  const ensureRuntime = useCallback(() => {
    if (!workspaceId) return;
    fetch("/api/code/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, action: "ensure" }),
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then(() => refresh(true))
      .catch(() => {
        /* silent — status comes from the list */
      });
  }, [workspaceId, refresh]);

  useEffect(() => {
    setSession(null);
    servedRef.current = "";
    setLoading(true);
    refresh();
  }, [refresh]);

  // Auto-start the runtime when this chat's preview becomes visible.
  useEffect(() => {
    if (active) {
      ensureRuntime();
      refresh(true);
    }
  }, [active, ensureRuntime, refresh]);

  // Keep the status warm only while this tab is the active one.
  useEffect(() => {
    const timer = setInterval(() => {
      if (active && document.visibilityState === "visible") refresh(true);
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh, active]);

  const running = session?.status === "running";

  // Live-reload the embedded page when the agent re-publishes this app.
  useEffect(() => {
    if (!session) {
      servedRef.current = "";
      return;
    }
    const served = `${session.sessionId}:${session.status}:${session.revision}:${session.url}`;
    if (servedRef.current === served) return;
    const reload = servedRef.current.startsWith(`${session.sessionId}:`);
    servedRef.current = served;
    if (reload && running) setFrameKey((k) => k + 1);
  }, [session, running]);

  const goLive = async () => {
    if (!workspaceId || busy) return;
    setBusy("start");
    try {
      const response = await fetch("/api/code/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, action: "start" }),
      });
      const result = (await response.json()) as { ok?: boolean; url?: string; error?: string };
      if (!response.ok || !result.ok) {
        toast.error(result.error ?? "Could not start the preview.");
        return;
      }
      toast.success("Preview is live.");
      refresh(true);
    } catch {
      toast.error("Could not reach the preview service.");
    } finally {
      setBusy(null);
    }
  };

  const stopRuntime = async () => {
    if (!workspaceId || !session || busy) return;
    setBusy("stop");
    try {
      const response = await fetch("/api/code/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, action: "stop", sessionId: session.sessionId }),
      });
      const result = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) {
        toast.error(result.error ?? "Could not stop the preview.");
        return;
      }
      toast("Preview stopped.");
      refresh(true);
    } catch {
      toast.error("Could not reach the preview service.");
    } finally {
      setBusy(null);
    }
  };

  const copyUrl = async () => {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${session.url}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable; ignore.
    }
  };

  const entry = session?.entry ?? "";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      <section
        className="flex min-h-[420px] flex-1 flex-col overflow-hidden rounded-xl border border-hairline bg-paper"
        aria-label="Live preview of this app"
      >
        {/* Toolbar — this app's one preview, always honest status */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-hairline/60 px-3 py-2">
          <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
            <MonitorPlay className="h-3.5 w-3.5 text-terra" aria-hidden />
            {session?.name ?? "This app"}
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              running
                ? "bg-terra-soft text-terra-deep"
                : session
                  ? "bg-paper text-ink-muted"
                  : "bg-paper text-ink-muted/70",
            )}
            role="status"
          >
            {running ? (
              <>
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#5F7A45]" aria-hidden />
                Running
              </>
            ) : busy === "start" || (loading && !session) ? (
              "Starting"
            ) : session ? (
              "Stopped"
            ) : (
              "No preview yet"
            )}
          </span>
          {entry && (
            <span className="hidden max-w-[220px] truncate rounded-md border border-hairline/60 bg-background px-1.5 py-0.5 font-mono text-[10px] text-ink-muted sm:inline-block" title={entry}>
              {entry}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1">
            {session?.url && (
              <>
                <a
                  href={session.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-hairline bg-background px-2.5 text-[11px] font-medium text-ink-soft transition-colors hover:bg-terra-soft hover:text-terra-deep"
                >
                  <ExternalLink className="h-3 w-3" aria-hidden />
                  Open
                </a>
                <button
                  type="button"
                  onClick={() => setFrameKey((k) => k + 1)}
              aria-label="Refresh preview"
                  title="Refresh"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-hairline bg-background text-ink-muted transition-colors hover:bg-terra-soft hover:text-terra-deep"
                >
                  <RefreshCw className="h-3 w-3" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => void copyUrl()}
                  aria-label="Copy preview URL"
                  title="Copy URL"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-hairline bg-background text-ink-muted transition-colors hover:bg-terra-soft hover:text-terra-deep"
                >
                  {copied ? <Check className="h-3 w-3 text-terra" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
                </button>
              </>
            )}
            {running ? (
              <button
                type="button"
                onClick={() => void stopRuntime()}
                disabled={busy === "stop"}
                className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-hairline bg-background px-2.5 text-[11px] font-medium text-ink-muted transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
              >
                {busy === "stop" ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                ) : (
                  <StopCircle className="h-3 w-3" aria-hidden />
                )}
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void goLive()}
                disabled={busy === "start"}
                className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-terra px-2.5 text-[11px] font-semibold text-white transition-colors hover:bg-terra-deep disabled:opacity-50"
              >
                {busy === "start" ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                ) : (
                  <Play className="h-3 w-3" aria-hidden />
                )}
                Go live
              </button>
            )}
          </div>
        </div>

        {running && session ? (
          <iframe
            key={frameKey}
            src={session.url}
            title={`Live preview of ${session.name}`}
            className="h-full min-h-[380px] w-full flex-1 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        ) : session ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
            <StopCircle className="h-6 w-6 text-ink-muted" aria-hidden />
            <p className="text-[13px] text-ink-muted">
              This app&apos;s preview was stopped. Hit “Go live” — or ask OnyxCode — to start it again.
            </p>
          </div>
        ) : loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin text-terra" aria-hidden />
            Loading…
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-terra-soft-border bg-terra-soft">
              <MonitorPlay className="h-5 w-5 text-terra" aria-hidden />
            </span>
            <p className="max-w-sm text-[13px] leading-relaxed text-ink-muted">
              Nothing to preview yet. Ask OnyxCode to build your app — the moment there&apos;s a real
              page, its live preview lands here automatically.
            </p>
            <button
              type="button"
              onClick={() => void goLive()}
              disabled={busy === "start"}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-terra-soft-border bg-terra-soft px-3 text-[12px] font-semibold text-terra-deep transition-colors hover:bg-terra-soft/70 disabled:opacity-50"
            >
              {busy === "start" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Square className="h-3 w-3 rotate-45" aria-hidden />
              )}
              Try starting anyway
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
