"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { DeltaChip, paperCardClass } from "./surfaces";

export interface DiffLine {
  kind: "context" | "added" | "removed";
  text: string;
}

const GUTTER: Record<DiffLine["kind"], string> = {
  context: " ",
  added: "+",
  removed: "−",
};

/**
 * CodeDiff — a unified diff with tinted additions and removals, sized for
 * chat. Filename with net +/- counts up top, then every context/added/
 * removed line beneath, tinted and gutter-marked by kind. Warm-toned tints
 * match the Terra palette (never neon).
 */
export function CodeDiff({
  filename,
  additions,
  deletions,
  lines,
  cycle,
  className,
  ...props
}: {
  filename: string;
  additions: number;
  deletions: number;
  lines: readonly DiffLine[];
  /** Folded into each line's key; increment to replay the entrance animation. */
  cycle: number;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "children">) {
  return (
    <div
      data-slot="code-diff"
      className={cn("max-w-md overflow-hidden", paperCardClass, className)}
      {...props}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="truncate font-mono text-[11px] font-medium text-foreground/85">
          {filename}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <DeltaChip value={additions} kind="added" />
          <DeltaChip value={deletions} kind="removed" />
        </span>
      </div>
      <div className="scrollbar-thin max-h-64 overflow-x-auto overflow-y-auto py-1 font-mono text-[11px] leading-relaxed">
        {lines.map((line, i) => (
          <div
            key={`${cycle}-${i}`}
            className={cn(
              "animate-[line-in_0.25s_ease-out_both] flex gap-2 px-3 whitespace-pre",
              line.kind === "added" && "bg-[#52701e]/10 text-[#42591a] dark:text-[#b8d98a]",
              line.kind === "removed" && "bg-destructive/10 text-destructive",
              line.kind === "context" && "text-foreground/70",
            )}
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <span className="w-3 shrink-0 text-muted-foreground/60 select-none">
              {GUTTER[line.kind]}
            </span>
            <span>{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
