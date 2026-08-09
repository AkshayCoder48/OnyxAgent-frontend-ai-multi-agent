"use client";

import * as React from "react";
import { TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { GenUIComponentProps, str, num } from "./helpers";

/**
 * `stock_ticker` — symbol + price + delta.
 *
 * Props:
 *   - symbol (string, required) — e.g. "AAPL"
 *   - price (number)
 *   - currency (string, default "$")
 *   - change (number) — absolute change
 *   - changePercent (number) — percentage change
 */
export function StockTicker({ props, streaming }: GenUIComponentProps) {
  const symbol = str(props.symbol);
  const price = num(props.price, 0);
  const currency = str(props.currency, "$");
  const change = num(props.change, 0);
  const changePercent = num(props.changePercent, 0);

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

  return (
    <div className="bg-card inline-flex items-center gap-3 rounded-xl border p-3">
      <div className="flex flex-col">
        <span className="text-foreground text-sm font-bold tracking-wide">{symbol}</span>
        <span className="text-foreground text-lg font-semibold tabular-nums">
          {currency}
          {price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      </div>
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
