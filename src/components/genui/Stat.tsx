"use client";

import * as React from "react";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { GenUIComponentProps, str, num } from "./helpers";

/**
 * `stat` — label + big number + delta.
 *
 * Props:
 *   - label (string)
 *   - value (string | number)
 *   - delta (number) — positive/negative change
 *   - deltaLabel (string) — e.g. "vs last week"
 */
export function Stat({ props, streaming }: GenUIComponentProps) {
  const label = str(props.label);
  const valueRaw = props.value;
  const value = typeof valueRaw === "number" ? valueRaw : str(valueRaw);
  const delta = num(props.delta ?? props.trend, 0);
  const deltaLabel = str(props.deltaLabel);

  if (streaming && !label && !value) {
    return (
      <div className="bg-card rounded-xl border p-4">
        <div className="shimmer mb-2 h-3 w-16 rounded" />
        <div className="shimmer h-6 w-24 rounded" />
      </div>
    );
  }

  const trend = delta > 0 ? "up" : delta < 0 ? "down" : "flat";

  return (
    <div className="bg-card rounded-xl border p-4">
      <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {label}
      </div>
      <div className="text-foreground mt-1 font-display text-2xl font-semibold tabular-nums">
        {value}
      </div>
      {delta !== 0 && (
        <div className="mt-1 flex items-center gap-1 text-xs">
          {trend === "up" && <TrendingUp className="text-brand h-3 w-3" />}
          {trend === "down" && <TrendingDown className="text-destructive h-3 w-3" />}
          {trend === "flat" && <Minus className="text-muted-foreground h-3 w-3" />}
          <span
            className={cn(
              "font-medium tabular-nums",
              trend === "up" && "text-brand",
              trend === "down" && "text-destructive",
              trend === "flat" && "text-muted-foreground",
            )}
          >
            {delta > 0 ? "+" : ""}{delta}%
          </span>
          {deltaLabel && <span className="text-muted-foreground">{deltaLabel}</span>}
        </div>
      )}
    </div>
  );
}

export default Stat;
