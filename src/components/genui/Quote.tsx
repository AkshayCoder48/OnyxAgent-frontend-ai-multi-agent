"use client";

import * as React from "react";
import { GenUIComponentProps, str } from "./helpers";

/**
 * `quote` — blockquote with author + role.
 *
 * Props:
 *   - text (string, required)
 *   - author (string)
 *   - role (string) — e.g. "CEO, Acme"
 */
export function Quote({ props, streaming }: GenUIComponentProps) {
  const text = str(props.text);
  const author = str(props.author || props.source || props.citation);
  const role = str(props.role);

  if (streaming && !text) {
    return (
      <div className="py-1 pl-4">
        <div className="shimmer h-3 w-full rounded" />
        <div className="shimmer mt-1.5 h-3 w-3/4 rounded" />
      </div>
    );
  }

  if (!text) return null;

  return (
    <blockquote className="border-l-2 border-primary/40 bg-muted/30 rounded-r-lg py-2 pr-3 pl-4">
      <p className="text-foreground text-sm leading-relaxed italic">&quot;{text}&quot;</p>
      {(author || role) && (
        <footer className="text-muted-foreground mt-2 text-xs">
          {author && <span className="font-medium not-italic text-foreground/80">— {author}</span>}
          {role && <span className="not-italic">, {role}</span>}
        </footer>
      )}
    </blockquote>
  );
}

export default Quote;
