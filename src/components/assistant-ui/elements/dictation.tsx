"use client";

import * as React from "react";
import { Mic, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { ShimmerLabel } from "./surfaces";

/**
 * Dictation — the assistant-ui "Dictation" element pattern (Terra retheme).
 *
 * While the user talks, the composer's textarea is REPLACED by
 * `ComposerVoice`: a pulsing record dot, a 14-bar waveform rippling on a
 * sine pattern, the live interim transcript and a mono `0:SS` clock. When
 * capture stops the bars settle flat and the surface shimmers
 * "Transcribing…" until the finalized words land in the composer (never
 * stuck — the hook flips `active` off even when nothing was said, PRD §49).
 *
 * `ComposerVoiceButton` is the mic toggle that lives in the composer's
 * action cluster — mic when idle, a filled stop square with a soft pulse
 * ring while a session is live.
 */

/** Waveform geometry: 14 bars rippling between 4px and 22px. */
const BAR_COUNT = 14;
const BAR_MIN_PX = 4;
const BAR_MAX_PX = 22;
/** Static height used while recording with reduced motion preferred. */
const BAR_MID_PX = (BAR_MIN_PX + BAR_MAX_PX) / 2;
/** Ripple speed — radians of phase per elapsed second. */
const WAVE_SPEED = 2.2;
/** Frame budget for the bar tick — ~30fps keeps it lightweight. */
const FRAME_BUDGET_MS = 33;

/** `m:ss` clock for the elapsed-seconds counter (`0:07`, `1:02`, …). */
function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function ComposerVoice({
  recording,
  seconds,
  interim,
  className,
}: {
  /** True while capturing audio; false during the "Transcribing" settle. */
  recording: boolean;
  /** Elapsed capture seconds (drives the mono clock). */
  seconds: number;
  /** Live partial transcript, when the engine has produced one. */
  interim?: string;
  className?: string;
}) {
  const barRefs = React.useRef<(HTMLSpanElement | null)[]>([]);
  const [reducedMotion, setReducedMotion] = React.useState(false);

  // Track the reduced-motion preference live, so a system setting change
  // takes effect even mid-session.
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Waveform drive: a rAF loop throttled to ~30fps writes each bar's height
  // directly (no per-frame React renders). The pattern is a continuous sine —
  // base + amplitude * |sin(t·speed + i·0.9)| — so the bars ripple
  // organically instead of looping a canned keyframe. Killed whenever we're
  // not recording; with reduced motion the bars rest at a static mid height.
  React.useEffect(() => {
    const bars = barRefs.current;
    if (!recording || reducedMotion) {
      const height = recording ? BAR_MID_PX : BAR_MIN_PX;
      for (const bar of bars) if (bar) bar.style.height = `${height}px`;
      return;
    }
    let raf = 0;
    let lastFrame = 0;
    const tick = (now: number) => {
      if (now - lastFrame >= FRAME_BUDGET_MS) {
        lastFrame = now;
        const t = now / 1000;
        for (let i = 0; i < bars.length; i++) {
          const bar = bars[i];
          if (!bar) continue;
          const h =
            BAR_MIN_PX +
            (BAR_MAX_PX - BAR_MIN_PX) * Math.abs(Math.sin(t * WAVE_SPEED + i * 0.9));
          bar.style.height = `${h.toFixed(2)}px`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [recording, reducedMotion]);

  return (
    <div
      data-slot="composer-voice"
      role="status"
      aria-label={recording ? "Recording voice input" : "Transcribing"}
      className={cn(
        "animate-fade-in flex min-h-[40px] w-full items-center gap-3 py-2.5",
        className,
      )}
    >
      {/* Waveform — decorative (the interim transcript is the a11y text). */}
      <div className="flex h-[22px] shrink-0 items-center gap-[3px]" aria-hidden="true">
        {recording && (
          <span className="bg-destructive mr-1 inline-block h-2 w-2 shrink-0 animate-pulse rounded-full motion-reduce:animate-none" />
        )}
        {Array.from({ length: BAR_COUNT }, (_, i) => (
          <span
            key={i}
            ref={(el) => {
              barRefs.current[i] = el;
            }}
            className="w-[3px] rounded-full bg-primary/80"
            style={{ height: recording ? BAR_MID_PX : BAR_MIN_PX }}
          />
        ))}
      </div>

      {recording ? (
        // Live partial transcript — single truncated line beside the bars.
        <p
          aria-live="polite"
          className="min-w-0 flex-1 truncate text-sm leading-relaxed text-muted-foreground/85"
        >
          {interim ?? ""}
        </p>
      ) : (
        <ShimmerLabel className="min-w-0 flex-1 truncate text-sm leading-relaxed">
          Transcribing…
        </ShimmerLabel>
      )}

      {recording && (
        <span className="shrink-0 font-mono text-xs tabular-nums text-foreground/55">
          {formatClock(seconds)}
        </span>
      )}
    </div>
  );
}

export function ComposerVoiceButton({
  active,
  onClick,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  /** True while a dictation session is live (recording or transcribing). */
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  "aria-label": string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={ariaLabel}
      className={cn(
        "relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:pointer-events-none disabled:opacity-50",
        active && "text-destructive hover:bg-destructive/10 hover:text-destructive",
        className,
      )}
    >
      {/* Soft pulse ring while a session is live. */}
      {active && (
        <span
          aria-hidden
          className="animate-ping absolute inset-0 rounded-xl bg-destructive/20 motion-reduce:animate-none"
        />
      )}
      {active ? (
        <Square className="relative h-3.5 w-3.5 fill-current" />
      ) : (
        <Mic className="relative h-4 w-4" />
      )}
    </button>
  );
}
