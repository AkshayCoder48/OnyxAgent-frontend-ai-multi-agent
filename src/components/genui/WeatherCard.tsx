"use client";

import * as React from "react";
import { Cloud, Sun, CloudRain, Snowflake, CloudSnow, Wind, Droplets } from "lucide-react";
import { GenUIComponentProps, str, num } from "./helpers";

/**
 * `weather_card` — current weather display.
 *
 * Props:
 *   - location (string)
 *   - temperature (number)
 *   - unit ("C" | "F", default "C")
 *   - condition (string) — e.g. "Sunny", "Partly Cloudy", "Rain"
 *   - icon (string) — override the auto-picked icon: "sun" | "cloud" | "rain" | "snow" | "wind"
 */
export function WeatherCard({ props, streaming }: GenUIComponentProps) {
  const location = str(props.location);
  const temperature = num(props.temperature, 0);
  const unit = str(props.unit, "C");
  const condition = str(props.condition);
  const iconHint = str(props.icon).toLowerCase();

  if (streaming && !location && !condition) {
    return (
      <div className="bg-card flex items-center gap-3 rounded-xl border p-3">
        <div className="shimmer h-10 w-10 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <div className="shimmer h-3 w-24 rounded" />
          <div className="shimmer h-2.5 w-16 rounded" />
        </div>
      </div>
    );
  }

  const conditionLower = condition.toLowerCase();
  const Icon =
    iconHint === "sun" || conditionLower.includes("sun") || conditionLower.includes("clear")
      ? Sun
      : iconHint === "rain" || conditionLower.includes("rain") || conditionLower.includes("drizzle")
        ? CloudRain
        : iconHint === "snow" || conditionLower.includes("snow")
          ? Snowflake
          : iconHint === "wind" || conditionLower.includes("wind")
            ? Wind
            : Cloud;

  return (
    <div className="bg-card flex items-center gap-3 rounded-xl border p-3">
      <div className="bg-primary/10 text-primary flex h-12 w-12 shrink-0 items-center justify-center rounded-full">
        <Icon className="h-6 w-6" />
      </div>
      <div className="min-w-0 flex-1">
        {location && (
          <div className="text-foreground truncate text-sm font-semibold">{location}</div>
        )}
        <div className="flex items-baseline gap-1.5">
          <span className="text-foreground text-2xl font-semibold tabular-nums">
            {Math.round(temperature)}°{unit}
          </span>
          {condition && (
            <span className="text-muted-foreground text-sm">{condition}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default WeatherCard;
