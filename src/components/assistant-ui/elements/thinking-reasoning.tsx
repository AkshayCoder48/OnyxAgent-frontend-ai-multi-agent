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
 * the caller when the turn settles) while preserving the reference geometry:
 * 40px sentence rows, 4px gaps, a 180px capped viewport with 16px fades,
 * and the ~360ms collapse beat. Honors prefers-reduced-motion.
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

// Geometry — keep in sync with the CSS below (reference values).
const SENT_H = 40; // 2 lines × 20px
const GAP = 4;
const MAX_H = 180; // viewport grows with content up to this, then scrolls
const FADE = 16; // top/bottom fade once the viewport is capped

export function ThinkingReasoning({
  sentences,
  phase,
  elapsedSeconds,
  verb = "Thought",
  activeLabel = "Thinking…",
}: ThinkingReasoningProps) {
  const [open, setOpen] = useState(false);
  const [fade, setFade] = useState({ top: false, bottom: true });
  const viewportRef = useRef<HTMLDivElement>(null);

  const done = phase === "done";
  const count = sentences.length;
  const contentH = count > 0 ? count * SENT_H + (count - 1) * GAP : 0;
  const capped = contentH > MAX_H;
  const viewH = capped ? MAX_H : contentH;
  const scrollable = done && open;
  const translate = scrollable ? 0 : capped ? MAX_H - FADE - contentH : 0;
  const showTop = scrollable ? fade.top : capped;
  const showBottom = scrollable ? fade.bottom : capped;
  const mask = capped
    ? `linear-gradient(to bottom, transparent 0, #000 ${showTop ? FADE : 0}px, #000 calc(100% - ${showBottom ? FADE : 0}px), transparent 100%)`
    : "none";
  const elapsedS = Math.max(1, Math.round(elapsedSeconds));

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
              height: `${viewH}px`,
              WebkitMaskImage: mask,
              maskImage: mask,
            }}
            onScroll={scrollable ? onScroll : undefined}
          >
            <div
              className={styles.trStream}
              style={{ transform: `translateY(${translate}px)` }}
            >
              {sentences.slice(0, count).map((line, i) => (
                <p key={i} className={styles.trSentence}>
                  {line}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
