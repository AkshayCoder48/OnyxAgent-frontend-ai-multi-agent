"use client";

import { useMemo } from "react";
import { ExternalLink, Globe, ShieldAlert } from "lucide-react";
import type { ToolCall } from "@/types";
import { LivePageFrame } from "./live-page-frame";

/**
 * WebPageResult — the web_fetch / fetch_url tool-call card's REAL preview of
 * the fetched site:
 *
 *  - A generous LivePageFrame — the page's actual URL in a sandboxed
 *    <iframe> (interactivity opt-in, enlarge ⤢, reload ⟳, new-tab escape).
 *    The frame defaults to a TALL viewport (h-[24rem] sm:h-[30rem]) so the
 *    site is readable without expanding anything.
 *  - The fetched TEXT excerpt (what the model actually read) stays available
 *    behind a collapsed <details> — it is the honest fallback when a site
 *    refuses framing.
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
  const isHttp = /^https?:\/\//i.test(url);
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
        <span className="inline-flex h-5 items-center gap-1 rounded-full bg-primary/10 px-2 text-[10px] font-semibold tracking-wide text-primary uppercase">
          <Globe className="h-3 w-3" aria-hidden />
          Web Page
        </span>
        {host ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <span className="truncate">{host}</span>
            <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
          </a>
        ) : null}
        {typeof payload?.length === "number" && payload.length > 0 ? (
          <span className="rounded-full bg-foreground/[0.05] px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
            {payload.length.toLocaleString()} chars
          </span>
        ) : null}
      </div>

      {title ? (
        <p className="truncate text-sm font-medium text-foreground/80">{title}</p>
      ) : null}

      {fetchError ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{fetchError}</span>
        </p>
      ) : isHttp ? (
        /* The LIVE page — tall by default (the user asked for a preview you
            can actually SEE), sandboxed, optionally interactive, enlargeable
            to 75% of the viewport. */
        <LivePageFrame
          url={url}
          title={title}
          badge="Web Page"
          heightClass="h-[24rem] sm:h-[30rem]"
          note={typeof payload?.length === "number" && payload.length > 0 ? `${payload.length.toLocaleString()} chars extracted` : undefined}
        />
      ) : null}

      {/* The fetched TEXT — what the model actually read. Always present:
          it IS the fallback preview when framing is refused. */}
      {text ? (
        <details className="group rounded-lg border border-border bg-foreground/[0.02]">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 font-mono text-[10px] tracking-wider text-muted-foreground uppercase transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <span className="flex-1">Extracted text</span>
            <span className="text-muted-foreground/60 transition-transform group-open:rotate-90">›</span>
          </summary>
          <div className="max-h-56 overflow-y-auto border-t border-border px-2.5 py-2 scrollbar-thin">
            <p className="text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {text.slice(0, 3000)}
              {text.length > 3000 ? "\n…" : ""}
            </p>
          </div>
        </details>
      ) : null}
    </div>
  );
}
