"use client";

import * as React from "react";
import { KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";

// ============================================================================
// Platform logos for the consolidated API Keys tab (task 2026-11-14: "sort
// all api keys input in a single setting tab … with platform logos").
//
// Each mark is a compact, monochrome currentColor SVG that evokes the
// platform's identity at 16–28px inside a rounded logo tile. They are
// deliberately simplified geometric marks (not pixel-perfect brand
// reproductions) so both themes and any accent color work without extra
// assets — the tile supplies the surface, the mark supplies the identity.
// ============================================================================

export type PlatformMark =
  | "openai"
  | "anthropic"
  | "gemini"
  | "groq"
  | "mistral"
  | "deepseek"
  | "xai"
  | "openrouter"
  | "e2b"
  | "triggerdev"
  | "pollinations"
  | "onyxbase"
  | "composio"
  | "langsearch"
  | "skillsmp"
  | "generic";

const MARKS: Record<PlatformMark, React.ReactNode> = {
  // OpenAI — three rotated petals around the center (the rosette).
  openai: (
    <g>
      {[0, 60, 120].map((deg) => (
        <ellipse
          key={deg}
          cx="12"
          cy="7.6"
          rx="3.1"
          ry="5.6"
          transform={`rotate(${deg} 12 12)`}
          fill="currentColor"
        />
      ))}
      <circle cx="12" cy="12" r="2.1" fill="currentColor" />
    </g>
  ),
  // Anthropic — the split "A".
  anthropic: (
    <path
      d="M9.2 3.5 4 20.5h3.4l1.3-3.9h6.6l1.3 3.9H20L14.8 3.5h-2.7l2.1 6.2h-5.2L4.9 19.4 9.2 3.5z"
      fill="currentColor"
    />
  ),
  // Gemini — the four-point spark.
  gemini: (
    <path
      d="M12 2.4c1.6 5.4 4.2 8 9.6 9.6-5.4 1.6-8 4.2-9.6 9.6-1.6-5.4-4.2-8-9.6-9.6 5.4-1.6 8-4.2 9.6-9.6z"
      fill="currentColor"
    />
  ),
  // Groq — bold rounded diagonal in a rounded square.
  groq: (
    <g>
      <rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" strokeWidth="2.1" />
      <path d="M8 15.5 16 8.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    </g>
  ),
  // Mistral — the block grid.
  mistral: (
    <g fill="currentColor">
      <rect x="4" y="4" width="7" height="4.2" rx="1" />
      <rect x="13" y="4" width="7" height="4.2" rx="1" opacity="0.55" />
      <rect x="4" y="9.9" width="7" height="4.2" rx="1" opacity="0.55" />
      <rect x="13" y="9.9" width="7" height="4.2" rx="1" />
      <rect x="4" y="15.8" width="7" height="4.2" rx="1" />
      <rect x="13" y="15.8" width="7" height="4.2" rx="1" opacity="0.55" />
    </g>
  ),
  // DeepSeek — the double-curve wave.
  deepseek: (
    <path
      d="M3.5 15.5c3-1.2 4.6-3.4 6-6.1 1-2 2-3.9 4.4-3.9 2.1 0 3.3 1.6 4.6 3.7.9 1.5 2 2.3 3.5 2.7-1.9 1-3.4.8-5-.3-1.1-.8-1.9-1.9-2.8-3-1.4 3.4-3.9 6.9-8.4 9.1 2.3-3.4 3.4-6.2 4.2-9.2-2.4 3.4-5 5.8-6.5 7z"
      fill="currentColor"
    />
  ),
  // xAI — the heavy X.
  xai: (
    <g stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
      <path d="M5.5 5.5 18.5 18.5" />
      <path d="M18.5 5.5 5.5 18.5" />
    </g>
  ),
  // OpenRouter — layered chevrons.
  openrouter: (
    <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12 12 5.5 19 12" strokeWidth="2.2" />
      <path d="M8.2 15.4 12 11.9l3.8 3.5" strokeWidth="2.2" opacity="0.6" />
    </g>
  ),
  // E2B — rounded square with the inner play cutout.
  e2b: (
    <g>
      <rect x="3" y="3" width="18" height="18" rx="5.5" fill="none" stroke="currentColor" strokeWidth="2.1" />
      <path d="M10 8.6v6.8l6-3.4z" fill="currentColor" />
    </g>
  ),
  // Trigger.dev — the rounded square with the bolt.
  triggerdev: (
    <g>
      <rect x="3" y="3" width="18" height="18" rx="5.5" fill="none" stroke="currentColor" strokeWidth="2.1" />
      <path d="M13.2 6.5 8.8 13h2.9l-.9 4.5 4.4-6.5h-2.9z" fill="currentColor" />
    </g>
  ),
  // Pollinations — five petals around the center.
  pollinations: (
    <g fill="currentColor">
      {[90, 162, 234, 306, 18].map((deg) => (
        <circle key={deg} cx="12" cy="6.8" r="3" transform={`rotate(${deg} 12 12)`} />
      ))}
      <circle cx="12" cy="12" r="2.2" fill="currentColor" opacity="0.55" />
    </g>
  ),
  // OnyxBase — the hexagon hub.
  onyxbase: (
    <g fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinejoin="round">
      <path d="M12 3.2 20 7.8v8.4L12 20.8 4 16.2V7.8z" />
      <circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none" opacity="0.55" />
    </g>
  ),
  // Composio — the puzzle socket.
  composio: (
    <path
      d="M4.5 6.5A2 2 0 0 1 6.5 4.5h4.2a1.8 1.8 0 0 1 2.6 0 1.8 1.8 0 0 1 2.6 0h1.6a2 2 0 0 1 2 2v4.1a1.8 1.8 0 0 0 0 2.7 1.8 1.8 0 0 1 0 2.6v1.6a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    />
  ),
  // LangSearch — the lens over the L.
  langsearch: (
    <g fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round">
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
      <path d="M8.4 8.2v5h3.4" strokeWidth="1.9" />
    </g>
  ),
  // SkillsMP — the spark "S".
  skillsmp: (
    <g>
      <path
        d="M15.8 4.2c-4-.6-7 1-7.4 3.6-.3 2.2 1.2 3.4 4.3 4.1 3.4.8 4.6 1.7 4.3 3.4-.3 2-2.8 3-5.7 2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path d="M5.2 18.6 8 15.8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </g>
  ),
  generic: null,
};

/** Map a free-form provider/platform name to its mark (case-insensitive
 *  substring matching — works for "OpenAI", "openai-compatible", "Groq
 *  Cloud", "Anthropic Claude 3", …). Falls back to the generic key. */
export function resolvePlatformMark(name: string | null | undefined): PlatformMark {
  const n = (name ?? "").toLowerCase();
  if (!n) return "generic";
  if (n.includes("openai") || n.includes("gpt") || n.includes("chatgpt")) return "openai";
  if (n.includes("anthropic") || n.includes("claude")) return "anthropic";
  if (n.includes("gemini") || n.includes("google")) return "gemini";
  if (n.includes("groq")) return "groq";
  if (n.includes("mistral") || n.includes("mixtral")) return "mistral";
  if (n.includes("deepseek")) return "deepseek";
  if (n.includes("xai") || n.includes("grok")) return "xai";
  if (n.includes("openrouter")) return "openrouter";
  if (n.includes("e2b") || n.includes("sandbox")) return "e2b";
  if (n.includes("trigger")) return "triggerdev";
  if (n.includes("pollinations")) return "pollinations";
  if (n.includes("onyxbase")) return "onyxbase";
  if (n.includes("composio")) return "composio";
  if (n.includes("langsearch") || n.includes("langsearch")) return "langsearch";
  if (n.includes("skillsmp") || n.includes("skills mp")) return "skillsmp";
  return "generic";
}

export interface PlatformLogoProps {
  platform: PlatformMark;
  /** Tile size in px (default 32 → a 20px mark). */
  size?: number;
  className?: string;
}

/** The standard platform logo tile used across the API Keys section: a
 *  subtle surface tile with the mark centered, theme-aware via tokens. */
export function PlatformLogo({ platform, size = 32, className }: PlatformLogoProps) {
  if (platform === "generic") {
    return (
      <span
        aria-hidden
        style={{ width: size, height: size }}
        className={cn(
          "bg-muted/50 text-muted-foreground inline-flex shrink-0 items-center justify-center rounded-lg border border-foreground/10",
          className,
        )}
      >
        <KeyRound style={{ width: size * 0.5, height: size * 0.5 }} />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn(
        "bg-muted/50 text-foreground/80 inline-flex shrink-0 items-center justify-center rounded-lg border border-foreground/10",
        className,
      )}
    >
      <svg
        viewBox="0 0 24 24"
        style={{ width: size * 0.62, height: size * 0.62 }}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {MARKS[platform]}
      </svg>
    </span>
  );
}
