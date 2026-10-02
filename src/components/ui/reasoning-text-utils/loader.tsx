"use client";

// beui.dev/components/agents/loading-states

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export type LoaderVariant = "ascii-line" | "ascii-dots" | "bar";

/** Terminal-style spinner frames. */
const ASCII_LINE_FRAMES = ["|", "/", "-", "\\"] as const;
const ASCII_DOT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const VARIANT_FRAMES: Record<LoaderVariant, readonly string[]> = {
  "ascii-line": ASCII_LINE_FRAMES,
  "ascii-dots": ASCII_DOT_FRAMES,
  bar: ["▰▱▱", "▰▰▱", "▰▰▰", "▱▰▰", "▱▱▰", "▱▱▱"],
};

export interface LoaderProps {
  /** Frame set drawn while the agent works. */
  variant?: LoaderVariant;
  /** Glyph size in pixels. */
  size?: number;
  /** Seconds each frame stays on screen. */
  speed?: number;
  /** Accessible description announced once to screen readers. */
  label?: string;
  className?: string;
}

/**
 * A terminal-style ASCII loader. Frames advance on a timer and pause when
 * the user prefers reduced motion.
 */
export function Loader({
  variant = "ascii-line",
  size = 14,
  speed = 0.8,
  label = "Loading",
  className,
}: LoaderProps) {
  const frames = VARIANT_FRAMES[variant];
  const frameMs = Math.max(40, speed * 1000);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % frames.length);
    }, frameMs);
    return () => window.clearInterval(timer);
  }, [frameMs, frames.length]);

  return (
    <span
      className={cn("inline-flex items-center justify-center font-mono leading-none", className)}
      style={{ fontSize: `${size}px`, width: `${Math.max(size, size * 1.1)}px`, textAlign: "center" }}
      aria-hidden="true"
    >
      {frames[index % frames.length]}
      <span className="sr-only">{label}</span>
    </span>
  );
}

export default Loader;
