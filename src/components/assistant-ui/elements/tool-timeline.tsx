"use client";

import * as React from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { chipClass, CollapsePanel, DeltaChip, ShimmerLabel } from "./surfaces";

export interface TimelineStep {
  verb: string;
  chip: string;
  icon: LucideIcon;
}

export interface TimelineStat {
  file: string;
  added?: number;
  removed?: number;
}

/**
 * ToolTimeline — a whole working session summarized as verbs, targets, and
 * file stats. One collapsed line expands into a vertical trace: a verb, an
 * icon, and a chip per step, ending in a row of file-change stats
 * (assistant-ui `elements-tool-timeline` recipe, Terra retheme).
 *
 * EXTENDED for the OnyxAgent "working" UI: `children` renders the FULL
 * process (the real event renderers — thinking blocks, tool cards,
 * intermediate text) below the step trace, behind the same disclosure, so
 * the whole run lives in ONE working panel. `failed` / `stopped` add
 * status suffixes to the resting label.
 */
export function ToolTimeline({
  steps,
  visibleSteps,
  streaming,
  open,
  onOpenChange,
  restingLabel,
  activeLabel,
  stats,
  className,
  embedded,
  children,
  childrenLabel,
  failed,
  stopped,
}: {
  steps: readonly TimelineStep[];
  visibleSteps: number;
  streaming: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restingLabel: string;
  activeLabel: string;
  stats: TimelineStat[];
  className?: string;
  /** Embedded (e.g. inside the timeline sidebar): hide the collapse trigger
   *  and always show the trace — the host provides its own header. */
  embedded?: boolean;
  /** The FULL process — real event renderers shown below the step trace
   *  inside the same disclosure (the "whole working session" view). */
  children?: React.ReactNode;
  /** Micro-label above the children section (e.g. "Process"). */
  childrenLabel?: string;
  /** Adds a "· Failed" suffix to the resting label. */
  failed?: boolean;
  /** Adds a "· Stopped" suffix to the resting label. */
  stopped?: boolean;
}) {
  const shown = Math.max(0, Math.min(Math.floor(visibleSteps) || 0, steps.length));

  return (
    <div data-slot="tool-timeline" className={cn("max-w-md", className)}>
      {embedded ? null : (
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-sm transition-colors hover:bg-accent/50"
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
              open && "rotate-90",
            )}
          />
          {streaming ? (
            <ShimmerLabel className="text-sm font-medium">{activeLabel}</ShimmerLabel>
          ) : (
            <>
              <span className="text-sm font-medium text-foreground/90">{restingLabel}</span>
              {failed && (
                <span className="text-sm font-medium text-destructive/90">· Failed</span>
              )}
              {!failed && stopped && (
                <span className="text-sm font-medium text-muted-foreground">· Stopped</span>
              )}
            </>
          )}
        </button>
      )}
      <CollapsePanel open={embedded ? true : open}>
        <div className="space-y-1 px-6 pt-1 pb-2">
          {Array.from({ length: shown }, (_, i) => {
            const step = steps[i]!;
            const isLast = i === shown - 1;
            const Icon = step.icon;
            return (
              <div key={i} className="flex items-center gap-2 py-0.5 text-sm">
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {streaming && isLast ? (
                  <ShimmerLabel className="text-sm">{step.verb}</ShimmerLabel>
                ) : (
                  <span className="text-sm text-foreground/80">{step.verb}</span>
                )}
                <span className={chipClass}>{step.chip}</span>
              </div>
            );
          })}
          {stats.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1.5">
              {stats.map((stat) => (
                <span key={stat.file} className="inline-flex items-center gap-1.5">
                  <span className="font-mono text-[11px] text-foreground/75">{stat.file}</span>
                  {stat.added !== undefined && <DeltaChip value={stat.added} kind="added" />}
                  {stat.removed !== undefined && <DeltaChip value={stat.removed} kind="removed" />}
                </span>
              ))}
            </div>
          )}
          {/* The FULL process — the real event renderers (thinking, tool
              cards, intermediate text) below the summarized trace. */}
          {children ? (
            <div className="border-border/70 mt-2 border-t pt-2">
              {childrenLabel ? (
                <p className="text-muted-foreground mb-1.5 font-mono text-[10px] tracking-wider uppercase">
                  {childrenLabel}
                </p>
              ) : null}
              <div className="space-y-1.5">{children}</div>
            </div>
          ) : null}
        </div>
      </CollapsePanel>
    </div>
  );
}
