"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { GenUIComponentProps, num } from "./helpers";

/**
 * `columns` — responsive column grid wrapping arbitrary children.
 *
 * Props:
 *   - count (1-4, default 2)
 *   - gap (px, default 16)
 */
export function Columns({ props, children, streaming, renderChildren }: GenUIComponentProps) {
  const count = Math.max(1, Math.min(4, Math.floor(num(props.count || props.columns, 2))));
  const gap = num(props.gap, 16);

  const colsClass = {
    1: "grid-cols-1",
    2: "grid-cols-1 sm:grid-cols-2",
    3: "grid-cols-1 sm:grid-cols-3",
    4: "grid-cols-2 sm:grid-cols-4",
  }[count] ?? "grid-cols-1 sm:grid-cols-2";

  if (streaming && (!children || children.length === 0)) {
    return (
      <div className={cn("grid", colsClass)} style={{ gap: `${gap}px` }}>
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="bg-muted/50 h-16 animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  if (!children || children.length === 0) return null;

  return (
    <div className={cn("grid", colsClass)} style={{ gap: `${gap}px` }}>
      {renderChildren ? renderChildren(children) : null}
    </div>
  );
}

export default Columns;
