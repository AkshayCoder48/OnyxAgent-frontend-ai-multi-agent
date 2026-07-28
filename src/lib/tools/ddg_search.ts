// Web Search Tools — web, image, news, video, map search.
//
// Routing:
//   - When the user has a LangSearch API key saved (encrypted in their
//     settings), `web_search` and `news_search` route through LangSearch's
//     hybrid keyword+vector API via the unified `/api/ddg-search` proxy
//     (which accepts an optional `langsearch_key` query param). LangSearch
//     returns enhanced results with long-text summaries — better recall
//     and cleaner context for the LLM.
//   - If no key is set, or the search type is image/video/map (LangSearch
//     only does web search), or LangSearch errors out, the proxy transparently
//     falls back to the DuckDuckGo organic scraper. No API key required.
//
// The key is read lazily from `settingsService.getDecryptedLangSearchApiKey`
// on every call so changes in Settings take effect immediately.
import { registerTool } from "./registry";
import type { ToolContext } from "./registry";
import { settingsService } from "@/lib/services";
import type { ToolResult } from "@/types";

/**
 * Issue a search against the unified `/api/ddg-search` proxy. When a
 * LangSearch API key is available for the user, it's appended as
 * `langsearch_key` so the proxy can prefer LangSearch for web/news queries.
 */
async function search(
  query: string,
  type: string,
  limit: number,
  ctx?: ToolContext,
): Promise<{ results: unknown[]; provider?: string }> {
  // Lazily fetch the LangSearch key (only for web/news — image/video/map
  // aren't supported by LangSearch, so we skip the decrypt round-trip).
  let langsearchKey = "";
  if (ctx?.userId && (type === "web" || type === "news")) {
    try {
      langsearchKey = (await settingsService.getDecryptedLangSearchApiKey(ctx.userId)) ?? "";
    } catch {
      // Vault locked / not initialized — silently fall back to DDG.
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
  };
}

// ---- Web Search ----
registerTool(
  "web_search",
  "Search the web for information. Returns titles, URLs, descriptions, and favicons. When a LangSearch API key is configured in Settings, results come from LangSearch's hybrid keyword+vector search (richer summaries, better recall); otherwise falls back to DuckDuckGo. Use for finding information, documentation, articles, tutorials.",
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
      const { results, provider } = await search(query, "web", limit, ctx);
      return {
        success: true,
        output: {
          query,
          type: "web",
          results,
          count: results.length,
          provider: provider ?? "duckduckgo",
        },
      };
    } catch (e) {
      return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
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
      const { results } = await search(query, "image", limit, ctx);
      return {
        success: true,
        output: {
          query,
          type: "image",
          results,
          count: results.length,
        },
      };
    } catch (e) {
      return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
    }
  },
  false,
  "search",
);

// ---- News Search ----
registerTool(
  "news_search",
  "Search for news articles. Returns recent news with titles, URLs, and descriptions. When a LangSearch API key is configured, results come from LangSearch biased toward the past week (freshness=week); otherwise falls back to DuckDuckGo. Use when the user wants current events, breaking news, or recent articles.",
  {
    type: "object",
    properties: {
      query: { type: "string", description: "News search query" },
      limit: { type: "number", description: "Max results (default 10, max 50)" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const query = args.query as string;
    const limit = Math.min((args.limit as number) ?? 10, 50);
    try {
      const { results, provider } = await search(query, "news", limit, ctx);
      return {
        success: true,
        output: {
          query,
          type: "news",
          results,
          count: results.length,
          provider: provider ?? "duckduckgo",
        },
      };
    } catch (e) {
      return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
    }
  },
  false,
  "search",
);

// ---- Video Search ----
registerTool(
  "video_search",
  "Search for videos using DuckDuckGo. Returns video titles, URLs, thumbnails, and sources. Use when the user wants to find videos, tutorials, or multimedia content.",
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
      const { results } = await search(query, "video", limit, ctx);
      return {
        success: true,
        output: {
          query,
          type: "video",
          results,
          count: results.length,
        },
      };
    } catch (e) {
      return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
    }
  },
  false,
  "search",
);

// ---- Map Search ----
registerTool(
  "map_search",
  "Search for places and locations using DuckDuckGo. Returns place names, addresses, and map URLs. Use when the user wants to find nearby places, restaurants, stores, or directions.",
  {
    type: "object",
    properties: {
      query: { type: "string", description: "Location/place search query (e.g., 'coffee near me', 'restaurants in Paris')" },
      limit: { type: "number", description: "Max results (default 10, max 50)" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const query = args.query as string;
    const limit = Math.min((args.limit as number) ?? 10, 50);
    try {
      // DDG doesn't have a separate map endpoint — use web search with location
      const { results } = await search(`${query} maps location`, "web", limit, ctx);
      return {
        success: true,
        output: {
          query,
          type: "map",
          results,
          count: results.length,
          map_url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web&iaxm=places`,
        },
      };
    } catch (e) {
      return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
    }
  },
  false,
  "search",
);
