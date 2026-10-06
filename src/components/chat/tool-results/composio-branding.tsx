"use client";

import { useState } from "react";
import { Puzzle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ComposioBranding } from "@/lib/composio/branding";

/**
 * ComposioToolBadge — the REAL platform identity (logo → letter-avatar →
 * generic integration glyph, in that order) for composio_* tool calls
 * (PRD §18–§23, §25). Sits in the existing icon slot of the tool cards with
 * a FIXED box size, so branding resolving after mount never shifts layout.
 *
 * Fallback chain (never a broken image, never the OnyxAgent logo — PRD §20):
 *   1. appLogo  → the remote CDN logo as a rounded, shrunk plain <img>
 *                 (Composio logos span many domains — next/image would need
 *                 per-domain config, hence the plain img).
 *   2. appName  → a letter-avatar tile (the app's initial on a neutral tile).
 *   3. neither  → the generic integration glyph (Puzzle — an integration
 *                 piece, NOT a platform guess).
 */

/** Fixed size classes per `size` (px) — static strings so Tailwind emits them. */
const SIZE_BOX: Record<number, string> = {
  14: "h-3.5 w-3.5",
  16: "h-4 w-4",
  20: "h-5 w-5",
};
const SIZE_LETTER: Record<number, string> = {
  14: "text-[8px]",
  16: "text-[9px]",
  20: "text-[11px]",
};

export function ComposioToolBadge({
  branding,
  size = 16,
  className,
}: {
  branding: ComposioBranding | null;
  /** Icon-slot size in px — 14 matches the h-3.5 timeline rows, 16 the tool
   *  card icon slot, 20 larger slots. */
  size?: 14 | 16 | 20;
  className?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const logo = branding?.appLogo ?? null;
  // A new logo URL resets a previous load failure (retry the new source) —
  // the render-time "adjust state when a prop changes" pattern from the
  // React docs (no effect → no cascading render; same approach as the
  // auto-expand adjustments in tool-call-card.tsx).
  const [prevLogo, setPrevLogo] = useState(logo);
  if (logo !== prevLogo) {
    setPrevLogo(logo);
    setFailedSrc(null);
  }

  const boxClass = SIZE_BOX[size] ?? SIZE_BOX[16]!;
  const letterClass = SIZE_LETTER[size] ?? SIZE_LETTER[16]!;
  const name = branding?.appName ?? null;

  // 1) Real platform logo — white tile so dark logos (e.g. GitHub's mark)
  //    stay visible on dark themes; onError falls through to the avatar.
  if (logo && failedSrc !== logo) {
    return (
      <span
        className={cn(
          "bg-white inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[4px]",
          boxClass,
          className,
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/no-noninteractive-element-interactions -- remote multi-domain Composio CDN logos (next/image would need per-domain config); onError is a load-failure handler, not an interaction */}
        <img
          src={logo}
          alt={name ?? "App logo"}
          className="h-full w-full p-px object-contain"
          loading="lazy"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailedSrc(logo)}
        />
      </span>
    );
  }

  // 2) Letter-avatar tile — the app's initial on a neutral tile.
  if (name) {
    return (
      <span
        aria-hidden
        className={cn(
          "bg-foreground/[0.06] text-foreground/70 inline-flex shrink-0 items-center justify-center rounded-[4px] font-semibold",
          boxClass,
          letterClass,
          className,
        )}
      >
        {name.charAt(0).toUpperCase()}
      </span>
    );
  }

  // 3) Unknown app → the generic integration glyph (NEVER a guessed logo).
  return <Puzzle aria-hidden className={cn("text-muted-foreground shrink-0", boxClass, className)} />;
}
