"use client";

import { useMemo } from "react";
import { ExternalLink, Globe, ShieldAlert } from "lucide-react";
import type { ToolCall } from "@/types";

/**
 * WebPageResult — the web_fetch / fetch_url tool-call result (PRD §6):
 * retrieved CONTENT, not a webpage preview.
 *
 *  - Identity header: the fetched URL host (real link), page title and the
 *    extracted size — what the model actually read.
 *  - The extracted TEXT is the payload and renders as the main body (the
 *    model's source of truth), behind the same whole-row disclosure
 *    pattern every tool uses.
 *  - No iframe, no webpage snapshot — visual browsing belongs to the
 *    Browser tool (BrowserLivePanel + use_browser cards). Web Fetch
 *    retrieves information; it does not preview sites.
 *
 * Event-driven only: everything shown comes from the tool call's own args
 * and result payload.
 */

/** web_fetch result payload (see src/lib/tools/web_fetch.ts). */
interface WebFetchPayload {
  url?: string;
  title?: string;
  content?: string;
  length?: number;
  error?: string;
}

function parseFetchPayload(result: unknown): WebFetchPayload | null {
  try {
    const p = typeof result === "string" ? JSON.parse(result) : result;
    if (p && typeof p === "object") return p as WebFetchPayload;
  } catch {
    /* not JSON */
  }
  return null;
}

/** Hostname of a URL, "" when unreadable. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "";
  } catch {
    return "";
  }
}

export function WebPageResult({ toolCall }: { toolCall: ToolCall }) {
  const args = (toolCall.args ?? {}) as Record<string, unknown>;
  const payload = useMemo(() => parseFetchPayload(toolCall.result), [toolCall.result]);

  const argUrl = typeof args.url === "string" ? args.url.trim() : "";
  const url = (typeof payload?.url === "string" && payload.url ? payload.url : argUrl) || "";
  const host = url ? hostOf(url) : "";
  const title = typeof payload?.title === "string" && payload.title ? payload.title : null;
  const text = typeof payload?.content === "string" && payload.content ? payload.content : null;
  const fetchError =
    typeof payload?.error === "string" && payload.error
      ? payload.error
      : toolCall.status === "error" && typeof toolCall.result === "object"
        ? String((toolCall.result as { error?: unknown }).error ?? "")
        : null;

  return (
    <div className="space-y-2.5 px-1.5 py-1 sm:px-2">
      {/* Header — identity + the fetched size. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="bg-primary/10 text-primary inline-flex h-5 items-center gap-1 rounded-full px-2 text-[10px] font-semibold tracking-wide uppercase">
          <Globe className="h-3 w-3" aria-hidden />
          Web Fetch
        </span>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground inline-flex min-w-0 items-center gap-1 truncate font-mono text-[10px] transition-colors"
          >
            <span className="truncate">{host || url}</span>
            <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
          </a>
        ) : null}
        {typeof payload?.length === "number" && payload.length > 0 ? (
          <span className="bg-foreground/[0.05] text-muted-foreground rounded-full px-2 py-0.5 font-mono text-[10px]">
            {payload.length.toLocaleString()} chars
          </span>
        ) : null}
      </div>

      {title ? (
        <p className="text-foreground/80 truncate text-sm font-medium">{title}</p>
      ) : null}

      {fetchError ? (
        <p className="text-destructive flex items-start gap-1.5 text-xs">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{fetchError}</span>
        </p>
      ) : null}

      {/* The fetched TEXT — what the model actually read. This IS the
          Web Fetch payload (no page preview — the Browser tool owns
          visual browsing). */}
      {text ? (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-foreground/[0.02] px-2.5 py-2 scrollbar-thin">
          <p className="text-muted-foreground text-[11px] leading-relaxed break-words whitespace-pre-wrap">
            {text.slice(0, 4000)}
            {text.length > 4000 ? "\n…" : ""}
          </p>
        </div>
      ) : null}
    </div>
  );
}
