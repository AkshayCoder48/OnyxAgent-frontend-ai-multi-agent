"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

function relativeTime(at: number): string {
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

/**
 * OnyxCode Preview tab — live preview sessions served by the preview service.
 * Session list on the left, embedded iframe + controls on the right.
 */
export function PreviewPanel({ workspaceId, active = true }: { workspaceId: string; active?: boolean }) {
  const [sessions, setSessions] = useState<PreviewSessionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  // Tracks the served snapshot of the selected session — when the agent
  // re-registers a preview with new files (or starts a new one) the URL or
  // entry changes and the embedded iframe reloads itself.
  const servedRef = useRef<string>("");
  // Newest session creation time seen so far — a brand-new running session
  // (the agent just hit start_preview) is auto-followed.
  const latestSeenRef = useRef(0);

  const refresh = useCallback(
    (silent = false) => {
      if (!workspaceId) return;
      if (!silent) setLoading(true);
      fetch(`/api/code/preview?workspace=${encodeURIComponent(workspaceId)}`, { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
        .then((data: { sessions?: PreviewSessionView[] }) => {
          setSessions(data.sessions ?? []);
          setSelectedId((current) => {
            const next = data.sessions ?? [];
            const newest = next.reduce<PreviewSessionView | null>(
              (acc, s) => (s.createdAt > (acc?.createdAt ?? 0) ? s : acc),
              null,
            );
            // The agent just published a new running session — follow it.
            if (
              newest &&
              newest.status === "running" &&
              newest.sessionId !== current &&
              newest.createdAt > latestSeenRef.current
            ) {
              latestSeenRef.current = newest.createdAt;
              return newest.sessionId;
            }
            if (newest) latestSeenRef.current = Math.max(latestSeenRef.current, newest.createdAt);
            if (current && next.some((s) => s.sessionId === current)) return current;
            const running = next.find((s) => s.status === "running");
            return running?.sessionId ?? next[0]?.sessionId ?? null;
          });
        })
        .catch(() => toast.error("Preview sessions could not be loaded."))
        .finally(() => setLoading(false));
    },
    [workspaceId],
  );

  useEffect(() => {
    setSessions([]);
    setSelectedId(null);
    latestSeenRef.current = 0;
    servedRef.current = "";
    refresh();
  }, [refresh]);

  // Catch up the moment the section becomes the active one.
  useEffect(() => {
    if (active) refresh(true);
    // refresh identity is stable per workspace.
  }, [active]);

  // Keep the list warm while the section is active.
  useEffect(() => {
    const timer = setInterval(() => {
      if (active && document.visibilityState === "visible") refresh(true);
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh, active]);

  const selected = useMemo(
    () => sessions.find((s) => s.sessionId === selectedId) ?? null,
    [sessions, selectedId],
  );

  // Live-reload the embedded page when the agent re-publishes the selected
  // session (revision bump) or its URL/entry changes — no manual Refresh.
  useEffect(() => {
    if (!selected) {
      servedRef.current = "";
      return;
    }
    const served = `${selected.sessionId}:${selected.status}:${selected.revision}:${selected.url}`;
    if (servedRef.current === served) return;
    const reload = servedRef.current.startsWith(`${selected.sessionId}:`);
    servedRef.current = served;
    if (reload) setFrameKey((k) => k + 1);
  }, [selected]);

  const startPreview = async () => {
    if (!workspaceId || starting) return;
    setStarting(true);
    try {
      const response = await fetch("/api/code/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, action: "start" }),
      });
      const result = (await response.json()) as { ok?: boolean; url?: string; sessionId?: string; error?: string };
      if (!response.ok || !result.ok) {
        toast.error(result.error ?? "Could not start the preview.");
        return;
      }
      toast.success("Preview is live.");
      if (result.sessionId) {
        // Show the fresh session immediately (the poll would also find it).
        setSelectedId(result.sessionId);
      }
      refresh(true);
    } catch {
      toast.error("Could not reach the preview service.");
    } finally {
      setStarting(false);
    }
  };

  const stopSession = async (sessionId: string) => {
    if (stoppingId) return;
    setStoppingId(sessionId);
    try {
      const response = await fetch("/api/code/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, action: "stop", sessionId }),
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
      setStoppingId(null);
    }
  };

  const copyUrl = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${selected.url}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable; ignore.
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:min-h-0 lg:flex-1">
        {/* Session list */}
        <aside className="w-full shrink-0 lg:w-64" aria-label="Preview sessions">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">
              Sessions · {sessions.length}
            </h2>
            <button
              type="button"
              onClick={() => void startPreview()}
              disabled={starting}
              className="inline-flex h-7 items-center gap-1 rounded-lg bg-terra px-2.5 text-[11px] font-semibold text-white transition-colors hover:bg-terra-deep disabled:opacity-50"
            >
              {starting ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Play className="h-3 w-3" aria-hidden />}
              Go live
            </button>
          </div>
          {loading && sessions.length === 0 ? (
            <div className="flex items-center justify-center gap-2 rounded-xl border border-hairline bg-paper py-10 text-[12px] text-ink-muted">
              <Loader2 className="h-4 w-4 animate-spin text-terra" aria-hidden />
              Loading…
            </div>
          ) : sessions.length === 0 ? (
            <div className="rounded-xl border border-hairline bg-paper px-4 py-10 text-center">
              <MonitorPlay className="mx-auto h-5 w-5 text-ink-muted" aria-hidden />
              <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
                No previews yet. Ask OnyxCode to start one — or scaffold an app and hit “Go live”.
              </p>
            </div>
          ) : (
            <ul className="terra-scroll flex gap-2 overflow-x-auto pb-1 lg:max-h-[60vh] lg:flex-col lg:overflow-y-auto lg:overflow-x-visible lg:pb-0">
              {sessions.map((session) => {
                const active = session.sessionId === selectedId;
                const running = session.status === "running";
                return (
                  <li key={session.sessionId} className="shrink-0 lg:w-full">
                    <div
                      className={cn(
                        "w-56 rounded-xl border p-3 transition-colors lg:w-auto",
                        active
                          ? "border-terra-soft-border bg-terra-soft"
                          : "border-hairline bg-paper hover:bg-terra-soft/40",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedId(session.sessionId)}
                        className="block w-full text-left"
                        aria-current={active ? "true" : undefined}
                      >
                        <span className="flex items-center gap-2">
                          <span
                            className={cn(
                              "h-[7px] w-[7px] shrink-0 rounded-full",
                              running ? "bg-[#5F7A45]" : "bg-ink-muted/40",
                            )}
                            aria-hidden
                          />
                          <span className="truncate text-[13px] font-medium text-ink">{session.name}</span>
                        </span>
                        <span className="mt-1 block truncate font-mono text-[10px] text-ink-muted">
                          {session.sessionId} · {relativeTime(session.createdAt)}
                        </span>
                      </button>
                      <div className="mt-2 flex items-center justify-between">
                        <span
                          className={cn(
                            "text-[10px] font-semibold uppercase tracking-wide",
                            running ? "text-[#5F7A45]" : "text-ink-muted",
                          )}
                        >
                          {session.status}
                        </span>
                        {running && (
                          <button
                            type="button"
                            onClick={() => void stopSession(session.sessionId)}
                            disabled={stoppingId === session.sessionId}
                            aria-label={`Stop preview ${session.name}`}
                            title="Stop server"
                            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium text-ink-muted transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                          >
                            {stoppingId === session.sessionId ? (
                              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                            ) : (
                              <Square className="h-3 w-3 fill-current" aria-hidden />
                            )}
                            Stop
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        {/* Iframe + controls */}
        <section
          className="flex min-h-[420px] flex-1 flex-col overflow-hidden rounded-xl border border-hairline bg-paper"
          aria-label="Live preview"
        >
          {selected ? (
            <>
              <div className="flex flex-wrap items-center gap-1.5 border-b border-hairline/60 px-3 py-2">
                <span className="mr-1 flex items-center gap-1.5 text-[12px] font-medium text-ink">
                  <MonitorPlay className="h-3.5 w-3.5 text-terra" aria-hidden />
                  {selected.name}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <a
                    href={selected.url}
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
                  {selected.status === "running" && (
                    <button
                      type="button"
                      onClick={() => void stopSession(selected.sessionId)}
                      disabled={stoppingId === selected.sessionId}
                      className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-hairline bg-background px-2.5 text-[11px] font-medium text-ink-muted transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                    >
                      <StopCircle className="h-3 w-3" aria-hidden />
                      Stop
                    </button>
                  )}
                </div>
              </div>
              {selected.status === "running" ? (
                <iframe
                  key={frameKey}
                  src={selected.url}
                  title={`Live preview of ${selected.name}`}
                  className="h-full min-h-[380px] w-full flex-1 bg-white"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                />
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
                  <StopCircle className="h-6 w-6 text-ink-muted" aria-hidden />
                  <p className="text-[13px] text-ink-muted">
                    This preview was stopped. Start it again by asking OnyxCode or hitting “Go live”.
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full border border-terra-soft-border bg-terra-soft">
                <MonitorPlay className="h-5 w-5 text-terra" aria-hidden />
              </span>
              <p className="max-w-sm text-[13px] leading-relaxed text-ink-muted">
                Live previews land here. Ask OnyxCode — “scaffold a static site and start a
                preview” — and the running app embeds in this panel.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
