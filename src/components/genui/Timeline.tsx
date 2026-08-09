"use client";

import * as React from "react";
import { GenUIComponentProps, str, arr, obj } from "./helpers";

interface TimelineEvent {
  date?: string;
  title?: string;
  description?: string;
}

/**
 * `timeline` — vertical list of dated events.
 *
 * Props:
 *   - title (string)
 *   - events (Array<{ date, title, description }>)
 */
export function Timeline({ props, streaming }: GenUIComponentProps) {
  const title = str(props.title);
  const eventsRaw = arr<Record<string, unknown>>(props.events);
  const events: TimelineEvent[] = eventsRaw.map((e) => {
    const o = obj(e);
    return {
      date: str(o.date),
      title: str(o.title),
      description: str(o.description),
    };
  });

  if (streaming && events.length === 0) {
    return (
      <div className="py-1 pl-4">
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <div className="shimmer h-3 w-20 rounded" />
              <div className="shimmer h-2.5 w-3/4 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (events.length === 0) return null;

  return (
    <div>
      {title && <h3 className="text-foreground mb-3 text-sm font-semibold">{title}</h3>}
      <ol className="relative space-y-3 pl-5">
        <div className="bg-border absolute top-1 bottom-1 left-1.5 w-0.5" aria-hidden />
        {events.map((e, i) => (
          <li key={i} className="relative">
            <div className="bg-primary absolute -left-[14px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-background" />
            {e.date && (
              <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                {e.date}
              </div>
            )}
            {e.title && (
              <div className="text-foreground mt-0.5 text-sm font-medium">{e.title}</div>
            )}
            {e.description && (
              <p className="text-muted-foreground mt-0.5 text-sm leading-relaxed">
                {e.description}
              </p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

export default Timeline;
