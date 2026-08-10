"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { GenUIComponentProps, num, gridCols, arr, obj, str } from "./helpers";
import type { GenUINode } from "@/lib/genui/types";

/**
 * `image_grid` — responsive grid of images.
 *
 * Props:
 *   - columns / count (1-4, default 2)
 *   - gap (px, default 8)
 *   - images / items (array of image props objects) — alternative to children
 *
 * The AI may pass images as either:
 *   1. `children` array (proper GenUI nodes), OR
 *   2. `images` / `items` array (plain objects with url/src/caption/etc.)
 */
export function ImageGrid({ props, children, streaming, renderChildren }: GenUIComponentProps) {
  const columns = num(props.columns ?? props.count, 2);
  const gap = num(props.gap, 8);

  const imagesRaw = arr<Record<string, unknown>>(props.images || props.items);

  const imageNodes: GenUINode[] = React.useMemo(() => {
    return imagesRaw.map((im, i) => {
      const o = obj(im);
      return {
        id: str(o.id) || `img-${i}`,
        type: "image",
        props: o,
      } as GenUINode;
    });
  }, [imagesRaw]);

  const nodesToRender = children && children.length > 0 ? children : imageNodes;

  if (streaming && nodesToRender.length === 0) {
    return (
      <div className={cn("grid", gridCols(columns))} style={{ gap }}>
        {Array.from({ length: columns }).map((_, i) => (
          <div key={i} className="bg-muted/50 aspect-video w-full animate-pulse rounded-xl" />
        ))}
      </div>
    );
  }

  if (nodesToRender.length === 0) return null;

  return (
    <div className={cn("grid", gridCols(columns))} style={{ gap: `${gap}px` }}>
      {renderChildren ? renderChildren(nodesToRender) : null}
    </div>
  );
}

export default ImageGrid;
