"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { ShimmerLabel, ghostButtonClass, monoLabelClass } from "./surfaces";

/**
 * Image generation element (assistant-ui style) — "a dot grid holds the
 * frame while the image resolves out of a blur".
 *
 * Standalone + fully controlled: the caller holds the prompt and whether
 * generation is in flight (and optionally handles regeneration):
 *
 *   <ImageGeneration prompt={prompt} generating={generating}
 *                    onRegenerate={() => void regenerate()} />
 *
 * The frame NEVER renders the generated image itself — it is the placeholder
 * graphic: an 8×8 dot grid (64 dots pulsing with a staggered delay while
 * generating, fully transparent once done) over a fixed decorative gradient
 * that only changes blur + opacity as `generating` flips. Once a real URL
 * arrives, the caller swaps in a renderer that shows it (see the chat
 * generate_image tool block).
 *
 * Everything is built from the app's semantic theme tokens (brand, primary,
 * muted, border) so every appearance re-skins the element at once.
 */

export interface ImageGenerationProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Shown below the frame once generation finishes. */
  prompt: string;
  /** While true: pulsing dot grid + shimmering "Generating" label. */
  generating: boolean;
  /** Renders the regenerate button and runs when activated. */
  onRegenerate?: () => void;
  /** Frame corner label (mono). Defaults to the element's "1024 × 1024". */
  label?: string;
  /** Extra classes for the frame (e.g. a non-square aspect). */
  frameClassName?: string;
}

/** The 64 grid dots (8×8), memoized once. */
const DOTS: readonly number[] = Array.from({ length: 64 }, (_, i) => i);

/** Fixed decorative gradient — a pure theme-token graphic present in both
 * states; only its blur + opacity change as `generating` flips. */
const GRADIENT_CLASS =
  "bg-[radial-gradient(120%_120%_at_18%_12%,var(--color-brand),transparent_55%),radial-gradient(120%_120%_at_85%_88%,var(--color-primary),transparent_52%)]";

export function ImageGeneration({
  prompt,
  generating,
  onRegenerate,
  label = "1024 × 1024",
  frameClassName,
  className,
  ...rest
}: ImageGenerationProps) {
  return (
    <div
      data-slot="image-generation"
      className={cn("w-full max-w-sm text-foreground", className)}
      {...rest}
    >
      {/* ── The frame: 8×8 pulsing dot grid over the decorative gradient. ── */}
      <div
        className={cn(
          "relative aspect-square w-full overflow-hidden rounded-xl border border-border bg-muted/40",
          "shadow-[inset_0_1px_0_0_var(--color-background)]",
          frameClassName,
        )}
      >
        {/* Gradient — blurred + dimmed while generating, sharp once done. */}
        <div
          aria-hidden="true"
          className={cn(
            "absolute inset-0 transition-all duration-700 ease-out",
            GRADIENT_CLASS,
            generating ? "opacity-25 blur-2xl" : "opacity-100 blur-0",
          )}
        />
        {/* Dot grid — staggered pulse while generating, transparent when done. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 grid content-center justify-items-center gap-2 p-6 [grid-template-columns:repeat(8,minmax(0,1fr))]"
        >
          {DOTS.map((i) => (
            <span
              key={i}
              className={cn(
                "h-1.5 w-1.5 rounded-full bg-muted-foreground/60 transition-opacity duration-700",
                generating ? "animate-pulse" : "opacity-0",
              )}
              style={
                generating
                  ? {
                      animationDelay: `${((i % 8) + Math.floor(i / 8)) * 90}ms`,
                      animationDuration: "1.5s",
                    }
                  : undefined
              }
            />
          ))}
        </div>
        {/* Resolution label (mono, bottom-left). */}
        <span className={cn(monoLabelClass, "absolute bottom-2.5 left-3")}>{label}</span>
      </div>

      {/* ── Prompt row + optional regenerate. ──────────────────────────── */}
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {generating ? <ShimmerLabel>Generating</ShimmerLabel> : prompt}
        </p>
        {onRegenerate && (
          <button
            type="button"
            aria-label="Regenerate image"
            disabled={generating}
            aria-hidden={generating}
            onClick={onRegenerate}
            className={cn(
              ghostButtonClass,
              "h-7 w-7 shrink-0 transition-opacity duration-300",
              generating && "pointer-events-none opacity-0",
            )}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
