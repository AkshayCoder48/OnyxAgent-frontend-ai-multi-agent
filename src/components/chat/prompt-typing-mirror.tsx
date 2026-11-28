"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * PromptTypingMirror — the composer's typing animation (user directive
 * 2026-11-24: "add this animation when we type our prompt in the prompt
 * box … not that auto writing").
 *
 * HOW IT WORKS — the syntax-highlight-mirror technique:
 *   · The TEXTAREA stays the real input (focus, caret, selection, mobile
 *     keyboards, slash palette — 100% native behavior) but paints its
 *     glyphs transparently (.prompt-mirror-text keeps the caret inked).
 *   · A MIRROR div behind it, with identical metrics (same width, font,
 *     padding, line-height, wrapping), paints the same text so the user
 *     still sees every character — and every freshly TYPED character
 *     mounts as its own span playing the reveal animation
 *     (.prompt-char-in: fade + 0.12em rise, 170ms — the MagicUI
 *     TypingAnimation character feel, applied to the user's OWN typing).
 *
 * SAFETY VALVES (the mirror must never lie or lag):
 *   · IME composition → the textarea renders natively (preedit text +
 *     underline must come from the OS; the mirror steps aside until
 *     compositionEnd).
 *   · Paste / dictation / any NON-typing delta (not a ≤3-char append at
 *     the end) → the boundary jumps to full length: everything renders
 *     as ONE static text node (no 200-span animation burst).
 *   · Deletions and middle edits → static, same reason.
 *   · prefers-reduced-motion → plain textarea, no mirror at all.
 *   · Internal scroll (>200px) → the mirror tracks the textarea's
 *     scrollTop so painted text and caret never desync.
 *
 * CARET ALIGNMENT (Task 50 → Task 52, the "cursor drifts from the text
 * while typing" fixes). The textarea's native caret positions itself
 * against the textarea's OWN text layout, so the mirror must paint a
 * layout-identical copy. Measured in a real Chromium (Task 52 pixel
 * harness, scripts/caret-drift-harness.py): EVERY per-char inline span
 * boundary costs ~+0.2px of subpixel layout snapping — 41 chars painted
 * as 41 spans measured 287.03px vs 286.73px as one unbroken text node.
 * While typing, that 0.2px/boundary ACCUMULATES: the painted text runs
 * progressively ahead of the native caret, and a deletion (which
 * collapses the tail into the static head) snaps it back — exactly the
 * reported symptom, just smaller than the inline-block bug Task 50
 * fixed. The only zero-divergence structure is the SAME one the textarea
 * itself lays out: ONE UNBROKEN TEXT NODE. So the animation must never
 * leave per-char boxes behind:
 *
 *   · SETTLE-TAIL MERGE (Task 52, hardened Task 53): a typed char
 *     animates as its own span for the 170ms reveal, then MERGES into
 *     the unbroken static head. At any instant at most the last few
 *     typed chars (≤ the typing-delta cap) are spanned, and the
 *     span/head boundary sits at or AFTER the caret — a boundary after
 *     the caret cannot shift any glyph position before it, and the
 *     boundary itself only ever accumulates ≤3 × 0.2px of transient,
 *     self-clearing divergence. The per-char pop is preserved (every
 *     char still mounts as a span and plays the animation exactly once);
 *     only the LINGERING boxes are gone. Task 53 hardened the timer: the
 *     expiry deadline is anchored to each char's OWN birth time (oldest
 *     alive char first), so continuous typing — which re-runs the effect
 *     every keystroke — can no longer postpone the merge forever (the
 *     Task 52 re-report: mid-sentence the tail grew unbounded and the
 *     drift came back).
 *   · Animated chars are INLINE spans, never inline-block (atomic
 *     inlines break the shaping run → kerning/ligature divergence —
 *     Task 50's finding, still true); the rise animates `top`, not
 *     transform (transforms are ignored on inline boxes).
 *   · Both elements carry the same scrollbar-gutter contract
 *     (.prompt-mirror-scroll / .prompt-mirror-gutter — BOTH declare
 *     scrollbar-gutter: stable so the engine reserves the SAME gutter
 *     width in both on every platform; the old hard-coded 8px
 *     padding-right was wrong wherever the platform scrollbar is not
 *     8px — overlay scrollbars (macOS/headless/many Android WebViews)
 *     reserve 0px, shifting every wrapped line's caret by 8px).
 * External value changes (dictation, quoted replies, command resets)
 * sync the boundary refs — a stale prevRef made the next keystroke's
 * typed-tail check compare against an ancient value.
 */

/** Typing-sized append: 1–3 chars at the end (a keystroke, maybe two
 * batched by a fast typist). Anything bigger is a paste/dictation drop.
 * ALSO the maximum number of animated char spans alive at once (the
 * settle-tail merge cap — see the caret-alignment note above). */
const TYPING_DELTA_MAX = 3;

/** The reveal animation's duration (ms) — after this a typed char's span
 * merges back into the static head (settle-tail merge). Keep in sync
 * with .prompt-char-in's animation duration in globals.css. */
const REVEAL_MS = 170;

interface PromptTypingMirrorProps {
  /** The composer's textarea ref (parent auto-resizes + focuses it). */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  disabled?: boolean;
  ariaLabel: string;
  /** Static native placeholder (plain, non-animated — the rotating
   *  auto-writing overlay was removed by the same user directive). */
  placeholder?: string;
}

export function PromptTypingMirror({
  textareaRef,
  value,
  onChange,
  onKeyDown,
  disabled,
  ariaLabel,
  placeholder,
}: PromptTypingMirrorProps) {
  const mirrorRef = React.useRef<HTMLDivElement | null>(null);

  // Reduced motion → never build the mirror (checked once, SSR-safe).
  const reduced = React.useMemo(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  // IME composition gate: while composing, the native preedit (with its
  // underline) must render in the textarea itself.
  const [composing, setComposing] = React.useState(false);

  // Plain boundary: leading char count rendered as one static text node.
  // Chars BEYOND it render as per-char spans (keyed by absolute index)
  // that play the reveal animation exactly ON MOUNT. `plain` lives in
  // STATE (it IS render output — the head/tail split), while prevRef holds
  // the last-seen value for the typed-tail comparison in the change handler.
  // Tasks 52/53: the SETTLE TIMER advances `plain` past chars whose own
  // reveal has ended — the tail never outlives its animation, so per-char
  // span boundaries never accumulate subpixel drift against the native
  // caret.
  const [plain, setPlain] = React.useState(value.length);
  const prevRef = React.useRef(value);

  // Per-char birth times for the animated tail (absolute index → ms when
  // the char was typed). Task 53: the settle timer's deadline must be
  // anchored to the OLDEST alive char — a fresh keystroke re-runs the
  // effect, and re-arming the FULL delay every time meant continuous
  // typing (<200ms between keystrokes) cancelled the timer forever: the
  // tail grew unbounded, every char stayed a live span, and the
  // accumulated per-span drift returned mid-typing (the Task 52 re-report:
  // "as I tap any letter it cuts the letter before it").
  const bornRef = React.useRef<Map<number, number>>(new Map());

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    const prev = prevRef.current;
    const delta = v.length - prev.length;
    // A TYPING append: small, at the end, while not composing. Everything
    // else (paste, dictation insert, autocorrect swap, deletion) renders
    // static — the boundary swallows the whole value.
    const typedTail =
      delta > 0 &&
      delta <= TYPING_DELTA_MAX &&
      v.startsWith(prev) &&
      !composing &&
      !reduced;
    if (!typedTail) {
      setPlain(v.length);
      bornRef.current.clear();
    } else {
      // Record the birth of every fresh char so its own reveal expiry —
      // not the next keystroke — decides when its span merges.
      const now = Date.now();
      for (let i = prev.length; i < v.length; i++) bornRef.current.set(i, now);
    }
    prevRef.current = v;
    onChange(v);
  };

  // EXTERNAL VALUE CHANGES (Task 50 caret-alignment hardening): the value
  // can change WITHOUT handleChange running — dictation appends via
  // setMessage, quoted replies land from the store, slash-command resets
  // clear it. prevRef then held a stale snapshot, so the next keystroke's
  // typed-tail check compared against an ancient value and the
  // plain-boundary could land mid-run with stale span keys (chars
  // re-animating, keys colliding with survivors). Sync whenever the prop
  // changes outside our own change event: any external change is by
  // definition NOT a typing append → static render, which is exactly the
  // safety the paste valve wants. (Setting state in an effect on a prop
  // change is the standard "sync external → internal" shape; it costs one
  // extra render ONLY on external changes, never per keystroke.)
  React.useEffect(() => {
    if (value !== prevRef.current) {
      prevRef.current = value;
      setPlain(value.length);
      bornRef.current.clear();
    }
  }, [value]);

  // SETTLE-TAIL MERGE (Tasks 52/53, the caret-drift root fix): advance the
  // plain boundary past every animated char whose OWN reveal has ended —
  // settled chars become part of the ONE unbroken text node that matches
  // the textarea's own layout (every lingering span boundary costs ~0.2px
  // of subpixel divergence against the native caret, accumulating while
  // typing). Task 53: the deadline is anchored to the OLDEST alive char's
  // BIRTH time, not re-armed from scratch on each keystroke — the Task 52
  // form re-ran this effect per keystroke and cancelled the pending timer,
  // so continuous typing (<200ms between keystrokes) never let it fire
  // and the tail grew unbounded (the full pre-fix drift mid-sentence).
  // Now each expiry merges only the chars that have actually finished
  // animating; a just-typed char keeps its span for its full 170ms even
  // while older siblings merge. One state update per expiry batch, never
  // per frame; a mid-reveal deletion simply re-runs this effect against
  // the current value (births past its length are dead indices — pruned).
  React.useEffect(() => {
    if (plain >= value.length) {
      bornRef.current.forEach((_t, i) => {
        if (i >= value.length) bornRef.current.delete(i);
      });
      return;
    }
    const now = Date.now();
    // OLDEST alive char's deadline (the MIN) — the timer fires at the
    // FIRST expiry, merges everything already expired, then re-arms for
    // the next-oldest. (max() would anchor to the NEWEST char and let
    // continuous typing slide the fire point forward forever — the exact
    // re-report.)
    const alive = Array.from(bornRef.current.entries())
      .filter(([i]) => i >= plain && i < value.length)
      .map(([, born]) => born + REVEAL_MS + 30);
    const deadline = alive.length ? Math.min(...alive) : now;
    const t = setTimeout(
      () => {
        const tnow = Date.now();
        // Expire every char whose own reveal window has closed…
        let next = plain;
        bornRef.current.forEach((born, i) => {
          if (i >= plain && i < value.length && born + REVEAL_MS + 30 <= tnow) {
            bornRef.current.delete(i);
            if (i + 1 > next) next = i + 1;
          }
        });
        // …but never past a still-animated survivor (boundary must stay
        // contiguous: settled head + animated tail, no interleaving).
        let firstAlive = value.length;
        bornRef.current.forEach((born, i) => {
          if (i >= next && i < value.length && born + REVEAL_MS + 30 > tnow && i < firstAlive) {
            firstAlive = i;
          }
        });
        setPlain(Math.min(next, firstAlive));
      },
      Math.max(0, deadline - now),
    );
    return () => clearTimeout(t);
  }, [plain, value.length]);

  // Scroll sync — the textarea scrolls internally past its 200px cap; the
  // painted mirror must follow or the text desyncs from the caret.
  const handleScroll = () => {
    if (mirrorRef.current && textareaRef.current) {
      mirrorRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  // Tail rendering: whitespace renders as plain fragments (animating a
  // space/newline is invisible, and spans around whitespace would change
  // the wrapping); every visible char is its own animated span. With the
  // settle-tail merge the tail is at most the last few typed chars.
  const head = value.slice(0, plain);
  const tail = value.slice(plain);
  const tailNodes: React.ReactNode[] = [];
  let wsRun = "";
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i]!;
    if (/\s/.test(ch)) {
      wsRun += ch;
    } else {
      if (wsRun) {
        tailNodes.push(wsRun);
        wsRun = "";
      }
      tailNodes.push(
        <span key={plain + i} className="prompt-char-in">
          {ch}
        </span>,
      );
    }
  }
  if (wsRun) tailNodes.push(wsRun);

  const mirrorOn = !reduced && !composing && !disabled;

  return (
    <div className="relative w-full">
      {mirrorOn && (
        <div
          ref={mirrorRef}
          aria-hidden
          className="prompt-mirror-gutter pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words min-h-[40px] w-full py-2.5 text-sm leading-relaxed text-foreground sm:text-[15px]"
        >
          {head}
          {tailNodes}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={onKeyDown}
        onScroll={handleScroll}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        aria-label={ariaLabel}
        className={cn(
          "prompt-mirror-scroll relative mb-height placeholder:text-muted-foreground/60 min-h-[40px] w-full resize-none scrollbar-thin bg-transparent py-2.5 text-sm leading-relaxed focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 sm:text-[15px]",
          mirrorOn && "prompt-mirror-text",
        )}
      />
    </div>
  );
}
