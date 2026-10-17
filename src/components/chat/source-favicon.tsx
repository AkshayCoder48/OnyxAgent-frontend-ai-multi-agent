"use client";

import { memo, useState } from "react";
import { FileText, Globe } from "lucide-react";
import { faviconForUrl } from "@/lib/chat-sources";
import { cn } from "@/lib/utils";

/**
 * SourceFavicon — the real site logo for a web source, rendered from the
 * Google S2 favicon service. Falls back to a Globe glyph when the URL has
 * no http(s) origin or the image fails to load; RAG sources (no url) fall
 * back to a document glyph.
 *
 * Memoized on (url, kind, className) — it renders inside the CitationsFooter
 * list which re-renders per streamed token while an answer streams.
 */
export const SourceFavicon = memo(function SourceFavicon({
  url,
  kind = "web",
  className,
  iconClassName,
}: {
  url?: string;
  kind?: "web" | "rag";
  className?: string;
  iconClassName?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = faviconForUrl(url);

  // No usable URL (RAG chunk) or the image 404'd/network-failed → glyph.
  if (!src || failed) {
    const Glyph = kind === "rag" ? FileText : Globe;
    return (
      <Glyph
        aria-hidden
        className={cn("text-foreground/40 h-3.5 w-3.5 shrink-0", iconClassName)}
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- remote favicon CDN, not a static asset; next/image brings no benefit at 16px
    <img
      src={src}
      alt=""
      role="presentation"
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn(
        "h-3.5 w-3.5 shrink-0 rounded-sm object-contain",
        // Subtle ring so light favicons stay visible on dark backgrounds
        // and vice-versa.
        "ring-foreground/10 ring-1",
        className,
      )}
    />
  );
});
