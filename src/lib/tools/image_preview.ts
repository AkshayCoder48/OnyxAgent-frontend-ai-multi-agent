"use client";

import { registerTool } from "./registry";
import { resolveImageSource } from "./image-sources";

/**
 * preview_image tool — lets the AI display an image inline in the chat.
 *
 * The AI can pass either:
 *   - A URL (http/https) — rendered as <img src="url">
 *   - A base64 data URI — rendered as <img src="data:image/...">
 *   - A path (Runtime PRD §54) — a workspace/sandbox path or an uploaded
 *     file name, resolved through the SAME resolver inspect_image uses
 *     (image-sources.ts: data URL → uploads registry → E2B sandbox → http).
 *     Display-only: no vision call happens here. Use inspect_image when the
 *     AI needs to actually analyze the image.
 *
 * The tool returns `{ kind: "image_preview", url, alt }` which the ToolCallCard
 * detects and renders as an inline image (similar to how charts render).
 */

registerTool(
  "preview_image",
  `Display an image inline in the chat. Use this to show the user a visual — a generated image, a screenshot, a diagram URL, a chart from an external service, etc.

Accepts (url/base64 win over path when several are given):
- url: An HTTP/HTTPS URL to an image (e.g. "https://example.com/chart.png")
- base64: A base64-encoded image with data URI prefix (e.g. "data:image/png;base64,iVBOR...")
- path: An image from the workspace — a sandbox path (e.g. "projects/my-app/public/logo.png", ".onyx/websession/shots/shot-3.png", "uploads/photo.jpg") or an uploaded file name (e.g. "photo.jpg"). Resolved locally and displayed; no AI analysis happens (use inspect_image for that).
- alt: Optional alt text / caption shown below the image

The image renders inline in the chat, just like a chart. The user sees it immediately without needing to click anything.`,
  {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "HTTP/HTTPS URL of the image to display.",
      },
      base64: {
        type: "string",
        description: "Base64 data URI of the image (e.g. 'data:image/png;base64,...'). Use this when you have the raw image data.",
      },
      path: {
        type: "string",
        description:
          "Workspace image to display: a sandbox path (e.g. 'uploads/photo.jpg', '.onyx/websession/shots/shot-2.png') or an uploaded file name. Ignored when url/base64 is given.",
      },
      alt: {
        type: "string",
        description: "Optional caption / alt text shown below the image.",
      },
    },
    additionalProperties: false,
  },
  async (args, ctx) => {
    const url = (args.url as string) || (args.base64 as string) || "";
    const alt = (args.alt as string) || "";

    if (url) {
      // Validate URL format
      if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("data:image/")) {
        return { error: "URL must start with http://, https://, or data:image/" };
      }
      return {
        kind: "image_preview",
        url,
        alt,
      };
    }

    // §54 — resolve a workspace/sandbox/upload path exactly like
    // inspect_image does, but display-only (no vision call).
    const path = (args.path as string) || "";
    if (!path) {
      return { error: "Either 'url', 'base64', or 'path' must be provided." };
    }
    const resolved = await resolveImageSource(path, ctx);
    if (!resolved.ok) {
      return { error: `Image unavailable — ${resolved.reason} (source: ${path})` };
    }
    return {
      kind: "image_preview",
      url: resolved.image.dataUrl,
      alt: alt || path,
    };
  },
  false,
  "general",
);
