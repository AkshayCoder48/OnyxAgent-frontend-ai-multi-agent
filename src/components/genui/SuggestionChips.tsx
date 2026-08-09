"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { GenUIComponentProps, str, arr, obj } from "./helpers";

interface ChipDef {
  text?: string;
  href?: string;
}

/**
 * `suggestion_chips` — clickable follow-up prompt chips.
 *
 * Props:
 *   - title (string) — optional label above the chips
 *   - chips (Array<{ text, href }>) — chip definitions; if `href` is set the
 *     chip is an anchor, otherwise it's a button that dispatches a custom
 *     event the chat input can listen for.
 *
 * Clicking a chip (without href) dispatches a `genui:suggestion` CustomEvent
 * on `window` with `{ detail: text }`. The chat input can listen for this to
 * auto-fill the prompt box.
 */
export function SuggestionChips({ props, streaming }: GenUIComponentProps) {
  const title = str(props.title);
  const chipsRaw = arr<unknown>(props.chips || props.items || props.suggestions);
  const chips: ChipDef[] = chipsRaw.map((c) => {
    if (typeof c === "string") return { text: c } as ChipDef;
    const o = obj(c);
    return { text: str(o.text || o.label), href: str(o.href) };
  });

  if (streaming && chips.length === 0) {
    return (
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="shimmer h-7 w-24 rounded-full" />
        ))}
      </div>
    );
  }

  if (chips.length === 0) return null;

  const handleClick = (text: string) => {
    try {
      window.dispatchEvent(
        new CustomEvent("genui:suggestion", { detail: text }),
      );
    } catch {
      // CustomEvent may not be available in some environments — ignore.
    }
  };

  return (
    <div>
      {title && (
        <div className="text-muted-foreground mb-1.5 text-xs font-medium tracking-wide uppercase">
          {title}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {chips.map((c, i) => {
          const base = cn(
            "border-foreground/15 bg-background hover:bg-foreground/5 hover:border-foreground/30",
            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
          );
          if (c.href) {
            return (
              <a
                key={i}
                href={c.href}
                target="_blank"
                rel="noopener noreferrer"
                className={base}
              >
                {c.text}
              </a>
            );
          }
          return (
            <button
              key={i}
              type="button"
              onClick={() => handleClick(c.text ?? "")}
              className={base}
            >
              {c.text}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default SuggestionChips;
