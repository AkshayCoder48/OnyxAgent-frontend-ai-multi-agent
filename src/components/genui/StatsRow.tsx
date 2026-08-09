"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { GenUIComponentProps, num } from "./helpers";

/**
 * `stats_row` — horizontal row of `stat` children.
 *
 * Props:
 *   - gap (px, default 12)
 *
 * On mobile, wraps to 2 columns; on desktop, all stats fit on one row.
 */
export function StatsRow({ props, children, streaming, renderChildren }: GenUIComponentProps) {
  const gap = num(props.gap, 12);

  if (streaming && (!children || children.length === 0)) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3" style={{ gap: `${gap}px` }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-card h-20 animate-pulse rounded-xl border" />
        ))}
      </div>
    );
  }

  if (!children || children.length === 0) return null;

  const count = children.length;
  const cols = count <= 2 ? "grid-cols-2" : count === 3 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2 sm:grid-cols-4";

  return (
    <div className={cn("grid", cols)} style={{ gap: `${gap}px` }}>
      {renderChildren ? renderChildren(children) : null}
    </div>
  );
}

export default StatsRow;
