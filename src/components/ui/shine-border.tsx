"use client";

import React from "react";

import { cn } from "@/lib/utils";
import { MAGIC_UI_CONFIG } from "@/config/magic-ui";

/**
 * Shine Border (Magic UI) — a subtle animated background border effect.
 * PRD "Premium Magic UI Integration" §7:
 *
 *   Shine Border = MEDIA previews and AI-generated visual content —
 *   image/video search results, generated images + videos, GenUI previews,
 *   rich AI-created cards. Never both Shine Border AND Border Beam on the
 *   same container; never on every nested element (galleries get ONE
 *   effect around the gallery container).
 *
 * Pure CSS animation (motion-safe — reduced-motion users see a static
 * border), zero timers, cheap to mount many of. The parent container
 * must be `relative`; the shine inherits its rounded corners.
 */
interface ShineBorderProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Width of the border in pixels. @default 1 */
  borderWidth?: number;
  /** Duration of the animation in seconds. @default 14 */
  duration?: number;
  /** Color of the border — a single color or an array (multicolor). */
  shineColor?: string | string[];
}

export function ShineBorder({
  borderWidth,
  duration,
  shineColor,
  className,
  style,
  ...props
}: ShineBorderProps) {
  const cfg = MAGIC_UI_CONFIG.shineBorder;
  const colors = shineColor ?? cfg.shineColor;
  return (
    <div
      aria-hidden
      style={
        {
          "--border-width": `${borderWidth ?? cfg.borderWidth}px`,
          "--duration": `${duration ?? cfg.duration}s`,
          backgroundImage: `radial-gradient(transparent,transparent, ${
            Array.isArray(colors) ? colors.join(",") : colors
          },transparent,transparent)`,
          backgroundSize: "300% 300%",
          mask: `linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)`,
          WebkitMask: `linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)`,
          WebkitMaskComposite: "xor",
          maskComposite: "exclude",
          padding: "var(--border-width)",
          ...style,
        } as React.CSSProperties
      }
      className={cn(
        "motion-safe:animate-shine pointer-events-none absolute inset-0 size-full rounded-[inherit] will-change-[background-position]",
        className,
      )}
      {...props}
    />
  );
}
