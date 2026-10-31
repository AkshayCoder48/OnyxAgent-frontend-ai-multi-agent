// Web Search Tools — web, image, and video search, all DuckDuckGo-backed.
//
// Routing:
//   - **web_search**: When the user has a LangSearch API key saved (encrypted
//     in their settings — their own key, BYOK), queries route through
//     LangSearch's hybrid keyword+vector API via the unified `/api/ddg-search`
//     proxy, which returns enhanced results with long-text summaries. If no
//     key is set or LangSearch errors out, the proxy serves the query from
//     DuckDuckGo's keyless HTML search.
//   - **image_search**: DuckDuckGo images via @mudbill/duckduckgo-images-api
//     — no API key, no billing, real thumbnails + dimensions.
//   - **video_search**: DuckDuckGo videos via the keyless v.js endpoint —
//     real durations, thumbnails, channel and view counts.
//
// The LangSearch key is read lazily from
// `settingsService.getDecryptedLangSearchApiKey` on every call so changes in
// Settings take effect immediately.
import { registerTool } from "./registry";
import type { ToolContext } from "./registry";
import { settingsService } from "@/lib/services";
import type { ToolResult } from "@/types";

/**
 * Clean, user-facing label per search kind — used by the no-results notice
 * and the sanitized error paths below. Raw upstream messages (provider
 * names, raw JSON bodies like '{"success":false,"error":"No results
 * found"}') must never reach the model's context or the chat tool-result
 * card verbatim.
 */
const SEARCH_LABELS = {
  web: { singular: "Web search", results: "web results" },
  image: { singular: "Image search", results: "images" },
  video: { singular: "Video search", results: "videos" },
} as const;

/** Label lookup that degrades to the web wording for unknown types
 * (noUncheckedIndexedAccess-safe). */
function labelsFor(type: string): { singular: string; results: string } {
  const hit = (SEARCH_LABELS as Record<string, { singular: string; results: string } | undefined>)[type];
  return hit ?? SEARCH_LABELS.web;
}

/**
 * Issue a search against the unified `/api/ddg-search` proxy. When a
 * LangSearch API key is available for the user, it's appended as
 * `langsearch_key` so the proxy can prefer LangSearch for web queries.
 */
async function search(
  query: string,
  type: string,
  limit: number,
  ctx?: ToolContext,
): Promise<{ results: unknown[]; provider?: string; note?: string }> {
  // Lazily fetch the LangSearch key (only for web — image/video aren't
  // supported by LangSearch, so we skip the decrypt round-trip).
  let langsearchKey = "";
  if (ctx?.userId && type === "web") {
    try {
      langsearchKey = (await settingsService.getDecryptedLangSearchApiKey(ctx.userId)) ?? "";
    } catch {
      langsearchKey = "";
    }
  }

  const params = new URLSearchParams({
    q: query,
    type,
    limit: String(limit),
  });
  if (langsearchKey) params.set("langsearch_key", langsearchKey);

  const res = await fetch(`/api/ddg-search?${params.toString()}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Search failed" }));
    throw new Error(err.error || `Search HTTP ${res.status}`);
  }
  const data = await res.json();
  return {
    results: data.results || [],
    provider: data.provider as string | undefined,
    note: typeof data.note === "string" ? data.note : undefined,
  };
}

/**
 * Build the graceful "nothing matched" payload. "No results" is a
 * legitimate outcome, NOT a failure — returning success:true with an empty
 * list plus this notice lets the model say "I couldn't find any images for
 * that" instead of surfacing a raw backend error blob.
 */
function noResultsOutput(query: string, type: string, provider?: string, note?: string) {
  const labels = labelsFor(type);
  return {
    query,
    type,
    results: [],
    count: 0,
    ...(provider ? { provider } : {}),
    message:
      note ??
      `No ${labels.results} found for "${query}". Try different or more general keywords.`,
  };
}

/**
 * Sanitize a failed search into a clean message. Belt-and-suspenders on top
 * of the proxy's own sanitization: strips any provider name / raw JSON
 * that slipped through so the chat never renders raw backend error blobs.
 * ("miklium" stays in the blocklist on purpose: it is the provider whose
 * raw errors once leaked into the chat — if any stale/regressed upstream
 * ever emits it again, it gets scrubbed here.)
 */
function sanitizedError(type: string, e: unknown): string {
  const labels = labelsFor(type);
  const raw = e instanceof Error ? e.message : String(e);
  const cleaned = raw
    .replace(/miklium|langsearch|duckduckgo|ddg-search/gi, "search backend")
    .replace(/\{[\s\S]*\}/g, "") // raw JSON bodies add nothing for the user
    .replace(/\s+/g, " ")
    .trim();
  return cleaned && cleaned !== raw
    ? `${labels.singular} failed: ${cleaned}`
    : `${labels.singular} is temporarily unavailable. Please try again in a moment.`;
}

// ---- Web Search ----
registerTool(
  "web_search",
  "Search the web for information. Returns titles, URLs, descriptions, and favicons. When a LangSearch API key is configured in Settings, results come from LangSearch's hybrid keyword+vector search (richer summaries, better recall); otherwise uses DuckDuckGo. Use for finding information, documentation, articles, tutorials.",
  {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Max results (default 10, max 50)" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const query = args.query as string;
    const limit = Math.min((args.limit as number) ?? 10, 50);
    try {
      const { results, provider, note } = await search(query, "web", limit, ctx);
      if (results.length === 0) {
        return { success: true, output: noResultsOutput(query, "web", provider, note) };
      }
      return {
        success: true,
        output: {
          // `kind` lets the citation extractor recognize this payload in any
          // wrapper shape (Beta V1.2 inline citations).
          kind: "web_search",
          query,
          type: "web",
          results,
          count: results.length,
          provider: provider ?? "ddg",
        },
      };
    } catch (e) {
      return { success: false, output: null, error: sanitizedError("web", e) };
    }
  },
  false,
  "search",
);

// ---- Image Search ----
registerTool(
  "image_search",
  "Search for images using DuckDuckGo. Returns image URLs, thumbnails, dimensions, and source pages. Use when the user wants to find pictures, photos, diagrams, or visual content.",
  {
    type: "object",
    properties: {
      query: { type: "string", description: "Image search query" },
      limit: { type: "number", description: "Max results (default 10, max 50)" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const query = args.query as string;
    const limit = Math.min((args.limit as number) ?? 10, 50);
    try {
      // The proxy reports the provider that actually served the results
      // ("ddg", or "langsearch" when the user's key is active).
      const { results, provider, note } = await search(query, "image", limit, ctx);
      if (results.length === 0) {
        return { success: true, output: noResultsOutput(query, "image", provider, note) };
      }
      return {
        success: true,
        output: {
          query,
          type: "image",
          results,
          count: results.length,
          provider: provider ?? "ddg",
        },
      };
    } catch (e) {
      return { success: false, output: null, error: sanitizedError("image", e) };
    }
  },
  false,
  "search",
);

// ---- Video Search ----
registerTool(
  "video_search",
  "Search for videos using DuckDuckGo. Returns video titles, URLs, thumbnails, durations, and channel info. Use when the user wants to find videos, tutorials, or multimedia content.",
  {
    type: "object",
    properties: {
      query: { type: "string", description: "Video search query" },
      limit: { type: "number", description: "Max results (default 10, max 50)" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const query = args.query as string;
    const limit = Math.min((args.limit as number) ?? 10, 50);
    try {
      const { results, provider, note } = await search(query, "video", limit, ctx);
      if (results.length === 0) {
        return { success: true, output: noResultsOutput(query, "video", provider ?? "ddg", note) };
      }
      return {
        success: true,
        output: {
          query,
          type: "video",
          results,
          count: results.length,
          provider: provider ?? "ddg",
        },
      };
    } catch (e) {
      return { success: false, output: null, error: sanitizedError("video", e) };
    }
  },
  false,
  "search",
);
