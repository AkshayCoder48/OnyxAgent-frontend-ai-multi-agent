"use client";

import { useState, type ReactNode } from "react";
import { Puzzle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ComposioBranding } from "@/lib/composio/branding";

/**
 * Composio platform identity in a premium glass/mirror SQUIRCLE — the
 * macOS-dock treatment (PRD §18–§23, §25): a translucent frosted surface
 * (backdrop blur), a hairline border, and a soft top reflection, all clipped
 * to a superellipse, with the service's REAL logo inside (GitHub, LinkedIn,
 * YouTube, Discord, Gmail, Slack…) — never a generic OnyxAgent logo (§20).
 *
 * Fallback chain (same semantics, new visuals):
 *   1. appLogo  → the remote CDN logo on a softened white tile inside the
 *                 glass squircle (Composio logos span many domains —
 *                 next/image would need per-domain config, hence the plain
 *                 img; the white tile keeps dark-on-transparent logos
 *                 visible on dark themes).
 *   2. appName  → a letter-avatar tile (the app's initial on a primary
 *                 gradient tile inside the same glass squircle).
 *   3. neither  → the generic integration glyph (Puzzle — an integration
 *                 piece, NOT a platform guess) on the bare glass surface.
 */

// ---------------------------------------------------------------------------
// The squircle clip — ONE shared SVG def
// ---------------------------------------------------------------------------

/** The superellipse ("squircle") path in 0..1 box units — a rounded square
 *  whose corner fullness sits between a circle and a CSS border-radius (the
 *  macOS icon silhouette). */
const SQUIRCLE_PATH =
  "M 0,0.5 C 0,0 0,0 0.5,0 S 1,0 1,0.5 1,1 0.5,1 0,1 0,0.5";

/**
 * SquircleDefs — the shared clipPath, emitted once per badge container as a
 * 0×0 hidden SVG. `clipPathUnits="objectBoundingBox"` makes the 0..1 path
 * scale onto whatever element references `url(#onyx-squircle-clip)`, so every
 * icon size (14px chat badges → 56px settings dock icons) reuses the same
 * def; the identical duplicates across badge instances are interchangeable.
 */
export function SquircleDefs() {
  return (
    <svg
      width="0"
      height="0"
      aria-hidden
      className="pointer-events-none absolute h-0 w-0"
    >
      <defs>
        <clipPath id="onyx-squircle-clip" clipPathUnits="objectBoundingBox">
          <path d={SQUIRCLE_PATH} />
        </clipPath>
      </defs>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// GlassSquircleIcon — the shared glass/mirror dock wrapper
// ---------------------------------------------------------------------------

/**
 * GlassSquircleIcon — the macOS-dock glass/mirror squircle wrapper shared by
 * the chat-side Composio badges (ComposioToolBadge) and the Integrations
 * settings cards' toolkit icons.
 *
 * Layers (built so every piece survives the squircle clip):
 *   • outer span — the fixed positioning box + the soft shadow blob
 *     (`rounded-[21%]` approximates the squircle silhouette so the shadow
 *     follows it; NOT clipped, or the shadow would be cut away entirely)
 *   • SquircleDefs — the one shared clipPath def (0×0, zero layout impact)
 *   • border layer — a squircle-clipped fill one pixel larger than the
 *     surface, reading as a hairline border. A CSS `border` would be cut
 *     away at the squircle's corners by the clip, so the border is its own
 *     clipped layer instead.
 *   • glass surface — `inset-px`, squircle-clipped, `overflow-hidden`:
 *     an adaptive translucent tint + `backdrop-blur-xl` + the soft top
 *     reflection (a `from-white/15` gradient over the top half — the
 *     "mirror" sheen).
 *   • content — the logo / letter / glyph, centered above the glass.
 *
 * Hover (scale/lift/shadow) is opt-in via `className` — the inline chat
 * badges are non-interactive and pass nothing; the settings dock icons pass
 * the `group-hover:*` lift tied to their card's hover.
 */
export function GlassSquircleIcon({
  boxClass,
  className,
  surfaceClassName,
  children,
}: {
  /** The squircle box — a static Tailwind size string ("h-4 w-4",
   *  "h-14 w-14") so the class is emitted. */
  boxClass: string;
  /** Passthrough classes for the outer box (margins, hover lift…). */
  className?: string;
  /** Replaces the default neutral glass tint — e.g. the softened white logo
   *  tile ("bg-white/90") or the letter-avatar gradient. */
  surfaceClassName?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "shadow-lg relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[21%]",
        boxClass,
        className,
      )}
    >
      <SquircleDefs />
      {/* Hairline squircle border — the clipped fill behind the surface. */}
      <span
        aria-hidden
        className="bg-foreground/10 dark:bg-white/15 absolute inset-0"
        style={{ clipPath: "url(#onyx-squircle-clip)" }}
      />
      {/* The glass surface — tint + backdrop blur + top reflection, clipped
          to the squircle. */}
      <span
        aria-hidden
        className={cn(
          "backdrop-blur-xl absolute inset-px overflow-hidden",
          surfaceClassName ?? "bg-foreground/[0.06] dark:bg-white/10",
        )}
        style={{ clipPath: "url(#onyx-squircle-clip)" }}
      >
        <span className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/15 to-transparent" />
      </span>
      {/* Content rides above the glass. */}
      <span className="relative flex size-full items-center justify-center">
        {children}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// ComposioToolBadge — the chat-side badge (tool cards + timeline rows)
// ---------------------------------------------------------------------------

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
/** Inner logo breathing room — proportionally LESS padding on the small
 *  boxes (the glass frame would crowd a 14px timeline icon), the fuller
 *  dock-style inset on the larger slots. */
const SIZE_PAD: Record<number, string> = {
  14: "p-[10%]",
  16: "p-[14%]",
  20: "p-[16%]",
};
/** Glyph size for the unknown-app tier (the Puzzle mark). */
const SIZE_GLYPH: Record<number, string> = {
  14: "h-2.5 w-2.5",
  16: "h-3 w-3",
  20: "h-3.5 w-3.5",
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
  const padClass = SIZE_PAD[size] ?? SIZE_PAD[16]!;
  const glyphClass = SIZE_GLYPH[size] ?? SIZE_GLYPH[16]!;
  const name = branding?.appName ?? null;

  // 1) Real platform logo — a softened white tile inside the glass squircle
  //    (many logos are dark-on-transparent, so the tile keeps them visible on
  //    dark themes); onError falls through to the letter avatar.
  if (logo && failedSrc !== logo) {
    return (
      <GlassSquircleIcon
        boxClass={boxClass}
        surfaceClassName="bg-white/90"
        className={className}
      >
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/no-noninteractive-element-interactions -- remote multi-domain Composio CDN logos (next/image would need per-domain config); onError is a load-failure handler, not an interaction */}
        <img
          src={logo}
          alt={name ?? "App logo"}
          className={cn("size-full object-contain", padClass)}
          loading="lazy"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailedSrc(logo)}
        />
      </GlassSquircleIcon>
    );
  }

  // 2) Letter-avatar tile — the app's initial on a primary gradient tile
  //    inside the same glass squircle.
  if (name) {
    return (
      <GlassSquircleIcon
        boxClass={boxClass}
        surfaceClassName="bg-gradient-to-br from-primary/80 to-primary"
        className={className}
      >
        <span
          aria-hidden
          className={cn(
            "text-primary-foreground font-semibold leading-none",
            letterClass,
          )}
        >
          {name.charAt(0).toUpperCase()}
        </span>
      </GlassSquircleIcon>
    );
  }

  // 3) Unknown app → the generic integration glyph on the bare glass
  //    surface (NEVER a guessed logo — PRD §23).
  return (
    <GlassSquircleIcon boxClass={boxClass} className={className}>
      <Puzzle aria-hidden className={cn("text-muted-foreground", glyphClass)} />
    </GlassSquircleIcon>
  );
}
