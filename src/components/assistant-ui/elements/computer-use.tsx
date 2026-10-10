"use client";

import * as React from "react";
import { MousePointer2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * ComputerUse — the assistant-ui "Computer use" element, re-themed to the
 * app's Terra tokens. A browser-chrome frame (traffic lights + mono address
 * field) around a 16:10 "screen" (the driver viewport is exactly 1280×800),
 * with a cursor that trails through the steps the agent took:
 *
 *   - `steps` — one entry per browser action (position as % of the frame);
 *   - `activeIndex` — the step the cursor sits on (clamped internally);
 *   - the two steps before the active one render as fading trail dots
 *     (0.18 / 0.36 / 0.54 opacity) leading into the full-opacity cursor;
 *   - the footer narrates the ACTIVE step (`action` + `target`) with an
 *     `n/total` counter — the play-once animation lives in the consumer
 *     (BrowserUseGroup), which advances `activeIndex` on a timer.
 *
 * Self-contained by design (lucide + cn + react only) — this file is part
 * of the elements showcase chain and never imports tool/runtime code.
 */
export interface ComputerStep {
  /** React key — the originating tool-call id. */
  id: string;
  /** The action verb, shown in the footer — "click", "type", "navigate"… */
  action: string;
  /** What the action acted on, shown in the footer. */
  target: string;
  /** Cursor/trail position as a % of the frame width, 0…100. */
  x: number;
  /** Cursor/trail position as a % of the frame height, 0…100. */
  y: number;
}

export function ComputerUse({
  url,
  steps,
  activeIndex,
  children,
  className,
  ...divProps
}: {
  /** Shown in the chrome's address field. */
  url: string;
  /** The actions to trail through. Empty ⇒ header + children only. */
  steps: readonly ComputerStep[];
  /** The step the cursor sits on — clamped into 0…steps.length-1. */
  activeIndex: number;
  /** The screen content under the trail/cursor (screenshot or placeholder). */
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  const count = steps.length;
  // Clamp: negative or out-of-range still resolves to a real step. With zero
  // steps there is no cursor and no footer at all.
  const clamped = count > 0 ? Math.min(Math.max(activeIndex, 0), count - 1) : -1;
  const active = clamped >= 0 ? steps[clamped] ?? null : null;
  // Trail window: the two steps before the active one + the active step
  // itself (fewer near the start). i is the index INSIDE the window, so the
  // opacities fade in toward the cursor: 0.18 → 0.36 → 0.54.
  const trail = active ? steps.slice(Math.max(0, clamped - 2), clamped + 1) : [];

  return (
    <div
      data-slot="computer-use"
      role="group"
      aria-label={`Browser session ${url}`}
      className={cn(
        "w-full select-none overflow-hidden rounded-xl border border-border bg-card",
        className,
      )}
      {...divProps}
    >
      {/* Chrome header — traffic lights + the mono address field. */}
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="flex shrink-0 items-center gap-1.5" aria-hidden>
          <span className="h-2 w-2 rounded-full bg-red-400/70" />
          <span className="h-2 w-2 rounded-full bg-amber-400/70" />
          <span className="h-2 w-2 rounded-full bg-emerald-400/70" />
        </span>
        {/* w-0 collapses the field's intrinsic min-content so a long URL
            can never stretch a narrow parent (grid columns, docked panels) —
            flex-1 still grows it to the available width. */}
        <span className="ml-1 w-0 min-w-0 flex-1 truncate rounded-md border border-border bg-background/70 px-2 py-1 font-mono text-[11px] text-muted-foreground">
          {url}
        </span>
      </div>

      {/* Screen — the driver viewport is exactly 1280×800 ⇒ 16:10. */}
      <div className="relative aspect-[16/10] overflow-hidden border-t border-border bg-muted/40">
        {children}
        {/* Trail dots + cursor sit ON TOP of the screen, never interactive. */}
        <span className="pointer-events-none absolute inset-0" aria-hidden>
          {trail.map((step, i) => (
            <span
              key={step.id}
              className="absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary"
              style={{ left: `${step.x}%`, top: `${step.y}%`, opacity: 0.18 * (i + 1) }}
            />
          ))}
          {active ? (
            <MousePointer2
              className={cn(
                "absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-primary fill-primary/20",
                "drop-shadow-sm transition-[left,top] duration-500 ease-out motion-reduce:transition-none",
              )}
              style={{ left: `${active.x}%`, top: `${active.y}%` }}
            />
          ) : null}
        </span>
      </div>

      {/* Footer — narrates the ACTIVE step (never rendered with zero steps). */}
      {active ? (
        <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-1.5 font-mono text-[10px]">
          <span className="flex w-0 min-w-0 flex-1 items-baseline gap-1.5" aria-live="polite">
            <span className="shrink-0 lowercase text-primary">{active.action}</span>
            <span className="min-w-0 truncate text-muted-foreground">{active.target}</span>
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {clamped + 1}/{count}
          </span>
        </div>
      ) : null}
    </div>
  );
}
