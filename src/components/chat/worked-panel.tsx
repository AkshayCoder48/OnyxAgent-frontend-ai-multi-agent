"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDuration } from "./tool-duration";

/**
 * WorkedPanel — the post-generation collapse panel (PRD §§12–22).
 *
 * When a generation settles, ALL of its activity (thinking, tool calls,
 * intermediate text — the exact events that streamed live) collapses into
 * ONE expandable panel:
 *
 *   ┌──────────────────────────────┐
 *   │  Worked 18s                ˅ │
 *   └──────────────────────────────┘
 *
 * Expanded, it reveals the REAL streamed events (the existing event
 * renderers — RoundPanels, tool cards, thinking blocks — not summaries or
 * reconstructions), in their exact chronological order. The final
 * user-facing answer renders OUTSIDE (below) the panel.
 *
 * Design notes:
 *  - Collapsed by default; expansion state is LOCAL component state — the
 *    panel never auto-reopens on navigation, rerenders, chat switching or
 *    streaming-state updates (PRD §19).
 *  - Failed generations keep their work: the label gains "· Failed" and
 *    the work history stays inspectable (PRD §22).
 *  - Uses the app's framer-motion motion language (same easing curve as
 *    the sidebar/panels) — no setTimeout hacks.
 */

export function WorkedPanel({
  durationMs,
  failed,
  stopped,
  children,
  className,
}: {
  /** Generation duration in ms (message.generation.durationMs, or derived
   *  from part timestamps for legacy rows). */
  durationMs?: number | null;
  /** True when the generation ended in an error. */
  failed?: boolean;
  /** True when the user stopped the generation mid-flight. */
  stopped?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const [expanded, setExpanded] = React.useState(false);

  const durationLabel = durationMs != null && durationMs > 0 ? formatDuration(durationMs) : null;
  const label =
    durationLabel != null
      ? `Worked ${durationLabel}`
      : stopped
        ? "Worked"
        : "Worked";

  return (
    <div className={cn("worked-panel w-full", className)}>
      {/* ONE trigger line — expands into the generation's real events. */}
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${label}${failed ? " (generation failed)" : ""}${stopped ? " (stopped by user)" : ""} — ${expanded ? "collapse" : "expand"} work details`}
        onClick={() => setExpanded((o) => !o)}
        className={cn(
          "hover:bg-accent/50 flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left transition-colors",
        )}
      >
        <ChevronRight
          className={cn(
            "text-muted-foreground h-3.5 w-3.5 shrink-0 transition-transform duration-200",
            expanded && "rotate-90",
          )}
          aria-hidden
        />
        <span className="text-sm font-medium text-foreground/90">{label}</span>
        {failed && (
          <span className="text-destructive text-destructive/80 text-sm font-medium">
            · Failed
          </span>
        )}
        {!failed && stopped && (
          <span className="text-muted-foreground text-sm font-medium">· Stopped</span>
        )}
      </button>

      {/* The REAL generation events — the same renderers the live stream
          used, revealed exactly as they streamed (never re-ordered, never
          summarized away). Animated open/close with the app's motion
          language; content unmounts when collapsed (settled cards carry no
          live state, so nothing is lost). */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="worked-panel-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-1 space-y-2">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Derive the generation duration for a settled assistant message:
 * prefers the persisted `generation` summary; falls back to the earliest
 * start stamp → latest end stamp across the message's parts (round stamps,
 * reasoning settlement stamps, tool call start/end stamps). Legacy rows
 * without any stamps return null (the panel just says "Worked").
 */
export function deriveGenerationDurationMs(
  message: import("@/types/chat").ChatMessage,
): number | null {
  const g = message.generation;
  if (g && typeof g.durationMs === "number" && g.durationMs > 0) return g.durationMs;

  let start: number | undefined;
  let end: number | undefined;
  const considerStart = (t: number | undefined) => {
    if (t !== undefined && (start === undefined || t < start)) start = t;
  };
  const considerEnd = (t: number | undefined) => {
    if (t !== undefined && (end === undefined || t > end)) end = t;
  };
  for (const p of message.parts ?? []) {
    considerStart(p.roundStartedAt);
    considerEnd(p.roundEndedAt);
    considerEnd(p.reasoningEndedAt);
    considerStart(p.toolCall?.startedAt);
    considerEnd(p.toolCall?.endedAt);
  }
  if (start === undefined || end === undefined || end <= start) return null;
  return end - start;
}
