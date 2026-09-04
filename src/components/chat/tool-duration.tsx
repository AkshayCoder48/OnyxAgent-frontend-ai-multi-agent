"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * ToolDurationBadge — the agentic "tool call visibility" layer (Beta V1.3):
 * every tool call card carries its cost in time. Settled calls show a
 * static "2.4s" badge; running calls tick a live elapsed counter (1s
 * cadence — one shared interval per MOUNTED running card, zero cost when
 * nothing runs).
 */

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1_000) return `${Math.max(1, Math.round(ms / 100) / 10)}s`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  if (m < 60) return `${m}m ${rest.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m - h * 60).toString().padStart(2, "0")}m`;
}

/** Live elapsed seconds while `active` — a 1s interval mounted only when
 *  the tool is actually running (unmounts on settle). */
export function useLiveElapsed(startedAt: number | undefined, active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active || startedAt === undefined) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [active, startedAt]);
  return now;
}

/** Settled duration badge — renders nothing without valid timing. */
export function ToolDurationBadge({
  startedAt,
  endedAt,
  className,
}: {
  startedAt?: number;
  endedAt?: number;
  className?: string;
}) {
  if (startedAt === undefined || endedAt === undefined) return null;
  const label = formatDuration(endedAt - startedAt);
  if (!label) return null;
  return (
    <span
      className={cn(
        "text-muted-foreground/70 shrink-0 font-mono text-[10px] tabular-nums",
        className,
      )}
      title={`Took ${label}`}
      aria-label={`Took ${label}`}
    >
      {label}
    </span>
  );
}

/** Running elapsed counter — ticks live next to the shimmering caption. */
export function ToolLiveElapsed({
  startedAt,
  className,
}: {
  startedAt?: number;
  className?: string;
}) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  if (startedAt === undefined) return null;
  const label = formatDuration(Math.max(0, now - startedAt));
  if (!label) return null;
  return (
    <span
      className={cn(
        "text-muted-foreground/60 shrink-0 font-mono text-[10px] tabular-nums",
        className,
      )}
      aria-label={`${label} elapsed`}
    >
      {label}
    </span>
  );
}
