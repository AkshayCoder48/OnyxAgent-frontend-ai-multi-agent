"use client";

import * as React from "react";
import { MoveRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { paperCardClass } from "./surfaces";

/**
 * AgentHandoff — control passing between agents, with the reason and what
 * came along: which agent had it, which has it now, why, and what context
 * carried over (assistant-ui `elements-agent-handoff` recipe, Terra
 * retheme; "in transit" tint uses terracotta instead of blue).
 */
export function AgentHandoff({
  from,
  to,
  reason,
  carried,
  settled,
  className,
  ...props
}: {
  from: string;
  to: string;
  reason: string;
  carried: readonly string[];
  settled: boolean;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "children">) {
  return (
    <div
      data-slot="agent-handoff"
      className={cn("max-w-md gap-2.5 p-3", paperCardClass, "flex flex-col", className)}
      {...props}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-medium transition-all duration-500",
            settled ? "text-muted-foreground opacity-60" : "text-foreground",
          )}
        >
          {from}
        </span>
        <MoveRight
          className={cn(
            "h-4 w-4 shrink-0 transition-colors duration-500",
            settled ? "text-muted-foreground/50" : "text-primary",
          )}
        />
        <span
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-all duration-500",
            settled
              ? "border-border bg-muted text-foreground"
              : "border-primary/30 bg-primary/10 text-primary",
          )}
        >
          {to}
        </span>
      </div>
      <p className="text-sm text-foreground/75">{reason}</p>
      {carried.length > 0 && (
        <div>
          <p className="mb-1 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
            Carried over
          </p>
          <ul className="space-y-0.5">
            {carried.map((item, i) => (
              <li key={i} className="text-xs text-foreground/70">
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
