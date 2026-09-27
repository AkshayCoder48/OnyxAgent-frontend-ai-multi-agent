"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * useTypewriter — the single-letter streaming engine.
 *
 * User spec: "make single letter streaming — every letter would stream, not
 * paragraphs, single letter only, with motion blur and fade-in … and a 0.5
 * second delay in streaming."
 *
 * Buffers the growing `target` text and reveals it CHARACTER BY CHARACTER on
 * a fixed tick, independent of how the deltas arrived — SSE chunks of any
 * size collapse into one smooth letter flow:
 *
 *  - 0.5s INITIAL HOLD: when the stream is live, the first reveal waits
 *    `initialDelayMs` (500ms default) so the buffer can smooth over
 *    provider chunking; the content then fades in letter by letter.
 *  - ADAPTIVE PACE: base ~65 letters/sec; when the backlog grows the pace
 *    rises proportionally (≈ 1s max lag) and huge backlogs jump ahead so
 *    only the tail animates.
 *  - FINISH, DON'T FLUSH: when the stream settles mid-reveal (fast turns,
 *    last-chunk arrivals), the letters keep flowing at catch-up pace until
 *    the animation completes — a settled message never shows half-typed
 *    text, but it also never snaps the ending.
 *  - REDUCED MOTION: instant reveal, zero timers.
 *  - INACTIVE PASS-THROUGH: messages that were never streaming (hydrated
 *    history, plain rerenders) render the full text with no timers at all.
 *
 * Returns the revealed substring plus `freshFrom` — the index where the
 * "fresh window" starts (chars revealed within the last ~360ms). Those are
 * the chars still playing their letter-in animation; everything before it
 * is safe to render as plain text.
 */
export interface TypewriterOptions {
  /** Hold before the first reveal while streaming (ms). Default 500. */
  initialDelayMs?: number;
  /** Base reveal pace, letters per second. Default 65. */
  baseCps?: number;
  /** Reveal tick interval (ms). Default 20. */
  tickMs?: number;
  /** Catch-up pace once the stream settled mid-reveal (letters/sec). */
  finishCps?: number;
}

export interface TypewriterState {
  /** The revealed substring — what should render right now. */
  text: string;
  /** True while letters are still flowing in (live or finishing). */
  animating: boolean;
  /** Index into `text` where the still-animating fresh window starts. */
  freshFrom: number;
}

interface RevealState {
  /** How many chars of the target are revealed. */
  n: number;
  /** Rolling samples of {time, revealed} used to derive the fresh window. */
  history: { t: number; n: number }[];
}

const FRESH_WINDOW_MS = 360;

export function useTypewriter(
  target: string,
  active: boolean,
  options?: TypewriterOptions,
): TypewriterState {
  const initialDelayMs = options?.initialDelayMs ?? 500;
  const baseCps = options?.baseCps ?? 65;
  const tickMs = options?.tickMs ?? 20;
  const finishCps = options?.finishCps ?? 240;

  // Reduced motion → never animate (checked once, SSR-safe).
  const reducedMotion = React.useMemo(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const animate = active && !reducedMotion;

  const [reveal, setReveal] = React.useState<RevealState>(() => ({
    n: animate ? 0 : target.length,
    history: [],
  }));

  // Latest target + revealed count for the tick closures (refs written only
  // in effects — React-Compiler safe).
  const targetRef = React.useRef(target);
  React.useEffect(() => {
    targetRef.current = target;
  }, [target]);
  const nRef = React.useRef(reveal.n);
  React.useEffect(() => {
    nRef.current = reveal.n;
  }, [reveal.n]);

  // True once this hook instance has ever run the live engine. Distinguishes
  // "settled after streaming" (finish the animation) from "never streamed"
  // (pure pass-through — hydrated history renders instantly). Mirrored as
  // STATE for render-time reads (React Compiler: no refs during render);
  // the ref is the effect-scope source of truth.
  const everAnimatedRef = React.useRef(animate);
  const [everAnimated, setEverAnimated] = React.useState(animate);

  // ── The tick engine ────────────────────────────────────────────────────
  // Runs while live (0.5s hold, adaptive pace) AND for one catch-up stretch
  // after settle (fast pace, no hold) until the reveal completes.
  React.useEffect(() => {
    if (reducedMotion) return;
    if (active) {
      if (!everAnimatedRef.current) {
        everAnimatedRef.current = true;
        setEverAnimated(true);
      }
    }
    const finishing = !active && everAnimatedRef.current;
    if (!active && !finishing) return;

    let interval: number | undefined;
    let stopped = false;

    const tick = () => {
      const t = targetRef.current;
      const backlog = t.length - nRef.current;
      if (backlog <= 0) {
        // Caught up. Live → idle-tick (the fresh window keeps sliding so
        // old chars settle out of the span window). Finishing → done, stop
        // the engine entirely.
        if (!active) {
          stopped = true;
          if (interval !== undefined) window.clearInterval(interval);
          interval = undefined;
        } else {
          const now = Date.now();
          setReveal((prev) => {
            const history = prune(prev.history, now);
            return history === prev.history ? prev : { n: prev.n, history };
          });
        }
        return;
      }
      const now = Date.now();
      setReveal((prev) => {
        const remaining = t.length - prev.n;
        if (remaining <= 0) return prev;
        let next = prev.n;
        if (remaining > 600) {
          // Huge backlog (re-attach mid-stream, long paste): jump ahead and
          // animate only the last ~600 chars.
          next = t.length - 600;
        } else {
          // Adaptive pace: base speed rising with the backlog (≈1s max lag
          // live); fixed fast pace while finishing after settle.
          const cps = active
            ? Math.max(baseCps, remaining)
            : Math.max(finishCps, remaining);
          const step = Math.max(1, Math.round((cps * tickMs) / 1000));
          next = Math.min(t.length, prev.n + step);
        }
        const history = prune([...prev.history, { t: now, n: next }], now);
        return { n: next, history };
      });
    };

    // 0.5s initial hold while LIVE; a finishing catch-up starts immediately.
    const hold = window.setTimeout(
      () => {
        if (stopped) return;
        interval = window.setInterval(tick, tickMs);
      },
      active ? initialDelayMs : 0,
    );

    return () => {
      stopped = true;
      window.clearTimeout(hold);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [active, reducedMotion, initialDelayMs, baseCps, tickMs, finishCps]);

  // ── Never-streamed pass-through ────────────────────────────────────────
  // Messages that mount settled (hydrated history) stay fully revealed and
  // track the target directly — no timers, no animation. (A reveal that is
  // still finishing after a live stream is handled by the engine above.)
  React.useEffect(() => {
    if (animate || everAnimatedRef.current) return;
    setReveal((prev) =>
      prev.n >= target.length && prev.history.length === 0
        ? prev
        : { n: target.length, history: [] },
    );
  }, [animate, target]);

  const n = Math.min(reveal.n, target.length);
  const text = animate || everAnimated ? target.slice(0, n) : target;

  // Fresh window: the revealed count ~FRESH_WINDOW_MS ago (per the rolling
  // samples). Every char in [freshFrom, n) is younger than the letter-in
  // animation (280ms) + margin, so unmounting older chars never pops.
  let freshFrom = n;
  if (reveal.history.length > 0) {
    const newest = reveal.history[reveal.history.length - 1]!;
    const cutoff = newest.t - FRESH_WINDOW_MS;
    const firstFresh = reveal.history.find((s) => s.t >= cutoff);
    freshFrom = Math.min(firstFresh?.n ?? n, n);
  }

  // Letters flow while live (the engine idles between deltas but the window
  // logic keeps fresh spans mounted) or while a settle catch-up is running.
  const finishingBacklog = everAnimated && n < target.length;
  const animating = !reducedMotion && everAnimated && (animate || finishingBacklog);

  return { text, animating, freshFrom };
}

function prune(history: { t: number; n: number }[], now: number) {
  const cutoff = now - (FRESH_WINDOW_MS + 240);
  const first = history.findIndex((s) => s.t >= cutoff);
  if (first <= 0) return first === 0 ? history : [];
  return history.slice(first);
}

/**
 * LetterStream — plain text rendered letter by letter with a motion-blur +
 * fade-in on every fresh letter (`.letter-in` CSS animation). Pairs with
 * `useTypewriter`: pass the revealed `text` and `freshFrom`; chars before
 * the window render as one plain string (zero per-char DOM), chars inside
 * the window each animate in exactly once (stable index keys — a char never
 * remounts while visible).
 *
 * While not animating this is a plain text span — settled content carries
 * no per-letter DOM at all.
 */
export function LetterStream({
  text,
  freshFrom,
  animating,
  className,
}: {
  text: string;
  /** Index where the still-animating window starts (from useTypewriter). */
  freshFrom: number;
  /** True while letters are flowing — false renders plain text. */
  animating: boolean;
  className?: string;
}) {
  if (!animating || !text) {
    return <span className={className}>{text}</span>;
  }

  const chars = Array.from(text);
  const windowStart = Math.max(0, Math.min(freshFrom, chars.length));

  return (
    <span className={cn("whitespace-pre-wrap", className)}>
      {windowStart > 0 ? chars.slice(0, windowStart).join("") : null}
      {chars.slice(windowStart).map((ch, i) =>
        // Whitespace never needs the animation (invisible) and rendering it
        // inside inline-block spans would disturb wrapping — plain chars.
        ch === " " || ch === "\n" || ch === "\t" ? (
          ch
        ) : (
          <span key={windowStart + i} className="letter-in">
            {ch}
          </span>
        ),
      )}
    </span>
  );
}
