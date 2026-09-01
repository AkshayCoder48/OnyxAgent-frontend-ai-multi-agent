"use client";

import * as React from "react";
import { GenUIComponentProps, str, num } from "./helpers";
import { readChatTheme, genuiThemeCssVars } from "@/lib/genui/theme";

/**
 * `custom_html` — render arbitrary HTML+CSS+JS in a sandboxed iframe.
 *
 * This lets the AI create interactive widgets, mini-games, calculators,
 * educational demos, visualizations — anything that fits in a single HTML
 * document — without any tool calls. The content runs in a sandboxed iframe
 * with `allow-scripts` only: it can run JavaScript but CANNOT access the
 * parent page's DOM, cookies, localStorage, or make same-origin requests.
 *
 * Props:
 *   - html (string, required) — HTML content. Can be a full document or a
 *     fragment (we wrap fragments in a basic HTML document with reset styles).
 *   - title (string) — optional label above the iframe
 *   - height (number, default 300) — iframe height in px
 *   - width (string, default "100%") — iframe width
 *
 * STREAMING STABILITY (PRD §6/§7/§13 — GenUI flicker fix): while the spec
 * is streaming, we render a reserved-height shimmer and DO NOT mount the
 * iframe at all. Updating `srcDoc` on every ~30ms flush used to re-parse
 * and reload the entire iframe document dozens of times per second — each
 * reload is a full document parse + style/layout pass on the main thread,
 * which froze the app and made the whole UI appear to flicker. The iframe
 * now mounts ONCE, when the block closes (streaming flips false) — the
 * container keeps its height the whole time, so there is no layout shift.
 *
 * THEME SYNC (PRD §20–22): the app's live theme is injected into the iframe
 * as CSS variables (--chat-background, --chat-foreground, --chat-muted,
 * --chat-border, --chat-surface, --chat-primary) and the body defaults to
 * the chat's background/foreground, so generated widgets belong to the
 * chat instead of rendering as an unrelated white/black HTML surface.
 */
export function CustomHTML({ props, streaming }: GenUIComponentProps) {
  const html = str(props.html);
  const title = str(props.title);
  const height = num(props.height, 300);
  const width = str(props.width, "100%");

  // While the block streams, keep the card's layout area reserved and mount
  // the iframe only once the spec is complete — see the doc comment above.
  if (streaming) {
    return (
      <div className="bg-muted/40 rounded-xl border p-4" style={{ height }}>
        <div className="shimmer h-full w-full rounded" />
      </div>
    );
  }

  if (!html) return null;

  // Live theme read at render time — reflects background changes WITHOUT a
  // page refresh (each finished card picks up the theme current at its
  // render; new generations get the new values automatically).
  const theme = readChatTheme();
  const themeVars = genuiThemeCssVars(theme);

  // Wrap bare HTML fragments in a full document with base styles.
  // If the AI provides a complete <html> doc, inject the theme vars into its
  // <head> so the same tokens are available either way.
  const isFullDoc = /<html[\s>]/i.test(html);
  const docContent = isFullDoc
    ? html.replace(
        /<head(\s[^>]*)?>/i,
        (m) =>
          `${m}<style>:root{${themeVars}}body{background:var(--chat-background);color:var(--chat-foreground);}</style>`,
      )
    : `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { ${themeVars} }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    padding: 12px;
    background: var(--chat-background, transparent);
    color: var(--chat-foreground, #1a1a1a);
    font-size: 14px;
    line-height: 1.5;
  }
  button, input, select {
    font-family: inherit;
    font-size: inherit;
  }
  button {
    cursor: pointer;
    padding: 6px 14px;
    border: 1px solid var(--chat-border, #ccc);
    border-radius: 6px;
    background: var(--chat-surface, #f5f5f5);
    color: var(--chat-foreground, #1a1a1a);
  }
  canvas { max-width: 100%; height: auto; }
</style>
</head>
<body>
${html}
</body>
</html>`;

  return (
    <div className="my-2">
      {title && (
        <div className="text-foreground/60 mb-1.5 flex items-center gap-1.5 font-mono text-[10px] tracking-wider uppercase">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
          {title}
        </div>
      )}
      <div className="bg-background overflow-hidden rounded-xl border">
        <iframe
          srcDoc={docContent}
          sandbox="allow-scripts"
          className="w-full border-0"
          style={{ height: `${height}px`, width, background: "transparent" }}
          title={title || "Custom widget"}
          loading="lazy"
        />
      </div>
    </div>
  );
}

export default CustomHTML;
