"use client";

/**
 * Project identity primitives (Task 1-b — Projects UI).
 *
 * Shared, dependency-light building blocks consumed by every project surface
 * (sidebar section, create/edit dialog, empty state, history drawer, chrome):
 *
 *   - The FIXED curated icon set + accent palette a project can pick
 *     (PRD §4.6 — appearance affects the project's visual identity only).
 *   - `ProjectGlyph` — the icon tinted with the project's accent color.
 *   - `useHydrated` — the codebase's SSR/hydration gate (same
 *     useSyncExternalStore trick as chat-workspace's `titleHydrated`): the
 *     projects zustand store PERSISTS to localStorage, so any UI whose
 *     structure depends on persisted state must render the server shape
 *     (empty) during hydration and only branch after mount.
 *   - `populateComposer` — puts text into the REAL chat composer textarea
 *     (the empty state's suggested-start chips populate, never auto-send).
 *   - `deriveProjectSuggestions` / `deriveProjectWelcome` — pure, honest
 *     goal-derived copy (no fake statistics, PRD §5).
 *   - LocalStorage affordances the conversation model has no field for yet:
 *     pinned project chats + each project's last-active conversation.
 */

import { useSyncExternalStore } from "react";
import {
  BarChart3,
  BookOpen,
  Boxes,
  Briefcase,
  Code2,
  FlaskConical,
  Globe,
  LayoutGrid,
  Leaf,
  Palette,
  PenLine,
  Rocket,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Fixed icon set (PRD §4.6 — a curated set, not a free-for-all picker)
// ---------------------------------------------------------------------------

export const PROJECT_ICONS: Record<string, LucideIcon> = {
  rocket: Rocket,
  boxes: Boxes,
  research: FlaskConical,
  design: Palette,
  code: Code2,
  learning: BookOpen,
  web: Globe,
  maintenance: Wrench,
  work: Briefcase,
  writing: PenLine,
  analytics: BarChart3,
  growth: Leaf,
};

export const PROJECT_ICON_KEYS = Object.keys(PROJECT_ICONS);

export const DEFAULT_PROJECT_ICON = "rocket";

/** Resolve an icon key to its lucide component (unknown → neutral grid). */
export function getProjectIcon(key?: string | null): LucideIcon {
  if (key && Object.prototype.hasOwnProperty.call(PROJECT_ICONS, key)) {
    return PROJECT_ICONS[key]!;
  }
  return LayoutGrid;
}

// ---------------------------------------------------------------------------
// Fixed accent palette (8 hex swatches; warm/earthen to match the app's
// terracotta brand — deliberately NO indigo/blue)
// ---------------------------------------------------------------------------

export const PROJECT_ACCENTS: readonly string[] = [
  "#C2510F", // terracotta (brand-adjacent)
  "#D97706", // amber
  "#65A30D", // olive
  "#059669", // emerald
  "#0F766E", // teal
  "#BE123C", // rose
  "#A21CAF", // fuchsia
  "#57534E", // stone (neutral)
];

export const DEFAULT_PROJECT_ACCENT = PROJECT_ACCENTS[0]!;

/** Normalize a stored accent to a 6-digit hex (fallback = default accent). */
export function normalizeAccent(hex?: string | null): string {
  if (typeof hex === "string" && /^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  return DEFAULT_PROJECT_ACCENT;
}

/** hex (#rgb/#rrggbb) → `rgba(r,g,b,alpha)` (works on light + dark surfaces). */
export function accentAlpha(hex: string | null | undefined, alpha: number): string {
  const base = normalizeAccent(hex);
  const r = parseInt(base.slice(1, 3), 16);
  const g = parseInt(base.slice(3, 5), 16);
  const b = parseInt(base.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ---------------------------------------------------------------------------
// ProjectGlyph — the project's icon, tinted with its accent
// ---------------------------------------------------------------------------

interface ProjectGlyphProps {
  iconKey?: string | null;
  accent?: string | null;
  /** Pixel size of the tinted tile (default 28). */
  size?: number;
  className?: string;
}

export function ProjectGlyph({ iconKey, accent, size = 28, className }: ProjectGlyphProps) {
  // Direct member lookup (NOT a function call) so the React Compiler can see
  // `Icon` is a stable module-constant component, never created during render.
  const Icon = (iconKey != null && Object.prototype.hasOwnProperty.call(PROJECT_ICONS, iconKey)
    ? PROJECT_ICONS[iconKey]
    : LayoutGrid) as LucideIcon;
  const tint = normalizeAccent(accent);
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg border",
        className,
      )}
      style={{
        width: size,
        height: size,
        color: tint,
        backgroundColor: accentAlpha(tint, 0.1),
        borderColor: accentAlpha(tint, 0.28),
      }}
    >
      <Icon style={{ width: Math.max(12, Math.round(size * 0.55)), height: Math.max(12, Math.round(size * 0.55)) }} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Hydration gate — persisted-store-driven UI must render the server shape
// during hydration (empty), then branch after mount
// ---------------------------------------------------------------------------

const emptySubscribe = () => () => {};

/** False during SSR AND the hydration render; true afterwards. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

// ---------------------------------------------------------------------------
// populateComposer — put text into the REAL composer textarea
// ---------------------------------------------------------------------------

/**
 * Populate the chat composer's textarea with `text` and focus it. The composer
 * (`ChatInput`) is a React controlled component with internal state, so the
 * value is written through the native setter + a bubbled `input` event — the
 * standard technique for programmatically updating a controlled input. Returns
 * true when a composer was found and updated.
 *
 * Selector note: the composer's textarea is the `mb-height` textarea WITHOUT
 * a form (ChatInput renders a plain div layout, not a <form>). The only other
 * `mb-height` textarea is the message-EDIT box (message-item), which can only
 * exist when messages exist — the project empty state renders exclusively
 * when there are none, so the bare class selector is unambiguous in context.
 */
export function populateComposer(text: string): boolean {
  if (typeof document === "undefined") return false;
  const el = document.querySelector<HTMLTextAreaElement>("textarea.mb-height");
  if (!el || el.disabled) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) return false;
  setter.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  try {
    el.setSelectionRange(text.length, text.length);
  } catch {
    // Some browsers guard selection on detached/disabled nodes — non-fatal.
  }
  return true;
}

// ---------------------------------------------------------------------------
// Goal-derived copy (pure, deterministic, honest — PRD §5)
// ---------------------------------------------------------------------------

const SUGGESTION_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "with", "at",
  "by", "from", "into", "our", "your", "this", "that", "these", "those", "is",
  "are", "be", "been", "as", "it", "its", "we", "you", "they", "will", "shall",
  "can", "may", "should", "must", "have", "has", "had", "do", "does", "did",
  "including", "about", "across", "using", "use", "used", "new", "more", "all",
  "any", "every", "each", "other", "than", "then", "when", "while", "where",
]);

/** Extract the most meaningful keywords from a goal sentence (3-5 words). */
function goalKeywords(goal: string, limit: number): string[] {
  const counts = new Map<string, number>();
  const order = new Map<string, number>();
  const words = goal
    .toLowerCase()
    .replace(/[^a-z0-9+#.-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !SUGGESTION_STOPWORDS.has(w));
  words.forEach((w, i) => {
    counts.set(w, (counts.get(w) ?? 0) + 1);
    if (!order.has(w)) order.set(w, i);
  });
  return [...counts.keys()]
    .sort((a, b) => {
      const d = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
      return d !== 0 ? d : (order.get(a) ?? 0) - (order.get(b) ?? 0);
    })
    .slice(0, limit);
}

/**
 * Three suggested ways to start working, derived from the project goal.
 * Deterministic keyword templates (PRD §5: populate the input, never auto-send).
 */
export function deriveProjectSuggestions(goal: string): [string, string, string] {
  const [k0, k1, k2] = goalKeywords(goal, 3);
  if (!k0) {
    return [
      "Review the project goal and outline a plan",
      "What should we tackle first in this project?",
      "Summarize where this project stands",
    ];
  }
  const a = k0.charAt(0).toUpperCase() + k0.slice(1);
  return [
    `Review the current state of ${k0}`,
    k1
      ? `Investigate a problem with ${k1}`
      : `Investigate an issue slowing this project down`,
    k2
      ? `Propose an improvement to ${k2}`
      : `Propose the next improvement for ${a}`,
  ];
}

/** A one-line welcome derived from the goal's first clause. */
export function deriveProjectWelcome(goal: string): string {
  const firstClause =
    goal
      .split(/[.!?\n]/)
      .map((s) => s.trim())
      .find((s) => s.length > 0) ?? goal;
  const clipped =
    firstClause.length > 140 ? `${firstClause.slice(0, 140).trimEnd()}…` : firstClause;
  const body = clipped.charAt(0).toLowerCase() + clipped.slice(1);
  return `Your dedicated workspace for ${body}.`;
}

// ---------------------------------------------------------------------------
// Pinned project chats + last-active project conversation (localStorage
// affordances — the Conversation model has no pinned field; honest UI-level
// favorites that Task 2-b can migrate into the data layer later)
// ---------------------------------------------------------------------------

const PROJECT_PINS_KEY = "onyx:project-pinned-chats";
const PROJECT_LAST_CONV_KEY = "onyx:project-last-conv";
const PINS_CHANGED_EVENT = "onyx:project-pins-changed";

function readJsonRecord(key: string): Record<string, string[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
    }
    return out;
  } catch {
    return {};
  }
}

function writeJsonRecord(key: string, record: Record<string, string[]>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // Storage unavailable (private mode / quota) — non-fatal, session-only.
  }
}

export function getPinnedProjectChats(projectId: string): string[] {
  return readJsonRecord(PROJECT_PINS_KEY)[projectId] ?? [];
}

export function isProjectChatPinned(projectId: string, conversationId: string): boolean {
  return getPinnedProjectChats(projectId).includes(conversationId);
}

/** Pin/unpin a conversation inside a project. Returns the new pinned state. */
export function togglePinnedProjectChat(projectId: string, conversationId: string): boolean {
  const record = readJsonRecord(PROJECT_PINS_KEY);
  const current = record[projectId] ?? [];
  const next = current.includes(conversationId)
    ? current.filter((id) => id !== conversationId)
    : [...current, conversationId];
  record[projectId] = next;
  writeJsonRecord(PROJECT_PINS_KEY, record);
  window.dispatchEvent(new CustomEvent(PINS_CHANGED_EVENT, { detail: projectId }));
  return next.includes(conversationId);
}

/** Subscribe to pin changes for a project (re-render hook). */
export function subscribeProjectPins(projectId: string, onChange: () => void): () => void {
  const handler = (e: Event) => {
    if ((e as CustomEvent<string>).detail === projectId) onChange();
  };
  window.addEventListener(PINS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(PINS_CHANGED_EVENT, handler);
}

/** Remember the last-active conversation of a project (project-view restore). */
export function setLastProjectConversation(projectId: string, conversationId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(PROJECT_LAST_CONV_KEY);
    const record = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    if (conversationId === null) delete record[projectId];
    else record[projectId] = conversationId;
    window.localStorage.setItem(PROJECT_LAST_CONV_KEY, JSON.stringify(record));
  } catch {
    // Non-fatal.
  }
}

export function getLastProjectConversation(projectId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PROJECT_LAST_CONV_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw) as Record<string, unknown>;
    const v = record[projectId];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}
