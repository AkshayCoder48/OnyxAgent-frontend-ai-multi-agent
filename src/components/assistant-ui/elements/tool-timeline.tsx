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
            <span className="text-sm font-medium text-foreground/90">{restingLabel}</span>
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
        </div>
      </CollapsePanel>
    </div>
  );
}
