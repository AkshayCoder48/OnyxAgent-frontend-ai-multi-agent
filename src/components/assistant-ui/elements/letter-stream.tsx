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

// ─────────────────────────────────────────────────────────────────────────────
// WORD-FADE STREAM — chained per-word fade synchronized with the AI's
// streaming speed (user spec: "every word will stream and fade
// synchronously — each word fades first, and the moment that fade ends the
// next generated word's fade starts; the pace varies with the AI's
// streaming speed").
//
// Where the letter engine reveals CHARACTERS on a fixed tick, this engine
// reveals WHOLE WORDS and paces the reveal to the fade duration itself:
//
//   • ONE WORD PER FADE — a word is revealed, fades in over `D` ms (the
//     CSS animation on its span), and the NEXT word reveals exactly when
//     that fade completes (the next engine step is scheduled `D` ms out).
//     The result is a seamless cascade: fade → fade → fade, never two
//     words fading at once (unless the stream outruns the drain, when
//     words deliberately share a frame at high speed).
//   • ADAPTIVE `D` — derived from the reveal backlog (how many words the
//     AI has streamed but are still un-faded). A slow stream (backlog ~1)
//     gets the full luxurious fade (`maxFadeMs`); a fast stream grows the
//     backlog and the fade shortens proportionally so the cascade NEVER
//     lags more than the lag budget behind the live buffer. The animation
//     speed literally follows the AI's streaming speed.
//   • SAME LIFECYCLE RULES AS THE LETTER ENGINE — initial hold while live,
//     finish-don't-flush on settle (the un-faded backlog keeps cascading
//     at catch-up pace), resume-across-remount via the identity cache
//     (namespaced `w:` so it never collides with the char cache), instant
//     pass-through for never-streamed messages, reduced-motion off.
//   • TOKENIZATION — a token is a word plus its trailing whitespace (the
//     markdown structure travels with its words); pure-whitespace tokens
//     are free reveals that never consume a fade slot; unbroken runs
//     longer than `chunk` chars (URLs, hashes, CJK stretches) are chunked
//     so one giant token can't stall the cascade.
// ─────────────────────────────────────────────────────────────────────────────

/** Split `s` into reveal tokens: `\S+` + trailing whitespace, standalone
 *  whitespace runs, and long unbroken runs chunked to ≤ `chunk` chars. */
function tokenizeWords(s: string, chunk: number): string[] {
  if (!s) return [];
  const out: string[] = [];
  const re = /\s+|\S+\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const tok = m[0];
    if (tok.trim().length <= chunk) {
      out.push(tok);
      continue;
    }
    // Giant unbroken run — chunk it; the trailing whitespace rides on the
    // final piece so separators still land with their word.
    const ws = /\s*$/.exec(tok)![0];
    const word = tok.slice(0, tok.length - ws.length);
    for (let i = 0; i < word.length; i += chunk) {
      out.push(
        i + chunk < word.length ? word.slice(i, i + chunk) : word.slice(i) + ws,
      );
    }
  }
  return out;
}

interface TokenCache {
  tokens: string[];
  /** How many chars of the target `tokens` covers. */
  covered: number;
}

/** Incremental retokenize for a GROWN target: every token before the last
 *  one's start offset is immutable, so only the tail is re-tokenized. */
function appendTokens(prev: TokenCache, next: string, chunk: number): TokenCache {
  const last = prev.tokens[prev.tokens.length - 1];
  const restart = prev.covered - last.length;
  const head = prev.tokens.slice(0, -1);
  return {
    tokens: head.concat(tokenizeWords(next.slice(restart), chunk)),
    covered: next.length,
  };
}

export interface WordTypewriterOptions {
  /** Hold before the first reveal while live (ms). Default 180. */
  initialDelayMs?: number;
  /** Floor for the per-word fade (ms) — fastest cascade. Default 55. */
  minFadeMs?: number;
  /** Ceiling for the per-word fade (ms) — relaxed full fade. Default 260. */
  maxFadeMs?: number;
  /** Max time the cascade may lag the live buffer while streaming (ms).
   *  Default 1200. */
  lagBudgetMs?: number;
  /** Finishing (post-settle) drain pace: fade floor. Default 45. */
  finishMinMs?: number;
  /** Finishing drain pace: fade ceiling. Default 150. */
  finishMaxMs?: number;
  /** Finishing drain pace: lag budget. Default 900. */
  finishLagMs?: number;
  /** Max chars of one unbroken token before chunking. Default 28. */
  chunk?: number;
  /** Live backlog (in words) that triggers a re-attach jump-ahead. Default 32. */
  jumpTokens?: number;
  /** Stable identity of the streamed text — seeds the reveal across
   *  remounts (namespaced from the char-engine cache). */
  identityKey?: string;
}

export interface WordTypewriterState {
  /** The revealed substring — what should render right now. */
  text: string;
  /** True while words are still fading in (live or finishing). */
  animating: boolean;
  /** Fade duration chosen for the most recently revealed word — feed this
   *  to the word spans so each fade matches the engine's pacing. */
  fadeMs: number;
}

export function useWordTypewriter(
  target: string,
  active: boolean,
  options?: WordTypewriterOptions,
): WordTypewriterState {
  const initialDelayMs = options?.initialDelayMs ?? 180;
  const minFadeMs = options?.minFadeMs ?? 55;
  const maxFadeMs = options?.maxFadeMs ?? 260;
  const lagBudgetMs = options?.lagBudgetMs ?? 1200;
  const finishMinMs = options?.finishMinMs ?? 45;
  const finishMaxMs = options?.finishMaxMs ?? 150;
  const finishLagMs = options?.finishLagMs ?? 900;
  const chunk = options?.chunk ?? 28;
  const jumpTokens = options?.jumpTokens ?? 32;
  const identityKey = options?.identityKey;

  const reducedMotion = React.useMemo(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  const animate = active && !reducedMotion;

  // ── Mount-time seed: identity cache lookup + token snapshot ───────────
  // `ever` distinguishes "this identity streamed before" (a relocated
  // remount must DRAIN, not dump) from a first-time settled render (pure
  // pass-through).
  const [seed] = React.useState(() => {
    const key = identityKey ? `w:${identityKey}` : null;
    if (!key) return { ever: false, n: 0, chars: 0 };
    const cached = readCache(key);
    const toks = tokenizeWords(target, chunk);
    if (cached === undefined) return { ever: false, n: 0, chars: 0 };
    const n = Math.max(0, Math.min(cached, toks.length));
    let chars = 0;
    for (let i = 0; i < n; i++) chars += toks[i].length;
    return { ever: true, n, chars: Math.min(chars, target.length) };
  });

  const [revealChars, setRevealChars] = React.useState<number>(() =>
    seed.ever ? seed.chars : animate ? 0 : target.length,
  );
  const [fadeMs, setFadeMs] = React.useState<number>(maxFadeMs);

  // Refs (written only in effects/timers — React-Compiler safe).
  const targetRef = React.useRef(target);
  React.useEffect(() => {
    targetRef.current = target;
  }, [target]);
  const tokRef = React.useRef<TokenCache>({ tokens: [], covered: 0 });
  const nTokRef = React.useRef(seed.n);
  const charsRef = React.useRef(seed.chars);

  const everAnimatedRef = React.useRef(animate || seed.ever);
  const [everAnimated, setEverAnimated] = React.useState(animate || seed.ever);

  // ── The chained-fade engine ────────────────────────────────────────────
  // A self-rescheduling timeout: each step reveals one fade unit (a word,
  // with any leading pure-whitespace tokens riding along) and schedules
  // the next step exactly `D` ms out — when THIS word's fade completes —
  // so the next word's fade starts the moment the previous one ends.
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

    const cacheKey = identityKey ? `w:${identityKey}` : undefined;
    let stopped = false;
    let timer: number | undefined;
    // Cheap poll while live+caught-up: picks a newly arrived word up in
    // ≤60ms without any target-change plumbing into the timer closure.
    const idleMs = 60;

    const step = () => {
      if (stopped) return;
      const t = targetRef.current;

      // Lazily (re)tokenize — the target only grows while streaming.
      let tok = tokRef.current;
      if (tok.covered !== t.length) {
        tok =
          t.length < tok.covered || tok.tokens.length === 0
            ? { tokens: tokenizeWords(t, chunk), covered: t.length }
            : appendTokens(tok, t, chunk);
        tokRef.current = tok;
      }
      const tokens = tok.tokens;
      const total = tokens.length;

      // Target replaced (shrank below the reveal) — clamp to full.
      if (charsRef.current > t.length) {
        nTokRef.current = total;
        charsRef.current = t.length;
        writeCache(cacheKey, total);
        setRevealChars(t.length);
        if (!active) stopped = true;
        else timer = window.setTimeout(step, idleMs);
        return;
      }

      let n = nTokRef.current;
      let backlog = total - n;
      if (backlog <= 0) {
        // Caught up. Live → idle-poll for the next word. Finishing → done.
        if (!active) {
          stopped = true;
          return;
        }
        timer = window.setTimeout(step, idleMs);
        return;
      }

      // Re-attach jump-ahead: a huge LIVE backlog (missed the live stream)
      // skips ahead instantly — only the tail cascades.
      if (backlog > jumpTokens && active) {
        const jumpTo = total - jumpTokens;
        let c = 0;
        for (let i = 0; i < jumpTo; i++) c += tokens[i].length;
        n = jumpTo;
        nTokRef.current = n;
        charsRef.current = c;
        backlog = total - n;
      }

      // Adaptive fade duration: the whole backlog drains within the lag
      // budget, clamped between a relaxed full fade and a quick flicker.
      const budget = active ? lagBudgetMs : finishLagMs;
      const min = active ? minFadeMs : finishMinMs;
      const max = active ? maxFadeMs : finishMaxMs;
      const d = Math.max(min, Math.min(max, Math.round(budget / backlog)));

      // Advance ONE fade unit: pure-whitespace tokens ride along free —
      // invisible separators never consume a fade slot.
      let chars = charsRef.current;
      let k = n;
      let sawWord = false;
      while (k < total) {
        const token = tokens[k];
        k++;
        chars += token.length;
        if (token.trim().length > 0) {
          sawWord = true;
          break;
        }
      }
      nTokRef.current = k;
      charsRef.current = chars;
      writeCache(cacheKey, k);
      setRevealChars(chars);
      setFadeMs(d);

      if (k >= total && !active) {
        stopped = true;
        return;
      }
      // The chain: the next word reveals exactly when this fade ends.
      timer = window.setTimeout(step, sawWord ? d : idleMs);
    };

    // Initial hold while LIVE; a finishing catch-up starts immediately.
    const hold = window.setTimeout(
      () => {
        if (!stopped) step();
      },
      active ? initialDelayMs : 0,
    );

    return () => {
      stopped = true;
      window.clearTimeout(hold);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [
    active,
    reducedMotion,
    initialDelayMs,
    minFadeMs,
    maxFadeMs,
    lagBudgetMs,
    finishMinMs,
    finishMaxMs,
    finishLagMs,
    chunk,
    jumpTokens,
    identityKey,
  ]);

  // ── Never-streamed pass-through (hydrated history) ─────────────────────
  React.useEffect(() => {
    if (animate || everAnimatedRef.current) return;
    setRevealChars((prev) => (prev >= target.length ? prev : target.length));
  }, [animate, target]);

  const n = Math.min(revealChars, target.length);
  const text = animate || everAnimated ? target.slice(0, n) : target;

  // Words are still fading in while live, or while a settle catch-up
  // (including a resumed relocation) drains the backlog.
  const finishingBacklog = everAnimated && n < target.length;
  const animating = !reducedMotion && everAnimated && (animate || finishingBacklog);

  return { text, animating, fadeMs };
}
