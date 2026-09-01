"use client";

import * as React from "react";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { chipClass, CollapsePanel, fieldBlockClass, ShimmerLabel } from "./surfaces";

/**
 * ToolCall — one tool invocation with its request and result tucked behind
 * a disclosure. Collapses to one line while it works: a chevron, a
 * shimmering label, and the tool's primary argument as a chip, with a
 * checkmark once it settles (assistant-ui `elements-tool-call` recipe,
 * re-themed to the Terra palette).
 */
export function ToolCall({
  label,
  activeLabel,
  query,
  request,
  result,
  running,
  open,
  onOpenChange,
  className,
}: {
  label: string;
  activeLabel: string;
  query: string;
  request: string;
  result: string;
  running: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}) {
  return (
    <div data-slot="tool-call" className={cn("max-w-md", className)}>
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
        {running ? (
          <ShimmerLabel className="text-sm font-medium">{activeLabel}</ShimmerLabel>
        ) : (
          <span className="text-sm font-medium text-foreground/90">{label}</span>
        )}
        <span className={cn(chipClass, "ml-1")}>{query}</span>
        <span className="ml-auto inline-flex h-4 w-4 items-center justify-center">
          {!running && <Check className="h-3.5 w-3.5 text-primary" aria-label="Done" />}
        </span>
      </button>
      <CollapsePanel open={open}>
        <div className="space-y-2 px-6 pt-1 pb-2">
          <div>
            <p className="mb-1 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
              Request
            </p>
            <div className={fieldBlockClass}>{request}</div>
          </div>
          <div className="border-t border-border/70" />
          <div>
            <p className="mb-1 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
              Result
            </p>
            <div className={fieldBlockClass}>{result}</div>
          </div>
        </div>
      </CollapsePanel>
    </div>
  );
}
