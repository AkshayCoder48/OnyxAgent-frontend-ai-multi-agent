"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui";
import { GenUIComponentProps, str, num } from "./helpers";
import { readChatTheme, genuiThemeCssVars } from "@/lib/genui/theme";

/**
 * `custom_card` — card-wrapped custom HTML widget.
 *
 * Like `custom_html` but wrapped in a styled card with title, icon, and
 * description. Good for educational widgets and demos that should look like
 * part of the chat UI.
 *
 * Props:
 *   - title (string) — card title
 *   - html (string, required) — HTML content for the iframe body
 *   - body / description / text (string) — optional description below title
 *   - icon (string) — emoji or short label
 *   - height (number, default 250) — iframe height in px
 *
 * The HTML runs in a sandboxed iframe with `allow-scripts` only.
 *
 * STREAMING STABILITY + THEME SYNC: identical to `custom_html` — the iframe
 * mounts ONCE when the block finishes streaming (never mid-stream, which
 * used to reload the document ~33×/sec and freeze the app), and the live
 * app theme is injected as --chat-* CSS variables with the body defaulting
 * to the chat background/foreground (PRD §6/§7/§13/§20–22).
 */
export function CustomCard({ props, streaming }: GenUIComponentProps) {
  const title = str(props.title);
  const html = str(props.html || props.content);
  const body = str(props.body || props.description || props.text);
  const icon = str(props.icon);
  const height = num(props.height, 250);

  if (streaming) {
    return (
      <Card className="overflow-hidden">
        <CardContent className="p-4">
          <div className="shimmer mb-3 h-4 w-32 rounded" />
          <div className="shimmer rounded" style={{ height }} />
        </CardContent>
      </Card>
    );
  }

  if (!html) return null;

  const theme = readChatTheme();
  const themeVars = genuiThemeCssVars(theme);

  const docContent = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { ${themeVars} }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    padding: 8px;
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
    padding: 4px 12px;
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
    <Card className="overflow-hidden">
      <CardContent className="p-4">
        <div className="mb-2 flex items-center gap-2">
          {icon && (
            <span className="bg-primary/10 text-primary flex h-7 w-7 items-center justify-center rounded-lg text-sm">
              {icon}
            </span>
          )}
          {title && (
            <h3 className="text-foreground text-sm font-semibold">{title}</h3>
          )}
        </div>
        {body && (
          <p className="text-muted-foreground mb-2 text-xs leading-relaxed">{body}</p>
        )}
        <div className="bg-background overflow-hidden rounded-lg border">
          <iframe
            srcDoc={docContent}
            sandbox="allow-scripts"
            className="w-full border-0"
            style={{ height: `${height}px`, background: "transparent" }}
            title={title || "Custom widget"}
            loading="lazy"
          />
        </div>
      </CardContent>
    </Card>
  );
}

export default CustomCard;
