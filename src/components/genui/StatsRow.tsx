"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { GenUIComponentProps, num, arr, obj, str } from "./helpers";
import type { GenUINode } from "@/lib/genui/types";

/**
 * `stats_row` — horizontal row of `stat` children.
 *
 * Props:
 *   - gap (px, default 12)
 *   - items / stats (array of stat props objects) — alternative to children
 *
 * On mobile, wraps to 2 columns; on desktop, all stats fit on one row.
 */
export function StatsRow({ props, children, streaming, renderChildren }: GenUIComponentProps) {
  const gap = num(props.gap, 12);

  // Collect stats from `items` or `stats` prop
  const statsRaw = arr<Record<string, unknown>>(props.items || props.stats);
  const statNodes: GenUINode[] = React.useMemo(() => {
    return statsRaw.map((s, i) => {
      const o = obj(s);
      return {
        id: str(o.id) || `stat-${i}`,
        type: "stat",
        props: o,
      } as GenUINode;
    });
  }, [statsRaw]);

  const nodesToRender = children && children.length > 0 ? children : statNodes;

  if (streaming && nodesToRender.length === 0) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3" style={{ gap: `${gap}px` }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-card h-20 animate-pulse rounded-xl border" />
        ))}
      </div>
    );
  }

  if (nodesToRender.length === 0) return null;

  const count = nodesToRender.length;
  const cols = count <= 2 ? "grid-cols-2" : count === 3 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2 sm:grid-cols-4";

  return (
    <div className={cn("grid", cols)} style={{ gap: `${gap}px` }}>
      {renderChildren ? renderChildren(nodesToRender) : null}
    </div>
  );
}

export default StatsRow;
