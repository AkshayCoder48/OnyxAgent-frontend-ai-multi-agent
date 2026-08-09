"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui";
import { GenUIComponentProps, str, num } from "./helpers";

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
 */
export function CustomCard({ props, streaming }: GenUIComponentProps) {
  const title = str(props.title);
  const html = str(props.html);
  const body = str(props.body || props.description || props.text);
  const icon = str(props.icon);
  const height = num(props.height, 250);

  if (streaming && !html) {
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

  const docContent = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    padding: 8px;
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
    padding: 4px 12px;
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
