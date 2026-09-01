"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./ThinkingReasoning.module.css";

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
}

const MAX_H = 180; // capped viewport (CSS max-height, kept in sync)
const FADE = 16; // top/bottom fade once the viewport is capped

/**
 * The live sentence's words: all plain except the newest two, which render
 * tinted blue and settle into the normal ink over 700ms as they leave the
 * trailing window (PRD §14 / assistant-ui "Streaming text"). A caret rides
 * at the end while streaming. Word spans keep stable word-index keys so a
 * word leaving the window transitions color rather than remounting.
 */
function StreamingSentence({ text }: { text: string }) {
  const words = text.split(" ").filter(Boolean);
  const tintFrom = Math.max(0, words.length - 2);
  return (
    <>
      {words.map((w, wi) => (
        <span
          key={wi}
          className={styles.trWord + (wi >= tintFrom ? " " + styles.trWordTint : "")}
        >
          {w}
          {wi < words.length - 1 ? " " : ""}
        </span>
      ))}
      <span className={styles.trCaret} aria-hidden="true" />
    </>
  );
}

export function ThinkingReasoning({
  sentences,
  phase,
  elapsedSeconds,
  verb = "Thought",
  activeLabel = "Thinking…",
}: ThinkingReasoningProps) {
  const [open, setOpen] = useState(false);
  const [capped, setCapped] = useState(false);
  const [fade, setFade] = useState({ top: false, bottom: true });
  const viewportRef = useRef<HTMLDivElement>(null);

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
    const next = !open;
    if (next) {
      setFade({ top: false, bottom: true });
      if (viewportRef.current) viewportRef.current.scrollTop = 0;
    }
    setOpen(next);
  };

  // While thinking the reasoning is always open; once done it folds into
  // the summary and the user can toggle it back open.
  const expanded = done ? open : true;

  const showTop = scrollable ? fade.top : capped;
  const showBottom = scrollable ? fade.bottom : capped;
  const mask = capped
    ? `linear-gradient(to bottom, transparent 0, #000 ${showTop ? FADE : 0}px, #000 calc(100% - ${showBottom ? FADE : 0}px), transparent 100%)`
    : "none";
  const elapsedS = Math.max(1, Math.round(elapsedSeconds));

  return (
    <div className={styles.tr}>
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
        ) : (
          <span className={styles.trLabel + " " + styles.trShimmer}>
            {activeLabel}
          </span>
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
                  {!done && i === count - 1 ? (
                    <StreamingSentence text={line} />
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
