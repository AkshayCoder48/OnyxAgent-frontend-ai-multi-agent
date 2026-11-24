"use client";

import { type ReactNode, useEffect, useState } from "react";
import styles from "./ThinkingReasoning.module.css";
import { HorizontalReasoningStream } from "./horizontal-reasoning-stream";

/**
 * ThinkingReasoning — the reasoning presentation shell (AICSS "Thinking +
 * Reasoning" recipe) now carrying the ADAPTIVE HORIZONTAL REASONING STREAM
 * (PRD 2026-11-24): the reasoning renders as ONE continuous horizontal
 * text line inside a fixed-height viewport that auto-follows the arriving
 * stream — never vertical expansion, never per-sentence rows. The header
 * line ("● Thinking · Used 6 tools" live / "Thought for Ns" settled)
 * remains exactly as recognizable as before.
 *
 * Rendering-only change (PRD §10): the SAME reasoning deltas feed the SAME
 * reveal engine (useWordTypewriter + FadeWords inside the horizontal
 * stream), so the user's selected streaming animation, its speed and the
 * disabled-animation behaviour all carry over untouched. `sentences` is
 * joined into the single stream text; nothing is split into cards,
 * slides or segments — and nothing is truncated (the stream scrolls, the
 * full text stays in the DOM).
 */
export interface ThinkingReasoningProps {
  /** The reasoning sentences, in order — JOINED into the one stream. */
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
   *  header button entirely — the stream renders bare and the host
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

/**
 * Join the sentence list back into the ONE continuous stream text. The
 * splitter upstream normalized whitespace; a single space separator keeps
 * the stream flowing as one line (PRD §2 — no paragraph breaks in the
 * horizontal stream; sentence punctuation already carries the pauses).
 */
function joinStream(sentences: readonly string[]): string {
  return sentences.filter(Boolean).join(" ");
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

  useEffect(() => {
    // Under reduced motion the block starts expanded (no reveal animations).
    // Deferred via setTimeout so no setState runs synchronously in the effect
    // body (React Compiler lint: cascading renders).
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setTimeout(() => setOpen(true), 0);
    return () => window.clearTimeout(id);
  }, []);

  const toggle = () => {
    setUserToggled(true);
    setOpen((v) => !v);
  };

  // While thinking the stream is always open; once done it folds into the
  // summary and the user can toggle it back open — UNLESS keepOpenOnDone
  // (no-tools turns): the block rests EXPANDED and only a manual toggle
  // folds it (auto-collapse removed for tool-less turns).
  const doneExpanded = userToggled ? open : keepOpenOnDone;
  const done = phase === "done";
  const expanded = done ? doneExpanded : true;

  const elapsedS = Math.max(1, Math.round(elapsedSeconds));
  const streamText = joinStream(sentences);

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
          {/* ONE continuous horizontal stream — fixed height, auto-follow,
              manual swipe/drag, adaptive vignette (PRD §2–§8). Rendered
              while live and after settle (re-open re-reads); a collapsed
              settled block unmounts it (cheap). */}
          {streamText ? (
            <HorizontalReasoningStream
              text={streamText}
              active={!done}
              ariaLabel={activeLabel}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
