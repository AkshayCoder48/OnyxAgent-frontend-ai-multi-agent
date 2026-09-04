// Web Search Tools — web, image, and video search.
//
// Routing:
//   - **web_search**: When the user has a LangSearch API key saved (encrypted
//     in their settings), queries route through LangSearch's hybrid
//     keyword+vector API via the unified `/api/ddg-search` proxy. LangSearch
//     returns enhanced results with long-text summaries — better recall and
//     cleaner context for the LLM. If no key is set or LangSearch errors out,
//     the proxy transparently falls back to the Miklium Search API (Yahoo-based).
//   - **image_search**: Always uses Miklium (LangSearch doesn't support images).
//   - **video_search**: Always uses Miklium (LangSearch doesn't support videos).
//
// The LangSearch key is read lazily from
// `settingsService.getDecryptedLangSearchApiKey` on every call so changes in
// Settings take effect immediately.
import { registerTool } from "./registry";
import type { ToolContext } from "./registry";
import { settingsService } from "@/lib/services";
import type { ToolResult } from "@/types";

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
): Promise<{ results: unknown[]; provider?: string }> {
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
  };
}

// ---- Web Search ----
registerTool(
  "web_search",
  "Search the web for information. Returns titles, URLs, descriptions, and favicons. When a LangSearch API key is configured in Settings, results come from LangSearch's hybrid keyword+vector search (richer summaries, better recall); otherwise uses Miklium (Yahoo-based). Use for finding information, documentation, articles, tutorials.",
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
          // `kind` lets the citation extractor recognize this payload in any
          // wrapper shape (Beta V1.2 inline citations).
          kind: "web_search",
          query,
          type: "web",
          results,
          count: results.length,
          provider: provider ?? "miklium",
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
  "Search for images using Miklium (Yahoo-based). Returns image URLs, thumbnails, dimensions, and source pages. Use when the user wants to find pictures, photos, diagrams, or visual content.",
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
          provider: "miklium",
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
  "Search for videos using Miklium (Yahoo-based). Returns video titles, URLs, thumbnails, durations, and channel info. Use when the user wants to find videos, tutorials, or multimedia content.",
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
          provider: "miklium",
        },
      };
    } catch (e) {
      return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
    }
  },
  false,
  "search",
);
