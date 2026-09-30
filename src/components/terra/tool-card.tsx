"use client";

import { useState } from "react";
import {
  Check,
  ChevronDown,
  Database,
  Folder,
  Globe,
  Loader2,
  Monitor,
  Search,
  Sparkles,
  Wrench,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SkipWaitButton } from "./skip-wait-button";
import { CreateAppResult } from "./tool-results/create-app";
import { PreviewResult } from "./tool-results/preview";
import { WebSessionResult } from "./tool-results/web-session";
import type { ToolCallData, ToolIconKind, ToolResultData } from "./types";

const TOOL_ICONS: Record<ToolIconKind, typeof Globe> = {
  globe: Globe,
  wrench: Wrench,
  search: Search,
  database: Database,
  monitor: Monitor,
  folder: Folder,
  sparkles: Sparkles,
};

function SpecializedResult({
  data,
  workspaceId,
}: {
  data: ToolResultData;
  workspaceId?: string;
}) {
  switch (data.kind) {
    case "create_app":
      return <CreateAppResult data={data} workspaceId={workspaceId} />;
    case "preview":
      return <PreviewResult data={data} />;
    case "web_session":
      return <WebSessionResult data={data} />;
    default:
      return null;
  }
}

interface ToolCardProps {
  tool: ToolCallData;
  /** The parent message is still streaming (enables skip-wait). */
  streaming?: boolean;
  /** OnyxCode workspace id (enables card actions like Start preview). */
  workspaceId?: string;
}

export function ToolCard({ tool, streaming = false, workspaceId }: ToolCardProps) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[tool.icon] ?? Wrench;
  const running = tool.status === "running";
  const failed = Boolean(tool.error);

  return (
    <div className="rounded-xl border border-hairline bg-paper text-left">
      <div className="flex w-full min-h-11 items-center gap-3 rounded-xl px-3.5 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={`tool-card-${tool.name}`}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-terra-soft-border bg-terra-soft"
            aria-hidden
          >
            <Icon className="h-3.5 w-3.5 text-terra" />
          </span>
          <span className="shrink-0 font-mono text-xs text-ink-soft">{tool.name}</span>
          <span className="hidden min-w-0 truncate text-xs text-ink-muted sm:block">
            — {tool.subtitle}
          </span>
        </button>
        {running && streaming && <SkipWaitButton tool={tool} />}
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
            running
              ? failed
                ? "bg-paper text-ink-muted"
                : tool.backgrounded
                  ? "bg-terra-soft/60 text-terra-deep"
                  : "bg-background text-ink-soft"
              : failed
                ? "bg-destructive/10 text-destructive"
                : "bg-terra-soft text-terra-deep",
          )}
        >
          {running ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          ) : failed ? (
            <XCircle className="h-3 w-3" aria-hidden />
          ) : (
            <Check className="h-3 w-3" aria-hidden />
          )}
          {running
            ? tool.backgrounded
              ? "Background"
              : "Running"
            : failed
              ? "Failed"
              : "Completed"}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? `Collapse ${tool.name} details` : `Expand ${tool.name} details`}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-terra-soft hover:text-terra"
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} aria-hidden />
        </button>
      </div>

      {tool.resultData && (
        <div className="border-t border-hairline/60 px-3.5 py-2.5">
          <SpecializedResult data={tool.resultData} workspaceId={workspaceId} />
        </div>
      )}

      {open && (
        <div className="space-y-3 border-t border-hairline/60 px-3.5 py-3.5">
          <div>
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted">
              Arguments
            </p>
            <pre className="terra-scroll max-h-48 overflow-auto rounded-lg border border-hairline/60 bg-background p-3 font-mono text-xs leading-relaxed text-ink-soft">
              {tool.args || "—"}
            </pre>
          </div>
          <div>
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted">
              Result
            </p>
            <pre className="terra-scroll max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-hairline/60 bg-background p-3 font-mono text-xs leading-relaxed text-ink-soft">
              {tool.result || (running ? "Waiting for the result…" : "—")}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
