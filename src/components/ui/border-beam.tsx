"use client";

import React from "react";
import { motion, useInView, useReducedMotion } from "framer-motion";

import { cn } from "@/lib/utils";
import { MAGIC_UI_CONFIG } from "@/config/magic-ui";

/**
 * Border Beam (Magic UI) — an animated beam of light that travels along
 * the border of its container. PRD "Premium Magic UI Integration" §5:
 *
 *   Border Beam = ACTIVE, important, interactive containers — the prompt
 *   composer, selection interfaces (model/provider/tool pickers), the
 *   question/todo/approval UIs, active generation cards. Never on every
 *   card; inactive cards keep the normal glass border; never two beams on
 *   nested containers.
 *
 * Adapted from the Magic UI reference for this repo:
 *  · framer-motion (installed) instead of the `motion` package.
 *  · The border mask is inline CSS (works on every Tailwind 4 minor —
 *    no dependency on the newest `mask-*` utilities).
 *  · Off-screen beams unmount (PRD §14.2 — no animation loops on
 *    off-screen components) and reduced-motion renders nothing.
 *
 * The parent container must be `relative` and own a border radius
 * (the beam inherits it via `rounded-[inherit]`).
 */
interface BorderBeamProps {
  /** The size of the border beam. */
  size?: number;
  /** The duration of the border beam, in seconds. */
  duration?: number;
  /** The delay of the border beam, in seconds. */
  delay?: number;
  /** The gradient start color. */
  colorFrom?: string;
  /** The gradient end color. */
  colorTo?: string;
  /** Custom framer-motion transition (overrides duration/ease). */
  transition?: import("framer-motion").Transition;
  className?: string;
  style?: React.CSSProperties;
  /** Reverse the animation direction. */
  reverse?: boolean;
  /** Initial offset position (0-100). */
  initialOffset?: number;
  /** Border width of the beam in px. */
  borderWidth?: number;
}

export const BorderBeam = ({
  className,
  size = 50,
  delay = 0,
  duration,
  colorFrom,
  colorTo,
  transition,
  style,
  reverse = false,
  initialOffset = 0,
  borderWidth,
}: BorderBeamProps) => {
  const cfg = MAGIC_UI_CONFIG.borderBeam;
  const durationS = duration ?? cfg.duration;
  const sizePx = size ?? cfg.size;
  const from = colorFrom ?? cfg.colorFrom;
  const to = colorTo ?? cfg.colorTo;
  const width = borderWidth ?? cfg.borderWidth;

  const ref = React.useRef<HTMLDivElement | null>(null);
  const inView = useInView(ref, { amount: 0.1 });
  const reduced = useReducedMotion();

  // Reduced motion or off-screen: no beam at all (the container keeps its
  // normal border — the beam is purely decorative).
  if (reduced) return null;

  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-0 rounded-[inherit] border-transparent"
      style={
        {
          borderWidth: `${width}px`,
          borderStyle: "solid",
          // Border-only mask (the same pattern ShineBorder uses): paint on
          // the border ring ONLY — padding-box and border-box layers
          // composited with exclude — so the beam never overlaps text or
          // interactive elements (PRD §5 visual behavior).
          mask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
          WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
          maskComposite: "exclude",
          WebkitMaskComposite: "xor",
          ...style,
        } as React.CSSProperties
      }
    >
      {inView && (
        <motion.div
          className={cn(
            "absolute aspect-square",
            "bg-linear-to-l",
            className,
          )}
          style={
            {
              width: sizePx,
              offsetPath: `rect(0 auto auto 0 round ${sizePx}px)`,
              // Gradient via inline style keeps the two colors configurable
              // without relying on CSS custom-property plumbing.
              backgroundImage: `linear-gradient(to left, ${from}, ${to}, transparent)`,
              ...style,
            } as React.CSSProperties
          }
          initial={{ offsetDistance: `${initialOffset}%` }}
          animate={{
            offsetDistance: reverse
              ? [`${100 - initialOffset}%`, `${-initialOffset}%`]
              : [`${initialOffset}%`, `${100 + initialOffset}%`],
          }}
          transition={{
            repeat: Infinity,
            ease: "linear",
            duration: durationS,
            delay: -delay,
            ...transition,
          }}
        />
      )}
    </div>
  );
};
