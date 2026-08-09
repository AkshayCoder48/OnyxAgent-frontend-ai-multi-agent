/**
 * GenUI validation — Zod-like validation without a zod dependency.
 *
 * Walks the node tree and:
 *   - Strips unknown props (each type has an allow-list; unknown keys are dropped)
 *   - Caps depth at 4 (prevents pathologically nested specs from blowing up React)
 *   - Sanitizes URLs in known URL fields (only https://, http://, data:image/)
 *   - Converts unknown types into a fallback `unknown_json` node carrying the
 *     raw payload as `props.__raw` so the renderer can show it in a `<pre>`.
 *
 * All functions are pure and never throw — invalid input degrades to a safe
 * fallback rather than crashing the chat.
 */

import type { GenUINode, GenUISpec } from "./types";

/** Maximum nesting depth for the node tree. */
export const MAX_DEPTH = 4;

/** URL schemes allowed in GenUI specs. */
const ALLOWED_URL_SCHEMES = ["https:", "http:", "data:image/"];

/** Known URL-bearing prop names per type. Used for URL sanitization. */
const URL_PROPS_BY_TYPE: Record<string, string[]> = {
  image: ["src", "href"],
  sources_panel: [],
  card: ["href"],
  agent_card: ["avatar", "href"],
};

/** Allow-list of string prop names per type. Anything not listed is dropped. */
const ALLOWED_PROPS_BY_TYPE: Record<string, string[]> = {
  header: ["title", "subtitle", "eyebrow", "level"],
  image: ["src", "alt", "caption", "credit", "href", "width", "height"],
  image_grid: ["columns", "gap"],
  comparison_table: ["title", "features", "options"],
  code_block: ["language", "code", "filename", "showLineNumbers"],
  sources_panel: ["title", "sources"],
  card: ["title", "body", "badge", "href", "icon"],
  card_grid: ["columns", "gap"],
  stat: ["label", "value", "delta", "deltaLabel"],
  stats_row: ["gap"],
  callout: ["variant", "title", "body"],
  list: ["ordered", "items"],
  checklist: ["title", "items"],
  timeline: ["title", "events"],
  stepper: ["title", "current", "steps"],
  divider: ["label"],
  columns: ["count", "gap"],
  tabs: ["title", "tabs"],
  accordion: ["title", "items"],
  text_block: ["content", "variant"],
  quote: ["text", "author", "role"],
  key_value: ["title", "pairs"],
  badge: ["text", "variant"],
  progress: ["label", "value", "max", "variant"],
  sparkline: ["data", "label", "color"],
  suggestion_chips: ["title", "chips"],
  agent_card: ["name", "role", "description", "avatar", "href", "status"],
  terminal_card: ["title", "lines", "prompt"],
  weather_card: ["location", "temperature", "unit", "condition", "icon"],
  stock_ticker: ["symbol", "price", "currency", "change", "changePercent"],
  unknown_json: ["__raw", "__type"],
};

/**
 * Sanitize a URL: return it unchanged if it uses an allowed scheme, else null.
 * Relative URLs (starting with `/` or `#`) are also allowed — they're same-origin.
 */
export function sanitizeUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  // Relative URLs are safe.
  if (trimmed.startsWith("/") || trimmed.startsWith("#")) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (ALLOWED_URL_SCHEMES.includes(parsed.protocol)) {
      return trimmed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Strip a props object to only the allow-listed keys for the given type. */
function filterProps(
  type: string,
  props: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!props) return undefined;
  const allowed = ALLOWED_PROPS_BY_TYPE[type];
  if (!allowed) {
    // Unknown type — keep nothing (caller wraps in fallback).
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in props) {
      out[key] = props[key];
    }
  }
  // Sanitize URL props.
  const urlProps = URL_PROPS_BY_TYPE[type] ?? [];
  for (const key of urlProps) {
    if (key in out) {
      const safe = sanitizeUrl(out[key]);
      if (safe === null) {
        delete out[key];
      } else {
        out[key] = safe;
      }
    }
  }
  // Return undefined if empty (keeps the node shape tidy).
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate a single node. Strips unknown props, caps depth, sanitizes URLs.
 * Unknown types become a fallback `unknown_json` node carrying the raw spec.
 *
 * `depth` is the current nesting depth (root = 0). Nodes deeper than
 * `MAX_DEPTH` are dropped.
 */
export function validateNode(
  node: GenUINode,
  depth: number = 0,
): GenUINode | null {
  if (!node || typeof node !== "object") return null;
  if (depth > MAX_DEPTH) return null;

  const type = typeof node.type === "string" ? node.type : "unknown";
  const id =
    typeof node.id === "string" && node.id.length > 0
      ? node.id
      : `genui-${depth}-${type}-${Math.random().toString(36).slice(2, 8)}`;

  // Unknown type → fallback node carrying raw JSON.
  if (!ALLOWED_PROPS_BY_TYPE[type]) {
    const raw = {
      type,
      props: node.props ?? {},
      children: node.children ?? [],
    };
    return {
      id,
      type: "unknown_json",
      props: {
        __type: type,
        __raw: JSON.stringify(raw, null, 2),
      },
      meta: node.meta,
    };
  }

  const props = filterProps(type, node.props);

  // Recursively validate children.
  let children: GenUINode[] | undefined;
  if (Array.isArray(node.children) && node.children.length > 0) {
    const validated = node.children
      .map((c) => validateNode(c, depth + 1))
      .filter((c): c is GenUINode => c !== null);
    if (validated.length > 0) children = validated;
  }

  return {
    id,
    type,
    props,
    children,
    meta: node.meta,
  };
}

/** Validate all nodes in a spec. */
export function validateSpec(spec: GenUISpec | null): GenUISpec {
  if (!spec || !Array.isArray(spec.nodes)) return { nodes: [] };
  const nodes = spec.nodes
    .map((n) => validateNode(n, 0))
    .filter((n): n is GenUINode => n !== null);
  return { nodes };
}
