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
 * CARET ALIGNMENT (Task 50, the "cursor drifts from the text while
 * typing" fix): the textarea's native caret positions itself against the
 * textarea's OWN text layout, so the mirror must paint a layout-
 * identical copy — see the caret-alignment contract in globals.css
 * (.prompt-char-in). Two structural rules:
 *   · Animated chars are INLINE spans, never inline-block (atomic
 *     inlines break the shaping run → kerning/ligature divergence →
 *     progressive caret drift); the rise animates `top`, not transform
 *     (transforms are ignored on inline boxes anyway).
 *   · Both elements carry the same scrollbar-gutter contract
 *     (.prompt-mirror-scroll / .prompt-mirror-gutter) so long prompts
 *     wrap identically past the 200px cap.
 * External value changes (dictation, quoted replies, command resets)
 * sync the boundary refs — a stale prevRef made the next keystroke's
 * typed-tail check compare against an ancient value.
 */

/** Typing-sized append: 1–3 chars at the end (a keystroke, maybe two
 *  batched by a fast typist). Anything bigger is a paste/dictation drop. */
const TYPING_DELTA_MAX = 3;

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
  // that play the reveal animation exactly ON MOUNT — existing spans keep
  // their keys across keystrokes so they never re-animate. `plain` lives in
  // STATE (it IS render output — the head/tail split), while prevRef holds
  // the last-seen value for the typed-tail comparison in the change handler.
  const [plain, setPlain] = React.useState(value.length);
  const prevRef = React.useRef(value);

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
    if (!typedTail) setPlain(v.length);
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
    }
  }, [value]);

  // Scroll sync — the textarea scrolls internally past its 200px cap; the
  // painted mirror must follow or the text desyncs from the caret.
  const handleScroll = () => {
    if (mirrorRef.current && textareaRef.current) {
      mirrorRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  // Tail rendering: whitespace renders as plain fragments (animating a
  // space/newline is invisible, and spans around whitespace would change
  // the wrapping); every visible char is its own animated span.
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
