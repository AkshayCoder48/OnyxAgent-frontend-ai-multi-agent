/**
 * Business Mode agent logo registry (Task 2-a).
 *
 * A set of distinctive, ORIGINAL geometric SVG marks (designed for this
 * project — not copied from lucide or any other icon set). Every logo:
 *   - is rendered inline (no emoji, no raster, no external deps);
 *   - uses viewBox="0 0 24 24" in a consistent 24px box;
 *   - is painted with `currentColor` ONLY (works in light + dark themes);
 *   - is purely decorative — the SVG carries aria-hidden and callers pass a
 *     human label via the `label` prop when the logo conveys meaning.
 *
 * This module has NO "use client" directive and no hooks — it is a pure
 * presentational module importable from both server and client components.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface AgentLogoDef {
  key: string;
  label: string;
}

/** Registry (for pickers) — key → human label. */
export const AGENT_LOGOS: AgentLogoDef[] = [
  { key: "orb", label: "Orb" },
  { key: "research", label: "Research" },
  { key: "strategy", label: "Strategy" },
  { key: "marketing", label: "Marketing" },
  { key: "content", label: "Content" },
  { key: "finance", label: "Finance" },
  { key: "operations", label: "Operations" },
  { key: "developer", label: "Developer" },
  { key: "quality", label: "Quality" },
  { key: "support", label: "Support" },
  { key: "legal", label: "Legal" },
  { key: "sales", label: "Sales" },
  { key: "data", label: "Data" },
  { key: "creative", label: "Creative" },
  { key: "growth", label: "Growth" },
  { key: "generic", label: "Generic" },
];

export const AGENT_LOGO_KEYS: string[] = AGENT_LOGOS.map((l) => l.key);

// ---------------------------------------------------------------------------
// SVG marks — original geometric shapes (circles / rects / polygons / paths).
// ---------------------------------------------------------------------------

/** Shared svg attributes: 24px box, currentColor paint, decorative. */
const SVG_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: "false" as const,
  className: "h-full w-full",
};

const LOGO_SVGS: Record<string, ReactNode> = {
  // Main agent — concentric orbital rings + core dot.
  orb: (
    <svg {...SVG_PROPS}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
    </svg>
  ),
  // Magnifier over a document.
  research: (
    <svg {...SVG_PROPS}>
      <rect x="4" y="3" width="9" height="13" rx="1.2" />
      <path d="M6.5 6.5h4M6.5 9.5h4M6.5 12.5h2.5" />
      <circle cx="15" cy="15" r="4" />
      <path d="M18 18l3 3" />
    </svg>
  ),
  // Target rings + incoming arrow.
  strategy: (
    <svg {...SVG_PROPS}>
      <circle cx="10" cy="14" r="8" />
      <circle cx="10" cy="14" r="4" />
      <circle cx="10" cy="14" r="1.2" fill="currentColor" stroke="none" />
      <path d="M15 5.5h5.5V11M20.5 5.5l-5.7 5.7" />
    </svg>
  ),
  // Megaphone horn + sound waves.
  marketing: (
    <svg {...SVG_PROPS}>
      <path d="M4 10.5L14 5.5v13L4 13.5z" />
      <path d="M17 9.5a4.5 4.5 0 010 5" />
      <path d="M19.5 7.5a8 8 0 010 9" />
    </svg>
  ),
  // Quill / pen nib.
  content: (
    <svg {...SVG_PROPS}>
      <path d="M20.5 3.5c-7 0-12.5 3.5-14.5 9.5l-2.5 7 7-2.5c6-2 10-7 10-14z" />
      <path d="M20.5 3.5L11 13" />
    </svg>
  ),
  // Chart bars + trend line.
  finance: (
    <svg {...SVG_PROPS}>
      <path d="M5 20v-6M12 20v-9M19 20V6" strokeWidth="2.6" />
      <path d="M4 12l5-4 3.5 2.5L20 4" />
    </svg>
  ),
  // Gear — ring + eight teeth.
  operations: (
    <svg {...SVG_PROPS}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" />
    </svg>
  ),
  // Code brackets + slash.
  developer: (
    <svg {...SVG_PROPS}>
      <path d="M8.5 6l-5 6 5 6" />
      <path d="M15.5 6l5 6-5 6" />
      <path d="M13.5 4l-3 16" />
    </svg>
  ),
  // Shield + check.
  quality: (
    <svg {...SVG_PROPS}>
      <path d="M12 3l7 2.8v5.4c0 4.6-3.2 7.5-7 9.8-3.8-2.3-7-5.2-7-9.8V5.8z" />
      <path d="M8.5 11.8l2.6 2.7 4.4-5" />
    </svg>
  ),
  // Headset — headband, ear cups, boom mic.
  support: (
    <svg {...SVG_PROPS}>
      <path d="M4 13.5a8 8 0 0116 0" />
      <rect x="3" y="13.5" width="4" height="6" rx="1.5" />
      <rect x="17" y="13.5" width="4" height="6" rx="1.5" />
      <path d="M19 19.5v.5a2.5 2.5 0 01-2.5 2.5H13" />
    </svg>
  ),
  // Scales — post, beam, two pans, base.
  legal: (
    <svg {...SVG_PROPS}>
      <path d="M12 3.5v15" />
      <path d="M4.5 6.5h15" />
      <path d="M4.5 6.5L2 12.5h5zM19.5 6.5l-2.5 6h5z" />
      <path d="M8.5 20.5h7" />
    </svg>
  ),
  // Price tag + hole.
  sales: (
    <svg {...SVG_PROPS}>
      <path d="M3.5 3.5h7.6L21 13.4 13.4 21 3.5 11.1z" />
      <circle cx="8" cy="8" r="1.6" />
    </svg>
  ),
  // Database cylinders.
  data: (
    <svg {...SVG_PROPS}>
      <ellipse cx="12" cy="5" rx="7.5" ry="2.5" />
      <path d="M4.5 5v14c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5V5" />
      <path d="M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5" />
    </svg>
  ),
  // Four-point spark.
  creative: (
    <svg {...SVG_PROPS}>
      <path d="M12 2.5l2 7.5 7.5 2-7.5 2-2 7.5-2-7.5-7.5-2 7.5-2z" />
    </svg>
  ),
  // Rising trend arrow.
  growth: (
    <svg {...SVG_PROPS}>
      <path d="M3 17.5l5.5-5.5 3.5 3 8-8" />
      <path d="M14.5 7H20v5.5" />
    </svg>
  ),
  // Plain hexagon (fallback).
  generic: (
    <svg {...SVG_PROPS}>
      <path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5z" />
    </svg>
  ),
};

// ---------------------------------------------------------------------------
// Role → logo mapping (keyword match on the free-form role string).
// ---------------------------------------------------------------------------

const ROLE_LOGO_RULES: { keywords: string[]; logo: string }[] = [
  { logo: "orb", keywords: ["coordinator", "orchestr", "main", "manager", "assistant", "general", "ceo", "chief"] },
  { logo: "research", keywords: ["research", "investigat", "scout", "analyst"] },
  { logo: "strategy", keywords: ["strategy", "strategist", "planning", "planner", "advisor", "consult"] },
  { logo: "marketing", keywords: ["marketing", "brand", "seo", "social", "ads", "advertis", "campaign"] },
  { logo: "content", keywords: ["content", "writer", "writing", "copy", "blog", "editor", "journalis"] },
  { logo: "finance", keywords: ["finance", "financial", "account", "bookkeep", "cpa", "tax", "payroll"] },
  { logo: "operations", keywords: ["operation", "ops", "logistic", "supply", "procurement"] },
  { logo: "developer", keywords: ["develop", "engineer", "program", "software", "code", "coding", "tech"] },
  { logo: "quality", keywords: ["quality", "qa", "test", "tester", "review", "audit", "compliance-check"] },
  { logo: "support", keywords: ["support", "customer", "helpdesk", "service", "success", "help"] },
  { logo: "legal", keywords: ["legal", "law", "compliance", "contract", "paralegal", "counsel"] },
  { logo: "sales", keywords: ["sales", "sdr", "bdr", "lead", "crm", "revenue", "acquisition"] },
  { logo: "data", keywords: ["data", "insight", "analytics", "bi ", "statistic"] },
  { logo: "creative", keywords: ["creative", "design", "ux", "ui ", "graphic", "art"] },
  { logo: "growth", keywords: ["growth", "demand", "expansion"] },
];

/** Pick a logo key for a free-form role string: keyword match first, else a
 *  random key from the full registry (safe — every key always exists). */
export function randomLogoForRole(role: string): string {
  const normalized = (role ?? "").toLowerCase();
  for (const rule of ROLE_LOGO_RULES) {
    for (const keyword of rule.keywords) {
      if (normalized.includes(keyword)) return rule.logo;
    }
  }
  const index = Math.floor(Math.random() * AGENT_LOGO_KEYS.length);
  return AGENT_LOGO_KEYS[index] ?? "generic";
}

// ---------------------------------------------------------------------------
// Component.
// ---------------------------------------------------------------------------

/**
 * Inline agent logo: a subtle circular container (rounded-full, faint
 * accent wash + hairline border) wrapping one of the registry SVG marks.
 * Unknown keys fall back to the "generic" hexagon. Sizing/color can be
 * overridden through `className` (it lands on the container span, and the
 * SVG inherits `currentColor`).
 */
export function AgentLogo({
  logo,
  className,
  label,
}: {
  logo: string;
  className?: string;
  label?: string;
}) {
  const node = LOGO_SVGS[logo] ?? LOGO_SVGS.generic ?? null;
  return (
    <span
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-border/60 bg-accent/10 p-1 text-accent-foreground",
        className,
      )}
      role={label ? "img" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
    >
      {node}
    </span>
  );
}
