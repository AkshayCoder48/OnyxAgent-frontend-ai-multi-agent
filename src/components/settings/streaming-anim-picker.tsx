"use client";

import * as React from "react";
import { Play, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  STREAMING_ANIMATIONS,
  readPersistedStreamingAnim,
  selectStreamingAnim,
} from "@/lib/streaming-motion";

/**
 * STREAMING ANIMATION PICKER (uploaded "Streaming Motion Lab" spec) —
 * the Settings → Appearance control that selects which of the 24
 * word-by-word reveals the chat stream plays.
 *
 * - The PREVIEW pane renders a sample sentence with the real engine
 *   markup (`.wf` word spans, one-shot CSS animation at mount) inside a
 *   container carrying `data-stream-anim` — the exact selector path the
 *   live stream uses, so what you see is what streams.
 * - Selecting persists via @/lib/streaming-motion (localStorage + the
 *   html attribute swap — pure CSS, no React re-render of the chat).
 * - "Default" clears the override: the app's own mixed blur settle.
 */

const SAMPLE =
  "Every word arrives with clarity — a smooth, fluid reading experience.";

const PREVIEW_WORD_STAGGER_MS = 110;
const PREVIEW_WORD_DURATION_MS = 420;

/** The preview pane — REMOUNTS on playKey, so the cascade always starts
 *  fresh (state resets to 0 with the component, no effect-time resets). */
function PreviewWords({ words }: { words: string[] }) {
  const [revealed, setRevealed] = React.useState(0);

  // Staggered reveal — mount word i at i * STAGGER; all words end visible.
  // Timer callbacks only (never a synchronous setState in the effect).
  React.useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (reduced) {
      // Reduced motion: no cascade — show the sentence statically.
      timers.push(setTimeout(() => setRevealed(words.length), 0));
    } else {
      words.forEach((_, i) => {
        timers.push(setTimeout(() => setRevealed(i + 1), i * PREVIEW_WORD_STAGGER_MS));
      });
    }
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [words]);

  return (
    <>
      {words.slice(0, revealed).map((w, i) => (
        <span key={i}>
          <span className="wf" style={{ animationDuration: `${PREVIEW_WORD_DURATION_MS}ms` }}>
            {w}
          </span>{" "}
        </span>
      ))}
      {revealed < words.length && (
        <Play className="text-muted-foreground/50 inline size-3.5 animate-pulse" aria-hidden />
      )}
    </>
  );
}

export function StreamingAnimPicker() {
  // undefined = not read yet (SSR-safe placeholder); null = the default.
  const [selected, setSelected] = React.useState<string | null | undefined>(undefined);
  const [playKey, setPlayKey] = React.useState(0);
  const words = React.useMemo(() => SAMPLE.split(/\s+/), []);

  React.useEffect(() => {
    // Deferred one tick (SSR-safe mount read; never a sync cascade).
    const t = setTimeout(() => setSelected(readPersistedStreamingAnim()), 0);
    return () => clearTimeout(t);
  }, []);

  const choose = (id: string | null) => {
    setSelected(id);
    selectStreamingAnim(id);
    setPlayKey((k) => k + 1); // replay the preview with the new animation
  };

  const selectedLabel =
    selected === undefined
      ? "…"
      : selected === null
        ? "Default (mixed blur settle)"
        : (STREAMING_ANIMATIONS.find((a) => a.id === selected)?.label ?? "Default");

  return (
    <section className="space-y-3" aria-label="Streaming animation">
      <div>
        <h3 className="text-sm font-semibold">Streaming animation</h3>
        <p className="text-muted-foreground text-xs">
          How streamed words appear in chat answers and thinking. Applies instantly — pick one and watch the preview.
        </p>
      </div>

      {/* PREVIEW — the real engine markup (.wf spans) under the selected
          animation's attribute. key={playKey} remounts for a clean replay. */}
      <div
        data-stream-anim={selected ?? undefined}
        className="bg-foreground/[0.03] min-h-[86px] rounded-xl border border-dashed p-4 text-sm leading-[1.9] tracking-tight"
      >
        <PreviewWords key={playKey} words={words} />
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs" aria-live="polite">
          Selected: <span className="text-foreground font-medium">{selectedLabel}</span>
        </p>
        <button
          type="button"
          onClick={() => setPlayKey((k) => k + 1)}
          className="border-border hover:bg-accent/50 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors"
        >
          <RotateCcw className="size-3" aria-hidden />
          Replay
        </button>
      </div>

      {/* OPTIONS — Default + the lab's 24 reveals. */}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Streaming animation options">
        <button
          type="button"
          aria-pressed={selected === null}
          onClick={() => choose(null)}
          className={cn(
            "rounded-full border px-2.5 py-1 text-xs transition-colors",
            selected === null
              ? "border-primary/60 bg-primary/15 text-foreground font-medium"
              : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          Default
        </button>
        {STREAMING_ANIMATIONS.map((anim, i) => (
          <button
            key={anim.id}
            type="button"
            aria-pressed={selected === anim.id}
            title={`${String(i + 1).padStart(2, "0")} · ${anim.label}`}
            onClick={() => choose(anim.id)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs transition-colors",
              selected === anim.id
                ? "border-primary/60 bg-primary/15 text-foreground font-medium"
                : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {anim.label}
          </button>
        ))}
      </div>
    </section>
  );
}
