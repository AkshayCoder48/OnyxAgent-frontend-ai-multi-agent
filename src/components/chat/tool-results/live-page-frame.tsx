"use client";

import { useState } from "react";
import {
  ExternalLink,
  Globe,
  Loader2,
  Maximize2,
  Minimize2,
  MousePointerClick,
  RotateCw,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * LivePageFrame — a REAL preview of a web page: the site's actual URL loaded
 * in a sandboxed <iframe>, so the page renders itself with its own JS and
 * layout ("replace the previewing strategy with an iframe").
 *
 *  - SANDBOXED: scripts, forms and popups are allowed but same-origin is
 *    deliberately WITHHELD — a framed third-party page can never touch this
 *    app's origin.
 *  - NON-INTERACTIVE BY DEFAULT: a transparent shield over the frame
 *    captures pointer events, so the chat keeps scrolling normally through
 *    the preview and a stray tap can't navigate the frame. The "Interact"
 *    toggle (or a tap on the shield) lifts it — links, buttons and inputs
 *    work; toggling back re-shields the frame.
 *  - ENLARGED, never a peek-hole: the frame defaults to a generous height
 *    (per-surface `heightClass`) and the ⤢ toggle grows it to 75% of the
 *    viewport — the page is meant to be READ, not squinted at.
 *  - RELOAD ⟳: remounts the frame (a fresh load of the live URL).
 *  - HONEST FRAMING FALLBACK: many sites send X-Frame-Options /
 *    CSP frame-ancestors and refuse to be framed — the frame then stays
 *    blank. The caption therefore always offers "Open in a new tab", so a
 *    framing refusal degrades to a link, never a dead rectangle.
 *
 * Event-driven only: the loading state is driven by the iframe's real load
 * event — no invented progress.
 */

/** Hostname of a URL, "" when unreadable. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "";
  } catch {
    return "";
  }
}

export interface LivePageFrameProps {
  /** The page's actual URL — only http(s) frames (anything else renders null). */
  url: string;
  /** Page title, used for the iframe's accessible name. */
  title?: string | null;
  /** Chrome-bar identity chip (e.g. "Web Page", "Browser"). */
  badge?: string;
  /** Normal height of the frame viewport (Tailwind height classes). */
  heightClass?: string;
  /** Extra classes for the outer wrapper. */
  className?: string;
  /** Optional extra note rendered in the caption row. */
  note?: string;
}

export function LivePageFrame({
  url,
  title,
  badge = "Web Page",
  heightClass = "h-72 sm:h-96",
  className,
  note,
}: LivePageFrameProps) {
  const [interactive, setInteractive] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // URL change (the agent navigated elsewhere) → reset the load state and
  // re-shield the frame. Render-time adjustment (React docs pattern), same
  // as the other tool cards.
  const [prevUrl, setPrevUrl] = useState(url);
  if (url !== prevUrl) {
    setPrevUrl(url);
    setFrameLoaded(false);
    setInteractive(false);
  }

  const isHttp = /^https?:\/\//i.test(url);
  const host = hostOf(url);

  if (!isHttp) return null;

  return (
    <figure className={cn("w-full overflow-hidden rounded-lg border border-border bg-muted/30", className)}>
      {/* Chrome bar — identity on the left, frame controls on the right. */}
      <div className="flex min-w-0 items-center gap-1.5 border-b border-border bg-foreground/[0.03] px-2 py-1">
        <Globe className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
        <span className="shrink-0 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {badge}
        </span>
        <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/80">
          {host || url}
        </span>

        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {/* Reload — remount the frame for a fresh load. */}
          <button
            type="button"
            onClick={() => {
              setFrameLoaded(false);
              setReloadKey((k) => k + 1);
            }}
            title="Reload the live preview"
            aria-label="Reload the live preview"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <RotateCw className="h-3 w-3" aria-hidden />
          </button>
          {/* Interactivity toggle — OPTIONAL by design. */}
          <button
            type="button"
            onClick={() => setInteractive((v) => !v)}
            aria-pressed={interactive}
            title={
              interactive
                ? "Interactive — the preview responds to clicks. Turn off to scroll the chat through it."
                : "Preview only — make the live page interactive"
            }
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-md border px-1.5 font-mono text-[10px] transition-colors",
              interactive
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <MousePointerClick className="h-3 w-3" aria-hidden />
            {interactive ? "Interacting" : "Interact"}
          </button>
          {/* Enlarge toggle — 75% of the viewport; the page is meant to be read. */}
          <button
            type="button"
            onClick={() => setEnlarged((v) => !v)}
            aria-pressed={enlarged}
            title={enlarged ? "Shrink the live preview" : "Enlarge the live preview"}
            aria-label={enlarged ? "Shrink the live preview" : "Enlarge the live preview"}
            className={cn(
              "inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors",
              enlarged
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
            )}
          >
            {enlarged ? <Minimize2 className="h-3 w-3" aria-hidden /> : <Maximize2 className="h-3 w-3" aria-hidden />}
          </button>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open the page in a new tab"
            aria-label="Open the page in a new tab"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </span>
      </div>

      {/* The LIVE page — sandboxed (no same-origin), optionally interactive. */}
      <div
        className={cn(
          "relative w-full transition-[height] duration-300",
          enlarged ? "h-[75vh]" : heightClass,
        )}
      >
        {!frameLoaded ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-muted/60 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            <span className="font-mono text-[10px]">loading live preview…</span>
          </div>
        ) : null}
        {/* The frame is ALWAYS in the layout (never display:none — a hidden
            lazy iframe never enters the viewport and would never load);
            the loading overlay above covers it until its real load event. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- onLoad is a load lifecycle event, not an interaction */}
        <iframe
          key={reloadKey}
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
            "h-full w-full bg-background",
            !interactive && "pointer-events-none",
          )}
        />
        {/* Interaction shield — captures pointer events while the preview is
            non-interactive so the chat scrolls through it normally. Clicking
            it flips the page interactive (one tap, no hidden traps). */}
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

      {/* Framing-refusal honesty note — a blank frame means the site blocks
          embedding; the new-tab link is always the real way out. */}
      <figcaption className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 border-t border-border bg-foreground/[0.02] px-2.5 py-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground/80">
        <span className="shrink-0">Live page —</span>
        <span className="min-w-0">
          {host ? `${host} ` : ""}renders itself here; some sites block embedding.
        </span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 underline decoration-foreground/30 underline-offset-2 transition-colors hover:text-foreground"
        >
          Open in a new tab
        </a>
        {note ? <span className="min-w-0 shrink-0">· {note}</span> : null}
      </figcaption>
    </figure>
  );
}
