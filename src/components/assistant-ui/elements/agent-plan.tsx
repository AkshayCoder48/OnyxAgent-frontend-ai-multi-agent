"use client";

import * as React from "react";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { paperCardClass } from "./surfaces";

/**
 * AgentPlan — a checklist the agent works through, with progress you can
 * glance at: a header count, a progress bar, and each step marked done,
 * active, or ahead (assistant-ui `elements-agent-plan` recipe, Terra
 * retheme; active state uses the terracotta brand color).
 */
export function AgentPlan({
  steps,
  activeIndex,
  className,
  ...props
}: {
  steps: readonly string[];
  activeIndex: number;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "children">) {
  const clamped = Number.isNaN(activeIndex)
    ? 0
    : Math.max(0, Math.min(activeIndex, steps.length));
  const allDone = clamped >= steps.length && steps.length > 0;
  const doneCount = steps.length === 0 ? 0 : Math.min(clamped, steps.length);

  return (
    <div
      data-slot="agent-plan"
      className={cn("max-w-md gap-3 p-3", paperCardClass, "flex flex-col", className)}
      {...props}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          Plan
        </span>
        <span className="font-mono text-[10px] tabular-nums text-foreground/70">
          {doneCount} of {steps.length}
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-foreground/8">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
          style={{ width: steps.length === 0 ? "0%" : `${(doneCount / steps.length) * 100}%` }}
        />
      </div>
      <ul className="space-y-1.5">
        {steps.map((step, i) => {
          const done = i < clamped || allDone;
          const active = !done && i === clamped;
          return (
            <li key={i} className="flex items-center gap-2 text-sm">
              {done ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-label="Done" />
              ) : active ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
              ) : (
                <span className="ml-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/25" />
              )}
              <span
                className={cn(
                  done
                    ? "text-muted-foreground line-through"
                    : active
                      ? "text-foreground"
                      : "text-foreground/60",
                )}
              >
                {step}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
