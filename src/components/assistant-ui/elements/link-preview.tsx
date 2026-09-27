"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * LinkPreview — the assistant-ui "link preview" element, re-themed to the
 * app's Terra warm-editorial tokens. A soft paper card for one URL: preview
 * image, favicon (or site initial) + site row, title, and a two-line
 * description.
 *
 * Safety first: `href` is parsed with `new URL` inside a try/catch and ONLY
 * http(s) URLs become anchors — anything else (javascript:, data:, mailto:,
 * relative paths, garbage) renders the exact same card as inert text with no
 * anchor, and the title's stretched hit-target only exists when linkable.
 */

/** Matches one bare http(s) URL inside a text blob. */
const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/;
/** Same pattern with the global flag — for collecting every URL in a blob. */
const URL_PATTERN_ALL = /https?:\/\/[^\s"'<>)\]]+/g;
/** Sentence-final punctuation that is almost never part of a real URL. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

function trimTrailingPunctuation(url: string): string {
  return url.replace(TRAILING_PUNCTUATION, "");
}

/** The first http(s) URL in a text blob, or null when there is none. */
export function extractFirstUrl(text: string): string | null {
  const match = text.match(URL_PATTERN);
  const raw = match?.[0];
  if (!raw) return null;
  return trimTrailingPunctuation(raw);
}

/** Up to `max` unique http(s) URLs from a text blob, in order of appearance. */
export function extractUrls(text: string, max = 4): string[] {
  if (max <= 0) return [];
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN_ALL)) {
    const url = trimTrailingPunctuation(match[0] ?? "");
    if (url && !seen.has(url)) {
      seen.add(url);
      if (seen.size >= max) break;
    }
  }
  return [...seen];
}

export interface LinkPreviewProps {
  /** Absolute http(s) URL the card points at. Unsafe values (non-http/https)
   *  render the same card as inert text — never an anchor. */
  href: string;
  /** Card title. Defaults to the URL host, then the raw href. */
  title?: string;
  /** Short summary under the title (clamped to two lines). */
  description?: string;
  /** Preview image; its frame is removed entirely when the image fails to load. */
  image?: string;
  /** Alt text for the preview image. */
  imageAlt?: string;
  /** Publisher name in the site row. Defaults to the URL host. */
  siteName?: string;
  /** 16px site icon; falls back to the site initial when missing or broken. */
  favicon?: string;
  /** "card" — image above the body (default); "compact" — leading 64px thumbnail. */
  layout?: "card" | "compact";
  className?: string;
}

export function LinkPreview({
  href,
  title,
  description,
  image,
  imageAlt = "",
  siteName,
  favicon,
  layout = "card",
  className,
  ...props
}: LinkPreviewProps & Omit<React.ComponentPropsWithoutRef<"article">, "title">) {
  // Parse strictly — anything that does not yield an http(s) URL renders
  // inert (the assistant-ui unsafe-URL handling).
  let parsed: URL | null = null;
  try {
    parsed = new URL(href);
  } catch {
    parsed = null;
  }
  const isLinkable =
    parsed !== null && (parsed.protocol === "http:" || parsed.protocol === "https:");

  // Missing title/siteName fall back to the URL host, then the raw href.
  const host = parsed?.hostname ?? null;
  const resolvedTitle = title ?? host ?? href;
  const resolvedSite = siteName ?? host ?? href;
  const siteInitial = resolvedSite.trim().charAt(0).toUpperCase() || "?";

  // Broken media is remembered per-src, so swapping in a new src re-attempts.
  const [brokenImageSrc, setBrokenImageSrc] = React.useState<string | null>(null);
  const [brokenFaviconSrc, setBrokenFaviconSrc] = React.useState<string | null>(null);

  return (
    <article
      data-slot="link-preview"
      data-layout={layout}
      className={cn(
        "relative w-full max-w-md overflow-hidden rounded-xl border border-border bg-secondary/60",
        "transition-shadow hover:shadow-sm",
        layout === "compact" && "flex items-stretch",
        className,
      )}
      {...props}
    >
      {image != null && brokenImageSrc !== image && (
        // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/no-noninteractive-element-interactions -- arbitrary remote preview URLs can't go through next/image; onError is a load-failure handler, not an interaction.
        <img
          src={image}
          alt={imageAlt}
          loading="lazy"
          onError={() => setBrokenImageSrc(image)}
          className={
            layout === "card"
              ? "aspect-[16/9] w-full rounded-t-xl object-cover"
              : "h-16 w-16 shrink-0 rounded-l-xl object-cover"
          }
        />
      )}
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-1",
          layout === "compact" ? "py-2.5 pr-3 pl-3" : "p-4",
        )}
      >
        {/* Site row — favicon (or the site's initial) + publisher name. */}
        <div className="flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground">
          {favicon != null && brokenFaviconSrc !== favicon ? (
            // eslint-disable-next-line @next/next/no-img-element -- 16px remote site icon, fail-soft to the site initial.
            <img
              src={favicon}
              alt=""
              aria-hidden="true"
              loading="lazy"
              onError={() => setBrokenFaviconSrc(favicon)}
              className="h-4 w-4 shrink-0 rounded-[4px] object-cover"
            />
          ) : (
            <span
              aria-hidden="true"
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] bg-muted font-mono text-[9px] font-semibold text-muted-foreground"
            >
              {siteInitial}
            </span>
          )}
          <span className="truncate">{resolvedSite}</span>
        </div>

        {/* The title is the anchor when — and only when — the URL is http(s).
            Its ::after stretches across the whole card so the hit target
            covers it while the visible text stays a quiet editorial line. */}
        {isLinkable ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-foreground after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
          >
            {resolvedTitle}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : (
          <span className="text-sm font-medium text-foreground">{resolvedTitle}</span>
        )}

        {description ? (
          <p className="line-clamp-2 text-xs leading-relaxed break-words text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
    </article>
  );
}
