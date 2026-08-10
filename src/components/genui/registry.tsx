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
 */

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import type { GenUIComponentProps } from "./helpers";

const loading = () => (
  <div className="bg-muted/40 flex h-16 w-full animate-pulse rounded-xl" />
);

/** Helper to wrap a component in `next/dynamic` with consistent options. */
function lazily(loader: () => Promise<{ default: ComponentType<GenUIComponentProps> }>) {
  return dynamic(loader, { ssr: false, loading });
}

/** Map of type → lazy-loaded renderer. */
export const RENDERERS: Record<string, ComponentType<GenUIComponentProps>> = {
  header: lazily(() => import("./Header")),
  image: lazily(() => import("./Image")),
  image_grid: lazily(() => import("./ImageGrid")),
  comparison_table: lazily(() => import("./ComparisonTable")),
  code_block: lazily(() => import("./CodeBlock")),
  sources_panel: lazily(() => import("./SourcesPanel")),
  card: lazily(() => import("./Card")),
  card_grid: lazily(() => import("./CardGrid")),
  stat: lazily(() => import("./Stat")),
  stats_row: lazily(() => import("./StatsRow")),
  callout: lazily(() => import("./Callout")),
  list: lazily(() => import("./List")),
  checklist: lazily(() => import("./Checklist")),
  timeline: lazily(() => import("./Timeline")),
  stepper: lazily(() => import("./Stepper")),
  divider: lazily(() => import("./Divider")),
  columns: lazily(() => import("./Columns")),
  tabs: lazily(() => import("./Tabs")),
  accordion: lazily(() => import("./Accordion")),
  text_block: lazily(() => import("./TextBlock")),
  quote: lazily(() => import("./Quote")),
  key_value: lazily(() => import("./KeyValue")),
  badge: lazily(() => import("./Badge")),
  progress: lazily(() => import("./Progress")),
  sparkline: lazily(() => import("./Sparkline")),
  suggestion_chips: lazily(() => import("./SuggestionChips")),
  agent_card: lazily(() => import("./AgentCard")),
  terminal_card: lazily(() => import("./TerminalCard")),
  weather_card: lazily(() => import("./WeatherCard")),
  stock_ticker: lazily(() => import("./StockTicker")),
  custom_html: lazily(() => import("./CustomHTML")),
  custom_card: lazily(() => import("./CustomCard")),
  root: lazily(() => import("./Root")),
  unknown_json: lazily(() => import("./UnknownFallback")),
};

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
