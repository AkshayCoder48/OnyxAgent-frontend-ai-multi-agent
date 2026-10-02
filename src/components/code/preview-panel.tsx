"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  Loader2,
  MonitorPlay,
  Play,
  RefreshCw,
  Square,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  findPreviewSession,
  usePreviewSessionStore,
  type PreviewSessionStatus,
} from "@/stores/preview-session-store";
import {
  isPreviewStartInFlight,
  refreshPreviewSessionLiveness,
  restartPreviewForConversation,
  stopPreviewSession,
  subscribePreviewStarts,
} from "@/lib/code/preview-ops";
import { cn } from "@/lib/utils";

/** The panel's view of the chat's ONE app. */
type PreviewPhase = "none" | "starting" | PreviewSessionStatus;

/**
 * OnyxCode Preview panel — THE CHAT's single live app (Runtime PRD §2-8:
 * "One Code Chat = One App Preview Project").
 *
 * Docked beside the chat (opened from the sub-header MonitorPlay button or
 * the tool-result cards): a compact toolbar with the app's name, framework
 * and HONEST status (starting/running/stopped/error — §7/§122), the
 * app's public URL as an iframe while it runs, and the Open / Refresh /
 * Stop / Start actions. There is NO session picker and NO session list —
 * the panel is scoped to the ACTIVE conversation's one preview record
 * (created by the first start_preview, auto-restarted on re-entering the
 * chat, stopped on leaving it).
 *
 * Perf (PRD §42/§97): the panel subscribes ONLY to the preview-session
 * store — never to chat messages — so streaming tokens don't re-render it,
 * and the iframe's key/src derive from the session record alone, so chat
 * text can never reload the embedded app.
 */
export function PreviewPanel({
  conversationId,
  active,
}: {
  /** The ACTIVE code-chat conversation — the panel never shows another chat's app. */
  conversationId: string | null;
  /** True while this panel is the visible docked panel (gates polling). */
  active: boolean;
}) {
  const sessions = usePreviewSessionStore((s) => s.sessions);
  const session = useMemo(
    () => findPreviewSession(sessions, conversationId),
    [sessions, conversationId],
  );

  // ── STARTING STATE (shared with tool-driven starts) ────────────────────
  // The start-in-flight flag lives in preview-ops (one start per
  // conversation, funnelled through startPreviewExclusive) — subscribe so
  // the panel shows "starting…" even when the AGENT's start_preview tool is
  // the one booting the server.
  const [startInFlight, setStartInFlight] = useState(false);
  useEffect(() => {
    if (!conversationId) {
      setStartInFlight(false);
      return;
    }
    const update = () => setStartInFlight(isPreviewStartInFlight(conversationId));
    update();
    return subscribePreviewStarts(update);
  }, [conversationId]);

  const phase: PreviewPhase = startInFlight
    ? "starting"
    : !session
      ? "none"
      : session.status;

  const [iframeKey, setIframeKey] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [checking, setChecking] = useState(false);

  const url = session?.url ?? null;
  const isRunning = phase === "running" && !!url;

  // ── ACTIONS ─────────────────────────────────────────────────────────────
  const start = async () => {
    if (!conversationId) return;
    const result = await restartPreviewForConversation(conversationId);
    if (result.ok && result.session?.status === "running") {
      toast.success(`Preview for ${result.session.name} is live`);
      // Honest status: confirm the URL actually responds post-start.
      if (result.session.url) await refreshPreviewSessionLiveness(result.session);
    } else if (!result.ok) {
      toast.error(result.error ?? "Failed to start the preview.");
    }
  };

  const stop = async () => {
    if (!session) return;
    setStopping(true);
    try {
      await stopPreviewSession(session);
      toast.success(`Stopped the preview for ${session.name}`);
    } finally {
      setStopping(false);
    }
  };

  const refresh = async () => {
    // Reload the iframe AND re-verify the URL honestly (§7) — a dead URL
    // flips the record to "stopped" instead of showing a broken embed.
    setIframeKey((k) => k + 1);
    if (session && session.url && session.status === "running") {
      setChecking(true);
      try {
        await refreshPreviewSessionLiveness(session);
      } finally {
        setChecking(false);
      }
    }
  };

  // ── LIVENESS (on open + a light 10s poll while OPEN + tab visible) ─────
  // Primitive deps on purpose: the session OBJECT identity changes on every
  // store write, which would re-arm the timer on unrelated updates.
  const sessionId = session?.id ?? null;
  const sessionStatus = session?.status ?? null;
  const sessionUrl = session?.url ?? null;
  useEffect(() => {
    if (!active || sessionId === null || sessionStatus !== "running" || !sessionUrl) return;
    let cancelled = false;
    const check = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      void refreshPreviewSessionLiveness({ id: sessionId, url: sessionUrl, status: "running" });
    };
    check(); // once on open
    const timer = window.setInterval(check, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, sessionId, sessionStatus, sessionUrl]);

  return (
    <div className="animate-in fade-in duration-150 flex h-full min-h-0 flex-col">
      {/* Toolbar: the chat's app + honest status + actions (NO picker) */}
      <div className="fluid-bar border-border flex shrink-0 flex-col gap-2 border-b px-2.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <MonitorPlay className="text-primary h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
            {session ? session.name : "Web preview"}
            {session && (
              <span className="text-muted-foreground font-normal"> · {session.frameworkLabel}</span>
            )}
          </span>
          {phase !== "none" && <StatusChip phase={phase} />}
        </div>

        {session && (
          <div className="flex items-center gap-1">
            {isRunning && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 px-2 text-[11px]"
                onClick={() => url && window.open(url, "_blank", "noopener,noreferrer")}
                title="Open the app in a new tab"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                Open
              </Button>
            )}
            {isRunning && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 px-2 text-[11px]"
                onClick={() => void refresh()}
                title="Reload the preview and re-check that it is live"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", checking && "animate-spin")} aria-hidden />
                Refresh
              </Button>
            )}
            {(phase === "running" || phase === "starting") && (
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground ml-auto h-7 gap-1.5 px-2 text-[11px]"
                onClick={() => void stop()}
                disabled={stopping || phase === "starting"}
                title={
                  phase === "starting"
                    ? "Wait for the start to finish before stopping"
                    : "Stop the dev server (it restarts automatically when you re-enter this chat)"
                }
              >
                <Square className="h-3.5 w-3.5" aria-hidden />
                {stopping ? "Stopping…" : "Stop"}
              </Button>
            )}
            {(phase === "stopped" || phase === "error") && (
              <Button
                size="sm"
                variant="ghost"
                className="text-primary hover:text-primary ml-auto h-7 gap-1.5 px-2 text-[11px]"
                onClick={() => void start()}
                title="Start this chat's app"
              >
                <Play className="h-3.5 w-3.5" aria-hidden />
                Start
              </Button>
            )}
          </div>
        )}

        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground block truncate font-mono text-[10px] transition-colors"
            title={url}
          >
            {url.replace(/^https?:\/\//, "")}
          </a>
        )}
      </div>

      {/* The app itself — fills the panel while it runs */}
      {isRunning && url ? (
        <div className="bg-muted/30 min-h-0 flex-1 p-2">
          <iframe
            key={`${session?.id ?? "app"}-${iframeKey}`}
            src={url}
            title={`Live preview of ${session?.name ?? "the app"}`}
            className="bg-background h-full w-full rounded-xl border border-border shadow-sm"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            referrerPolicy="no-referrer"
          />
        </div>
      ) : (
        <PanelBody phase={phase} session={session} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function StatusChip({ phase }: { phase: PreviewPhase }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide",
        phase === "running"
          ? "bg-primary/10 text-primary"
          : phase === "starting"
            ? "bg-primary/10 text-primary"
            : phase === "stopped"
              ? "bg-muted text-muted-foreground"
              : "bg-destructive/10 text-destructive",
      )}
    >
      {phase === "starting" && <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden />}
      {phase}
    </span>
  );
}

function PanelBody({
  phase,
  session,
}: {
  phase: PreviewPhase;
  session: { name: string; error?: string } | null;
}) {
  if (phase === "none") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <span
          aria-hidden
          className="bg-muted text-muted-foreground mb-3 flex h-12 w-12 items-center justify-center rounded-full"
        >
          <MonitorPlay className="h-5 w-5" />
        </span>
        <p className="text-sm font-medium">No app yet</p>
        <p className="text-muted-foreground mt-1 max-w-sm text-xs leading-relaxed">
          Ask OnyxCode to create your app — once it starts a preview, the live
          website is embedded here, served from your E2B sandbox.
        </p>
      </div>
    );
  }
  if (phase === "starting") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <Loader2 className="text-primary mb-3 h-6 w-6 animate-spin" aria-hidden />
        <p className="text-sm font-medium">
          Starting {session ? session.name : "the app"}…
        </p>
        <p className="text-muted-foreground mt-1 max-w-sm text-xs leading-relaxed">
          Installing dependencies if needed and waiting for the dev server to
          respond. This can take up to a minute on the first boot.
        </p>
      </div>
    );
  }
  if (phase === "stopped") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <span
          aria-hidden
          className="bg-muted text-muted-foreground mb-3 flex h-12 w-12 items-center justify-center rounded-full"
        >
          <Square className="h-5 w-5" />
        </span>
        <p className="text-sm font-medium">{session?.name} is stopped</p>
        <p className="text-muted-foreground mt-1 max-w-sm text-xs leading-relaxed">
          The dev server is not running. Press Start to boot it again — or ask
          OnyxCode to keep building the app.
        </p>
      </div>
    );
  }
  // phase === "error" — the honest failure state (PRD §122): show the real
  // error + the manual Start button lives in the toolbar.
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <span
        aria-hidden
        className="bg-destructive/10 text-destructive mb-3 flex h-12 w-12 items-center justify-center rounded-full"
      >
        <AlertTriangle className="h-5 w-5" />
      </span>
      <p className="text-sm font-medium">The preview failed to start</p>
      <p className="text-destructive mt-1 max-w-sm text-xs leading-relaxed">
        {session?.error ?? "The dev server did not come up."}
      </p>
      <p className="text-muted-foreground mt-2 max-w-sm text-[11px] leading-relaxed">
        Press Start to retry, or ask OnyxCode to fix the app and start the
        preview again.
      </p>
    </div>
  );
}
