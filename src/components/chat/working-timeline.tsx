"use client";

import * as React from "react";
import { ToolTimeline } from "@/components/assistant-ui/elements/tool-timeline";
import { deriveTimeline } from "@/lib/agent-tool-steps";
import type { ToolCall } from "@/types";
import { formatDuration } from "./tool-duration";

/**
 * WorkingTimeline — the ONE "working" UI for a whole agent generation,
 * built directly on the assistant-ui `ToolTimeline` element.
 *
 * User spec: "add this when AI is working — tool calling, thinking and etc
 * … the whole process should be in this working's UI, not only steps."
 *
 * While the agent works, EVERYTHING (thinking, tool calls, intermediate
 * text — the real event renderers) lives inside ONE disclosure:
 *
 *   ┌────────────────────────────────────┐
 *   │  ˅ Working            (shimmering) │   ← live
 *   │    ─ step trace: verb · chip · ⋯   │
 *   │    ─ file-change stats             │
 *   │    ─ PROCESS ─────────────────     │
 *   │      thinking blocks · tool cards  │
 *   │      · intermediate text           │
 *   └────────────────────────────────────┘
 *   Final answer streams BELOW, outside the panel.
 *
 * When the generation settles it collapses to ONE resting line —
 * `Worked 18s · 3 steps · 1 file changed` (`· Failed` / `· Stopped` when
 * the run ended badly) — and expands back into the SAME real events
 * (never summaries). Expansion after settle is purely user-driven; it
 * never auto-reopens on rerenders, chat switches or refreshes.
 */
export function WorkingTimeline({
  toolCalls,
  streaming,
  durationMs,
  failed,
  stopped,
  children,
  className,
}: {
  /** Every tool call of this generation, in chronological order (the step
   *  trace + file stats are derived from them). */
  toolCalls: readonly ToolCall[];
  /** True while this generation is live. */
  streaming: boolean;
  /** Generation duration in ms (message.generation.durationMs, or derived
   *  from part timestamps for legacy rows). */
  durationMs?: number | null;
  /** True when the generation ended in an error. */
  failed?: boolean;
  /** True when the user stopped the generation mid-flight. */
  stopped?: boolean;
  /** The FULL process — real event renderers (thinking, tool cards,
   *  intermediate text). */
  children: React.ReactNode;
  className?: string;
}) {
  const { steps, stats, filesChanged } = React.useMemo(
    () => deriveTimeline(toolCalls),
    [toolCalls],
  );

  // ── Open-state machine ─────────────────────────────────────────────────
  //  - Streaming: EXPANDED (the live view of the whole process). The user
  //    may manually collapse — their intent wins until the stream settles.
  //  - On settle: collapse to the resting label. Afterwards expansion is
  //    user-driven only (never auto-reopens).
  const [userOpen, setUserOpen] = React.useState(false);
  const [manualClose, setManualClose] = React.useState(false);
  const prevStreamingRef = React.useRef(streaming);
  React.useEffect(() => {
    if (prevStreamingRef.current && !streaming) {
      // Just settled → collapse (fresh state for any later re-expansion).
      setUserOpen(false);
      setManualClose(false);
    }
    prevStreamingRef.current = streaming;
  }, [streaming]);

  const open = streaming ? !manualClose : userOpen;
  const onOpenChange = React.useCallback(
    (next: boolean) => {
      if (streaming) setManualClose(!next);
      else setUserOpen(next);
    },
    [streaming],
  );

  // ── Labels ──────────────────────────────────────────────────────────────
  const durationLabel =
    durationMs != null && durationMs > 0 ? formatDuration(durationMs) : null;
  const restingParts: string[] = [
    durationLabel ? `Worked ${durationLabel}` : "Worked",
  ];
  if (steps.length > 0) restingParts.push(`${steps.length} step${steps.length === 1 ? "" : "s"}`);
  if (filesChanged > 0)
    restingParts.push(`${filesChanged} file${filesChanged === 1 ? "" : "s"} changed`);
  const restingLabel = restingParts.join(" · ");

  return (
    <ToolTimeline
      steps={steps}
      visibleSteps={steps.length}
      streaming={streaming}
      open={open}
      onOpenChange={onOpenChange}
      restingLabel={restingLabel}
      activeLabel="Working"
      stats={stats}
      childrenLabel="Process"
      failed={failed}
      stopped={stopped}
      className={className ?? "w-full max-w-none"}
    >
      {children}
    </ToolTimeline>
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
