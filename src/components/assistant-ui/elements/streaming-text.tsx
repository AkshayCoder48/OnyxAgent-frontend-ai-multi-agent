"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface Segment {
  text: string;
  mono?: boolean;
}

interface Word {
  text: string;
  mono: boolean;
}

function splitSegments(segments: readonly Segment[]): Word[] {
  const words: Word[] = [];
  for (const seg of segments) {
    for (const w of seg.text.split(" ").filter((s) => s.length > 0)) {
      words.push({ text: w, mono: !!seg.mono });
    }
  }
  return words;
}

/**
 * StreamingText — tokens arrive softly: the newest words land in blue and
 * settle into ink (assistant-ui `elements-streaming-text` recipe). The
 * trailing tint and the caret are fixed to `text-blue-500` / `bg-blue-500`
 * per the reference ("add this blue to white streamer"); older words fade
 * back to plain over ~700ms rather than snapping.
 */
export function StreamingText({
  segments,
  count,
  streaming,
  className,
  ...props
}: {
  segments: Segment[];
  count: number;
  streaming: boolean;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"p">, "children">) {
  const words = React.useMemo(() => splitSegments(segments), [segments]);
  const shown = Math.max(0, Math.min(Math.floor(count) || 0, words.length));

  return (
    <p
      data-slot="streaming-text"
      className={cn("min-h-[8.5rem] max-w-sm text-sm leading-relaxed", className)}
      {...props}
    >
      {words.slice(0, shown).map((word, i) => {
        const isFresh = streaming && i >= shown - 2;
        return (
          <React.Fragment key={i}>
            <span
              className={cn(
                "transition-colors duration-700",
                word.mono && "rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]",
                isFresh ? "text-blue-500" : "text-foreground",
              )}
            >
              {word.text}
            </span>{" "}
          </React.Fragment>
        );
      })}
      {streaming && shown > 0 && (
        <span aria-hidden className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-blue-500 align-middle" />
      )}
    </p>
  );
}
