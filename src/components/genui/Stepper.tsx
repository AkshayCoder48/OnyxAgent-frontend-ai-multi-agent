"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { GenUIComponentProps, str, num, arr, obj } from "./helpers";

interface Step {
  title?: string;
  description?: string;
}

/**
 * `stepper` — numbered horizontal/vertical progress.
 *
 * Props:
 *   - title (string)
 *   - current (number) — 1-indexed current step (steps before = done, after = pending)
 *   - steps (Array<{ title, description }>)
 */
export function Stepper({ props, streaming }: GenUIComponentProps) {
  const title = str(props.title);
  const current = num(props.current, 0);
  const stepsRaw = arr<Record<string, unknown>>(props.steps);
  const steps: Step[] = stepsRaw.map((s) => {
    const o = obj(s);
    return { title: str(o.title), description: str(o.description) };
  });

  if (streaming && steps.length === 0) {
    return (
      <div className="py-1">
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="shimmer h-6 w-6 rounded-full" />
              <div className="shimmer h-3 w-32 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (steps.length === 0) return null;

  return (
    <div>
      {title && <h3 className="text-foreground mb-3 text-sm font-semibold">{title}</h3>}
      <ol className="space-y-2">
        {steps.map((s, i) => {
          const stepNum = i + 1;
          const isDone = current > stepNum || (current === 0 && false);
          const isCurrent = current === stepNum;
          const isPending = current < stepNum && current !== 0;
          return (
            <li key={i} className="flex items-start gap-3">
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  isDone && "bg-primary text-primary-foreground",
                  isCurrent && "bg-primary/15 text-primary ring-2 ring-primary/30",
                  isPending && "bg-muted text-muted-foreground",
                )}
              >
                {isDone ? <Check className="h-3.5 w-3.5" /> : stepNum}
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                {s.title && (
                  <div className={cn("text-sm font-medium", isPending ? "text-muted-foreground" : "text-foreground")}>
                    {s.title}
                  </div>
                )}
                {s.description && (
                  <div className="text-muted-foreground text-xs leading-relaxed">{s.description}</div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export default Stepper;
