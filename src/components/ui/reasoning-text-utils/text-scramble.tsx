"use client";

// beui.dev/components/agents/loading-states

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export interface TextScrambleProps {
  /** Target text that resolves left to right. */
  text: string;
  /** Total scramble duration in ms. */
  duration?: number;
  className?: string;
  style?: CSSProperties;
}

function randomGlyph(): string {
  return GLYPHS[Math.floor(Math.random() * GLYPHS.length)] ?? "x";
}

/**
 * Scramble-in text: unresolved characters flicker through random glyphs
 * while the real phrase resolves left to right. Falls back to plain text
 * when the user prefers reduced motion.
 */
export function TextScramble({ text, duration = 700, className, style }: TextScrambleProps) {
  // Resolved once on mount — SSR renders the plain text either way.
  const [reduce] = useState(() =>
    typeof window !== "undefined"
      ? Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
      : false,
  );
  const [display, setDisplay] = useState(text);
  const frameRef = useRef<number>(0);
  const startRef = useRef<number>(0);

  useEffect(() => {
    if (reduce) return;
    startRef.current = performance.now();
    cancelAnimationFrame(frameRef.current);

    const tick = (now: number) => {
      const progress = Math.min(1, (now - startRef.current) / Math.max(80, duration));
      const settled = Math.floor(progress * text.length);
      let next = text.slice(0, settled);
      for (let i = settled; i < text.length; i += 1) {
        const source = text[i] ?? " ";
        next += source === " " ? " " : randomGlyph();
      }
      setDisplay(next);
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(tick);
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [text, duration, reduce]);

  return (
    <span className={cn("inline-block whitespace-pre", className)} style={style}>
      {reduce ? text : display}
    </span>
  );
}

export default TextScramble;
