"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Check, Copy, ExternalLink, MonitorPlay, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ROUTES } from "@/lib/constants";
import { usePreviewSessionStore } from "@/stores/preview-session-store";
import { PreviewSessionCard } from "./preview-session-card";
import { cn } from "@/lib/utils";

/**
 * OnyxCode Preview tab (OnyxCode PRD §4.3 + extension PRD §3.5) — the live
 * E2B sandbox preview. Left: session list (every preview the agent started,
 * persisted across refreshes). Right: the selected session's public URL in
 * an iframe with Open-in-new-tab / Refresh / Copy-URL / Stop controls.
 */
export function PreviewPanel() {
  const sessions = usePreviewSessionStore((s) => s.sessions);

  // Auto-select the newest running session (or the newest overall).
  const autoId = useMemo(() => {
    const running = sessions.find((s) => s.status === "running");
    return running?.id ?? sessions[0]?.id ?? null;
  }, [sessions]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // DERIVED selection (no effect): the user's click wins while it points at
  // a live session; otherwise (initial load, session removed) fall back to
  // the auto-pick. Never cascades renders.
  const effectiveSelectedId =
    selectedId && sessions.some((s) => s.id === selectedId) ? selectedId : autoId;
  const selected = sessions.find((s) => s.id === effectiveSelectedId) ?? null;

  const [iframeKey, setIframeKey] = useState(0);
  const [copied, setCopied] = useState(false);

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

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* Session list (left) */}
      <aside className="hidden w-72 shrink-0 flex-col border-r border-border md:flex" aria-label="Preview sessions">
        <div className="flex h-full min-h-0 flex-col">
          <div className="border-border/60 flex shrink-0 items-center justify-between border-b px-3 py-2.5">
            <h2 className="font-display text-[13px] font-semibold tracking-tight">Sessions</h2>
            <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
              {sessions.length}
            </span>
          </div>
          <div className="scrollbar-thin max-h-full flex-1 space-y-2 overflow-y-auto p-2.5">
            {sessions.length === 0 ? (
              <p className="text-muted-foreground px-1 pt-6 text-center text-xs leading-relaxed">
                No preview sessions yet.
              </p>
            ) : (
              sessions.map((s) => (
                <PreviewSessionCard
                  key={s.id}
                  session={s}
                  selected={s.id === selectedId}
                  onSelect={() => setSelectedId(s.id)}
                />
              ))
            )}
          </div>
        </div>
      </aside>

      {/* Iframe region (right) */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            {/* Toolbar */}
            <div className="glass-header flex h-11 shrink-0 items-center justify-between gap-2 border-b px-2.5 sm:px-4">
              <div className="flex min-w-0 items-center gap-2">
                <MonitorPlay className="text-primary h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="truncate text-[13px] font-semibold">{selected.name}</span>
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
                <span className="text-muted-foreground/80 hidden truncate font-mono text-[10px] lg:block">
                  {selected.url.replace(/^https?:\/\//, "")}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1.5 px-2.5 text-xs"
                  onClick={() => window.open(selected.url, "_blank", "noopener,noreferrer")}
                  title="Open in a new tab"
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  <span className="hidden sm:inline">Open</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1.5 px-2.5 text-xs"
                  onClick={() => setIframeKey((k) => k + 1)}
                  title="Reload the preview"
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                  <span className="hidden sm:inline">Refresh</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1.5 px-2.5 text-xs"
                  onClick={() => void copyUrl()}
                  title="Copy the public URL"
                >
                  {copied ? (
                    <Check className="text-primary h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <Copy className="h-3.5 w-3.5" aria-hidden />
                  )}
                  <span className="hidden sm:inline">{copied ? "Copied" : "Copy URL"}</span>
                </Button>
              </div>
            </div>

            {/* iframe — CSP frame-src allows https://*.e2b.dev */}
            <div className="bg-muted/30 min-h-0 flex-1 p-2 sm:p-3">
              <iframe
                key={`${selected.id}-${iframeKey}`}
                src={selected.url}
                title={`Live preview of ${selected.name}`}
                className="bg-background h-full w-full rounded-xl border border-border shadow-sm"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                referrerPolicy="no-referrer"
              />
            </div>
          </>
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
              Ask the agent to create an app and start a preview — it will appear here,
              served live from your E2B sandbox.
            </p>
            <Button asChild size="sm" variant="outline" className="mt-4">
              <Link href={ROUTES.CODE}>Go to the Chat tab</Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
