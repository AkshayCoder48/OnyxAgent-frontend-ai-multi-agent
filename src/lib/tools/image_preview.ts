"use client";

import { registerTool } from "./registry";

/**
 * preview_image tool — lets the AI display an image inline in the chat.
 *
 * The AI can pass either:
 *   - A URL (http/https) — rendered as <img src="url">
 *   - A base64 data URI — rendered as <img src="data:image/...">
 *
 * The tool returns `{ kind: "image_preview", url, alt }` which the ToolCallCard
 * detects and renders as an inline image (similar to how charts render).
 */

registerTool(
  "preview_image",
  `Display an image inline in the chat. Use this to show the user a visual — a generated image, a screenshot, a diagram URL, a chart from an external service, etc.

Accepts:
- url: An HTTP/HTTPS URL to an image (e.g. "https://example.com/chart.png")
- base64: A base64-encoded image with data URI prefix (e.g. "data:image/png;base64,iVBOR...")
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
      alt: {
        type: "string",
        description: "Optional caption / alt text shown below the image.",
      },
    },
    additionalProperties: false,
  },
  async (args) => {
    const url = (args.url as string) || (args.base64 as string) || "";
    const alt = (args.alt as string) || "";

    if (!url) {
      return { error: "Either 'url' or 'base64' must be provided." };
    }

    // Validate URL format
    if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("data:image/")) {
      return { error: "URL must start with http://, https://, or data:image/" };
    }

    return {
      kind: "image_preview",
      url,
      alt,
    };
  },
  false,
  "general",
);
