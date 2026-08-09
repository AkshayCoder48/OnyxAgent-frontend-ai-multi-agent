/**
 * GenUI — Generative UI type definitions.
 *
 * The AI emits `<<<genui>>>...<<</genui>>>` blocks in its text stream. Between
 * the sentinels is a JSON spec describing a tree of rich inline components
 * (image grids, comparison tables, charts, code blocks, etc.). The client
 * parses the spec and renders native React components in place of the block.
 *
 * Design goals:
 *   - Tolerant: specs may be partial while streaming (strings cut mid-value,
 *     missing closing brackets). The parser must never throw — it always
 *     returns *something* renderable.
 *   - Composable: nodes form a tree (children), so layouts like `card_grid`
 *     can contain `card` children, `columns` can contain arbitrary nodes, etc.
 *   - Serializable: the whole spec is plain JSON, so it persists in Dexie
 *     alongside the message and survives reloads.
 */

/** A single node in the GenUI tree. Maps 1:1 to a registered renderer. */
export interface GenUINode {
  /** Stable id (used as React key + for diffing during streaming). */
  id: string;
  /** Renderer type — looked up in the registry. Unknown types fall back to a
   *  card showing the raw JSON. */
  type: string;
  /** Type-specific props. Untyped on purpose — each renderer validates its
   *  own props and degrades gracefully on missing/invalid values. */
  props?: Record<string, unknown>;
  /** Child nodes (for containers like `card_grid`, `columns`, `tabs`). */
  children?: GenUINode[];
  /** Optional metadata — `source` for attribution, `streaming` to show a
   *  shimmer placeholder while the spec is still being received. */
  meta?: {
    source?: string;
    streaming?: boolean;
  };
}

/** A complete GenUI spec — the top-level wrapper emitted between sentinels. */
export interface GenUISpec {
  nodes: GenUINode[];
}

/** The sentinels that delimit a GenUI block in the text stream. */
export const GENUI_OPEN = "<<<genui>>>";
export const GENUI_CLOSE = "<<</genui>>>";

/** Result of `processTextDelta` — describes what the caller should render. */
export interface ProcessTextDeltaResult {
  /** Text outside sentinels that comes BEFORE the first GenUI block. Render
   *  this as normal markdown/text. */
  beforeText: string;
  /** Parsed spec (all complete + in-progress blocks). `null` if no GenUI
   *  block has been seen yet. */
  genuiSpec: GenUISpec | null;
  /** True if we're currently inside a `<<<genui>>>` block (no closing
   *  sentinel seen yet). The UI uses this to show a shimmer placeholder. */
  inGenUI: boolean;
}
