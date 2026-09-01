"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { ShimmerLabel } from "./surfaces";

/**
 * ThinkingIndicator — a live status line that names what the agent is doing
 * right now, with elapsed time (assistant-ui `elements-thinking-indicator`
 * recipe).
 *
 * A pulsing dot, a label that fades in fresh every time it changes, and an
 * optional elapsed-time badge. The label keys its inner span on the string
 * itself, so changing `label` replays the shimmer / slide-in on the new text.
 *
 * Anatomy (per the reference): a root div with three spans — the pulsing
 * dot, the label (ShimmerLabel), and the elapsed badge when supplied.
 *
 * `showDot` (default true) hides the leading dot when the line is led by an
 * Orb glyph instead — both indicators then share one baseline via the fixed
 * row height, keeping the label vertically aligned with the orb's lattice.
 */
export function ThinkingIndicator({
  label,
  elapsed,
  showDot = true,
  className,
  ...props
}: {
  /** Status text; changing it replays the fade-in. */
  label: string;
  /** Preformatted elapsed time shown after the label. Omit to hide the badge. */
  elapsed?: string;
  /** Hide the leading pulsing dot when an Orb leads the line. */
  showDot?: boolean;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "children">) {
  return (
    <div
      data-slot="thinking-indicator"
      className={cn("flex h-7 min-w-0 items-center gap-2.5", className)}
      {...props}
    >
      {/* Pulsing dot — fixed to the reference blue; omitted when an Orb
          already leads the line so the two indicators never double up. */}
      {showDot && (
        <span
          aria-hidden
          className="inline-block h-2 w-2 shrink-0 rounded-full bg-blue-500 animate-pulse"
        />
      )}
      {/* Label — keyed on its own content so a new value replays the fade */}
      <span key={label} className="min-w-0 truncate text-sm leading-none">
        <ShimmerLabel>{label}</ShimmerLabel>
      </span>
      {elapsed !== undefined && (
        <span className="inline-flex shrink-0 items-center rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums leading-none text-foreground/70">
          {elapsed}
        </span>
      )}
    </div>
  );
}
