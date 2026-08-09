"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { GenUIComponentProps, str, bool } from "./helpers";

/**
 * `header` — section heading with eyebrow / title / subtitle.
 *
 * Props:
 *   - title (string, required)
 *   - subtitle (string)
 *   - eyebrow (string) — small label above the title
 *   - level ("h1" | "h2" | "h3", default "h2")
 */
export function Header({ props, streaming }: GenUIComponentProps) {
  const title = str(props.title);
  const subtitle = str(props.subtitle);
  const eyebrow = str(props.eyebrow);
  const level = str(props.level, "h2") as "h1" | "h2" | "h3";

  if (streaming && !title) {
    return <div className="flex flex-col gap-2 py-2"><div className="shimmer h-5 w-48 rounded" /><div className="shimmer h-3 w-32 rounded" /></div>;
  }

  const titleClass = cn(
    "font-display font-semibold tracking-tight text-foreground",
    level === "h1" && "text-2xl sm:text-3xl",
    level === "h2" && "text-xl sm:text-2xl",
    level === "h3" && "text-lg sm:text-xl",
  );

  const TitleTag = level === "h1" ? "h1" : level === "h3" ? "h3" : "h2";

  return (
    <div className="py-1">
      {eyebrow && (
        <div className="text-primary mb-1 text-xs font-semibold tracking-wider uppercase">
          {eyebrow}
        </div>
      )}
      <TitleTag className={titleClass}>{title}</TitleTag>
      {subtitle && (
        <p className="text-muted-foreground mt-1 text-sm">{subtitle}</p>
      )}
    </div>
  );
}

export default Header;
