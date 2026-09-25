"use client";

/**
 * GenUI component registry.
 *
 * Maps type strings to lazy-loaded React components via `next/dynamic`. This
 * keeps heavy components (Tabs, Accordion, ComparisonTable, etc.) out of the
 * initial chat bundle — they're only loaded when an assistant message actually
 * emits a GenUI block of that type.
 *
 * Lookup is O(1) via the `RENDERERS` map. Unknown types fall back to
 * `UnknownFallback` (registered under the synthetic `unknown_json` type by
 * `validate.ts`).
 *
 * Each dynamic import uses `ssr: false` because GenUI blocks are inherently
 * client-rendered (they arrive via the streaming chat — never SSR'd). The
 * loading placeholder is a small shimmer to avoid layout shift.
 *
 * PRD §21 (creation text → block cross-fade): while the creation line streams,
 * the renderers for the partial spec's node types are PRELOADED
 * (`preloadRenderer`) so the moment the block mounts at completion there is
 * no lazy-chunk loading flash — the finished UI blur-in starts immediately.
 */

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import type { GenUIComponentProps } from "./helpers";

const loading = () => (
  <div className="bg-muted/40 flex h-16 w-full animate-pulse rounded-xl" />
);

/** All lazy loaders, keyed by type — the single source the RENDERERS map and
 *  `preloadRenderer` share. */
const LOADERS: Record<string, () => Promise<{ default: ComponentType<GenUIComponentProps> }>> = {
  header: () => import("./Header"),
  image: () => import("./Image"),
  image_grid: () => import("./ImageGrid"),
  comparison_table: () => import("./ComparisonTable"),
  code_block: () => import("./CodeBlock"),
  sources_panel: () => import("./SourcesPanel"),
  card: () => import("./Card"),
  card_grid: () => import("./CardGrid"),
  stat: () => import("./Stat"),
  stats_row: () => import("./StatsRow"),
  callout: () => import("./Callout"),
  list: () => import("./List"),
  checklist: () => import("./Checklist"),
  timeline: () => import("./Timeline"),
  stepper: () => import("./Stepper"),
  divider: () => import("./Divider"),
  columns: () => import("./Columns"),
  tabs: () => import("./Tabs"),
  accordion: () => import("./Accordion"),
  text_block: () => import("./TextBlock"),
  quote: () => import("./Quote"),
  key_value: () => import("./KeyValue"),
  badge: () => import("./Badge"),
  progress: () => import("./Progress"),
  sparkline: () => import("./Sparkline"),
  suggestion_chips: () => import("./SuggestionChips"),
  agent_card: () => import("./AgentCard"),
  terminal_card: () => import("./TerminalCard"),
  weather_card: () => import("./WeatherCard"),
  stock_ticker: () => import("./StockTicker"),
  custom_html: () => import("./CustomHTML"),
  custom_card: () => import("./CustomCard"),
  root: () => import("./Root"),
  unknown_json: () => import("./UnknownFallback"),
};

/** Map of type → lazy-loaded renderer (built once at module scope). */
export const RENDERERS: Record<string, ComponentType<GenUIComponentProps>> = {};
for (const [type, loader] of Object.entries(LOADERS)) {
  RENDERERS[type] = dynamic(loader, { ssr: false, loading });
}

/**
 * Warm the lazy chunk for a type WITHOUT rendering it — called by the GenUI
 * creation gate while the "Creating …" line streams so the finished block
 * renders without a loading flash. `next/dynamic` caches the import, so
 * repeat calls (every stream flush) are free no-ops.
 */
export function preloadRenderer(type: string): void {
  const loader = LOADERS[type];
  if (loader) void loader();
}

/**
 * Look up a renderer by type. Falls back to `UnknownFallback` for unknown
 * types (which `validate.ts` already rewrites to `unknown_json`, but this
 * is a defensive second line of defense).
 */
export function getRenderer(type: string): ComponentType<GenUIComponentProps> {
  return RENDERERS[type] ?? RENDERERS.unknown_json!;
}

/** List of all registered type names (for the system prompt + debugging). */
export const REGISTERED_TYPES = Object.keys(RENDERERS).filter((t) => t !== "unknown_json");
