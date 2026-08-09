"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { GenUIComponentProps, str, num } from "./helpers";

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
 * Use cases:
 *   - Mini-games (tic-tac-toe, snake, memory match, quiz)
 *   - Calculators (mortgage, BMI, unit converter)
 *   - Educational demos (solar system, DNA helix, physics simulation)
 *   - Interactive charts (custom D3/SVG visualizations)
 *   - Animations (CSS art, canvas animations)
 *   - Forms and input widgets
 *   - Anything HTML/CSS/JS can do in a sandbox
 */
export function CustomHTML({ props, streaming }: GenUIComponentProps) {
  const html = str(props.html);
  const title = str(props.title);
  const height = num(props.height, 300);
  const width = str(props.width, "100%");

  if (streaming && !html) {
    return (
      <div className="bg-muted/40 rounded-xl border p-4" style={{ height }}>
        <div className="shimmer h-full w-full rounded" />
      </div>
    );
  }

  if (!html) return null;

  // Wrap bare HTML fragments in a full document with base styles.
  // If the AI provides a complete <html> doc, use as-is.
  const isFullDoc = /<html[\s>]/i.test(html);
  const docContent = isFullDoc
    ? html
    : `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    padding: 12px;
    background: transparent;
    color: #1a1a1a;
    font-size: 14px;
    line-height: 1.5;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e5e5e5; }
  }
  button, input, select {
    font-family: inherit;
    font-size: inherit;
  }
  button {
    cursor: pointer;
    padding: 6px 14px;
    border: 1px solid #ccc;
    border-radius: 6px;
    background: #f5f5f5;
  }
  @media (prefers-color-scheme: dark) {
    button { background: #2a2a2a; border-color: #444; color: #e5e5e5; }
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
