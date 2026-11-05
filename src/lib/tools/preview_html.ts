"use client";

/**
 * Tool: preview_html — render ANY codebase HTML file live in the chat.
 *
 * User request 2026-11-05: "add option for AI to preview any codebase's
 * html into gen ui with a tool". The agent builds a site/app in the
 * workspace (landing pages, games, demos, static builds) and this tool
 * turns a chosen file into a LIVE, interactive preview card — rendered
 * through the same sandboxed iframe machinery as GenUI's custom_html node
 * (allow-scripts only: no parent DOM, no cookies, no same-origin fetches),
 * so the user sees the result without leaving the chat or downloading
 * anything.
 *
 * Resolution:
 *   - `path` — a workspace file (the usual case: the AI just wrote
 *     index.html / game.html / dist/index.html and previews it). Relative
 *     paths resolve against /home/user. Non-HTML extensions are accepted
 *     as long as the CONTENT parses as HTML (builds emit extensionless or
 *     oddly-named files); the card only ever sandbox-renders.
 *   - `html` — inline content instead of a file (small fragments the model
 *     wants to show without a workspace round-trip).
 *
 * The result payload { html, title, height, source } drives the chat's
 * PreviewHtmlResult card (tool-results/preview-html.tsx).
 */

import { registerTool, type ToolContext } from "./registry";
import { chatSandboxForCtx } from "@/lib/e2b/sandbox-rotation";

/** Single-preview size bound (the card ships the whole document to the
 *  iframe srcDoc — 2 MB is far beyond any sensible hand-written page). */
const MAX_HTML_BYTES = 2 * 1024 * 1024;

const PREVIEW_HTML_DESCRIPTION = `Render an HTML file from the workspace (or inline HTML) as a LIVE, interactive preview card in the chat.

WHEN TO USE: after building or editing any HTML page/site/game/demo in the workspace — show the user the result immediately instead of describing it. Also for quick visual verification of your own markup before iterating further.

Arguments:
- path (preferred): workspace file to render, e.g. "index.html", "projects/site/dist/index.html". Relative paths resolve against the workspace root (/home/user).
- html: inline HTML when there is no file (either path or html is required; path wins when both are given).
- height (optional): card height in px (default 420, max 900).
- title (optional): label shown above the preview (defaults to the file name).

The preview runs sandboxed (scripts execute, but it cannot touch the app's data). Multi-file sites with separate CSS/JS resolve only if they sit next to the previewed file — for multi-file apps prefer a single self-contained HTML or use the preview server tools.`;

interface PreviewHtmlResult {
  html: string;
  title: string;
  height: number;
  source: string;
  truncated?: boolean;
  error?: string;
}

function looksLikeHtml(s: string): boolean {
  const head = s.slice(0, 2000).toLowerCase();
  return (
    head.includes("<!doctype html") ||
    head.includes("<html") ||
    head.includes("<head") ||
    head.includes("<body") ||
    head.includes("<div") ||
    head.includes("<canvas") ||
    head.includes("<svg")
  );
}

export async function previewHtmlHandler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<PreviewHtmlResult> {
  const path = typeof args.path === "string" ? args.path.trim() : "";
  const inline =
    typeof args.html === "string"
      ? args.html
      : typeof args.content === "string"
        ? (args.content as string)
        : "";
  const height = Math.max(
    160,
    Math.min(
      typeof args.height === "number" ? args.height : 420,
      900,
    ),
  );
  let title = typeof args.title === "string" ? args.title.trim() : "";

  if (!path && !inline.trim()) {
    return {
      html: "",
      title: title || "Preview",
      height,
      source: "none",
      error:
        "Nothing to preview — pass `path` (a workspace HTML file) or `html` (inline content).",
    };
  }

  // Inline lane — no sandbox round-trip.
  if (!path) {
    if (inline.length > MAX_HTML_BYTES) {
      return {
        html: "",
        title: title || "Inline preview",
        height,
        source: "inline",
        error: `Inline HTML is ${(inline.length / 1024).toFixed(0)} KB — the preview cap is ${MAX_HTML_BYTES / 1024} KB. Write it to a workspace file instead.`,
      };
    }
    return {
      html: inline,
      title: title || "Inline preview",
      height,
      source: "inline",
    };
  }

  // File lane — read from the ctx-resolved sandbox.
  const sbx = await chatSandboxForCtx(ctx);
  if (!sbx) {
    return {
      html: "",
      title: title || path,
      height,
      source: path,
      error:
        "No sandbox is configured — add an E2B key in Settings → Config to preview workspace files.",
    };
  }
  try {
    const client = sbx.client;
    const content = await client.readFile(path);
    if (!content || !content.trim()) {
      return {
        html: "",
        title: title || path,
        height,
        source: path,
        error: `The file is empty: ${path}`,
      };
    }
    if (content.length > MAX_HTML_BYTES) {
      return {
        html: "",
        title: title || path,
        height,
        source: path,
        error: `${path} is ${(content.length / 1024).toFixed(0)} KB — the preview cap is ${MAX_HTML_BYTES / 1024} KB. Serve it with the preview-server tools instead.`,
      };
    }
    if (!looksLikeHtml(content)) {
      return {
        html: "",
        title: title || path,
        height,
        source: path,
        error: `${path} does not look like HTML (no doctype/html/head/body/div markers in the first 2 KB). Use read_file for text or preview_image for images.`,
      };
    }
    return {
      html: content,
      title: title || path.split("/").pop() || path,
      height,
      source: path,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      html: "",
      title: title || path,
      height,
      source: path,
      error: `Could not read ${path}: ${msg}`,
    };
  }
}

registerTool(
  "preview_html",
  PREVIEW_HTML_DESCRIPTION,
  {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace HTML file to render live (preferred over html).",
      },
      html: {
        type: "string",
        description: "Inline HTML to render when there is no file.",
      },
      height: {
        type: "number",
        description: "Preview card height in px (default 420, max 900).",
      },
      title: { type: "string", description: "Label above the preview." },
    },
    additionalProperties: false,
  },
  previewHtmlHandler,
  false,
  "files",
);
