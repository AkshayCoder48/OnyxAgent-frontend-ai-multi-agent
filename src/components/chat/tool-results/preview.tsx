"use client";

import { useRouter } from "next/navigation";
import { ExternalLink, MonitorPlay, Square, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ROUTES } from "@/lib/constants";
import { usePreviewSessionStore } from "@/stores/preview-session-store";
import { stopPreviewSession } from "@/lib/code/preview-ops";
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
  url?: string;
  port?: number;
  status?: string;
  message?: string;
  error?: string;
  sessions?: Array<{
    sessionId: string;
    name: string;
    framework: string;
    url: string;
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
 * status, "Open in Preview tab" action, and for `list` the session table.
 */
export function PreviewResult({ data }: { data: PreviewPayload }) {
  const router = useRouter();

  if (data.action === "list" && data.sessions) {
    return (
      <div className="space-y-2 py-1">
        <div className="text-muted-foreground font-mono text-[10px] tracking-wider uppercase">
          {data.count ?? data.sessions.length} preview session{(data.count ?? data.sessions.length) === 1 ? "" : "s"}
        </div>
        <div className="border-foreground/10 divide-foreground/8 divide-y overflow-hidden rounded-xl border">
          {data.sessions.map((s) => (
            <button
              key={s.sessionId}
              type="button"
              onClick={() => router.push(ROUTES.CODE_PREVIEW)}
              className="hover:bg-foreground/[0.03] flex w-full items-center gap-2 px-3 py-2 text-left"
            >
              <MonitorPlay className="text-muted-foreground h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{s.name}</span>
                <span className="text-muted-foreground block truncate font-mono text-[10px]">{s.url}</span>
              </span>
              <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", statusChip(s.status))}>
                {s.status}
              </span>
            </button>
          ))}
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
          <Button size="sm" className="h-8 gap-1.5" onClick={() => router.push(ROUTES.CODE_PREVIEW)}>
            <MonitorPlay className="h-3.5 w-3.5" aria-hidden />
            Open in Preview tab
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={() => window.open(data.url, "_blank", "noopener,noreferrer")}
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

/**
 * Small stop control used by the Preview tab cards (shared styling with the
 * chat card). Kept here so the chat card + panel card share one look.
 */
export function PreviewStopButton({
  session,
  onStopped,
}: {
  session: { id: string; name: string; port: number; url: string; status: string };
  onStopped?: () => void;
}) {
  const isStopped = session.status === "stopped";
  return (
    <Button
      size="sm"
      variant={isStopped ? "outline" : "secondary"}
      className="h-7 gap-1.5 px-2.5 text-[11px]"
      onClick={() => {
        if (isStopped) {
          usePreviewSessionStore.getState().remove(session.id);
          onStopped?.();
          return;
        }
        void stopPreviewSession(session).then(() => onStopped?.());
      }}
      title={isStopped ? "Remove from the list" : "Stop the dev server"}
    >
      {isStopped ? <Trash2 className="h-3 w-3" aria-hidden /> : <Square className="h-3 w-3" aria-hidden />}
      {isStopped ? "Remove" : "Stop"}
    </Button>
  );
}
