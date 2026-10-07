"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import styles from "./ThinkingReasoning.module.css";
import { useTypewriter, LetterStream } from "./letter-stream";

/**
 * ThinkingReasoning — an animated, collapsible thinking block (AICSS
 * "Thinking + Reasoning" recipe): a shimmering label expands to reveal the
 * agent's reasoning, then folds into a "Thought for Ns" summary.
 *
 * Adapted from the reference to be props-driven (the sentences stream in
 * from the agent's live thinking/reasoning text, and `phase` is flipped by
 * the caller when the turn settles). Honors prefers-reduced-motion.
 *
 * NATURAL ROW HEIGHTS (PRD §5 — reasoning text formatting): sentences used
 * to sit in FIXED 40px two-line boxes — short sentences left ~20px of dead
 * space under them (the "unwanted gaps") and long sentences were clipped at
 * two lines. Rows now size to their content: line-height 20px, 4px gaps,
 * no clamping, with a 180px capped scroll viewport + 16px edge fades.
 */
export interface ThinkingReasoningProps {
  /** The reasoning sentences, in order — revealed as they arrive. */
  sentences: readonly string[];
  /** "thinking" while streaming, "done" once the block settles. */
  phase: "thinking" | "done";
  /** Seconds to show in the settled summary ("Thought for Ns"). */
  elapsedSeconds: number;
  /** Verb for the settled summary — "Thought" or "Reasoned". */
  verb?: string;
  /** Label while streaming — "Thinking…" or "Reasoning…". */
  activeLabel?: string;
  /** LIVE HEADER OVERRIDE (thinking-text continuity fix): while streaming,
  // render this node as the header INSTEAD of the static shimmer label —
  // the SAME cycling status indicator the message showed BEFORE the first
  // reasoning sentence arrived, so the "thinking" text never visibly
  // changes character the moment real thinking starts. Ignored once the
  // block settles (the "Thought for Ns" summary replaces it). */
  headerNode?: ReactNode;
  /** HEADERLESS LIVE MODE (WorkingPanel): while streaming, skip the
   *  header button entirely — the sentences stream bare and the host
   *  panel's own trigger line owns the "Thinking" status (no duplicate
   *  shimmer labels stacked). The settled "Thought for Ns" header still
   *  renders once the stream ends. */
  headerlessLive?: boolean;
  /** NO AUTO-COLLAPSE (user directive: "if no tool ran, auto detect and
   *  remove auto collapsing"): when true, the DONE state stays EXPANDED
   *  by default — the user folds it manually. Default false keeps the
   *  classic fold-to-summary behavior (used where a host panel owns the
   *  collapse, or where collapsing is desired). */
  keepOpenOnDone?: boolean;
}

const MAX_H = 180; // capped viewport (CSS max-height, kept in sync)
const FADE = 16; // top/bottom fade once the viewport is capped

/**
 * The sentences stream in LETTER BY LETTER — useTypewriter buffers each
 * growing sentence and reveals one character at a time at full ink (NO
 * per-letter fade/blur). The FIRST sentence of a thinking block holds the
 * stream-start delay (180ms); later sentences flow with a tiny 40ms
 * pacing gap. A caret rides at the end of the LIVE last sentence.
 *
 * NO INTER-SENTENCE DUMPS: every sentence of a live block keeps its own
 * typewriter (stable index keys), so when a NEW sentence starts, the
 * previous one flips `active` → false and FINISHES its remaining reveal
 * at catch-up pace instead of snapping to full text (the round-end
 * "auto-throwing" rule, applied at sentence boundaries too).
 */
function StreamingSentence({
  text,
  holdMs,
  active,
}: {
  text: string;
  holdMs: number;
  /** True only for the LIVE trailing sentence — previous sentences finish
   *  their reveal paced, then rest fully revealed. */
  active: boolean;
}) {
  const { text: revealed, animating } = useTypewriter(text, active, {
    initialDelayMs: holdMs,
  });
  return (
    <>
      <LetterStream text={revealed} />
      {active && animating && <span className={styles.trCaret} aria-hidden="true" />}
    </>
  );
}

export function ThinkingReasoning({
  sentences,
  phase,
  elapsedSeconds,
  verb = "Thought",
  activeLabel = "Thinking…",
  headerNode,
  headerlessLive = false,
  keepOpenOnDone = false,
}: ThinkingReasoningProps) {
  const [open, setOpen] = useState(false);
  const [userToggled, setUserToggled] = useState(false);
  const [capped, setCapped] = useState(false);
  const [fade, setFade] = useState({ top: false, bottom: true });
  const viewportRef = useRef<HTMLDivElement>(null);

  // EVER-LIVE (finish-don't-flush): a block that STREAMED in this session
  // keeps its per-sentence typewriters mounted after settle so the last
  // sentence can finish revealing at catch-up pace — only the block's
  // collapse hides it. A block that mounts ALREADY settled (hydrated
  // history) renders plain text instantly (no timers, spec §23).
  // Render-time adjustment (no effect, no cascading renders).
  const [everLive, setEverLive] = useState(phase === "thinking");
  const [prevLive, setPrevLive] = useState(phase === "thinking");
  if (phase === "thinking" && !prevLive) {
    setPrevLive(true);
    setEverLive(true);
  }

  const done = phase === "done";
  const count = sentences.length;
  const scrollable = done && open;

  // Capped detection + follow-the-stream auto-scroll. Runs whenever the
  // sentence list grows (streaming) or the block expands (done + open).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const over = el.scrollHeight > el.clientHeight + 1;
    setCapped(over);
    if (!done && over) {
      // While streaming, keep the newest sentence in view.
      el.scrollTop = el.scrollHeight;
    }
    if (scrollable) {
      setFade({
        top: el.scrollTop > 1,
        bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
      });
    }
  }, [count, done, scrollable]);

  useEffect(() => {
    // Under reduced motion the block starts expanded (no reveal animations).
    // Deferred via setTimeout so no setState runs synchronously in the effect
    // body (React Compiler lint: cascading renders).
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setTimeout(() => setOpen(true), 0);
    return () => window.clearTimeout(id);
  }, []);

  const onScroll = () => {
    const el = viewportRef.current;
    if (!el) return;
    setFade({
      top: el.scrollTop > 1,
      bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
    });
  };

  const toggle = () => {
    const next = !expanded;
    if (next) {
      setFade({ top: false, bottom: true });
      if (viewportRef.current) viewportRef.current.scrollTop = 0;
    }
    setUserToggled(true);
    setOpen(next);
  };

  // While thinking the reasoning is always open; once done it folds into
  // the summary and the user can toggle it back open — UNLESS
  // keepOpenOnDone (no-tools turns): the block rests EXPANDED and only a
  // manual toggle folds it (auto-collapse removed for tool-less turns).
  const doneExpanded = userToggled ? open : keepOpenOnDone;
  const expanded = done ? doneExpanded : true;

  const showTop = scrollable ? fade.top : capped;
  const showBottom = scrollable ? fade.bottom : capped;
  const mask = capped
    ? `linear-gradient(to bottom, transparent 0, #000 ${showTop ? FADE : 0}px, #000 calc(100% - ${showBottom ? FADE : 0}px), transparent 100%)`
    : "none";
  const elapsedS = Math.max(1, Math.round(elapsedSeconds));

  return (
    <div className={styles.tr}>
      {headerlessLive && !done ? null : (
        <button
          type="button"
          className={styles.trHeader + (done ? " " + styles.isClickable : "")}
          aria-expanded={expanded}
          aria-label="Toggle thought"
          onClick={done ? toggle : undefined}
        >
          {done ? (
            <span className={styles.trLabel}>
              <span className={styles.trVerb}>{verb}</span> for {elapsedS}s
            </span>
          ) : headerNode !== undefined && headerNode !== null ? (
            // The caller's LIVE status node (cycling AI phrases) — identical
            // to the pre-thinking indicator so the status text never swaps.
            <span className={styles.trLiveNode}>{headerNode}</span>
          ) : (
            <span className={styles.trLabel}>{activeLabel}</span>
          )}
          {done && (
            <svg
              className={styles.trChevron}
              viewBox="0 0 24 24"
              width="12"
              height="12"
              aria-hidden="true"
            >
              <path
                d="m4.5 15.75 7.5-7.5 7.5 7.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
      )}
      <div
        className={styles.trCollapsible + (expanded ? "" : " " + styles.isCollapsed)}
      >
        <div className={styles.trInner}>
          <div
            ref={viewportRef}
            className={styles.trViewport + (scrollable ? " " + styles.isScroll : "")}
            style={{
              maxHeight: `${MAX_H}px`,
              WebkitMaskImage: mask,
              maskImage: mask,
            }}
            onScroll={scrollable ? onScroll : undefined}
          >
            <div className={styles.trStream}>
              {sentences.slice(0, count).map((line, i) => (
                <p key={i} className={styles.trSentence}>
                  {everLive ? (
                    <StreamingSentence
                      text={line}
                      holdMs={count === 1 ? 180 : 40}
                      active={phase === "thinking" && i === count - 1}
                    />
                  ) : (
                    line
                  )}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
