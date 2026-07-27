"use client";

import { registerTool } from "./registry";

/**
 * Web Fetch tool — fetch and extract readable content from web pages.
 * Uses the server-side /api/chat-proxy to avoid CORS.
 * Supports HTML pages (extracts text) and text files (.txt, .md, .csv, .json).
 */

registerTool(
  "web_fetch",
  "Fetch and extract readable text content from a web page URL. Returns the page title, text content, and metadata. Useful for reading articles, documentation, or API responses. Supports HTML pages and text files.",
  {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch (must start with http:// or https://)" },
      max_length: { type: "number", description: "Maximum content length in characters (default 10000)" },
    },
    required: ["url"],
    additionalProperties: false,
  },
  async (args) => {
    const url = args.url as string;
    const maxLength = (args.max_length as number) ?? 10000;
    if (!url || !url.match(/^https?:\/\//)) {
      return { error: "Invalid URL. Must start with http:// or https://" };
    }

    try {
      const res = await fetch(`/api/chat-proxy?url=${encodeURIComponent(url)}`, {
        method: "GET",
        headers: {
          "x-target-url": url,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        return { error: `Failed to fetch URL: HTTP ${res.status}` };
      }

      const html = await res.text();

      // Extract title
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const title = titleMatch?.[1]?.trim() || url;

      // Extract readable text — strip HTML tags, scripts, styles
      let text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();

      if (text.length > maxLength) {
        text = text.slice(0, maxLength) + "\n\n... (truncated, full length: " + text.length + " chars)";
      }

      return {
        url,
        title,
        content: text,
        length: text.length,
      };
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
  false,
  "web",
);
