"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Badge as UIBadge } from "@/components/ui";
import { GenUIComponentProps, str } from "./helpers";

/**
 * `badge` — status pill.
 *
 * Props:
 *   - text (string, required)
 *   - variant ("default" | "secondary" | "destructive" | "outline" | "success" | "warning")
 */
export function BadgeBlock({ props, streaming }: GenUIComponentProps) {
  const text = str(props.text || props.label);
  const variantRaw = str(props.variant || props.color || props.tone, "default");
  const variant = variantRaw === "green" ? "success" : variantRaw === "red" ? "destructive" : variantRaw === "yellow" || variantRaw === "orange" ? "warning" : variantRaw === "blue" ? "default" : variantRaw;

  if (streaming && !text) {
    return <div className="shimmer h-5 w-16 rounded-full" />;
  }
  if (!text) return null;

  const v = variant === "success"
    ? "default"
    : variant === "warning"
      ? "secondary"
      : (variant as "default" | "secondary" | "destructive" | "outline");

  return (
    <UIBadge
      variant={v}
      className={cn(
        variant === "success" && "border-transparent bg-brand/15 text-brand",
        variant === "warning" && "border-transparent bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
      )}
    >
      {text}
    </UIBadge>
  );
}

export default BadgeBlock;
