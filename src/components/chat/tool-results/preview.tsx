"use client";

import { useRouter } from "next/navigation";
import { ExternalLink, MonitorPlay } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ROUTES } from "@/lib/constants";
import { useCodePanelStore } from "@/stores/code-panel-store";
import { cn } from "@/lib/utils";

/** OnyxCode preview result payload (see src/lib/tools/code_preview.ts). */
export interface PreviewPayload {
  kind: "preview";
  ok: boolean;
  action: "start" | "stop" | "list" | "check";
  sessionId?: string;
  name?: string;
  framework?: string;
  frameworkLabel?: string;
  url?: string | null;
  port?: number;
  status?: string;
  message?: string;
  error?: string;
  /** This conversation's session only (one app per chat — 0 or 1 entries). */
  sessions?: Array<{
    sessionId: string;
    name: string;
    framework: string;
    url: string | null;
    status: string;
    createdAt: number;
  }>;
  count?: number;
  serving?: boolean;
}

export function parsePreviewResult(result: unknown): PreviewPayload | null {
  try {
    const p = typeof result === "string" ? JSON.parse(result) : result;
    if (p && typeof p === "object" && (p as { kind?: string }).kind === "preview") {
      return p as PreviewPayload;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function statusChip(status: string | undefined): string {
  switch (status) {
    case "running":
      return "bg-primary/10 text-primary";
    case "stopped":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-destructive/10 text-destructive";
  }
}

/**
 * Rich card for the OnyxCode preview tools (extension PRD §3.7): public URL,
 * status, and "Open preview panel" action. `list` renders THIS chat's single
 * session as the same card — never a multi-session table (one app per chat).
 */
export function PreviewResult({ data }: { data: PreviewPayload }) {
  const router = useRouter();

  // Opens the docked web-preview panel — on /code it docks beside the chat;
  // from anywhere else (an agent-mode chat, a shared link) it routes to
  // /code first so the panel has somewhere to render.
  const openPreviewPanel = () => {
    useCodePanelStore.getState().setOpen("preview");
    if (!window.location.pathname.startsWith("/code")) router.push(ROUTES.CODE);
  };

  // `list` — this conversation's ONE session (or none yet).
  if (data.action === "list") {
    const s = data.sessions?.[0];
    if (!s) {
      return (
        <p className="text-muted-foreground py-1 text-xs">
          No preview session for this chat yet — start one with start_preview.
        </p>
      );
    }
    return (
      <div className="space-y-2.5 py-1">
        <div className="flex flex-wrap items-center gap-2">
          <MonitorPlay className="text-primary h-4 w-4 shrink-0" aria-hidden />
          <span className="text-foreground text-sm font-semibold">{s.name}</span>
          <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", statusChip(s.status))}>
            {s.status}
          </span>
        </div>
        {s.url && (
          <a
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:bg-primary/5 block truncate rounded-lg px-2 py-1.5 font-mono text-xs underline-offset-2 hover:underline"
          >
            {s.url}
          </a>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className="animate-press h-8 gap-1.5" onClick={openPreviewPanel}>
            <MonitorPlay className="h-3.5 w-3.5" aria-hidden />
            Open preview panel
          </Button>
          {s.url && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5"
              onClick={() => window.open(s.url!, "_blank", "noopener,noreferrer")}
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              New tab
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (!data.ok) {
    return <p className="text-destructive py-1 text-xs">{data.error ?? "Preview failed."}</p>;
  }

  return (
    <div className="space-y-2.5 py-1">
      <div className="flex flex-wrap items-center gap-2">
        <MonitorPlay className="text-primary h-4 w-4 shrink-0" aria-hidden />
        <span className="text-foreground text-sm font-semibold">{data.name ?? "Preview"}</span>
        {data.status && (
          <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", statusChip(data.status))}>
            {data.status}
          </span>
        )}
        {data.port != null && (
          <span className="text-muted-foreground font-mono text-[10px]">port {data.port}</span>
        )}
      </div>
      {data.url && (
        <a
          href={data.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:bg-primary/5 block truncate rounded-lg px-2 py-1.5 font-mono text-xs underline-offset-2 hover:underline"
        >
          {data.url}
        </a>
      )}
      {data.action === "start" && data.url && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className="animate-press h-8 gap-1.5" onClick={openPreviewPanel}>
            <MonitorPlay className="h-3.5 w-3.5" aria-hidden />
            Open preview panel
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={() => window.open(data.url!, "_blank", "noopener,noreferrer")}
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            New tab
          </Button>
        </div>
      )}
      {data.message && (
        <p className="text-muted-foreground text-[11px] leading-relaxed">{data.message}</p>
      )}
    </div>
  );
}
