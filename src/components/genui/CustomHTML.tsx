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
 *   - js / javascript / script (string) — SEPARATE JavaScript payload. Models
 *     often split markup and logic across `html` + `js` props; the script is
 *     appended at the END of the body (after all markup exists) and wrapped
 *     in try/catch + an error surface so a JS bug shows in-card instead of
 *     silently killing the widget.
 *   - css / style (string) — SEPARATE stylesheet appended into <head>.
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
/** Pull the separate JS payload out of the props (js | javascript | script). */
function extractJs(props: Record<string, unknown>): string {
  for (const key of ["js", "javascript", "script"]) {
    const v = props[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

/** Pull the separate CSS payload out of the props (css | style). */
function extractCss(props: Record<string, unknown>): string {
  for (const key of ["css", "style"]) {
    const v = props[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

/** Build the script payload: the JS wrapped in try/catch + an error
 *  surface. A plain <script> with a runtime error fails SILENTLY in an
 *  iframe — the widget looks dead with no clue why. The wrapper catches
 *  errors (sync + async) and paints them at the top of the card so the
 *  user can see what broke. */
function wrapJs(js: string): string {
  return `
window.__genuiError = function (err) {
  try {
    var box = document.getElementById('__genui-err');
    if (!box) {
      box = document.createElement('div');
      box.id = '__genui-err';
      box.style.cssText = 'position:relative;z-index:99;margin:0 0 8px;padding:6px 10px;border-radius:6px;background:rgba(220,38,38,0.08);border:1px solid rgba(220,38,38,0.35);color:#b91c1c;font:600 11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word;';
      document.body.insertBefore(box, document.body.firstChild);
    }
    box.textContent = 'Script error: ' + (err && err.message ? err.message : String(err));
  } catch (e) { /* last-resort — never loop */ }
};
window.addEventListener('error', function (e) { window.__genuiError(e.error || e.message); });
window.addEventListener('unhandledrejection', function (e) { window.__genuiError(e.reason); });
try {
${js}
} catch (err) { window.__genuiError(err); }
`;
}

export function CustomHTML({ props, streaming }: GenUIComponentProps) {
  const html = str(props.html);
  const js = extractJs(props);
  const css = extractCss(props);
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

  if (!html && !js) return null;

  // Live theme read at render time — reflects background changes WITHOUT a
  // page refresh (each finished card picks up the theme current at its
  // render; new generations get the new values automatically).
  const theme = readChatTheme();
  const themeVars = genuiThemeCssVars(theme);

  const customStyle = css ? `<style>\n${css}\n</style>\n` : "";
  const customScript = js ? `<script>\n${wrapJs(js)}\n</script>\n` : "";

  // Wrap bare HTML fragments in a full document with base styles.
  // If the AI provides a complete <html> doc, inject the theme vars + the
  // separate css/js payloads into it so both formats behave identically.
  const isFullDoc = /<html[\s>]/i.test(html);
  const docContent = isFullDoc
    ? (() => {
        let doc = html;
        // Inject theme vars + custom css into <head> (or create one).
        const headInject = `<style>:root{${themeVars}}body{background:var(--chat-background);color:var(--chat-foreground);}</style>${customStyle}`;
        if (/<head(\s[^>]*)?>/i.test(doc)) {
          doc = doc.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${headInject}`);
        } else {
          doc = doc.replace(/<html(\s[^>]*)?>/i, (m) => `${m}<head>${headInject}</head>`);
        }
        // Append the custom script right before </body> (markup exists by then).
        if (customScript) {
          if (/<\/body>/i.test(doc)) {
            doc = doc.replace(/<\/body>/i, `${customScript}</body>`);
          } else {
            doc += customScript;
          }
        }
        return doc;
      })()
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
${customStyle}</head>
<body>
${html}
${customScript}</body>
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
