"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { GenUIComponentProps, str } from "./helpers";

/**
 * `text_block` — paragraph of text (plain or simple markdown).
 *
 * Props:
 *   - content (string)
 *   - variant ("default" | "muted" | "lead")
 *
 * We render plain text with `whitespace-pre-wrap` to preserve line breaks.
 * For full markdown, the AI should emit markdown outside the GenUI block.
 */
export function TextBlock({ props, streaming }: GenUIComponentProps) {
  const title = str(props.title);
  const content = str(props.content || props.text || props.body);
  const variant = str(props.variant || props.type, "default") as "default" | "muted" | "lead";

  if (streaming && !content) {
    return (
      <div className="space-y-1.5 py-1">
        <div className="shimmer h-3 w-full rounded" />
        <div className="shimmer h-3 w-4/5 rounded" />
      </div>
    );
  }

  if (!content) return null;

  return (
    <div>
      {title && (
        <h3 className="text-foreground mb-1 text-sm font-semibold">{title}</h3>
      )}
      <p
        className={cn(
          "text-sm leading-relaxed whitespace-pre-wrap",
          variant === "muted" && "text-muted-foreground",
          variant === "lead" && "text-foreground text-base leading-relaxed",
          variant === "default" && "text-foreground",
        )}
      >
        {content}
      </p>
    </div>
  );
}

export default TextBlock;
