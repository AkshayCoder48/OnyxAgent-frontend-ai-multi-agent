"use client";

import * as React from "react";
import { TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { GenUIComponentProps, str, num, arr } from "./helpers";

/**
 * `stock_ticker` — symbol + price + delta + optional sparkline.
 *
 * Props:
 *   - symbol (string, required) — e.g. "AAPL"
 *   - name (string) — full company name
 *   - price (number)
 *   - currency (string, default "$")
 *   - change (number) — absolute change
 *   - changePercent / changePct (number) — percentage change
 *   - spark / sparkline (number[]) — tiny sparkline data
 */
export function StockTicker({ props, streaming }: GenUIComponentProps) {
  const symbol = str(props.symbol);
  const name = str(props.name);
  const price = num(props.price, 0);
  const currency = str(props.currency, "$");
  const change = num(props.change, 0);
  const changePercent = num(props.changePercent ?? props.changePct ?? props.change_percent, 0);
  const sparkData = arr<number>(props.spark || props.sparkline).filter(
    (n) => typeof n === "number" && Number.isFinite(n),
  );

  if (streaming && !symbol) {
    return (
      <div className="bg-card flex items-center gap-3 rounded-xl border p-3">
        <div className="shimmer h-4 w-12 rounded" />
        <div className="shimmer h-6 w-20 rounded" />
      </div>
    );
  }

  if (!symbol) return null;

  const isUp = change >= 0;
  const TrendIcon = isUp ? TrendingUp : TrendingDown;

  // Build sparkline SVG points
  let sparklineSvg: React.ReactNode = null;
  if (sparkData.length >= 2) {
    const sw = 48;
    const sh = 20;
    const min = Math.min(...sparkData);
    const max = Math.max(...sparkData);
    const range = max - min || 1;
    const stepX = sw / (sparkData.length - 1);
    const pts = sparkData
      .map((v, i) => `${(i * stepX).toFixed(1)},${(sh - ((v - min) / range) * sh).toFixed(1)}`)
      .join(" ");
    sparklineSvg = (
      <svg width={sw} height={sh} viewBox={`0 0 ${sw} ${sh}`} className="overflow-visible">
        <polyline
          points={pts}
          fill="none"
          stroke={isUp ? "currentColor" : "currentColor"}
          strokeWidth={1.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <div className="bg-card inline-flex items-center gap-3 rounded-xl border p-3">
      <div className="flex flex-col">
        <span className="text-foreground text-sm font-bold tracking-wide">{symbol}</span>
        {name && <span className="text-muted-foreground text-[10px] leading-tight">{name}</span>}
        <span className="text-foreground text-lg font-semibold tabular-nums">
          {currency}
          {price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      </div>
      {sparklineSvg && (
        <div className={cn(isUp ? "text-brand" : "text-destructive", "opacity-70")}>
          {sparklineSvg}
        </div>
      )}
      <div
        className={cn(
          "flex flex-col items-end",
          isUp ? "text-brand" : "text-destructive",
        )}
      >
        <div className="flex items-center gap-0.5">
          <TrendIcon className="h-3 w-3" />
          <span className="text-sm font-medium tabular-nums">
            {isUp ? "+" : ""}{changePercent.toFixed(2)}%
          </span>
        </div>
        <span className="text-xs tabular-nums opacity-80">
          {isUp ? "+" : ""}{change.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

export default StockTicker;
