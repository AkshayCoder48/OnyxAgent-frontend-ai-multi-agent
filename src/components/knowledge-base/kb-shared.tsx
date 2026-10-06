"use client";

import { Sparkles } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import {
  MAX_KB_CONTENT_CHARS,
  MAX_KB_TITLE_CHARS,
  type KBItemType,
} from "@/lib/onyxbase/kb-store";

/**
 * Shared presentational bits for the Knowledge Base tab — type metadata,
 * badges, tag chips and small formatting helpers. Semantic design tokens
 * only (no indigo/blue).
 */

/** Type filter pills (All + one per KBItemType). */
export const KB_TYPE_FILTERS: { value: KBItemType | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "memory", label: "Memory" },
  { value: "knowledge", label: "Knowledge" },
  { value: "decision", label: "Decisions" },
  { value: "document", label: "Documents" },
  { value: "research", label: "Research" },
  { value: "note", label: "Notes" },
];

/** Singular labels for each knowledge type. */
export const KB_TYPE_META: Record<KBItemType, string> = {
  memory: "Memory",
  knowledge: "Knowledge",
  decision: "Decision",
  document: "Document",
  research: "Research",
  note: "Note",
};

/** Subtle per-type badge tints (semantic tokens, theme-aware). */
export const KB_TYPE_BADGE_CLASS: Record<KBItemType, string> = {
  memory: "bg-primary/10 text-primary",
  knowledge: "bg-foreground/5 text-foreground",
  decision: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  document: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  research: "bg-foreground/5 text-foreground",
  note: "bg-muted text-muted-foreground",
};

export function TypeBadge({ type, className }: { type: KBItemType; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[11px] font-medium",
        KB_TYPE_BADGE_CLASS[type],
        className,
      )}
    >
      {KB_TYPE_META[type]}
    </span>
  );
}

/** Distinct badge for AI-saved items — primary tint + sparkles. */
export function AISavedBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary",
        className,
      )}
    >
      <Sparkles aria-hidden className="h-3 w-3" />
      AI Saved
    </span>
  );
}

export function TagChips({
  tags,
  max = 6,
  className,
}: {
  tags: string[];
  max?: number;
  className?: string;
}) {
  if (!tags.length) return null;
  const shown = tags.slice(0, max);
  const rest = tags.length - shown.length;
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)}>
      {shown.map((tag) => (
        <span
          key={tag}
          className="max-w-48 truncate rounded-full bg-foreground/[0.05] px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          {tag}
        </span>
      ))}
      {rest > 0 && <span className="text-[11px] text-muted-foreground/70">+{rest}</span>}
    </div>
  );
}

/** "2h ago" style relative time; "—" for missing/invalid dates. */
export function timeAgo(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return formatDistanceToNow(d, { addSuffix: true });
  } catch {
    return "—";
  }
}

/** Absolute timestamp for detail views ("3 Oct 2026 · 14:05"). */
export function formatDateTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return format(d, "d MMM yyyy · HH:mm");
  } catch {
    return "—";
  }
}

/** Parse a comma-separated tags string into clean values. */
export function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Uniform error-message extraction (OnyxBaseError et al.). */
export function kbErrorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return "Something went wrong";
}

/** Form limits surfaced by the store. */
export const KB_LIMITS = {
  title: MAX_KB_TITLE_CHARS,
  content: MAX_KB_CONTENT_CHARS,
} as const;
