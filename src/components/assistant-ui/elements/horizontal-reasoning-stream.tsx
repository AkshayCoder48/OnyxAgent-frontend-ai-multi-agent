"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import styles from "./HorizontalReasoningStream.module.css";
import { useWordTypewriter, FadeWords } from "./letter-stream";

/**
 * HorizontalReasoningStream — ONE continuous, horizontally-scrolling line of
 * reasoning text (PRD "Adaptive Horizontal Reasoning Stream UI",
 * 2026-11-24). A strictly RENDERING change: the same reasoning deltas the
 * chat store already produces feed ONE growing text element inside a
 * fixed-height, single-row viewport — no vertical growth, no per-sentence
 * rows, no second stream.
 *
 *   ● Thinking · Used 6 tools
 *   ┌──────────────────────────────────────────┐
 *   │◄ Let me analyze the workspace and read th…│ ►
 *   └──────────────────────────────────────────┘
 *      (edge vignette:      (auto-follow advances the viewport
 *       theme-background)    as text arrives; swipe to go back)
 *
 * Behaviour map (PRD §2–§8, as amended 2026-11-24 by user directive):
 *   - AUTO-FOLLOW — while streaming, the viewport advances to keep the
 *     newest text visible (rAF-batched, width read from the viewport's
 *     scrollWidth, no per-token layout reads).
 *   - MANUAL NAVIGATION — wheel/trackpad (horizontal deltas), touch swipe,
 *     pointer drag, and keyboard arrows move the stream; ANY manual move
 *     farther than a small threshold from the tail PAUSES auto-follow
 *     (the ref flips SYNCHRONOUSLY in the gesture handler — the rAF loop
 *     can never fight the user even for one frame). Reaching the very end
 *     while streaming RESUMES following. While paused, incoming text still
 *     renders (the line keeps growing off-screen) but the viewport stays
 *     where the user left it.
 *     REMOVED (user directive 2026-11-24): the Follow Latest chip — follow
 *     state is silent; no control rides the stream.
 *   - SHARP TEXT — the resting stream renders at full clarity (the subtle
 *     blur veil was removed by the same user directive); newly arriving
 *     words keep the user's selected streaming animation (the same .wf
 *     spans the main answer uses).
 *   - ADAPTIVE VIGNETTE (§5) — left/right fades composited from the LIVE
 *     theme background color (readThemeBackground reads the computed
 *     --color-background off <html>, re-read on class/style mutations), so
 *     it adapts to light/dark/custom backgrounds with zero hardcoded
 *     colors. The only visual chrome on the stream (the accent overflow
 *     rail, the accent focus outline and the chip border were removed as
 *     user-requested noise, 2026-11-24).
 *   - ANIMATION REUSE (§4) — the reveal engine IS the existing one:
 *     useWordTypewriter + FadeWords, which already respects
 *     html[data-stream-anim] (the user's selected streaming animation),
 *     its speed, and prefers-reduced-motion. No new setting, no override.
 *   - MOBILE/DESKTOP (§8) — touch swipe via native overflow scrolling with
 *     overscroll-behavior-x contain (never hijacks the page's vertical
 *     chat scroll), wheel/trackpad Δx, pointer drag with a slop (clicks
 *     and selection still work), arrow keys when focused.
 *
 * Performance notes (§9): auto-follow batches scroll writes through
 * requestAnimationFrame; the stream is ONE text node whose growing tail
 * re-renders (FadeWords memoizes settled words); the vignette is pure CSS
 * (no filter, no backdrop-filter on the text); a settled block costs zero
 * timers.
 */

/** Distance (px) from the trailing edge that counts as "at the latest". */
const AT_TAIL_TOLERANCE = 8;
/** Manual-scroll distance (px) past the tail that pauses auto-follow. */
const USER_NAV_THRESHOLD = 24;
/** Pointer movement (px) before a press becomes a drag (clicks stay clicks). */
const DRAG_SLOP = 4;
/** Viewport height: one text line + breathing room (fixed, §2). */
const ROW_H = "2.25rem";

interface HorizontalReasoningStreamProps {
  /** The full reasoning text so far (grows as deltas arrive). */
  text: string;
  /** True while the reasoning stream is live. */
  active: boolean;
  /** Stable identity for the reveal engine (resumes across remounts). */
  identityKey?: string;
  /** Hold before the first reveal while live (ms). */
  initialDelayMs?: number;
  /** aria-label for the stream viewport. */
  ariaLabel?: string;
}

/** Read the live theme background as an rgb() string for the vignette.
 *  Resolves --color-background (falling back to --background) off <html>,
 *  so light/dark/custom appearances all blend without hardcoded colors.
 *  Exported for unit tests (jsdom cannot read back gradient styles). */
export function readThemeBackground(): string {
  if (typeof window === "undefined") return "rgb(0, 0, 0)";
  try {
    const cs = getComputedStyle(document.documentElement);
    const raw =
      cs.getPropertyValue("--color-background").trim() ||
      cs.getPropertyValue("--background").trim();
    if (!raw) return "rgb(0, 0, 0)";
    if (raw.startsWith("#")) {
      const h = raw.slice(1);
      const full =
        h.length === 3
          ? h
              .split("")
              .map((c) => c + c)
              .join("")
          : h.slice(0, 6);
      const v = parseInt(full, 16);
      return `rgb(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255})`;
    }
    // Already an rgb()/named form (or a var-resolved value) — use as-is.
    return raw;
  } catch {
    return "rgb(0, 0, 0)";
  }
}

export function HorizontalReasoningStream({
  text,
  active,
  identityKey,
  initialDelayMs = 180,
  ariaLabel = "AI reasoning stream",
}: HorizontalReasoningStreamProps) {
  const viewportRef = useRef<HTMLDivElement>(null);

  // ── auto-follow state (paused = the user navigated away from the tail) ──
  // `followingRef` is the rAF loop's source of truth and flips
  // SYNCHRONOUSLY inside the gesture handlers — the follow loop can never
  // overwrite a manual scroll in the same frame (PRD §3: automatic
  // scrolling must never fight manual gestures).
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  useEffect(() => {
    followingRef.current = following;
  }, [following]);

  // Latest content width — measured inside the follow loop, not per render.
  const widthRef = useRef(0);
  // Token that cancels the follow loop when the effect re-runs/unmounts.
  const followEpochRef = useRef(0);

  const { text: revealed, animating, fadeMs } = useWordTypewriter(text, active, {
    identityKey,
    initialDelayMs,
  });

  // ── AUTO-FOLLOW LOOP (rAF-batched) ─────────────────────────────────────
  // While active, each frame checks the viewport's scrollWidth and, when it
  // grew AND we are following, advances scrollLeft to the tail. A frame loop
  // (rather than a per-delta effect) batches any number of deltas into one
  // scroll write and idles cheaply between growth; it stops entirely once
  // the block settles (a settled stream costs nothing).
  useLayoutEffect(() => {
    if (!active) return;
    const el = viewportRef.current;
    if (!el) return;
    const epoch = ++followEpochRef.current;
    let raf = 0;
    const tick = () => {
      if (epoch !== followEpochRef.current) return;
      const sw = el.scrollWidth;
      if (sw !== widthRef.current) {
        widthRef.current = sw;
        if (followingRef.current) {
          el.scrollLeft = sw; // clamps to the max automatically
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (epoch === followEpochRef.current) followEpochRef.current++;
    };
  }, [active]);

  // Snap to the tail when (re)mounting mid-stream while following.
  useLayoutEffect(() => {
    if (active && followingRef.current) {
      const el = viewportRef.current;
      if (el) {
        el.scrollLeft = el.scrollWidth;
        widthRef.current = el.scrollWidth;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // ── MANUAL NAVIGATION (wheel / touch / drag / keyboard) ─────────────────
  // A manual interaction pauses auto-follow ONLY once the user has moved
  // meaningfully away from the tail (small wobbles don't), and reaching the
  // very end while streaming RESUMES it (PRD §3).
  const noteManualScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const tail = el.scrollWidth - el.clientWidth;
    const off = tail - el.scrollLeft;
    if (off > USER_NAV_THRESHOLD) {
      if (followingRef.current) {
        followingRef.current = false; // sync — the rAF loop sees it now
        setFollowing(false);
      }
    } else if (off <= AT_TAIL_TOLERANCE && !followingRef.current) {
      followingRef.current = true;
      setFollowing(true);
    }
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      // Steer only when the event is genuinely horizontal (trackpad Δx);
      // vertical deltas belong to the page's chat scroll and are never
      // captured here. The native overflow container applies the horizontal
      // delta itself — this handler only re-evaluates the follow state on
      // the next frame (post-scroll).
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      requestAnimationFrame(noteManualScroll);
    },
    [noteManualScroll],
  );

  const onScroll = useCallback(() => {
    // Native scroll (wheel/touch/drag) — evaluate follow state.
    noteManualScroll();
  }, [noteManualScroll]);

  // Pointer drag (desktop, PRD §8 "optional mouse drag"): press, move past
  // DRAG_SLOP px, drag the stream. A click under the slop stays a click
  // (selection intact); once dragging, the stream text deselects (CSS
  // .hrs-dragging) so a swipe never smear-selects.
  const dragRef = useRef<{ x: number; left: number; moved: boolean } | null>(
    null,
  );
  const [dragging, setDragging] = useState(false);
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Primary button only; touch swipes ride the native scroll instead
    // (pointerdown with pointerType touch would double-apply).
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const el = viewportRef.current;
    if (!el) return;
    dragRef.current = { x: e.clientX, left: el.scrollLeft, moved: false };
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const el = viewportRef.current;
    if (!d || !el) return;
    const dx = e.clientX - d.x;
    if (!d.moved) {
      if (Math.abs(dx) < DRAG_SLOP) return;
      d.moved = true;
      setDragging(true);
    }
    el.scrollLeft = d.left - dx;
    noteManualScroll();
  }, [noteManualScroll]);
  const endDrag = useCallback(() => {
    if (dragRef.current?.moved) setDragging(false);
    dragRef.current = null;
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const el = viewportRef.current;
      if (!el) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        el.scrollLeft += e.key === "ArrowLeft" ? -120 : 120;
        noteManualScroll();
      }
    },
    [noteManualScroll],
  );

  // ── THEME-ADAPTIVE VIGNETTE (§5) ───────────────────────────────────────
  // Left/right fades composited over the LIVE background color so the
  // stream dissolves into whatever surface it sits on. Re-read whenever the
  // theme could flip (attribute mutations on <html> cover the light/dark
  // class toggle AND accent/custom scheme swaps via deriveCanvasTokens'
  // inline vars).
  const [bg, setBg] = useState<string | null>(null);
  useEffect(() => {
    let mo: MutationObserver | undefined;
    const update = () => setBg(readThemeBackground());
    update();
    if (typeof MutationObserver !== "undefined") {
      mo = new MutationObserver(update);
      mo.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme"],
      });
    }
    return () => mo?.disconnect();
  }, []);

  // The overflow state is no longer surfaced visually (the accent hint
  // rail and the Follow Latest chip were removed as user-requested visual
  // noise, 2026-11-24) — the vignette strips alone carry the containment.

  // Compose the horizontal fade from the live background: BOTH edges
  // dissolve into the surface (fixed relative to the VIEWPORT, never the
  // moving text — pointer-events-none overlays, §5). Two fixed-width edge
  // strips painted in the LIVE background color; their mask shapes live in
  // the CSS module (no calc() — jsdom's CSSOM, and thus our component
  // tests, reject calc() inside gradients; strips are equivalent and
  // testable everywhere).
  const edgeStyle = bg === null ? undefined : { backgroundColor: bg };

  return (
    <div className={styles.hrsRoot}>
      <div
        ref={viewportRef}
        className={
          styles.hrsViewport + (dragging ? " " + styles.hrsDragging : "")
        }
        style={{ height: ROW_H }}
        role="region"
        aria-label={ariaLabel}
        tabIndex={0}
        onWheel={onWheel}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onPointerCancel={endDrag}
      >
        {/* ONE continuous text element — every delta appends HERE (§2). */}
        <span className={styles.hrsStream}>
          {/* Reuse the existing selected streaming animation: FadeWords
              renders .wf spans whose per-word settle follows the
              html[data-stream-anim] override sheet — reasoning matches the
              main answer's configured reveal exactly (§4). */}
          <FadeWords text={revealed} fadeMs={fadeMs} />
          {active && animating ? (
            <span className={styles.hrsCaret} aria-hidden="true" />
          ) : null}
        </span>
        {/* Fixed-to-viewport edge vignette (over the scrollable text): two
            strips painted in the LIVE background color, masked towards
            transparency so each edge dissolves into the surface (§5). */}
        {bg !== null ? (
          <>
            <div
              className={`${styles.hrsVignette} ${styles.hrsVignetteLeft}`}
              style={edgeStyle}
              aria-hidden="true"
            />
            <div
              className={`${styles.hrsVignette} ${styles.hrsVignetteRight}`}
              style={edgeStyle}
              aria-hidden="true"
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
