"use client";

import * as React from "react";
import { Progress } from "@/components/ui";
import { cn } from "@/lib/utils";
import { GenUIComponentProps, str, num } from "./helpers";

interface ProgressItem {
  label?: string;
  value?: number;
  max?: number;
  variant?: string;
}

/**
 * `progress` — one or more progress bars.
 *
 * Props:
 *   - label (string) — single-bar label (use `items` for multiple bars)
 *   - value (number, 0-100) — for single bar
 *   - max (number, default 100)
 *   - variant (string) — color hint (default/brand)
 *   - items (Array<{ label, value, max, variant }>) — multiple bars
 */
export function ProgressBlock({ props, streaming }: GenUIComponentProps) {
  const singleLabel = str(props.label);
  const explicitValue = props.value;
  const currentVal = num(props.current ?? props.total, 0); // total used as current if current missing
  const totalVal = num(props.total, 0);
  // If explicit value given, use it. Else if current+total given, compute percentage.
  const singleValue = explicitValue != null
    ? num(explicitValue, 0)
    : totalVal > 0
      ? (currentVal / totalVal) * 100
      : 0;
  const singleMax = num(props.max, 100);
  const itemsRaw = Array.isArray(props.items) ? props.items : [];
  const items: ProgressItem[] = itemsRaw.map((it) => {
    const o = it && typeof it === "object" ? (it as Record<string, unknown>) : {};
    return {
      label: str(o.label),
      value: num(o.value, 0),
      max: num(o.max, 100),
      variant: str(o.variant, "default"),
    };
  });
  const useItems = items.length > 0;

  if (streaming && !useItems && !singleLabel) {
    return (
      <div className="bg-card rounded-xl border p-3">
        <div className="shimmer mb-2 h-3 w-24 rounded" />
        <div className="shimmer h-2 w-full rounded-full" />
      </div>
    );
  }

  if (useItems) {
    return (
      <div className="bg-card rounded-xl border p-3 space-y-3">
        {items.map((it, i) => (
          <ProgressBar key={i} item={it} />
        ))}
      </div>
    );
  }

  return (
    <div className="bg-card rounded-xl border p-3">
      <ProgressBar
        item={{ label: singleLabel, value: singleValue, max: singleMax }}
      />
    </div>
  );
}

function ProgressBar({ item }: { item: ProgressItem }) {
  const max = item.max ?? 100;
  const value = item.value ?? 0;
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div>
      {item.label && (
        <div className="text-muted-foreground mb-1 flex items-center justify-between text-xs">
          <span className="font-medium">{item.label}</span>
          <span className="tabular-nums">{Math.round(pct)}%</span>
        </div>
      )}
      <Progress value={pct} className={cn("h-2")} />
    </div>
  );
}

export default ProgressBlock;
