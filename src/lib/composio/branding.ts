"use client";

// ============================================================================
// Composio branding store — REAL platform identity for composio_* tool calls
// (PRD §18–§23, §25): the GitHub logo for GitHub tools, the Slack logo for
// Slack, resolved DYNAMICALLY from Composio metadata. Never hardcoded, never
// inferred from tool-name prefixes (PRD §23), never the OnyxAgent logo as a
// substitute (PRD §20), never applied to use_browser (own 🌐 identity).
//
// Two in-memory maps, persisted to localStorage ("composio-branding-v1"):
//   toolkits       toolkit slug → { name, logo }   — from the toolkit catalog
//                  (/api/composio/toolkits, ~3 pages of 100, loaded lazily
//                  once per session by ensureToolkitCatalog)
//   toolkitByTool  TOOL slug (upper) → toolkit slug — harvested from
//                  composio_search_tools results, whose `tools[]` entries
//                  carry Composio's OWN tool_schemas.toolkit mapping — the
//                  ONLY authoritative toolName→toolkit source.
//
// Resolution (resolveComposioBranding) is SYNC map lookups so renderers never
// await; when the catalog finishes loading after a card already mounted, the
// listener pattern (notifyBrandings → subscribeBrandings /
// useSyncExternalStore in useComposioBranding) re-renders those cards with
// the real logos. Dependency-free apart from React hooks + the existing
// browser service.
// ============================================================================

import { useEffect, useSyncExternalStore } from "react";
import { useAuthStore } from "@/stores/auth-store";
import type { ToolCall } from "@/types";
import { apiComposioToolkits, resolveComposioHeaders, type ComposioToolkitCard } from "./browser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The resolved platform identity for one composio_* tool call. */
export interface ComposioBranding {
  /** Composio toolkit slug (e.g. "github"); null = unknown/unresolved app. */
  appSlug: string | null;
  /** Human display name (catalog name once loaded); "Composio" is the
   *  honest fallback for an UNRESOLVED app — never a guessed platform. */
  appName: string | null;
  /** Remote CDN logo URL; null = none loaded (letter-avatar fallback). */
  appLogo: string | null;
}

/** The three session meta-tools that act on external apps via Composio. */
export function isComposioToolName(name: string): boolean {
  return (
    name === "composio_search_tools" ||
    name === "composio_connect_platform" ||
    name === "composio_execute_tool"
  );
}

// ---------------------------------------------------------------------------
// Store — in-memory maps + localStorage persistence
// ---------------------------------------------------------------------------

const STORAGE_KEY = "composio-branding-v1";
const CATALOG_PAGE_LIMIT = 100;
const CATALOG_MAX_PAGES = 3;

interface ToolkitMeta {
  name: string;
  logo: string | null;
}

interface PersistedShape {
  v: 1;
  toolkits: Record<string, ToolkitMeta>;
  tools: Record<string, string>;
}

/** TOOL slug (uppercase) → toolkit slug. */
const toolkitByTool = new Map<string, string>();
/** Toolkit slug → { name, logo }. */
const toolkits = new Map<string, ToolkitMeta>();

/** Lazily hydrate from localStorage on first access (never during import —
 *  the module may be evaluated in environments without a DOM). */
let hydrated = false;
function hydrate(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as PersistedShape | null;
    if (!parsed || parsed.v !== 1) return;
    for (const [slug, meta] of Object.entries(parsed.toolkits ?? {})) {
      if (!meta || typeof meta.name !== "string") continue;
      toolkits.set(slug, { name: meta.name, logo: typeof meta.logo === "string" ? meta.logo : null });
    }
    for (const [tool, slug] of Object.entries(parsed.tools ?? {})) {
      if (typeof slug === "string" && slug && tool) toolkitByTool.set(tool.toUpperCase(), slug);
    }
  } catch {
    // Corrupt payload — start from an empty (still in-memory) store.
  }
}

function persist(): void {
  if (typeof window === "undefined") return;
  try {
    const shape: PersistedShape = {
      v: 1,
      toolkits: Object.fromEntries(toolkits),
      tools: Object.fromEntries(toolkitByTool),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(shape));
  } catch {
    // Quota / private mode — the in-memory maps still work this session.
  }
}

// ---------------------------------------------------------------------------
// Subscription (dependency-free listener pattern)
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
let version = 0;

/** Notify subscribers that branding data changed (catalog loaded, mapping
 *  harvested) — mounted cards re-resolve on the next render. */
function notifyBrandings(): void {
  version++;
  for (const cb of listeners) cb();
}

/** Subscribe to branding-store updates. Returns an unsubscribe function. */
export function subscribeBrandings(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Stable snapshot counter for useSyncExternalStore. */
export function getBrandingVersion(): number {
  return version;
}

/** A subscribe that never fires — non-composio cards skip re-renders. */
const subscribeBrandingsNever = (_cb: () => void): (() => void) => () => undefined;

// ---------------------------------------------------------------------------
// Harvesting — the authoritative toolName→toolkit mapping
// ---------------------------------------------------------------------------

/**
 * Record the toolName→toolkit mapping from composio_search_tools results
 * (each entry carries Composio's own tool_schemas.toolkit). Accepts the raw
 * `output.tools[]` array defensively — junk entries are skipped, so callers
 * can pass untyped payloads straight through.
 */
export function recordToolToolkits(
  tools: ReadonlyArray<{ slug?: unknown; toolkit?: unknown }>,
): void {
  hydrate();
  let changed = false;
  for (const entry of tools) {
    if (!entry || typeof entry !== "object") continue;
    const slug = entry.slug;
    const toolkit = entry.toolkit;
    if (typeof slug !== "string" || !slug.trim()) continue;
    if (typeof toolkit !== "string" || !toolkit.trim()) continue;
    const key = slug.trim().toUpperCase();
    const value = toolkit.trim().toLowerCase();
    if (toolkitByTool.get(key) !== value) {
      toolkitByTool.set(key, value);
      changed = true;
    }
  }
  if (changed) {
    persist();
    notifyBrandings();
  }
}

/** Best-effort object view of a tool result (object or JSON-string). */
function asObject(result: unknown): Record<string, unknown> | null {
  if (!result) return null;
  if (typeof result === "object") return result as Record<string, unknown>;
  if (typeof result === "string") {
    try {
      const parsed = JSON.parse(result);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Belt-and-braces harvest from a composio_search_tools ToolCall's own result
 * (rehydrated conversations can render execute cards whose search ran in a
 * previous session — re-reading the persisted result rebuilds the mapping).
 */
export function harvestFromToolCall(toolCall: { name: string; result?: unknown }): void {
  if (!toolCall || toolCall.name !== "composio_search_tools") return;
  const parsed = asObject(toolCall.result);
  const tools = parsed && Array.isArray(parsed.tools) ? parsed.tools : null;
  if (!tools) return;
  recordToolToolkits(tools as Array<{ slug?: unknown; toolkit?: unknown }>);
}

// ---------------------------------------------------------------------------
// Catalog — toolkit slug → { name, logo }, loaded once per session
// ---------------------------------------------------------------------------

/** Merge one catalog page into the toolkits map. Returns true when anything
 *  changed (used to decide persist + notify once, after the last page). */
function recordToolkitCards(cards: ReadonlyArray<ComposioToolkitCard>): boolean {
  let changed = false;
  for (const card of cards) {
    if (!card || typeof card.slug !== "string" || !card.slug.trim()) continue;
    const slug = card.slug.trim().toLowerCase();
    const name = typeof card.name === "string" && card.name.trim() ? card.name.trim() : slug;
    const logo = typeof card.logo === "string" && card.logo.trim() ? card.logo.trim() : null;
    const prev = toolkits.get(slug);
    if (!prev || prev.name !== name || prev.logo !== logo) {
      toolkits.set(slug, { name, logo });
      changed = true;
    }
  }
  return changed;
}

let catalogPromise: Promise<void> | null = null;

/**
 * Lazily load the toolkit catalog (up to ~3 pages of 100) ONCE per session.
 * Concurrent calls share one in-flight promise; a failure resets it so a
 * later mount can retry. Silently no-ops when Composio isn't configured.
 */
export function ensureToolkitCatalog(userId: string): Promise<void> {
  if (!catalogPromise) {
    catalogPromise = loadToolkitCatalog(userId).catch(() => {
      // Transient failure (network / upstream) — allow a retry later.
      catalogPromise = null;
    });
  }
  return catalogPromise;
}

async function loadToolkitCatalog(userId: string): Promise<void> {
  hydrate();
  let headers: Awaited<ReturnType<typeof resolveComposioHeaders>> = null;
  try {
    headers = await resolveComposioHeaders(userId);
  } catch {
    headers = null;
  }
  if (!headers) return; // Composio not configured / vault locked — no-op.
  let cursor: string | undefined;
  let changed = false;
  for (let page = 0; page < CATALOG_MAX_PAGES; page++) {
    const res = await apiComposioToolkits(headers, {
      limit: CATALOG_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    if (recordToolkitCards(res.items)) changed = true;
    cursor = res.nextCursor ?? undefined;
    if (!cursor) break;
  }
  if (changed) {
    persist();
    notifyBrandings();
  }
}

// ---------------------------------------------------------------------------
// Resolution — pure, synchronous
// ---------------------------------------------------------------------------

/** "slack" → "Slack", "google_calendar" → "Google Calendar" — an honest
 *  fallback label for a KNOWN toolkit slug (never used to guess a toolkit
 *  from a tool name — PRD §23). */
function prettifySlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Resolve the platform branding for a composio_* tool call, synchronously,
 * from the in-memory maps (hydrated from localStorage, refreshed by the
 * catalog loader). Returns null for every non-composio tool.
 *
 *  - composio_execute_tool     → args.toolName → toolkitByTool → toolkits.
 *    When the mapping is MISSING the result is the "unknown" branding
 *    {appSlug: null, appName: "Composio", appLogo: null} — the generic
 *    Composio identity, and the renderer MUST NOT guess the platform from
 *    the tool slug's prefix (PRD §23).
 *  - composio_connect_platform → args.toolkit (the authoritative slug).
 *  - composio_search_tools     → the Composio platform itself ("composio"
 *    catalog entry when present, else a generic Composio identity).
 */
export function resolveComposioBranding(
  userId: string | null,
  toolCall: { name: string; args?: unknown },
): ComposioBranding | null {
  if (!toolCall || !isComposioToolName(toolCall.name)) return null;
  // `userId` is accepted for interface symmetry (the catalog load is
  // user-scoped; the resolved maps are shared) — resolution itself is pure.
  void userId;
  hydrate();
  const args =
    toolCall.args && typeof toolCall.args === "object" ? (toolCall.args as Record<string, unknown>) : {};

  if (toolCall.name === "composio_search_tools") {
    const meta = toolkits.get("composio");
    return {
      appSlug: "composio",
      appName: meta?.name ?? "Composio",
      appLogo: meta?.logo ?? null,
    };
  }

  if (toolCall.name === "composio_connect_platform") {
    const slug = typeof args.toolkit === "string" ? args.toolkit.trim().toLowerCase() : "";
    if (!slug) return { appSlug: null, appName: "Composio", appLogo: null };
    const meta = toolkits.get(slug);
    return {
      appSlug: slug,
      appName: meta?.name ?? prettifySlug(slug),
      appLogo: meta?.logo ?? null,
    };
  }

  // composio_execute_tool — toolName is a Composio tool slug; the mapping to
  // its toolkit comes ONLY from search results (Composio's own metadata).
  const toolName = typeof args.toolName === "string" ? args.toolName.trim().toUpperCase() : "";
  const slug = toolName ? toolkitByTool.get(toolName) ?? null : null;
  if (!slug) {
    // Unknown mapping → the generic Composio identity (letter tile / glyph).
    // NEVER guess the platform from the tool slug's prefix (PRD §23).
    return { appSlug: null, appName: "Composio", appLogo: null };
  }
  const meta = toolkits.get(slug);
  return {
    appSlug: slug,
    appName: meta?.name ?? prettifySlug(slug),
    appLogo: meta?.logo ?? null,
  };
}

// ---------------------------------------------------------------------------
// React hook — resolve sync, subscribe to updates, load the catalog on mount
// ---------------------------------------------------------------------------

/**
 * Composio platform branding for a tool call. Resolves synchronously from
 * the store, re-renders when branding data updates (catalog loaded / mapping
 * harvested), and triggers the catalog load once on mount. Returns null for
 * every non-composio tool (and never subscribes those cards).
 *
 * `userId` may be omitted — it then falls back to the auth store's current
 * user (the catalog is user-scoped only through the vault-decrypted key).
 */
export function useComposioBranding(
  userId: string | null | undefined,
  toolCall: ToolCall,
): ComposioBranding | null {
  const isComposio = isComposioToolName(toolCall?.name ?? "");
  useSyncExternalStore(
    isComposio ? subscribeBrandings : subscribeBrandingsNever,
    getBrandingVersion,
    getBrandingVersion,
  );
  useEffect(() => {
    if (!isComposio) return;
    const uid = userId ?? useAuthStore.getState().user?.id ?? null;
    if (uid) void ensureToolkitCatalog(uid);
    // Belt-and-braces harvest (see harvestFromToolCall).
    harvestFromToolCall(toolCall);
  }, [isComposio, userId, toolCall]);
  if (!isComposio) return null;
  return resolveComposioBranding(userId ?? null, toolCall);
}
