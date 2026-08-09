"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { GenUIComponentProps, num, gridCols } from "./helpers";

/**
 * `image_grid` — responsive grid of `image` children.
 *
 * Props:
 *   - columns (1-4, default 2)
 *   - gap (px, default 8)
 *
 * Children: `image` nodes rendered via `renderChildren`.
 */
export function ImageGrid({ props, children, streaming, renderChildren }: GenUIComponentProps) {
  const columns = num(props.columns, 2);
  const gap = num(props.gap, 8);

  if (streaming && (!children || children.length === 0)) {
    return (
      <div className={cn("grid", gridCols(columns))} style={{ gap }}>
        {Array.from({ length: columns }).map((_, i) => (
          <div key={i} className="bg-muted/50 aspect-video w-full animate-pulse rounded-xl" />
        ))}
      </div>
    );
  }

  if (!children || children.length === 0) {
    return null;
  }

  return (
    <div
      className={cn("grid", gridCols(columns))}
      style={{ gap: `${gap}px` }}
    >
      {renderChildren ? renderChildren(children) : null}
    </div>
  );
}

export default ImageGrid;
