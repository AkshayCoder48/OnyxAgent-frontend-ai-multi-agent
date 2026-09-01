"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Shared visual tokens for the agent "elements" (tool cards) — the
 * assistant-ui–style disclosure cards used across chat and agent panels.
 *
 * Everything is built from the app's semantic color tokens (Terra warm
 * terracotta editorial palette), so retheming `globals.css` restyles
 * every element at once:
 *
 *  - `paperCardClass`  — soft card surface (paper cream in light mode)
 *  - `monoLabelClass`  — small tracked-caps mono labels / counters
 *  - `fieldBlockClass` — inset mono field blocks (request/result/raw)
 *  - `chipClass`       — small argument chips (query, filename, …)
 *  - `ghostButtonClass`— quiet icon/text buttons inside cards
 */

export const paperCardClass =
  "rounded-xl border border-border bg-secondary/60 text-foreground";

export const fieldBlockClass =
  "rounded-lg border border-border bg-background/70 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/85 whitespace-pre-wrap break-words";

export const chipClass =
  "inline-flex max-w-48 items-center truncate rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/75";

export const ghostButtonClass =
  "inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground";

export const monoLabelClass =
  "font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase";

export const collapsePanelClass =
  "grid transition-[grid-template-rows] duration-200 ease-out";

/** Shimmering label used while work is in flight (terracotta-tinted). */
export function ShimmerLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "relative inline-block bg-clip-text text-transparent",
        "bg-[linear-gradient(110deg,var(--color-muted-foreground)_35%,var(--color-brand)_50%,var(--color-muted-foreground)_65%)]",
        "bg-[length:200%_100%] animate-[element-shimmer_1.4s_linear_infinite]",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Animated disclosure panel — animates between 0 and measured height. */
export function CollapsePanel({
  open,
  children,
  className,
}: {
  open: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(collapsePanelClass, open ? "[grid-template-rows:1fr]" : "[grid-template-rows:0fr]", className)}
      aria-hidden={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/** Terracotta "count chip" for +additions / −deletions style stats. */
export function DeltaChip({
  value,
  kind,
  className,
}: {
  value: number;
  kind: "added" | "removed";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "font-mono text-[10px] tabular-nums",
        kind === "added" ? "text-[#52701e] dark:text-[#b8d98a]" : "text-destructive",
        className,
      )}
    >
      {kind === "added" ? "+" : "−"}
      {value}
    </span>
  );
}
