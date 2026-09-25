/**
 * GenUI creation label — PRD §21.
 *
 * While a `<<<genui>>>` block streams in, the chat does NOT show a shimmer
 * placeholder card. It shows a thinking-UI-style gray animated line:
 *
 *     "Creating a card grid…"
 *
 * The description is derived from the streaming JSON itself — an explicit
 * `label` / `title` / `heading` / `name` prop on the first node when the AI
 * provided one, otherwise a friendly phrase mapped from the node type
 * ("a minigame" for game-like custom HTML, "a flow chart" for a timeline,
 * "a card grid", "a dashboard", …), and finally the fallback "this UI".
 *
 * PHRASING RULES (per the user's spec):
 *   - Rendered WITHOUT literal parentheses — "Creating a minigame…", never
 *     "Creating (a minigame)…". Parentheses are stripped from AI labels.
 *   - The caller composes `Creating ${phrase}…` — this module returns the
 *     phrase only ("a minigame", "this UI").
 *   - AI labels read naturally: a bare lowercase noun gets an article
 *     ("minigame" → "a minigame", "image gallery" → "an image gallery"),
 *     while capitalized titles are treated as proper names and kept verbatim
 *     ("Weather Dashboard" → "Weather Dashboard"). Labels that already start
 *     with an article are used verbatim ("a fun flow chart").
 */

import type { GenUINode, GenUISpec } from "./types";

/** Friendly noun phrase per renderer type (articles included). */
const TYPE_PHRASES: Record<string, string> = {
  header: "a header",
  image: "an image",
  image_grid: "an image gallery",
  comparison_table: "a comparison table",
  code_block: "a code block",
  sources_panel: "a sources panel",
  card: "a card",
  card_grid: "a card grid",
  stat: "a stat card",
  stats_row: "a stats dashboard",
  callout: "a callout",
  list: "a list",
  checklist: "a checklist",
  timeline: "a flow chart",
  stepper: "a step-by-step guide",
  divider: "a divider",
  columns: "a column layout",
  tabs: "a tabbed panel",
  accordion: "an accordion",
  text_block: "a text block",
  quote: "a quote",
  key_value: "a key-value list",
  badge: "a badge",
  progress: "a progress bar",
  sparkline: "a sparkline chart",
  suggestion_chips: "suggestion chips",
  agent_card: "an agent card",
  terminal_card: "a terminal card",
  weather_card: "a weather card",
  stock_ticker: "a stock ticker",
  custom_html: "an interactive app",
  custom_card: "a custom card",
};

/** Prop keys that name the thing being created (checked in this order). */
const NAME_KEYS = ["label", "title", "heading", "name", "headline", "caption"] as const;

/** Container types whose FIRST CHILD usually describes the creation better
 *  than the wrapper itself (validateSpec already flattens `root`). */
const CONTAINER_TYPES = new Set(["root", "columns", "card_grid", "tabs", "accordion"]);

/** Game-ish markers inside custom HTML/JS → the phrase becomes "a minigame". */
const GAME_RE = /\b(game|minigame|sprite|canvas|score|player|lives|gamepad|joystick)\b/i;

/** Props that may carry the HTML/JS source of a custom block. */
const CONTENT_KEYS = ["html", "js", "code", "source", "body", "content"] as const;

const MAX_LABEL_LEN = 48;

/** Sanitize an AI-provided label: trim, strip wrapping markdown/quotes and
 *  ALL parentheses (phrasing rule), collapse whitespace, cap the length. */
function cleanLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  let s = value.trim();
  if (!s) return "";
  s = s.replace(/[()]/g, " ");
  s = s.replace(/^["'`*#>\s]+/, "").replace(/["'`*]+\s*$/, "");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > MAX_LABEL_LEN) {
    s = s.slice(0, MAX_LABEL_LEN).replace(/\s+\S*$/, "");
  }
  return s;
}

/** Make a bare AI label read naturally as a creation description. */
function withArticle(phrase: string): string {
  // Already article-led ("a fun flow chart") or demonstrative — verbatim.
  if (/^(a|an|the|this|that|some|my|your|our)\s/i.test(phrase)) return phrase;
  // Capitalized → a proper title ("Weather Dashboard") — verbatim.
  if (/^[A-Z]/.test(phrase)) return phrase;
  // Bare lowercase noun → prepend the right article.
  return (/^[aeiou]/i.test(phrase) ? "an " : "a ") + phrase;
}

/** Phrase for one node: explicit name → game sniff → child descent → type map. */
function nodePhrase(node: GenUINode | undefined): string {
  if (!node) return "";
  const props = node.props ?? {};

  // 1. The AI named what it is creating.
  for (const key of NAME_KEYS) {
    const label = cleanLabel(props[key]);
    if (label) return withArticle(label);
  }
  // card_grid may carry its cards as a plain `cards`/`items` prop array —
  // the first card's title names the creation better than "a card grid".
  const cards = Array.isArray(props.cards) ? props.cards : Array.isArray(props.items) ? props.items : null;
  if (cards && cards.length > 0) {
    const first = cards[0];
    if (first && typeof first === "object") {
      for (const key of NAME_KEYS) {
        const label = cleanLabel((first as Record<string, unknown>)[key]);
        if (label) return withArticle(label);
      }
    }
  }

  const type = String(props.kind ?? node.type ?? "").toLowerCase();

  // 2. Game-like custom blocks → the PRD's flagship example.
  if (type === "custom_html" || type === "custom_card") {
    const content = CONTENT_KEYS.map((k) =>
      typeof props[k] === "string" ? (props[k] as string) : "",
    ).join(" ");
    if (GAME_RE.test(content)) return "a minigame";
  }

  // 3. A container's first child describes the creation more specifically
  //    (columns wrapping a weather card → "a weather card").
  if (CONTAINER_TYPES.has(type) && node.children && node.children.length > 0) {
    const child = nodePhrase(node.children[0]);
    if (child) return child;
  }

  // 4. Friendly phrase for the type itself.
  return TYPE_PHRASES[type] ?? "";
}

/**
 * Derive the creation phrase for a (possibly partial, still-streaming) spec.
 * Never returns an empty string — the caller falls back to "this UI" via the
 * return value itself.
 */
export function deriveCreationPhrase(spec: GenUISpec | null | undefined): string {
  const first = spec?.nodes?.[0];
  return nodePhrase(first) || "this UI";
}
