"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { chipClass } from "./surfaces";

/** A citation target: where the claim came from. */
export interface Source {
  /** Site domain, e.g. "assistant-ui.com". */
  domain: string;
  /** Title of the source page. */
  title: string;
  /** Short quoted passage backing the claim. */
  snippet: string;
}

/**
 * InlineCitation — numbered references inside a sentence, each with a hover
 * preview of its source (assistant-ui `elements-inline-citation` recipe,
 * Terra retheme).
 *
 * Renders a fixed reference sentence with numbered markers attached at two
 * anchor points; hovering (or focusing) a marker opens a preview card with
 * the source's domain, title, and snippet. `openIndex` is controlled and
 * admits only one open preview at a time — opening marker 1 closes marker 0
 * and vice versa; `null` closes every marker.
 */
export function InlineCitation({
  sources,
  openIndex,
  onOpenIndexChange,
  className,
  ...props
}: {
  /** Citation targets. Only indices 0 and 1 are ever attached to a marker. */
  sources: Source[];
  /** Which citation's preview is open. `null` closes every marker. */
  openIndex: number | null;
  /** Called with the marker's index when it opens, or null when it closes. */
  onOpenIndexChange: (index: number | null) => void;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"p">, "children">) {
  return (
    <p
      data-slot="inline-citation"
      className={cn("max-w-md text-sm leading-relaxed text-foreground/90", className)}
      {...props}
    >
      Optimistic updates keep the thread responsive while the server confirms
      the write
      {sources[0] && (
        <Citation
          index={0}
          source={sources[0]}
          open={openIndex === 0}
          onOpenChange={(open) => onOpenIndexChange(open ? 0 : null)}
        />
      )}
      , so no extra reconciliation pass is needed
      {sources[1] && (
        <Citation
          index={1}
          source={sources[1]}
          open={openIndex === 1}
          onOpenChange={(open) => onOpenIndexChange(open ? 1 : null)}
        />
      )}
      .
    </p>
  );
}

/** One numbered marker + its hover/focus preview popup. */
function Citation({
  index,
  source,
  open,
  onOpenChange,
}: {
  index: number;
  source: Source;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ref = React.useRef<HTMLSpanElement>(null);

  // Close on outside click (pointer) — hover opens, but a tap elsewhere
  // settles the popup on touch devices.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open, onOpenChange]);

  return (
    <span ref={ref} className="relative inline-block">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Source ${index + 1}: ${source.title}`}
        onFocus={() => onOpenChange(true)}
        onBlur={() => onOpenChange(false)}
        onClick={(e) => {
          e.preventDefault();
          onOpenChange(!open);
        }}
        onMouseEnter={() => onOpenChange(true)}
        onMouseLeave={() => onOpenChange(false)}
        className={cn(
          "mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full border align-[super] px-1",
          "font-mono text-[9px] font-medium leading-none tabular-nums transition-colors",
          open
            ? "border-primary/60 bg-primary/15 text-primary"
            : "border-border bg-muted text-foreground/70 hover:border-primary/40 hover:text-primary",
        )}
      >
        {index + 1}
      </button>

      {/* Preview popup — domain, title, snippet on the shared paper surface */}
      <span
        aria-hidden={!open}
        className={cn(
          "absolute bottom-[calc(100%+0.4rem)] left-0 z-30 w-64 origin-bottom-left rounded-xl p-3",
          "border border-border bg-secondary shadow-lg transition-all duration-150",
          open ? "pointer-events-auto scale-100 opacity-100" : "pointer-events-none scale-95 opacity-0",
        )}
        role={open ? "tooltip" : undefined}
      >
        <span className={cn(chipClass, "mb-1.5 max-w-full")}>{source.domain}</span>
        <span className="mb-1 block truncate text-xs font-medium text-foreground/90">
          {source.title}
        </span>
        <span className="block text-[11px] leading-relaxed text-muted-foreground">
          {source.snippet}
        </span>
      </span>
    </span>
  );
}
