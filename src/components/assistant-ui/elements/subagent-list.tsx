"use client";

import * as React from "react";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { paperCardClass } from "./surfaces";

export interface SubagentItem {
  name: string;
  model: string;
}

function AgentRow({
  item,
  done,
  running,
  percent,
}: {
  item: SubagentItem;
  done: boolean;
  running: boolean;
  percent: number;
}) {
  const pct = Number.isNaN(percent) ? 0 : Math.max(0, Math.min(100, percent ?? 0));
  return (
    <div className={cn("flex items-center gap-3 px-3 py-2.5", paperCardClass)}>
      {done ? (
        <Check className="h-4 w-4 shrink-0 text-primary" aria-label="Done" />
      ) : (
        <Loader2
          className={cn(
            "h-4 w-4 shrink-0 text-primary",
            running && "animate-spin",
            !running && "opacity-40",
          )}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground/90">{item.name}</span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {item.model}
          </span>
        </div>
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-foreground/8">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * SubagentList — parallel workers with their own progress, models, and
 * completions, plus an optional trailing card for a synthesis step
 * (assistant-ui `elements-subagent-list` recipe, Terra retheme).
 */
export function SubagentList({
  agents,
  completedCount,
  progress,
  showSummary,
  summaryAgent,
  className,
  ...props
}: {
  agents: readonly SubagentItem[];
  completedCount: number;
  progress: readonly number[];
  showSummary: boolean;
  summaryAgent: SubagentItem;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "children">) {
  return (
    <div
      data-slot="subagent-list"
      className={cn("flex max-w-sm flex-col gap-2", className)}
      {...props}
    >
      {agents.map((agent, i) => (
        <AgentRow
          key={agent.name}
          item={agent}
          done={i < completedCount}
          running={i === completedCount}
          percent={progress[i] ?? 0}
        />
      ))}
      {showSummary && (
        <div
          className={cn(
            "flex items-center gap-3 px-3 py-2.5 opacity-70",
            paperCardClass,
          )}
        >
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground/90">
                {summaryAgent.name}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {summaryAgent.model}
              </span>
            </div>
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-foreground/8">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-primary/60" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
