"use client";

import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type RefAttributes,
  type RefObject,
} from "react";
import {
  motion,
  useInView,
  useReducedMotion,
  type HTMLMotionProps,
  type MotionProps,
} from "framer-motion";

import { cn } from "@/lib/utils";
import { MAGIC_UI_CONFIG } from "@/config/magic-ui";

/**
 * Typing Animation (Magic UI) — characters appearing in a typed animation.
 * PRD "Premium Magic UI Integration" §6: the EMPTY prompt composer shows
 * rotating placeholder suggestions ("Build a complete website…", "Research
 * a topic…", …). The animation is display-only — it must never touch the
 * user's text, cursor position, IME composition or the input itself (the
 * composer overlays it and stops it the moment typing starts).
 *
 * Adapted from the Magic UI reference: framer-motion (installed) instead
 * of the `motion` package; reduced-motion renders the current suggestion
 * statically with NO timers (PRD §14.8), and the loop pauses whenever the
 * element is off-screen (PRD §14.2).
 */

type TypingAnimationProps = Omit<HTMLMotionProps<"span">, "children"> &
  MotionProps & {
    /** Single string to animate (mutually exclusive with `words`). */
    children?: string;
    /** Array of strings to type and delete in sequence. */
    words?: string[];
    className?: string;
    /** Duration for each character (ms per char, `typeSpeed` alias). */
    duration?: number;
    typeSpeed?: number;
    deleteSpeed?: number;
    /** Delay before the animation starts (ms). */
    delay?: number;
    /** Pause duration between words (ms). */
    pauseDelay?: number;
    /** Whether to loop the word cycle forever. */
    loop?: boolean;
    /** Render element (span by default — inline, no layout shift). */
    as?: "article" | "div" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li" | "p" | "section" | "span";
    /** Start only when scrolled into view. */
    startOnView?: boolean;
    showCursor?: boolean;
    blinkCursor?: boolean;
    cursorStyle?: "line" | "block" | "underscore";
  };

export function TypingAnimation({
  children,
  words,
  className,
  duration,
  typeSpeed,
  deleteSpeed,
  delay = 0,
  pauseDelay,
  loop = false,
  as = "span",
  startOnView = true,
  showCursor = true,
  blinkCursor = true,
  cursorStyle = "line",
  ...props
}: TypingAnimationProps) {
  const cfg = MAGIC_UI_CONFIG.typingAnimation;
  const MotionComponent = motion[as] as ComponentType<
    Omit<HTMLMotionProps<"span">, "ref"> & RefAttributes<HTMLElement>
  >;

  const [displayedText, setDisplayedText] = useState<string>("");
  const [currentWordIndex, setCurrentWordIndex] = useState(0);
  const [currentCharIndex, setCurrentCharIndex] = useState(0);
  const [phase, setPhase] = React.useState<"typing" | "pause" | "deleting">("typing");
  const elementRef = useRef<HTMLElement | null>(null);
  const reduced = useReducedMotion();
  const isInView = useInView(elementRef as RefObject<Element>, {
    amount: 0.3,
    once: true,
  });

  const wordsToAnimate = useMemo(
    () => words ?? (children ? [children] : []),
    [words, children],
  );
  const hasMultipleWords = wordsToAnimate.length > 1;

  const typingSpeed = typeSpeed ?? duration ?? cfg.typeSpeed;
  const deletingSpeed = deleteSpeed ?? typingSpeed / 2;
  const pauseMs = pauseDelay ?? cfg.pauseDelay;

  const shouldStart = (startOnView ? isInView : true) && !reduced;
  const animationSourceKey = useMemo(
    () => (words ? words.join("\u0000") : (children ?? "")),
    [words, children],
  );

  // Reset when the word list changes identity.
  const [prevSourceKey, setPrevSourceKey] = useState(animationSourceKey);
  if (prevSourceKey !== animationSourceKey) {
    setPrevSourceKey(animationSourceKey);
    setDisplayedText("");
    setCurrentWordIndex(0);
    setCurrentCharIndex(0);
    setPhase("typing");
  }

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | null = null;

    if (shouldStart && wordsToAnimate.length > 0) {
      const timeoutDelay =
        delay > 0 && displayedText === ""
          ? delay
          : phase === "typing"
            ? typingSpeed
            : phase === "deleting"
              ? deletingSpeed
              : pauseMs;

      timeout = setTimeout(() => {
        const currentWord = wordsToAnimate[currentWordIndex] || "";
        const graphemes = Array.from(currentWord);

        switch (phase) {
          case "typing":
            if (currentCharIndex < graphemes.length) {
              setDisplayedText(graphemes.slice(0, currentCharIndex + 1).join(""));
              setCurrentCharIndex(currentCharIndex + 1);
            } else if (hasMultipleWords || loop) {
              const isLastWord = currentWordIndex === wordsToAnimate.length - 1;
              if (!isLastWord || loop) {
                setPhase("pause");
              }
            }
            break;

          case "pause":
            setPhase("deleting");
            break;

          case "deleting":
            if (currentCharIndex > 0) {
              setDisplayedText(graphemes.slice(0, currentCharIndex - 1).join(""));
              setCurrentCharIndex(currentCharIndex - 1);
            } else {
              const nextIndex = (currentWordIndex + 1) % wordsToAnimate.length;
              setCurrentWordIndex(nextIndex);
              setPhase("typing");
            }
            break;
        }
      }, timeoutDelay);
    }

    return () => {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
    };
  }, [
    shouldStart,
    phase,
    currentCharIndex,
    currentWordIndex,
    displayedText,
    wordsToAnimate,
    hasMultipleWords,
    loop,
    typingSpeed,
    deletingSpeed,
    pauseMs,
    delay,
  ]);

  const currentWordGraphemes = Array.from(wordsToAnimate[currentWordIndex] || "");
  const isComplete =
    !loop &&
    currentWordIndex === wordsToAnimate.length - 1 &&
    currentCharIndex >= currentWordGraphemes.length &&
    phase !== "deleting";

  const shouldShowCursor =
    showCursor &&
    !isComplete &&
    !reduced &&
    (hasMultipleWords || loop || currentCharIndex < currentWordGraphemes.length);

  const getCursorChar = () => {
    switch (cursorStyle) {
      case "block":
        return "▌";
      case "underscore":
        return "_";
      case "line":
      default:
        return "|";
    }
  };

  return (
    <MotionComponent
      ref={elementRef}
      className={cn(
        "tracking-[-0.02em]",
        as === "span" && "inline-block",
        className,
      )}
      {...props}
    >
      {/* Reduced motion: the current suggestion, statically — no typing,
          no blinking cursor, no timers (PRD §14.8). */}
      {reduced
        ? (wordsToAnimate[currentWordIndex] ?? "")
        : displayedText}
      {shouldShowCursor && (
        <span
          aria-hidden
          className={cn("inline-block", blinkCursor && "animate-blink-cursor")}
        >
          {getCursorChar()}
        </span>
      )}
    </MotionComponent>
  );
}
