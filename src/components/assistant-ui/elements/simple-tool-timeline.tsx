"use client";

import * as React from "react";
import { Check, ChevronRight, FileText, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { CollapsePanel, ShimmerLabel } from "./surfaces";
import type { FriendlyStep } from "@/lib/agent-friendly-steps";

/**
 * SimpleToolTimeline — the tool timeline retold as plain sentences for the
 * "simple" display mode. Same anatomy as `ToolTimeline` (one collapsed line
 * expanding into a vertical trace), but every step reads as a finished
 * sentence with a checkmark, the in-flight step narrates in present tense
 * with a spinner, and file changes collapse to one human line ("Updated 3
 * files") instead of git-style +/- stat chips. No tool names, no mono
 * chips, no code — friendly for people who don't read code.
 */
export interface SimpleToolTimelineProps {
  steps: readonly FriendlyStep[];
  streaming: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restingLabel: string;
  activeLabel: string;
  /** Distinct files the run changed — renders one "Updated N files" line
   *  when > 0, and nothing otherwise. */
  filesChanged: number;
  className?: string;
}

export function SimpleToolTimeline({
  steps,
  streaming,
  open,
  onOpenChange,
  restingLabel,
  activeLabel,
  filesChanged,
  className,
}: SimpleToolTimelineProps) {
  return (
    <div data-slot="simple-tool-timeline" className={cn("max-w-md", className)}>
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
      <CollapsePanel open={open}>
        <div className="space-y-1 px-6 pt-1 pb-2">
          {steps.map((step, i) => {
            // Only the LAST step can be in flight, and only while streaming.
            const running = streaming && i === steps.length - 1;
            return (
              <div key={i} className="flex min-h-6 items-baseline gap-2 py-0.5 text-sm">
                {running ? (
                  <Loader2
                    className="h-3.5 w-3.5 shrink-0 translate-y-0.5 animate-spin text-primary"
                    aria-hidden
                  />
                ) : (
                  <Check className="h-3.5 w-3.5 shrink-0 translate-y-0.5 text-primary/70" aria-hidden />
                )}
                {running ? (
                  <ShimmerLabel className="text-sm font-medium">{step.present}</ShimmerLabel>
                ) : (
                  <span className="text-sm text-foreground/80">
                    {step.past}
                    {step.detail && (
                      <>
                        {" "}
                        <span className="text-foreground/55">{step.detail}</span>
                      </>
                    )}
                  </span>
                )}
              </div>
            );
          })}
          {filesChanged > 0 && (
            <div className="flex min-h-6 items-baseline gap-2 py-0.5 pt-1.5 text-sm">
              <FileText className="h-3.5 w-3.5 shrink-0 translate-y-0.5 text-muted-foreground" aria-hidden />
              <span className="text-sm text-foreground/70">
                Updated {filesChanged} {filesChanged === 1 ? "file" : "files"}
              </span>
            </div>
          )}
        </div>
      </CollapsePanel>
    </div>
  );
}
