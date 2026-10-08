"use client";

import { useMemo, useState } from "react";
import {
  ExternalLink,
  Globe,
  Loader2,
  MousePointerClick,
  ShieldAlert,
} from "lucide-react";
import type { ToolCall } from "@/types";
import { cn } from "@/lib/utils";

/**
 * WebPageResult — a REAL preview of the fetched site inside the web_fetch /
 * fetch_url tool-call card ("a preview of that site for real, interactive
 * optional"):
 *
 *  - A SANDBOXED <iframe> of the page's actual URL — the site renders
 *    itself with its own JS and layout. The sandbox allows scripts, forms
 *    and popups but NOT same-origin, so a framed page can never touch this
 *    app's origin.
 *  - NON-INTERACTIVE BY DEFAULT: a transparent overlay over the frame
 *    captures pointer events, so the chat keeps scrolling normally through
 *    the preview and a stray tap can't navigate the frame. The
 *    "Interact" toggle lifts the overlay and hands the frame real pointer
 *    events — links, buttons and inputs work; toggling back re-shields it.
 *  - HONEST FRAMING FALLBACK: many sites send X-Frame-Options /
 *    CSP frame-ancestors and refuse to be framed — the frame then stays
 *    blank. The preview therefore always carries the fetched TEXT excerpt
 *    (what the model actually read) plus an open-in-new-tab affordance, so
 *    a framing refusal degrades to a text preview, never a dead rectangle.
 *
 * Event-driven only: everything shown comes from the tool call's own args
 * and result payload — no invented "loading the page…" state beyond the
 * iframe's real load event.
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
  const [interactive, setInteractive] = useState(false);
  const [frameLoaded, setFrameLoaded] = useState(false);

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
      {/* Header — identity + the two affordances. */}
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
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* Interactivity toggle — OPTIONAL by design. */}
          <button
            type="button"
            onClick={() => setInteractive((v) => !v)}
            aria-pressed={interactive}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-md border px-1.5 font-mono text-[10px] transition-colors",
              interactive
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
            title={
              interactive
                ? "Interactive — the preview responds to clicks. Turn off to scroll the chat through it."
                : "Preview only — make the live page interactive"
            }
          >
            <MousePointerClick className="h-3 w-3" aria-hidden />
            {interactive ? "Interacting" : "Interact"}
          </button>
        </span>
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
        <>
          {/* The LIVE page — sandboxed (no same-origin), optionally interactive. */}
          <div className="relative overflow-hidden rounded-lg border border-border bg-muted/30">
            {!frameLoaded ? (
              <div className="flex aspect-[16/10] w-full items-center justify-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                <span className="font-mono text-[10px]">loading live preview…</span>
              </div>
            ) : null}
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- onLoad is a load lifecycle event, not an interaction */}
            <iframe
              src={url}
              title={title ? `Live preview of ${title}` : `Live preview of ${url}`}
              onLoad={() => setFrameLoaded(true)}
              loading="lazy"
              referrerPolicy="no-referrer"
              // Scripts/forms/popups allowed so the real site works; SAME-ORIGIN
              // deliberately withheld — a framed third-party page must never
              // gain access to this app's origin.
              sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
              className={cn(
                "aspect-[16/10] w-full bg-background",
                frameLoaded ? "block" : "hidden",
                !interactive && "pointer-events-none",
              )}
            />
            {/* Interaction shield — captures pointer events while the
                preview is non-interactive so the chat scrolls through it
                normally. Clicking it flips the page interactive (one tap,
                no hidden traps). */}
            {!interactive && frameLoaded ? (
              <button
                type="button"
                aria-label="Make the live preview interactive"
                onClick={() => setInteractive(true)}
                className="absolute inset-0 flex cursor-pointer items-end justify-center bg-transparent p-2"
              >
                <span className="rounded-full border border-border bg-background/85 px-2.5 py-1 font-mono text-[10px] text-muted-foreground backdrop-blur-sm">
                  tap to interact
                </span>
              </button>
            ) : null}
          </div>
          {/* Framing-refusal honesty note — blank frame ⇒ the site blocks
              embedding; the excerpt + open-in-tab remain the real content. */}
          <p className="font-mono text-[10px] leading-relaxed text-muted-foreground/80">
            Live preview loads the real site — some sites block embedding; if the frame
            stays blank, {host ? `${host} ` : ""}refuses framing.{" "}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-foreground/30 underline-offset-2 transition-colors hover:text-foreground"
            >
              Open in a new tab
            </a>
            .
          </p>
        </>
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
