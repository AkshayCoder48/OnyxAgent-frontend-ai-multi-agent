"use client";

import { registerTool } from "./registry";
import { resolveImageSource } from "./image-sources";

/**
 * preview_image tool — lets the AI display an image inline in the chat.
 *
 * The AI can pass either:
 *   - A URL (http/https) — rendered as <img src="url">
 *   - A base64 data URI — rendered as <img src="data:image/...">
 *   - A path — a workspace/sandbox path or an uploaded file name, resolved
 *     through image-sources.ts (data URL → uploads registry → E2B sandbox →
 *     http). Display-only: no vision call happens here.
 *
 * WORKSPACE FIX: models frequently put a workspace path ("uploads/photo.jpg",
 * "projects/my-app/public/logo.png") into the `url` argument. That used to
 * hard-fail with "URL must start with http://, https://, or data:image/".
 * Now anything that isn't an http(s)/data: URL is treated as a workspace
 * path and resolved through the same resolver the `path` argument uses —
 * so workspace images just work no matter which argument the model chose.
 */

const HTTPISH_RE = /^https?:\/\//i;

registerTool(
  "preview_image",
  `Display an image inline in the chat. Use this to show the user a visual — a generated image, a screenshot, a diagram URL, a chart from an external service, etc.

Accepts (base64 wins; url and path are interchangeable):
- url: An HTTP/HTTPS URL to an image (e.g. "https://example.com/chart.png") — or a workspace path (same as path)
- base64: A base64-encoded image with data URI prefix (e.g. "data:image/png;base64,iVBOR...")
- path: An image from the workspace — a sandbox path (e.g. "projects/my-app/public/logo.png", ".onyx/browser/shots/shot-3.png", "uploads/photo.jpg") or an uploaded file name (e.g. "photo.jpg"). Resolved locally and displayed inline.
- alt: Optional alt text / caption shown below the image

The image renders inline in the chat, just like a chart. The user sees it immediately without needing to click anything.`,
  {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "HTTP/HTTPS URL of the image to display — or a workspace/sandbox path / uploaded file name.",
      },
      base64: {
        type: "string",
        description: "Base64 data URI of the image (e.g. 'data:image/png;base64,...'). Use this when you have the raw image data.",
      },
      path: {
        type: "string",
        description:
          "Workspace image to display: a sandbox path (e.g. 'uploads/photo.jpg', '.onyx/browser/shots/shot-2.png') or an uploaded file name.",
      },
      alt: {
        type: "string",
        description: "Optional caption / alt text shown below the image.",
      },
    },
    additionalProperties: false,
  },
  async (args, ctx) => {
    const alt = (args.alt as string) || "";
    const base64 = ((args.base64 as string) || "").trim();
    const urlArg = ((args.url as string) || "").trim();
    const pathArg = ((args.path as string) || "").trim();

    // 1. base64 wins outright — it is already the image bytes.
    if (base64) {
      const url = base64.startsWith("data:")
        ? base64
        : `data:image/png;base64,${base64.replace(/\s+/g, "")}`;
      return { kind: "image_preview", url, alt };
    }

    // 2. A real http(s) URL (or a bare data:image/ URI in `url`) displays
    //    directly.
    if (urlArg && (HTTPISH_RE.test(urlArg) || urlArg.startsWith("data:image/"))) {
      return { kind: "image_preview", url: urlArg, alt };
    }

    // 3. Workspace resolution — an explicit `path`, OR a `url` that isn't
    //    http(s)/data: (models frequently pass workspace paths in `url`;
    //    that used to hard-fail with "URL must start with http(s)://").
    //    Resolution order: data URL → uploads registry → E2B sandbox →
    //    direct http fetch.
    const candidate = pathArg || urlArg;
    if (!candidate) {
      return { error: "Either 'url', 'base64', or 'path' must be provided." };
    }
    const resolved = await resolveImageSource(candidate, ctx);
    if (!resolved.ok) {
      return { error: `Image unavailable — ${resolved.reason} (source: ${candidate})` };
    }
    return {
      kind: "image_preview",
      url: resolved.image.dataUrl,
      alt: alt || candidate,
    };
  },
  false,
  "general",
);
