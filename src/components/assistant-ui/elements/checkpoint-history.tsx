"use client";

import * as React from "react";
import { History } from "lucide-react";
import { cn } from "@/lib/utils";
import { paperCardClass } from "./surfaces";

export interface Checkpoint {
  id: string;
  label: string;
  at: string;
  files: number;
}

/**
 * CheckpointHistory — points you can fall back to, with what each one
 * would give back. Plain list with one entry marked current; restoring is
 * a callback you wire up (assistant-ui `elements-checkpoint-history`
 * recipe, Terra retheme).
 */
export function CheckpointHistory({
  checkpoints,
  currentId,
  onRestore,
  className,
  ...props
}: {
  checkpoints: readonly Checkpoint[];
  currentId: string;
  onRestore?: (id: string) => void;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "children">) {
  const currentIndex = checkpoints.findIndex((c) => c.id === currentId);

  return (
    <div
      data-slot="checkpoint-history"
      className={cn("max-w-md gap-1 overflow-hidden", paperCardClass, "flex flex-col", className)}
      {...props}
    >
      <span className="px-3 pt-3 pb-1 font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
        Checkpoints
      </span>
      <div className="pb-1.5">
        {checkpoints.map((cp, i) => {
          const isCurrent = cp.id === currentId;
          const isAhead = currentIndex >= 0 && i > currentIndex;
          return (
            <div
              key={cp.id}
              className={cn(
                "group flex items-center gap-3 px-3 py-1.5",
                isCurrent && "bg-accent",
                isAhead && "opacity-50",
              )}
            >
              <span
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  isCurrent
                    ? "bg-primary"
                    : isAhead
                      ? "border border-foreground/35 bg-transparent"
                      : "bg-foreground/25",
                )}
              />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground/85">
                {cp.label}
              </span>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                {cp.at} · {cp.files} file{cp.files === 1 ? "" : "s"}
              </span>
              {isCurrent ? (
                <span className="shrink-0 font-mono text-[10px] text-primary">current</span>
              ) : (
                <button
                  type="button"
                  onClick={() => onRestore?.(cp.id)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-foreground/5 hover:text-foreground focus-visible:opacity-100"
                >
                  <History className="h-3 w-3" />
                  Restore
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
