"use client";

import { useMemo, useState } from "react";
import { Check, Copy, ExternalLink, MonitorPlay, RefreshCw, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { usePreviewSessionStore } from "@/stores/preview-session-store";
import { stopPreviewSession } from "@/lib/code/preview-ops";
import { cn } from "@/lib/utils";

/**
 * OnyxCode Preview panel — the live web preview of the app the agent built.
 *
 * Docked beside the chat (opened from the sub-header MonitorPlay button,
 * the tool-result cards, or the legacy /code/preview route): a compact
 * toolbar with the session picker + status + actions, and the selected
 * session's public URL filling the rest of the panel as an iframe — the
 * WEB PREVIEW itself, always visible while the panel is open.
 */
export function PreviewPanel() {
  const sessions = usePreviewSessionStore((s) => s.sessions);

  // Auto-select the newest running session (or the newest overall).
  const autoId = useMemo(() => {
    const running = sessions.find((s) => s.status === "running");
    return running?.id ?? sessions[0]?.id ?? null;
  }, [sessions]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // DERIVED selection (no effect): the user's pick wins while it points at
  // a live session; otherwise fall back to the auto-pick.
  const effectiveSelectedId =
    selectedId && sessions.some((s) => s.id === selectedId) ? selectedId : autoId;
  const selected = sessions.find((s) => s.id === effectiveSelectedId) ?? null;

  const [iframeKey, setIframeKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [stopping, setStopping] = useState(false);

  const copyUrl = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.url);
      setCopied(true);
      toast.success("Preview URL copied");
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy the URL");
    }
  };

  const stop = async () => {
    if (!selected) return;
    setStopping(true);
    try {
      await stopPreviewSession(selected);
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="animate-in fade-in duration-150 flex h-full min-h-0 flex-col">
      {/* Toolbar: session picker + status + actions */}
      <div className="glass-header border-border flex shrink-0 flex-col gap-2 border-b px-2.5 py-2.5">
        <div className="flex items-center gap-2">
          <MonitorPlay className="text-primary h-3.5 w-3.5 shrink-0" aria-hidden />
          {sessions.length > 0 ? (
            <label className="min-w-0 flex-1">
              <span className="sr-only">Preview session</span>
              <select
                value={selected?.id ?? ""}
                onChange={(e) => setSelectedId(e.target.value || null)}
                className="border-border bg-background text-foreground focus-visible:ring-ring w-full cursor-pointer truncate rounded-lg border px-2 py-1.5 text-[13px] font-medium outline-none focus-visible:ring-1"
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.frameworkLabel} · {s.status}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="truncate text-[13px] font-semibold">Web preview</span>
          )}
          {selected && (
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide",
                selected.status === "running"
                  ? "bg-primary/10 text-primary"
                  : selected.status === "stopped"
                    ? "bg-muted text-muted-foreground"
                    : "bg-destructive/10 text-destructive",
              )}
            >
              {selected.status}
            </span>
          )}
        </div>

        {selected && (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-2 text-[11px]"
              onClick={() => window.open(selected.url, "_blank", "noopener,noreferrer")}
              title="Open in a new tab"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              Open
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-2 text-[11px]"
              onClick={() => setIframeKey((k) => k + 1)}
              title="Reload the preview"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Refresh
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-2 text-[11px]"
              onClick={() => void copyUrl()}
              title="Copy the public URL"
            >
              {copied ? (
                <Check className="text-primary h-3.5 w-3.5" aria-hidden />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden />
              )}
              {copied ? "Copied" : "Copy URL"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground ml-auto h-7 gap-1.5 px-2 text-[11px]"
              onClick={() => {
                if (selected.status === "stopped") {
                  usePreviewSessionStore.getState().remove(selected.id);
                } else {
                  void stop();
                }
              }}
              disabled={stopping}
              title={selected.status === "stopped" ? "Remove from the list" : "Stop the dev server"}
            >
              {selected.status === "stopped" ? (
                <>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  Remove
                </>
              ) : (
                <>
                  <Square className="h-3.5 w-3.5" aria-hidden />
                  {stopping ? "Stopping…" : "Stop"}
                </>
              )}
            </Button>
          </div>
        )}

        {selected && (
          <a
            href={selected.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground block truncate font-mono text-[10px] transition-colors"
            title={selected.url}
          >
            {selected.url.replace(/^https?:\/\//, "")}
          </a>
        )}
      </div>

      {/* The web preview itself — fills the panel */}
      {selected ? (
        <div className="bg-muted/30 min-h-0 flex-1 p-2">
          <iframe
            key={`${selected.id}-${iframeKey}`}
            src={selected.url}
            title={`Live preview of ${selected.name}`}
            className="bg-background h-full w-full rounded-xl border border-border shadow-sm"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            referrerPolicy="no-referrer"
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <span
            aria-hidden
            className="bg-muted text-muted-foreground mb-3 flex h-12 w-12 items-center justify-center rounded-full"
          >
            <MonitorPlay className="h-5 w-5" />
          </span>
          <p className="text-sm font-medium">No preview sessions yet</p>
          <p className="text-muted-foreground mt-1 max-w-sm text-xs leading-relaxed">
            Ask the agent to create an app and start a preview — the live website will be
            embedded here, served from your E2B sandbox.
          </p>
        </div>
      )}
    </div>
  );
}
