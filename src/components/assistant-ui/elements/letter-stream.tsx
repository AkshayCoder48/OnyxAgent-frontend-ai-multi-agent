"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * useTypewriter — the single-letter streaming engine.
 *
 * User spec: "make single letter streaming — every letter would stream, not
 * paragraphs, single letter only" with a short initial hold — one smooth
 * character flow, and NO per-word/per-character blur or fade animations:
 * freshly revealed characters render at full ink immediately (the reveal
 * pacing itself is the motion; the message-level entrance fade handles the
 * "whole response fades in" feel).
 *
 * Buffers the growing `target` text and reveals it CHARACTER BY CHARACTER on
 * a fixed tick, independent of how the deltas arrived — SSE chunks of any
 * size collapse into one smooth letter flow:
 *
 *  - INITIAL HOLD: when the stream goes live, the first reveal waits
 *    `initialDelayMs` so the buffer can smooth over provider chunking.
 *  - ADAPTIVE PACE: base ~90 letters/sec; when the backlog grows the pace
 *    rises with it (the reveal never lags more than ~1s behind the buffer).
 *    A huge backlog while LIVE (re-attach mid-stream) jumps ahead so only
 *    the tail types out.
 *  - FINISH, DON'T FLUSH: when the stream settles mid-reveal (round ends,
 *    AI stops, fast turns, last-chunk arrivals), the letters keep flowing at
 *    catch-up pace until the animation completes — a settled message never
 *    shows half-typed text, and the backlog is never dumped at once.
 *  - RESUME ACROSS REMOUNTS: when the turn settles, message-item relocates
 *    the trailing text out of the WorkingPanel — the bubble REMOUNTS as
 *    "settled". The typewriter seeds from the identity's reveal cache and
 *    keeps finishing the reveal at the same paced speed instead of dumping
 *    the un-revealed backlog (the round-end "auto throwing" fix).
 *  - REDUCED MOTION: instant reveal, zero timers.
 *  - INACTIVE PASS-THROUGH: messages that were never streaming (hydrated
 *    history, plain rerenders) render the full text with no timers at all.
 */
export interface TypewriterOptions {
  /** Hold before the first reveal while streaming (ms). Default 180. */
  initialDelayMs?: number;
  /** Base reveal pace, letters per second. Default 90. */
  baseCps?: number;
  /** Reveal tick interval (ms). Default 20. */
  tickMs?: number;
  /** Minimum catch-up pace once the stream settled mid-reveal (letters/sec).
   *  Larger backlogs reveal proportionally faster (bounded ~1s drain). */
  finishCps?: number;
  /** Stable identity of the streamed text (e.g. the message/part id).
   *
   * REMOUNT STABILITY: when a streaming component REMOUNTS mid-stream or
   * mid-finish (round-end relocation of the trailing text, route change,
   * background-stream reconnect, tab visibility reload), the typewriter
   * seeds its revealed count from this per-identity cache instead of
   * restarting — already seen characters render instantly and only the
   * genuinely new tail animates. Without a key, a remount re-reveals from
   * zero (bounded by the huge-backlog jump-ahead). */
  identityKey?: string;
}

export interface TypewriterState {
  /** The revealed substring — what should render right now. */
  text: string;
  /** True while letters are still flowing in (live or finishing). */
  animating: boolean;
}

/** Reveal-count cache for `identityKey` remounts — bounded, insertion-order
 * eviction, only ever touched by the typewriter engine. Written from the
 * tick itself (synchronously) so the value is current even when a remount
 * races the last effect flush. */
const REVEAL_CACHE_MAX = 128;
const revealCache = new Map<string, number>();

function readCache(identityKey: string | undefined): number | undefined {
  if (!identityKey) return undefined;
  const cached = revealCache.get(identityKey);
  return typeof cached === "number" ? cached : undefined;
}

function writeCache(identityKey: string | undefined, n: number): void {
  if (!identityKey) return;
  revealCache.set(identityKey, n);
  if (revealCache.size > REVEAL_CACHE_MAX) {
    const oldest = revealCache.keys().next().value;
    if (oldest !== undefined) revealCache.delete(oldest);
  }
}

export function useTypewriter(
  target: string,
  active: boolean,
  options?: TypewriterOptions,
): TypewriterState {
  const initialDelayMs = options?.initialDelayMs ?? 180;
  const baseCps = options?.baseCps ?? 90;
  const tickMs = options?.tickMs ?? 20;
  const finishCps = options?.finishCps ?? 320;
  const identityKey = options?.identityKey;

  // Reduced motion → never animate (checked once, SSR-safe).
  const reducedMotion = React.useMemo(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const animate = active && !reducedMotion;

  // ── Resume seed (computed ONCE per mount) ───────────────────────────────
  // A bubble that mounts SETTLED but whose identity holds a PARTIAL cached
  // reveal is a relocated remount (round end / AI stop moves the trailing
  // text out of the WorkingPanel): pick up the reveal where the previous
  // instance left off and let the finishing engine keep pacing the backlog
  // out — never a full dump. Genuinely settled text (cache empty, or the
  // cached reveal is already complete) takes the pass-through path.
  const [resume] = React.useState(() => {
    if (animate || !identityKey) return null;
    const cached = readCache(identityKey);
    if (cached === undefined || cached <= 0 || cached >= target.length) return null;
    return { n: Math.min(cached, target.length) };
  });

  const [reveal, setReveal] = React.useState<number>(() => {
    if (resume) return resume.n;
    if (!animate) return target.length;
    // Reconnect seed: resume from this identity's last known reveal instead
    // of replaying the whole message.
    const cached = readCache(identityKey);
    if (cached !== undefined) return Math.max(0, Math.min(cached, target.length));
    return 0;
  });

  // Latest target + revealed count for the tick closures (refs written only
  // in effects — React-Compiler safe).
  const targetRef = React.useRef(target);
  React.useEffect(() => {
    targetRef.current = target;
  }, [target]);
  const nRef = React.useRef(reveal);
  React.useEffect(() => {
    nRef.current = reveal;
  }, [reveal]);

  // True once this hook instance has ever run the live engine — either it
  // went live itself or it inherited a mid-reveal resume. Distinguishes
  // "settled after streaming" (finish the reveal) from "never streamed"
  // (pure pass-through — hydrated history renders instantly). Mirrored as
  // STATE for render-time reads (React Compiler: no refs during render);
  // the ref is the effect-scope source of truth.
  const everAnimatedRef = React.useRef(animate || !!resume);
  const [everAnimated, setEverAnimated] = React.useState(animate || !!resume);

  // ── The tick engine ────────────────────────────────────────────────────
  // Runs while live (initial hold, adaptive pace) AND for one catch-up
  // stretch after settle (fast pace, no hold) until the reveal completes.
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
        // Caught up. Live → idle-tick (waiting for the next delta).
        // Finishing → done, stop the engine entirely.
        if (!active) {
          stopped = true;
          if (interval !== undefined) window.clearInterval(interval);
          interval = undefined;
        }
        return;
      }
      let next: number;
      if (backlog > 600 && active) {
        // Huge backlog while LIVE (re-attach mid-stream, long paste): jump
        // ahead and type out only the last ~600 chars. Never applies while
        // finishing — a settle must play the remaining reveal out, not
        // throw it (the round-end "auto throwing" rule).
        next = t.length - 600;
      } else {
        // Adaptive pace: base speed rising with the backlog (≈1s max lag
        // live); catch-up pace while finishing after settle — always
        // PACED, never an instant dump.
        const cps = active
          ? Math.max(baseCps, backlog)
          : Math.max(finishCps, backlog);
        const step = Math.max(1, Math.round((cps * tickMs) / 1000));
        next = Math.min(t.length, nRef.current + step);
      }
      nRef.current = next;
      // Cache write INSIDE the tick (synchronous): the value is current the
      // instant the reveal advances, so a remount racing the last effect
      // flush still seeds the exact reveal count.
      writeCache(identityKey, next);
      setReveal(next);
    };

    // Initial hold while LIVE; a finishing catch-up starts immediately.
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
  }, [active, reducedMotion, initialDelayMs, baseCps, tickMs, finishCps, identityKey]);

  // ── Never-streamed pass-through ────────────────────────────────────────
  // Messages that mount settled (hydrated history) stay fully revealed and
  // track the target directly — no timers, no animation. (A reveal that is
  // still finishing after a live stream — or a resumed relocation — is
  // handled by the engine above.)
  React.useEffect(() => {
    if (animate || everAnimatedRef.current) return;
    setReveal((prev) => (prev >= target.length ? prev : target.length));
  }, [animate, target]);

  // ── Identity reveal persistence ────────────────────────────────────────
  // Mirror the revealed count into the bounded cache so a REMOUNT of this
  // identity (round-end relocation of the trailing text, route change,
  // background-stream reconnect) seeds from it. The tick already writes
  // synchronously; this effect additionally covers the initial-hold window
  // (before the first tick — a mid-hold relocation resumes from 0 instead
  // of dumping) and any reveal change that arrives outside the tick.
  React.useEffect(() => {
    if (!identityKey || !everAnimated) return;
    writeCache(identityKey, reveal);
  }, [identityKey, reveal, everAnimated]);

  const n = Math.min(reveal, target.length);
  const text = animate || everAnimated ? target.slice(0, n) : target;

  // Letters flow while live or while a settle catch-up (including a resumed
  // one) is still draining the backlog.
  const finishingBacklog = everAnimated && n < target.length;
  const animating = !reducedMotion && everAnimated && (animate || finishingBacklog);

  return { text, animating };
}

/**
 * LetterStream — plain text, always. The typewriter (useTypewriter) paces
 * the CHARACTER-BY-CHARACTER reveal; revealed characters render at full ink
 * immediately (NO per-word/per-character blur or fade — the reveal pacing is
 * the only motion). This component renders the revealed text as ONE plain
 * string for the non-markdown call sites (tool cards, thinking text,
 * captions) where container-level styling is already handled by the host.
 */
export function LetterStream({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return <span className={cn("whitespace-pre-wrap", className)}>{text}</span>;
}
