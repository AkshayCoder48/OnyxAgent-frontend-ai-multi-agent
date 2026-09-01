"use client";

import * as React from "react";
import { ArrowUpRight, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { paperCardClass, ShimmerLabel } from "./surfaces";

/**
 * ArtifactCard — a generated document as a tangible object, written live
 * and versioned: file icon, truncated title, and a caption that reads as a
 * shimmering word count while it writes, settling into a version caption
 * once done (assistant-ui `elements-artifact-card` recipe, Terra retheme).
 */
export function ArtifactCard({
  title,
  meta,
  generating = false,
  words = 0,
  className,
  ...props
}: {
  title: string;
  meta: string;
  generating?: boolean;
  words?: number;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "children">) {
  return (
    <div
      data-slot="artifact-card"
      className={cn(
        "group flex max-w-sm cursor-pointer items-center gap-3 px-3 py-2.5 transition-all hover:bg-accent active:scale-[0.99]",
        paperCardClass,
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary",
          generating && "animate-pulse",
        )}
      >
        <FileText className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
        {generating ? (
          <p className="text-xs">
            <ShimmerLabel>Writing</ShimmerLabel>{" "}
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {words} words
            </span>
          </p>
        ) : (
          <p className="animate-[element-label-in_0.3s_ease-out_both] truncate font-mono text-[10px] text-muted-foreground">
            {meta}
          </p>
        )}
      </div>
      <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </div>
  );
}
