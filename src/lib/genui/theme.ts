/**
 * GenUI theme bridge (PRD §20–22 — GenUI Theme Sync).
 *
 * GenUI cards must feel native to the chat they render in, not like a
 * detached HTML surface. This module reads the app's LIVE theme values from
 * the document root (which the color-scheme picker / dark mode keep
 * up-to-date) and exposes them for two consumers:
 *
 *   1. The AGENT (system prompt) — the AI is told the current chat
 *      background/foreground so it generates GenUI that integrates with it
 *      instead of arbitrarily choosing white/black.
 *   2. The custom_html / custom_card IFRAME renderer — theme values are
 *      injected as CSS variables (`--chat-background`, `--chat-foreground`,
 *      `--chat-muted`, `--chat-border`, `--chat-surface`, `--chat-primary`)
 *      so generated HTML can reference the active theme.
 *
 * Both reads happen at generation/render time — NO page refresh is needed
 * when the user changes the chat background: the next generation picks the
 * new value automatically.
 */

export interface GenUITheme {
  background: string;
  foreground: string;
  muted: string;
  border: string;
  surface: string;
  primary: string;
}

/** Terra defaults (match the light preset) — used for SSR / missing vars. */
export const DEFAULT_GENUI_THEME: GenUITheme = {
  background: "#faf6f0",
  foreground: "#1a1a1a",
  muted: "#f4ece1",
  border: "#e7dccc",
  surface: "#fffdf9",
  primary: "#c4552f",
};

/** Read the app's current theme from the document root's CSS variables. */
export function readChatTheme(): GenUITheme {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return DEFAULT_GENUI_THEME;
  }
  try {
    const cs = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string): string => {
      const raw = cs.getPropertyValue(name).trim();
      return raw || fallback;
    };
    return {
      background: read("--color-background", DEFAULT_GENUI_THEME.background),
      foreground: read("--color-foreground", DEFAULT_GENUI_THEME.foreground),
      muted: read("--color-muted", DEFAULT_GENUI_THEME.muted),
      border: read("--color-border", DEFAULT_GENUI_THEME.border),
      surface: read("--color-card", DEFAULT_GENUI_THEME.surface),
      primary: read("--color-primary", DEFAULT_GENUI_THEME.primary),
    };
  } catch {
    return DEFAULT_GENUI_THEME;
  }
}

/** CSS custom-property block exposing the theme inside a GenUI iframe. */
export function genuiThemeCssVars(theme: GenUITheme): string {
  return [
    `--chat-background: ${theme.background};`,
    `--chat-foreground: ${theme.foreground};`,
    `--chat-muted: ${theme.muted};`,
    `--chat-border: ${theme.border};`,
    `--chat-surface: ${theme.surface};`,
    `--chat-primary: ${theme.primary};`,
  ].join(" ");
}

/**
 * Human-readable theme context for the agent's system prompt. The AI uses
 * this to pick GenUI colors that integrate with the current chat instead of
 * defaulting to a contrasting white/black HTML surface.
 */
export function genuiThemePromptBlock(theme: GenUITheme): string {
  return [
    "## Current Chat Theme (GenUI must match it)",
    `The chat surface the user sees RIGHT NOW uses these colors:`,
    `- background: ${theme.background}`,
    `- foreground (text): ${theme.foreground}`,
    `- muted surface: ${theme.muted}`,
    `- border: ${theme.border}`,
    `- card surface: ${theme.surface}`,
    `- accent: ${theme.primary}`,
    "",
    "When you emit GenUI (including custom_html / custom_card), make it visually belong to this environment:",
    "- Match the background above (or use a derived transparent variant) — do NOT invent a contrasting white/black page background.",
    "- Keep readable contrast for text against that background.",
    "- Reuse the app's visual language: soft borders, rounded corners, subtle surfaces — avoid heavy opaque containers that clash with the chat.",
    "- In custom_html / custom_card you can reference the live theme via CSS variables: var(--chat-background), var(--chat-foreground), var(--chat-muted), var(--chat-border), var(--chat-surface), var(--chat-primary). These are pre-injected into the iframe — prefer them over hardcoded colors.",
    "The injected iframe body ALREADY defaults to background var(--chat-background) and color var(--chat-foreground); only override when the widget truly needs a contrasting surface.",
  ].join("\n");
}
