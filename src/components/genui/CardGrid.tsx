"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { GenUIComponentProps, num, gridCols, arr, obj, str } from "./helpers";
import type { GenUINode } from "@/lib/genui/types";

/**
 * `card_grid` — responsive grid of cards.
 *
 * Props:
 *   - columns / count (1-4, default 2)
 *   - gap (px, default 12)
 *   - cards / items (array of card props objects) — alternative to children
 *
 * The AI may pass cards as either:
 *   1. `children` array (proper GenUI nodes), OR
 *   2. `cards` / `items` array (plain objects with title/description/etc.)
 *
 * We handle both: if `cards` is present, we convert each to a GenUINode and
 * pass to renderChildren. If only `children` is present, use that directly.
 */
export function CardGrid({ props, children, streaming, renderChildren }: GenUIComponentProps) {
  const columns = num(props.columns ?? props.count, 2);
  const gap = num(props.gap, 12);

  // Collect cards from `cards` or `items` prop (plain objects)
  const cardsRaw = arr<Record<string, unknown>>(props.cards || props.items);

  // Convert plain card objects to GenUINodes
  const cardNodes: GenUINode[] = React.useMemo(() => {
    return cardsRaw.map((c, i) => {
      const o = obj(c);
      return {
        id: str(o.id) || `card-${i}`,
        type: "card",
        props: o,
      } as GenUINode;
    });
  }, [cardsRaw]);

  // Use children (proper nodes) if available, else use converted cardNodes
  const nodesToRender = children && children.length > 0 ? children : cardNodes;

  if (streaming && nodesToRender.length === 0) {
    return (
      <div className={cn("grid", gridCols(columns))} style={{ gap: `${gap}px` }}>
        {Array.from({ length: columns }).map((_, i) => (
          <div key={i} className="bg-card h-24 animate-pulse rounded-xl border" />
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

export default CardGrid;
