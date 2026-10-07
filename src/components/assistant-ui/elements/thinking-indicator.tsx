"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * ThinkingIndicator — the assistant-ui "Thinking indicator" element
 * (elements-thinking-indicator recipe): a pulsing dot, a status label that
 * FADES IN once when it changes, and an optional preformatted elapsed badge.
 *
 * Per the Realtime PRD the status text is STATIC — no phrase cycling, no
 * per-word shimmer/scramble. Liveness is carried by the dot (and the
 * companion), not by animating the words themselves. `showDot` hides the
 * leading dot when a glyph (chevron, orb) already leads the line.
 */
export function ThinkingIndicator({
  label,
  elapsed,
  showDot = true,
  className,
  ...props
}: {
  /** Status text — a change fades the new label in once. */
  label: string;
  /** Preformatted elapsed time shown after the label. Omit to hide the badge. */
  elapsed?: string;
  /** Hide the leading pulsing dot when another glyph leads the line. */
  showDot?: boolean;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "children">) {
  return (
    <div
      data-slot="thinking-indicator"
      className={cn("flex h-7 min-w-0 items-center gap-2.5", className)}
      {...props}
    >
      {/* Pulsing dot — brand primary (omitted when another glyph already
          leads the line so the two never double up). */}
      {showDot && (
        <span
          aria-hidden
          className="bg-primary inline-block h-2 w-2 shrink-0 animate-pulse rounded-full motion-reduce:animate-none"
        />
      )}
      {/* STATIC status text — keyed on its own content so a NEW status
          (Thinking → Working) fades in once, then sits still. leading-snug
          keeps descenders visible inside overflow-hidden rows. */}
      <span
        key={label}
        className="text-muted-foreground animate-in fade-in duration-300 min-w-0 text-sm leading-snug motion-reduce:animate-none"
      >
        {label}
      </span>
      {elapsed !== undefined && (
        <span className="text-foreground/70 bg-muted inline-flex shrink-0 items-center rounded-md border border-border px-1.5 py-0.5 font-mono text-[10px] tabular-nums leading-none">
          {elapsed}
        </span>
      )}
    </div>
  );
}
