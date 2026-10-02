"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { ReasoningText } from "@/components/ui/reasoning-text";

/**
 * ThinkingIndicator — a live status line that names what the agent is doing
 * right now, with elapsed time (assistant-ui `elements-thinking-indicator`
 * recipe).
 *
 * Upgraded with the ReasoningText engine (beui.dev loading-states): the
 * label now cycles through follow-up phrases (Reading the context →
 * Connecting the details → Forming a response) and the phrase transition
 * rotates through EVERY variant — cascade (character-by-character rise) →
 * swap (slide fade) → scramble (glyph shuffle) — so the working text has
 * more moves than a single shimmer. The live `label` is always phrase #1,
 * so a fresh status (e.g. "Browsing the web") still leads the rotation.
 *
 * `showDot` (default true) hides the leading dot when the line is led by an
 * Orb glyph instead — both indicators then share one baseline via the fixed
 * row height, keeping the label vertically aligned with the orb's lattice.
 */

/** Default follow-up phrases cycled after the live label. */
const FOLLOW_UP_PHRASES = [
  "Reading the context",
  "Connecting the details",
  "Forming a response",
];

export function ThinkingIndicator({
  label,
  elapsed,
  showDot = true,
  phrases,
  variant = "auto",
  interval = 1800,
  className,
  ...props
}: {
  /** Status text; changing it replays the rotation from the new label. */
  label: string;
  /** Preformatted elapsed time shown after the label. Omit to hide the badge. */
  elapsed?: string;
  /** Hide the leading pulsing dot when an Orb leads the line. */
  showDot?: boolean;
  /** Extra phrases cycled after the live label. Defaults to the beui set. */
  phrases?: string[];
  /** Phrase-transition animation. "auto" rotates cascade → swap → scramble. */
  variant?: "auto" | "cascade" | "swap" | "scramble";
  /** Milliseconds each phrase remains visible. */
  interval?: number;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "children">) {
  return (
    <div
      data-slot="thinking-indicator"
      className={cn("flex h-7 min-w-0 items-center gap-2.5", className)}
      {...props}
    >
      {/* Pulsing dot — brand cyan (omitted when an Orb already leads the
          line so the two indicators never double up). */}
      {showDot && (
        <span
          aria-hidden
          className="bg-primary inline-block h-2 w-2 shrink-0 animate-pulse rounded-full"
        />
      )}
      {/* Label — keyed on its own content so a new live status restarts the
          phrase rotation + variant cycle from the fresh label. leading-snug
          (NOT leading-none): the phrase sizer row is overflow-hidden, and at
          line-height 1 the descenders of g/y/p were clipped — the "caption
          text cut off a bit" fix. */}
      <span key={label} className="text-muted-foreground min-w-0 text-sm leading-snug">
        <ReasoningText
          phrases={[label, ...(phrases ?? FOLLOW_UP_PHRASES)]}
          variant={variant}
          interval={interval}
          indicator={null}
          className="leading-snug"
        />
      </span>
      {elapsed !== undefined && (
        <span className="text-foreground/70 bg-muted inline-flex shrink-0 items-center rounded-md border border-border px-1.5 py-0.5 font-mono text-[10px] tabular-nums leading-none">
          {elapsed}
        </span>
      )}
    </div>
  );
}
