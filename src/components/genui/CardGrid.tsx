"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { GenUIComponentProps, num, gridCols } from "./helpers";

/**
 * `card_grid` — responsive grid of `card` children.
 *
 * Props:
 *   - columns (1-4, default 2)
 *   - gap (px, default 12)
 */
export function CardGrid({ props, children, streaming, renderChildren }: GenUIComponentProps) {
  const columns = num(props.columns, 2);
  const gap = num(props.gap, 12);

  if (streaming && (!children || children.length === 0)) {
    return (
      <div className={cn("grid", gridCols(columns))} style={{ gap: `${gap}px` }}>
        {Array.from({ length: columns }).map((_, i) => (
          <div key={i} className="bg-card h-24 animate-pulse rounded-xl border" />
        ))}
      </div>
    );
  }

  if (!children || children.length === 0) return null;

  return (
    <div className={cn("grid", gridCols(columns))} style={{ gap: `${gap}px` }}>
      {renderChildren ? renderChildren(children) : null}
    </div>
  );
}

export default CardGrid;
