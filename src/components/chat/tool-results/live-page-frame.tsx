"use client";

import { useEffect, useState } from "react";
import {
  BookOpenText,
  ExternalLink,
  Globe,
  Loader2,
  Maximize2,
  Minimize2,
  MousePointerClick,
  RotateCw,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * LivePageFrame — a REAL preview of a web page: the site's actual URL loaded
 * in a sandboxed <iframe>, so the page renders itself with its own JS and
 * layout.
 *
 *  - FRAMING-GUARDED: on mount the frame asks /api/frame-check (server-side
 *    fetch) whether the site allows embedding. When it does NOT
 *    (x-frame-options / CSP frame-ancestors — the browser would show
 *    "refused to connect" / "content is blocked"), the frame switches to the
 *    READER SNAPSHOT: the page's title + text fetched server-side. No raw
 *    browser error pages, ever.
 *  - UNREACHABLE SITES (connection refused / DNS / timeout) get their own
 *    honest card (error + retry + open-in-new-tab), never a dead rectangle.
 *  - LIVE TIMEOUT: when a frameable site's load event hasn't fired within
 *    15s (network captive portals, hung connects), the reader snapshot
 *    takes over — with a notice, and the toggle can go back to live.
 *  - READER TOGGLE (📖): manual live ↔ snapshot switch at any time.
 *  - SANDBOXED: scripts, forms and popups are allowed but same-origin is
 *    deliberately WITHHELD — a framed third-party page can never touch this
 *    app's origin.
 *  - NON-INTERACTIVE BY DEFAULT: a transparent shield over the frame
 *    captures pointer events; the "Interact" toggle lifts it.
 *  - ENLARGED, never a peek-hole: generous default height, ⤢ grows to 75%
 *    of the viewport.
 *  - RELOAD ⟳: live mode remounts the frame; reader mode refetches the
 *    snapshot.
 */

/** /api/frame-check payload (see the route). */
interface FrameCheck {
  ok: boolean;
  frameable: boolean;
  reason?: string;
  status?: number;
  title?: string;
  text?: string;
  error?: string;
}

/** Module-level per-URL cache — the browser group re-checks on every
 * navigation; don't hammer one URL. Simple LRU-ish (insertion order). */
const checkCache = new Map<string, FrameCheck>();
const CHECK_CACHE_MAX = 80;

async function fetchFrameCheck(url: string, force = false): Promise<FrameCheck> {
  const cached = force ? undefined : checkCache.get(url);
  if (cached) return cached;
  try {
    const res = await fetch(`/api/frame-check?url=${encodeURIComponent(url)}`);
    const data = (await res.json()) as FrameCheck;
    if (force || !checkCache.has(url)) {
      if (checkCache.size >= CHECK_CACHE_MAX) {
        const oldest = checkCache.keys().next().value;
        if (oldest) checkCache.delete(oldest);
      }
      checkCache.set(url, data);
    }
    return data;
  } catch {
    return { ok: false, frameable: false, error: "Frame check failed" };
  }
}

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
  // Frameability check + reader mode (auto-switched when embedding is
  // refused, manually toggleable any time).
  const [check, setCheck] = useState<FrameCheck | null>(null);
  const [checkPending, setCheckPending] = useState(true);
  const [reader, setReader] = useState(false);
  const [autoNotice, setAutoNotice] = useState<string | null>(null);

  // URL change (the agent navigated elsewhere) → reset everything and
  // re-shield the frame. Render-time adjustment (React docs pattern), same
  // as the other tool cards.
  const [prevUrl, setPrevUrl] = useState(url);
  if (url !== prevUrl) {
    setPrevUrl(url);
    setFrameLoaded(false);
    setInteractive(false);
    setReader(false);
    setAutoNotice(null);
    setCheck(null);
    setCheckPending(true);
  }

  const isHttp = /^https?:\/\//i.test(url);
  const host = hostOf(url);

  // Framing guard — ask the server whether this site allows embedding, and
  // auto-switch to the reader snapshot when it does not (the browser error
  // page must never be the thing the user sees). checkPending is already
  // true here: initial state, and the render-time URL reset above owns the
  // url-change case (no synchronous setState in the effect body).
  useEffect(() => {
    let cancelled = false;
    fetchFrameCheck(url).then((data) => {
      if (cancelled) return;
      setCheck(data);
      setCheckPending(false);
      if (data.ok && !data.frameable && data.text) {
        setReader(true);
        setAutoNotice(
          data.reason
            ? `this site blocks embedding (${data.reason}) — showing the fetched snapshot`
            : "this site blocks embedding — showing the fetched snapshot",
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Live-load timeout — a frameable site whose load event never fires
  // (captive portals, hung connects, sandboxed browsers) degrades to the
  // reader snapshot instead of an eternal spinner.
  useEffect(() => {
    if (reader || frameLoaded || !check?.ok || !check.text) return;
    const timer = setTimeout(() => {
      setReader(true);
      setAutoNotice("the live preview did not load in time — showing the fetched snapshot");
    }, 15_000);
    return () => clearTimeout(timer);
  }, [reader, frameLoaded, check, url, reloadKey]);

  /** Re-run the frame check (reader reload / unreachable retry). */
  const refetchSnapshot = () => {
    setCheckPending(true);
    fetchFrameCheck(url, true).then((data) => {
      setCheck(data);
      setCheckPending(false);
      if (data.ok && !data.frameable && data.text && !reader) {
        setReader(true);
        setAutoNotice("this site blocks embedding — showing the fetched snapshot");
      }
    });
  };

  if (!isHttp) return null;

  const unreachable = check !== null && !check.ok;
  const readerText = check?.ok ? check.text : undefined;
  const readerTitle = check?.ok ? check.title : undefined;

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
          {/* Reload — live mode remounts the frame; reader/unreachable
              re-fetches the snapshot. */}
          <button
            type="button"
            onClick={() => {
              if (reader || unreachable) {
                refetchSnapshot();
              } else {
                setFrameLoaded(false);
                setReloadKey((k) => k + 1);
              }
            }}
            title={reader || unreachable ? "Refetch the snapshot" : "Reload the live preview"}
            aria-label={reader || unreachable ? "Refetch the snapshot" : "Reload the live preview"}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <RotateCw className="h-3 w-3" aria-hidden />
          </button>
          {/* Reader toggle — the snapshot escape hatch, always available. */}
          <button
            type="button"
            onClick={() => setReader((v) => !v)}
            aria-pressed={reader}
            title={reader ? "Show the live page" : "Show the fetched snapshot instead of the live page"}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-md border px-1.5 font-mono text-[10px] transition-colors",
              reader
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <BookOpenText className="h-3 w-3" aria-hidden />
            {reader ? "Snapshot" : "Reader"}
          </button>
          {/* Interactivity toggle — live pages only. */}
          {!reader && !unreachable ? (
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
          ) : null}
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

      {/* Auto-switch notice — why the snapshot is showing instead of the
          live page. */}
      {autoNotice && reader ? (
        <p className="flex items-center gap-1.5 border-b border-border bg-muted/50 px-2.5 py-1 font-mono text-[10px] leading-relaxed text-muted-foreground">
          <ShieldAlert className="h-3 w-3 shrink-0" aria-hidden />
          <span className="min-w-0">{host} {autoNotice}</span>
        </p>
      ) : null}

      {/* The viewport — live iframe, reader snapshot, or unreachable card. */}
      <div
        className={cn(
          "relative w-full transition-[height] duration-300",
          enlarged ? "h-[75vh]" : heightClass,
        )}
      >
        {unreachable ? (
          /* UNREACHABLE — the server-side fetch itself failed (connection
             refused / DNS / timeout). Honest card, never a browser error
             page or an eternal spinner. */
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background px-4 text-center">
            <ShieldAlert className="h-5 w-5 text-destructive/80" aria-hidden />
            <p className="text-sm font-medium text-foreground/90">Site not accessible</p>
            <p className="max-w-md text-xs leading-relaxed break-words text-muted-foreground">
              {check?.error ?? "The site refused the connection."}
            </p>
            <span className="mt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={refetchSnapshot}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 font-mono text-[11px] text-foreground transition-colors hover:bg-accent/50"
              >
                <RotateCw className="h-3 w-3" aria-hidden />
                Try again
              </button>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 font-mono text-[11px] text-foreground transition-colors hover:bg-accent/50"
              >
                <ExternalLink className="h-3 w-3" aria-hidden />
                Open in a new tab
              </a>
            </span>
          </div>
        ) : reader ? (
          /* READER SNAPSHOT — the page's title + text as fetched
             server-side; the honest fallback when embedding is refused. */
          checkPending && !readerText ? (
            <div className="absolute inset-0 flex items-center justify-center gap-2 bg-muted/60 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              <span className="font-mono text-[10px]">fetching the snapshot…</span>
            </div>
          ) : readerText ? (
            <div className="scrollbar-thin absolute inset-0 overflow-y-auto bg-background px-4 py-3 sm:px-6 sm:py-4">
              {readerTitle || title ? (
                <p className="mb-2 text-base font-semibold text-foreground/90">
                  {readerTitle || title}
                </p>
              ) : null}
              <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/80">
                {readerText}
              </p>
            </div>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background px-4 text-center">
              <BookOpenText className="h-5 w-5 text-muted-foreground" aria-hidden />
              <p className="text-sm font-medium text-foreground/90">Snapshot unavailable</p>
              <p className="text-xs text-muted-foreground">
                The live view is on; open the page in a new tab if it stays blank.
              </p>
            </div>
          )
        ) : (
          /* THE LIVE PAGE — sandboxed (no same-origin), optionally interactive. */
          <>
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
          </>
        )}
      </div>

      {/* Caption — honest per mode. */}
      <figcaption className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 border-t border-border bg-foreground/[0.02] px-2.5 py-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground/80">
        {reader ? (
          <>
            <span className="shrink-0">Reader snapshot —</span>
            <span className="min-w-0">{host ? `${host} ` : ""}fetched just now; the site blocks a live embed.</span>
          </>
        ) : unreachable ? (
          <>
            <span className="shrink-0">Unreachable —</span>
            <span className="min-w-0">{host ? `${host} ` : ""}could not be fetched from here.</span>
          </>
        ) : (
          <>
            <span className="shrink-0">Live page —</span>
            <span className="min-w-0">
              {host ? `${host} ` : ""}renders itself here; some sites block embedding.
            </span>
          </>
        )}
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
