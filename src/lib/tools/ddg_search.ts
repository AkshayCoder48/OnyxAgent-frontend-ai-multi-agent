// DuckDuckGo Search Tools — web, image, news, video, map search.
// Uses /api/ddg-search (server-side proxy) to avoid CORS.
// No API key required — DuckDuckGo is free and privacy-focused.
import { registerTool } from "./registry";
import type { ToolResult } from "@/types";

async function ddgSearch(query: string, type: string, limit: number = 10): Promise<unknown[]> {
  const res = await fetch(`/api/ddg-search?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Search failed" }));
    throw new Error(err.error || `Search HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.results || [];
}

// ---- Web Search ----
registerTool(
  "web_search",
  "Search the web using DuckDuckGo (privacy-focused, no tracking). Returns titles, URLs, descriptions, and favicons. Use for finding information, documentation, articles, tutorials.",
  {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Max results (default 10, max 50)" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async (args): Promise<ToolResult> => {
    const query = args.query as string;
    const limit = Math.min((args.limit as number) ?? 10, 50);
    try {
      const results = await ddgSearch(query, "web", limit);
      return {
        success: true,
        output: {
          query,
          type: "web",
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
  async (args): Promise<ToolResult> => {
    const query = args.query as string;
    const limit = Math.min((args.limit as number) ?? 10, 50);
    try {
      const results = await ddgSearch(query, "image", limit);
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
  "Search for news articles using DuckDuckGo. Returns recent news with titles, URLs, and descriptions. Use when the user wants current events, breaking news, or recent articles.",
  {
    type: "object",
    properties: {
      query: { type: "string", description: "News search query" },
      limit: { type: "number", description: "Max results (default 10, max 50)" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async (args): Promise<ToolResult> => {
    const query = args.query as string;
    const limit = Math.min((args.limit as number) ?? 10, 50);
    try {
      const results = await ddgSearch(query, "news", limit);
      return {
        success: true,
        output: {
          query,
          type: "news",
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
  async (args): Promise<ToolResult> => {
    const query = args.query as string;
    const limit = Math.min((args.limit as number) ?? 10, 50);
    try {
      const results = await ddgSearch(query, "video", limit);
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
  async (args): Promise<ToolResult> => {
    const query = args.query as string;
    const limit = Math.min((args.limit as number) ?? 10, 50);
    try {
      // DDG doesn't have a separate map endpoint — use web search with location
      const results = await ddgSearch(`${query} maps location`, "web", limit);
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
