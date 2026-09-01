"use client";

import * as React from "react";
import { Brain, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ghostButtonClass, monoLabelClass, paperCardClass } from "./surfaces";

/** One remembered fact. */
export interface MemoryChip {
  id: string;
  /** The fact text shown in the pill. */
  text: string;
  /** "existing" renders neutral; "added" and "updated" share the highlighted tint. */
  change: "added" | "updated" | "existing";
}

/**
 * MemoryChips — what it now remembers about you, written during the turn
 * and removable (assistant-ui `elements-memory-chips` recipe, Terra
 * retheme).
 *
 * One pill per fact, freshly written ones tinted terracotta, each with its
 * own forget button. The header reads "memory" until at least one chip's
 * change is added/updated, then switches to "remembered N" (counting only
 * the non-existing chips). Each pill keys on its id and mounts with a
 * 300ms fade + scale, so appending a chip animates only that pill in.
 */
export function MemoryChips({
  chips,
  onForget,
  className,
  ...props
}: {
  /** The pills to render, in order. */
  chips: readonly MemoryChip[];
  /** Called with a chip's id when its forget button is pressed. */
  onForget?: (id: string) => void;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "children">) {
  const freshCount = chips.filter((c) => c.change !== "existing").length;
  const header =
    freshCount > 0 ? (freshCount === 1 ? "remembered 1" : `remembered ${freshCount}`) : "memory";

  return (
    <div
      data-slot="memory-chips"
      className={cn(paperCardClass, "max-w-md p-3", className)}
      {...props}
    >
      {/* Header — brain icon + "memory" / "remembered N" */}
      <div className="mb-2 flex items-center gap-2">
        <Brain className="h-3.5 w-3.5 text-primary" aria-hidden />
        <span className={monoLabelClass}>{header}</span>
      </div>

      {/* Pills — one per chip; fresh ones tinted, each with its forget button */}
      <div className="flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <span
            key={chip.id}
            data-change={chip.change}
            className="animate-[memory-chip-in_300ms_ease-out_both]"
          >
            <span
              className={cn(
                "inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-xs",
                chip.change === "existing"
                  ? "border-border bg-muted text-foreground/80"
                  : "border-primary/30 bg-primary/10 text-primary",
              )}
            >
              <span className="min-w-0 truncate">{chip.text}</span>
              <button
                type="button"
                aria-label={`Forget "${chip.text}"`}
                onClick={() => onForget?.(chip.id)}
                className={cn(ghostButtonClass, "h-4 w-4 shrink-0 rounded-full")}
              >
                <X className="h-2.5 w-2.5" aria-hidden />
              </button>
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
