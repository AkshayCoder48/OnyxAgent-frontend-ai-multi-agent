"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * BranchPicker — the ‹ i/n › switcher on messages with forked siblings
 * (CHAT BRANCHES, 2026-11-05). Interaction model borrowed from
 * assistant-ui's BranchPickerPrimitive (previous / count / next), but
 * hand-built for this app's Zustand stores — the @assistant-ui package is
 * installed yet never wired into a runtime, so its primitives can't render
 * here (verified: zero @assistant-ui imports in src/).
 *
 * Switching is disabled while a turn runs (same policy as assistant-ui's
 * switchBranchDuringRun guard) — a live execution appends to the ACTIVE
 * branch; switching mid-flight would repaint history under a streaming
 * placeholder.
 */
export function BranchPicker({
  index,
  count,
  disabled,
  onPrev,
  onNext,
  label = "variant",
}: {
  /** 1-based position of the shown sibling. */
  index: number;
  /** Total siblings at this fork point. */
  count: number;
  disabled?: boolean;
  onPrev: () => void;
  onNext: () => void;
  /** What the variants are called (a11y label only). */
  label?: string;
}) {
  if (count < 2) return null;
  const atFirst = index <= 1;
  const atLast = index >= count;
  return (
    <span
      className="inline-flex items-center rounded-full border border-border bg-foreground/[0.03]"
      role="group"
      aria-label={`Message ${label} ${index} of ${count}`}
      data-slot="branch-picker"
    >
      <button
        type="button"
        onClick={onPrev}
        disabled={disabled || atFirst}
        aria-label={`Previous ${label}`}
        title={`Previous ${label}`}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:cursor-default disabled:opacity-30"
      >
        <ChevronLeft className="h-3 w-3" aria-hidden />
      </button>
      <span
        className={cn(
          "select-none px-0.5 font-mono text-[10px] tabular-nums text-muted-foreground",
          disabled && "opacity-50",
        )}
        title={`${count} ${label}s at this point — edit the message or regenerate to create more`}
      >
        {index}/{count}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={disabled || atLast}
        aria-label={`Next ${label}`}
        title={`Next ${label}`}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:cursor-default disabled:opacity-30"
      >
        <ChevronRight className="h-3 w-3" aria-hidden />
      </button>
    </span>
  );
}
