"use client";

import { memo, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Database,
  Folder,
  Globe,
  Image as ImageIcon,
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
import { ImageResult } from "./tool-results/image";
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
  image: ImageIcon,
};

/** Argument keys shown first and highlighted in the structured view. */
const PRIORITY_KEYS = ["path", "name", "framework", "url", "key", "action", "question"];
const HIDDEN_KEYS = new Set(["content"]);

/**
 * Extract the most meaningful snippet from PARTIAL JSON text while the model
 * is still writing the call — the file path must appear on screen the moment
 * it exists in the stream, long before the tool actually runs.
 */
function liveSnippet(args: string): string {
  const order = ["path", "name", "framework", "url", "key", "action", "question", "screenshot"];
  for (const key of order) {
    const match = new RegExp(`"${key}"\\s*:\\s*"([^"]{0,80})`).exec(args);
    if (match?.[1]) return match[1];
  }
  return "";
}

/** Parse complete args into ordered key/value blocks (static, only on open). */
function structuredArgs(args: string): { key: string; value: string }[] | null {
  try {
    const parsed = JSON.parse(args) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) return null;
    return entries
      .filter(([key]) => !HIDDEN_KEYS.has(key))
      .sort((a, b) => {
        const ai = PRIORITY_KEYS.indexOf(a[0]);
        const bi = PRIORITY_KEYS.indexOf(b[0]);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      })
      .map(([key, value]) => ({
        key,
        value:
          typeof value === "string"
            ? value
            : (() => {
                try {
                  return JSON.stringify(value);
                } catch {
                  return String(value);
                }
              })(),
      }));
  } catch {
    return null;
  }
}

function ArgsView({ args, streaming }: { args: string; streaming: boolean }) {
  const blocks = useMemo(() => (streaming ? null : structuredArgs(args)), [args, streaming]);

  if (streaming || !blocks) {
    // While the model is still writing the call, show the growing raw text —
    // real streamed arguments, never a fake "Creating…" placeholder.
    return (
      <pre className="terra-scroll max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-hairline/60 bg-background p-3 font-mono text-xs leading-relaxed text-ink-soft">
        {args || "(waiting for the model…)"}
        {streaming && <span className="terra-caret ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] rounded-[1px] bg-terra" aria-hidden />}
      </pre>
    );
  }

  return (
    <dl className="space-y-1.5">
      {blocks.map((block) => (
        <div
          key={block.key}
          className={cn(
            "flex flex-col gap-0.5 rounded-lg border px-2.5 py-1.5 sm:flex-row sm:items-baseline sm:gap-2.5",
            PRIORITY_KEYS.includes(block.key)
              ? "border-terra-soft-border bg-terra-soft/50"
              : "border-hairline/60 bg-background",
          )}
        >
          <dt className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
            {block.key}
          </dt>
          <dd className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed text-ink">
            {block.value || "—"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

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
    case "image":
      return <ImageResult data={data} />;
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

/**
 * One tool call's lifecycle card:
 *   preparing (model writing arguments) → running (executing) → completed /
 *   failed — each phase honestly labeled, with the real arguments visible.
 */
export const ToolCard = memo(function ToolCard({ tool, streaming = false, workspaceId }: ToolCardProps) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[tool.icon] ?? Wrench;
  const preparing = tool.status === "preparing";
  const running = tool.status === "running";
  const failed = Boolean(tool.error);
  const subtitle = preparing ? liveSnippet(tool.args) || "writing the call…" : tool.subtitle;

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
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-terra-soft-border",
              preparing ? "animate-pulse bg-terra-soft/60" : "bg-terra-soft",
            )}
            aria-hidden
          >
            <Icon className="h-3.5 w-3.5 text-terra" />
          </span>
          <span className="shrink-0 font-mono text-xs text-ink-soft">{tool.name}</span>
          <span
            className={cn(
              "hidden min-w-0 text-xs sm:block",
              preparing ? "animate-pulse text-ink-muted" : "truncate text-ink-muted",
            )}
          >
            {subtitle ? `— ${subtitle}` : ""}
          </span>
        </button>
        {running && streaming && <SkipWaitButton tool={tool} />}
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
            preparing
              ? "bg-terra-soft/60 text-terra-deep"
              : running
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
          {preparing || running ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          ) : failed ? (
            <XCircle className="h-3 w-3" aria-hidden />
          ) : (
            <Check className="h-3 w-3" aria-hidden />
          )}
          {preparing
            ? "Writing arguments"
            : running
              ? tool.backgrounded
                ? "Background"
                : "Executing"
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
              {preparing ? "Arguments (streaming)" : "Arguments"}
            </p>
            <ArgsView args={tool.args} streaming={preparing} />
          </div>
          {!preparing && (
            <div>
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted">
                Result
              </p>
              <pre className="terra-scroll max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-hairline/60 bg-background p-3 font-mono text-xs leading-relaxed text-ink-soft">
                {tool.result || (running ? "Waiting for the result…" : "—")}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
