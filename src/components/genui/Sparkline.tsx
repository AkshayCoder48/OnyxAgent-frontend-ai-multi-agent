"use client";

import * as React from "react";
import { GenUIComponentProps, str, arr, num } from "./helpers";

/**
 * `sparkline` — tiny inline SVG line chart.
 *
 * Props:
 *   - data (number[]) — y values
 *   - label (string) — caption below the chart
 *   - color (string) — stroke color (CSS color, defaults to primary)
 *
 * Renders a minimal SVG polyline scaled to the data range. No axes, no
 * legend — just the trend line. Width is responsive.
 */
export function Sparkline({ props, streaming }: GenUIComponentProps) {
  const dataRaw = arr<number>(props.data || props.values || props.points).filter(
    (n) => typeof n === "number" && Number.isFinite(n),
  );
  const data = dataRaw.map((n) => Number(n));
  const label = str(props.label);
  const color = str(props.color, "var(--color-primary, hsl(var(--primary)))");

  const width = 120;
  const height = 32;

  if (streaming && data.length === 0) {
    return (
      <div className="bg-card rounded-lg border p-2">
        <div className="shimmer h-8 w-full rounded" />
      </div>
    );
  }

  if (data.length < 2) {
    if (data.length === 1) {
      return (
        <div className="bg-card rounded-lg border p-2">
          <div className="text-foreground text-lg font-semibold tabular-nums">{data[0]}</div>
          {label && <div className="text-muted-foreground text-xs">{label}</div>}
        </div>
      );
    }
    return null;
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);

  const points = data
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  // Area fill path
  const areaPath = `M0,${height} L${points.replace(/ /g, " L")} L${width},${height} Z`;

  return (
    <div className="bg-card inline-flex items-center gap-2 rounded-lg border p-2">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="overflow-visible"
        aria-label={label || "Sparkline"}
        role="img"
      >
        <path
          d={areaPath}
          fill={color}
          opacity={0.12}
        />
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Last point dot */}
        <circle
          cx={(data.length - 1) * stepX}
          cy={height - ((data[data.length - 1]! - min) / range) * height}
          r={2}
          fill={color}
        />
      </svg>
      {label && (
        <div className="flex flex-col">
          <span className="text-foreground text-sm font-semibold tabular-nums">
            {data[data.length - 1]}
          </span>
          <span className="text-muted-foreground text-[10px]">{label}</span>
        </div>
      )}
    </div>
  );
}

export default Sparkline;
