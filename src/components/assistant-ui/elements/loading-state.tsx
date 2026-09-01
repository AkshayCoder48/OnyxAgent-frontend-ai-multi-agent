"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { ShimmerLabel } from "./surfaces";

const CELLS = 9;

/**
 * GenerationLoader — a pixel matrix that keeps time while the model has
 * nothing to show yet. Nine cells cycle a moving band of lit cells driven
 * by `tick`; the label names what is happening. Retint with terracotta by
 * default via the `--color-brand` var.
 */
export function GenerationLoader({
  label,
  tick,
  variant = "dots",
  className,
  ...props
}: {
  label: string;
  tick: number;
  variant?: "dots" | "squares" | "rounded";
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "children">) {
  const band = tick % (CELLS + 3);
  return (
    <div
      data-slot="generation-loader"
      className={cn("flex w-fit flex-col items-center gap-2", className)}
      {...props}
    >
      <div aria-hidden className="grid grid-cols-3 gap-1">
        {Array.from({ length: CELLS }, (_, i) => {
          const lit = i <= band && i > band - 3;
          return (
            <span
              key={i}
              className={cn(
                "h-2 w-2 bg-primary transition-opacity duration-150",
                variant === "dots" && "rounded-full",
                variant === "rounded" && "rounded-[4px]",
                lit ? "opacity-100" : "opacity-20",
              )}
            />
          );
        })}
      </div>
      <ShimmerLabel className="text-xs">{label}</ShimmerLabel>
    </div>
  );
}
