"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { monoLabelClass, paperCardClass } from "./surfaces";

/** One event on the axis. */
export interface TimelineEvent {
  /** Stable identifier, used as the React key. */
  id: string;
  /** Decides the dot, connector, and title styling for that row. */
  when: "past" | "now" | "future";
  /** Shown in the time column, in monospace. */
  time: string;
  /** The event's headline. */
  title: string;
  /** Optional line under the title. */
  detail?: string;
}

/**
 * Timeline — events on a time axis, with what already happened and what is
 * still coming (assistant-ui `elements-timeline` recipe, Terra retheme).
 *
 * A vertical axis joins the rows: the connector runs solid through the past,
 * turns terracotta at "now", and hollow/dim once it crosses into the future.
 * "now" fills solid with a ring around it and bolds the title; "past" fills
 * solid gray; "future" is a hollow outline. `visibleCount` is floored and
 * clamped into 0…events.length, and the connector after the last visible row
 * is omitted so a partial reveal never trails a dangling line.
 */
export function Timeline({
  events,
  visibleCount,
  className,
  ...props
}: {
  /** The full list of events, only the first `visibleCount` render. */
  events: readonly TimelineEvent[];
  /** How many events to show, floored and clamped into 0…events.length. */
  visibleCount: number;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "children">) {
  const shown = Math.max(0, Math.min(Math.floor(visibleCount) || 0, events.length));

  return (
    <div
      data-slot="timeline"
      className={cn(paperCardClass, "max-w-md p-3", className)}
      {...props}
    >
      {Array.from({ length: shown }, (_, i) => {
        const event = events[i]!;
        const isLast = i === shown - 1;
        return (
          <div key={event.id} className="flex gap-3">
            {/* Time column — right-aligned mono */}
            <span className="w-12 shrink-0 pt-1 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
              {event.time}
            </span>

            {/* Dot + connector column */}
            <span className="relative flex w-4 shrink-0 flex-col items-center">
              {/* Dot */}
              <span
                aria-hidden
                className={cn(
                  "relative z-10 mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  event.when === "now" &&
                    "bg-primary ring-4 ring-primary/20",
                  event.when === "past" && "bg-foreground/35",
                  event.when === "future" && "border border-foreground/40 bg-transparent",
                )}
              />
              {/* Connector down to the next row — omitted after the last
                  visible row so a partial reveal never dangles. */}
              {!isLast && (
                <span
                  aria-hidden
                  className={cn(
                    "absolute top-3.5 bottom-0 w-px",
                    event.when === "future" ? "bg-foreground/15" : "bg-foreground/25",
                  )}
                />
              )}
            </span>

            {/* Title + optional detail */}
            <div className="min-w-0 pb-3 last:pb-0">
              <span
                className={cn(
                  "block text-sm leading-snug",
                  event.when === "now" ? "font-semibold text-foreground" : "font-medium text-foreground/85",
                  event.when === "future" && "text-foreground/60",
                )}
              >
                {event.title}
              </span>
              {event.detail && (
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                  {event.detail}
                </span>
              )}
            </div>
          </div>
        );
      })}
      {shown === 0 && <p className={cn(monoLabelClass, "px-1")}>no events</p>}
    </div>
  );
}
