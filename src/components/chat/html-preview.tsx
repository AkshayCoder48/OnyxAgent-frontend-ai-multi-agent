"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2, MonitorPlay, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * HTML Preview — the code-block "Preview" affordance (user request
 * 2026-11-14, replacing the removed preview_html agent tool).
 *
 * The APP detects HTML code blocks in chat (no agent tool involved):
 * `isPreviewableHtml()` gates a **Preview** button into the code-block
 * header — placed just before Save — and tapping it opens a small popup
 * card rendering the snippet live. The render runs in a fully SANDBOXED
 * iframe (allow-scripts, no allow-same-origin: the snippet cannot touch
 * the app's DOM, cookies or storage), so arbitrary generated HTML is safe
 * to preview.
 *
 * Card affordances (exactly the requested interactions):
 *   - small box: ~560×440 card over a dimmed backdrop; tapping the CENTER
 *     of the rendered page (the subtle ⤢ zone) or the header expand icon
 *     goes fullscreen;
 *   - fullscreen: near-viewport card, fully interactive page (the center
 *     zone disappears), shrink icon returns to the small box;
 *   - cross (X) button, backdrop click and Esc close the preview.
 */

// ---------------------------------------------------------------------------
// Detection — which fenced blocks are previewable HTML?
// ---------------------------------------------------------------------------

/** Fence language slugs that mean HTML, case-insensitive. */
const HTML_LANGS = new Set(["html", "htm", "xhtml", "text/html", "text/html; charset=utf-8"]);

/** Root-level tags that make an untagged snippet look like a previewable
 *  page fragment (a lone <p> could be anything — a <canvas>/<style>/<script>/
 *  layout root says "this renders"). */
const FRAGMENT_ROOT_RE = /<(?:html|body|head|div|section|main|canvas|style|script|template|svg)\b/i;

/** Is this code block HTML the app can render in the preview card? */
export function isPreviewableHtml(lang: string | null, code: string): boolean {
  if (!code || code.length < 8) return false;
  const trimmed = code.trim();
  if (!trimmed.startsWith("<")) return false;
  const l = (lang ?? "").trim().toLowerCase();
  if (HTML_LANGS.has(l)) return true;
  // Untagged blocks must look like a DOCUMENT (doctype/<html>) or carry a
  // page-fragment root tag — never raw text that merely starts with "<".
  if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return true;
  return FRAGMENT_ROOT_RE.test(trimmed);
}

// ---------------------------------------------------------------------------
// The preview card (small box ⇄ fullscreen).
// ---------------------------------------------------------------------------

export function HtmlPreviewCard({
  code,
  onClose,
  className,
}: {
  code: string;
  onClose: () => void;
  className?: string;
}) {
  const [fullscreen, setFullscreen] = useState(false);

  // Esc closes (any mode); the card is a plain overlay, not a Radix Dialog,
  // so the key handler lives here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const goFullscreen = useCallback(() => setFullscreen(true), []);
  const shrink = useCallback(() => setFullscreen(false), []);

  // PORTAL to <body>: the chat's message tree contains transformed ancestors
  // (stream-fade animations) — inside them `position: fixed` is relative to
  // the transform box, which trapped the overlay inside the message bubble
  // (caught in the 2026-11-14 visual check). document.body is transform-free.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="HTML preview"
      data-fullscreen={fullscreen ? "true" : "false"}
    >
      <div
        className={cn(
          // Warm charcoal card matching the chat code-block chrome.
          "bg-card text-card-foreground relative flex flex-col overflow-hidden rounded-xl border border-[#3a3128] shadow-2xl transition-[width,height,max-width,max-height] duration-200",
          fullscreen
            ? "h-full max-h-full w-full max-w-full"
            : "h-[min(70vh,26rem)] w-[min(94vw,35rem)]",
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header strip — expand/shrink + close. */}
        <div
          className="flex items-center justify-between px-3.5 py-2 font-mono text-[11px]"
          style={{ backgroundColor: "var(--chat-code-header-bg, #1F1A15)", color: "#a5947c" }}
        >
          <span className="truncate">HTML Preview</span>
          <span className="flex shrink-0 items-center gap-1">
            {fullscreen ? (
              <button
                type="button"
                onClick={shrink}
                title="Shrink to small preview"
                aria-label="Shrink the HTML preview"
                className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-[11px] transition-colors hover:bg-white/5 hover:text-[#e8decc]"
              >
                <Minimize2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                onClick={goFullscreen}
                title="Fullscreen"
                aria-label="Expand the HTML preview fullscreen"
                className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-[11px] transition-colors hover:bg-white/5 hover:text-[#e8decc]"
              >
                <Maximize2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              title="Close preview"
              aria-label="Close the HTML preview"
              className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-[11px] transition-colors hover:bg-white/5 hover:text-[#e8decc]"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              <span className="leading-none">Close</span>
            </button>
          </span>
        </div>

        {/* The live render — sandboxed: scripts run, same-origin does NOT
            (the snippet can't reach the app, its cookies or storage). */}
        <div className="relative min-h-0 flex-1">
          <iframe
            title="HTML preview"
            srcDoc={code}
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
            className="h-full w-full border-0 bg-white"
          />
          {/* CENTER TAP ZONE (small mode only): tapping the center of the
              rendered page goes fullscreen — the affordance the request
              named. In fullscreen the zone is gone and the whole page is
              interactive. */}
          {!fullscreen && (
            <button
              type="button"
              onClick={goFullscreen}
              aria-label="Show the HTML preview fullscreen"
              className="group absolute left-1/2 top-1/2 flex h-[45%] w-[45%] -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-xl bg-transparent transition-colors hover:bg-black/5 focus-visible:bg-black/10 focus-visible:outline-2 focus-visible:outline-[#a5947c]"
            >
              <span className="flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-[11px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <Maximize2 className="h-3.5 w-3.5" aria-hidden />
                Tap to fullscreen
              </span>
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// The header button (code-block chrome, next to Save).
// ---------------------------------------------------------------------------

export function HtmlPreviewButton({
  code,
  className,
}: {
  code: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title="Preview HTML"
        aria-label="Preview this HTML block"
        className={cn(
          "inline-flex h-6 cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-[11px] transition-colors hover:bg-white/5",
          className,
        )}
      >
        <MonitorPlay className="h-3.5 w-3.5" aria-hidden />
        <span className="leading-none">Preview</span>
      </button>
      {open && <HtmlPreviewCard code={code} onClose={() => setOpen(false)} />}
    </>
  );
}
