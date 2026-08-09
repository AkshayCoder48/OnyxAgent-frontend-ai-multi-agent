// ============================================================================
// Unified Web Search API — LangSearch (primary, when API key is supplied)
// with Miklium fallback (https://miklium.vercel.app/api/search).
//
// When the client passes `langsearch_key` (the user's decrypted LangSearch
// API key, fetched from their encrypted settings on the client), `web`
// queries are routed through LangSearch's hybrid keyword+vector search
// API at https://api.langsearch.com/v1/web-search — which returns enhanced
// results with long-text summaries, ideal for feeding clean context to an LLM.
//
// If no key is supplied, LangSearch returns an error, or the search type is
// `image` / `video` (LangSearch only does web search), we transparently
// fall back to the Miklium Search API — a Yahoo-based search engine that
// returns text, image, and video results.
//
// Miklium API: https://miklium.vercel.app/api/search
//   POST { search: ["query"], type: "default"|"images"|"videos", ... }
//   GET  ?search=query&type=images&maxResults=10
//
// Miklium response formats:
//   Web (type=default): { results: [{ url, snippet, type: "short"|"long", symbols, query }] }
//   Images (type=images): { results: [{ imageUrl, title, referenceUrl, size: {width,height}, query }] }
//   Videos (type=videos): { results: [{ videoUrl, thumbUrl, title, description, duration, query, additionalData? }] }
// ============================================================================

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface SearchResult {
  title: string;
  url: string;
  domain?: string;
  description?: string;
  icon?: string;
  imageUrl?: string;
  thumbnail?: string;
  width?: number;
  height?: number;
  source?: string;
  date?: string;
  duration?: string;
  provider?: string;
  // Video-specific
  videoUrl?: string;
  thumbUrl?: string;
  channelTitle?: string;
  viewCount?: string;
  likeCount?: string;
  // Miklium-specific (snippet type)
  snippetType?: string; // "short" | "long"
  symbols?: number;
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function getFavicon(domain: string): string {
  if (!domain) return "";
  return `https://external-content.duckduckgo.com/ip3/${domain}.ico`;
}

// ---- Miklium Search (fallback for web, primary for images/videos) ----

/**
 * Call the Miklium Search API.
 *
 * @param query - search query string
 * @param type - "web" | "image" | "video" (mapped to Miklium's "default"|"images"|"videos")
 * @param limit - max results
 * @returns normalized SearchResult[]
 */
async function searchMiklium(
  query: string,
  type: "web" | "image" | "video",
  limit: number,
): Promise<SearchResult[]> {
  const mikliumType = type === "web" ? "default" : type === "image" ? "images" : "videos";

  const body: Record<string, unknown> = {
    search: [query],
    type: mikliumType,
  };

  if (type === "web") {
    // Request short snippets only (faster, no scraping). The long snippets
    // are full-page scrapes that take much longer and return 4500+ chars
    // each — overkill for a search result card.
    body.maxSmallSnippets = Math.min(limit, 10);
    body.maxLargeSnippets = 0;
  } else {
    body.maxResults = Math.min(limit, 20);
  }

  const res = await fetch("https://miklium.vercel.app/api/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Miklium HTTP ${res.status}: ${errText.slice(0, 200) || res.statusText}`);
  }

  const data = await res.json();
  if (!data.success) {
    throw new Error(`Miklium error: ${data.error || "Unknown error"}`);
  }

  const rawResults: Array<Record<string, unknown>> = data.results || [];

  // Normalize based on type
  if (type === "web") {
    // Miklium web results: { url, snippet, type: "short"|"long", symbols, query }
    // Group by URL — Miklium returns multiple snippets per URL (short + long)
    const byUrl = new Map<string, SearchResult>();
    for (const item of rawResults) {
      const url = String(item.url || "");
      if (!url) continue;
      const existing = byUrl.get(url);
      const snippet = String(item.snippet || "");
      const snippetType = String(item.type || "short");
      // Prefer long snippets; within the same URL, keep the longest
      if (!existing) {
        const domain = getDomain(url);
        byUrl.set(url, {
          title: domain || url, // Miklium doesn't return a title for web — use domain
          url,
          domain,
          description: snippet,
          icon: getFavicon(domain),
          source: "Miklium",
          provider: "miklium",
          snippetType,
          symbols: Number(item.symbols) || undefined,
        });
      } else if (snippetType === "long" && existing.snippetType !== "long") {
        // Replace short with long
        existing.description = snippet;
        existing.snippetType = "long";
        existing.symbols = Number(item.symbols) || undefined;
      } else if (snippet.length > (existing.description?.length ?? 0)) {
        existing.description = snippet;
      }
    }
    return Array.from(byUrl.values()).slice(0, limit);
  }

  if (type === "image") {
    // Miklium image results: { imageUrl, title, referenceUrl, size: {width,height}, query }
    const seen = new Set<string>();
    const results: SearchResult[] = [];
    for (const item of rawResults) {
      const imageUrl = String(item.imageUrl || "");
      if (!imageUrl || seen.has(imageUrl)) continue; // dedupe
      seen.add(imageUrl);
      const size = item.size as { width?: number; height?: number } | undefined;
      const refUrl = String(item.referenceUrl || imageUrl);
      results.push({
        title: String(item.title || ""),
        url: refUrl,
        domain: getDomain(refUrl),
        imageUrl,
        thumbnail: imageUrl,
        width: size?.width,
        height: size?.height,
        source: "Miklium",
        provider: "miklium",
      });
    }
    return results.slice(0, limit);
  }

  // Video
  // Miklium video results: { videoUrl, thumbUrl, title, description, duration, query, additionalData? }
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const item of rawResults) {
    const videoUrl = String(item.videoUrl || "");
    if (!videoUrl || seen.has(videoUrl)) continue; // dedupe
    seen.add(videoUrl);
    const additional = item.additionalData as
      | { channelTitle?: string; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }
      | undefined;
    results.push({
      title: String(item.title || ""),
      url: videoUrl,
      domain: getDomain(videoUrl),
      description: String(item.description || ""),
      imageUrl: String(item.thumbUrl || ""),
      thumbnail: String(item.thumbUrl || ""),
      videoUrl,
      thumbUrl: String(item.thumbUrl || ""),
      duration: String(item.duration || "") || undefined,
      source: additional?.channelTitle || "Miklium",
      provider: "miklium",
      channelTitle: additional?.channelTitle,
      viewCount: additional?.statistics?.viewCount,
      likeCount: additional?.statistics?.likeCount,
    });
  }
  return results.slice(0, limit);
}

// ---- LangSearch backend (primary for web when API key supplied) ----

/**
 * Call LangSearch's /v1/web-search API. Returns enhanced results with
 * long-text summaries — better for LLM context than raw snippets.
 */
async function searchLangSearch(
  query: string,
  apiKey: string,
  limit: number,
): Promise<SearchResult[]> {
  const res = await fetch("https://api.langsearch.com/v1/web-search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query,
      freshness: "noLimit",
      summary: true,
      count: Math.min(limit, 20),
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`LangSearch HTTP ${res.status}: ${errText.slice(0, 200) || res.statusText}`);
  }

  const data = await res.json();
  const raw: Array<Record<string, unknown>> =
    (data?.data?.webPages?.value as Array<Record<string, unknown>> | undefined) ?? [];

  const results: SearchResult[] = [];
  for (const item of raw) {
    const url = String(item.url || item.link || "");
    const title = String(item.name || item.title || "");
    if (!url || !title) continue;
    const domain = getDomain(url);
    const summary = item.summary ? String(item.summary) : "";
    const snippet = item.snippet ? String(item.snippet) : "";
    results.push({
      title,
      url,
      domain,
      description: summary || snippet,
      icon: getFavicon(domain),
      source: domain || "LangSearch",
      provider: "langsearch",
      ...(item.datePublished ? { date: String(item.datePublished) } : {}),
    });
  }
  return results.slice(0, limit);
}

// ---- Main handler ----

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const query = searchParams.get("q") || "";
  const type = searchParams.get("type") || "web";
  const limit = Math.min(parseInt(searchParams.get("limit") || "10", 10), 50);
  const langsearchKey = searchParams.get("langsearch_key") || "";

  if (!query.trim()) {
    return NextResponse.json({ error: "Query is required" }, { status: 400 });
  }

  try {
    let results: SearchResult[] = [];
    let provider: "langsearch" | "miklium" = "miklium";

    // For web search: try LangSearch first if key is available, else Miklium
    if (type === "web") {
      if (langsearchKey) {
        try {
          const lsResults = await searchLangSearch(query, langsearchKey, limit);
          if (lsResults.length > 0) {
            results = lsResults;
            provider = "langsearch";
          } else {
            results = await searchMiklium(query, "web", limit);
          }
        } catch (err) {
          console.warn("[web-search] LangSearch failed, falling back to Miklium:", err instanceof Error ? err.message : String(err));
          results = await searchMiklium(query, "web", limit);
        }
      } else {
        // No LangSearch key — use Miklium directly
        results = await searchMiklium(query, "web", limit);
      }
    } else if (type === "image") {
      // Image search always uses Miklium (LangSearch doesn't support images)
      results = await searchMiklium(query, "image", limit);
    } else if (type === "video") {
      // Video search always uses Miklium (LangSearch doesn't support videos)
      results = await searchMiklium(query, "video", limit);
    } else {
      // Unknown type — default to web
      results = await searchMiklium(query, "web", limit);
    }

    return NextResponse.json({
      query,
      type,
      results: results.slice(0, limit),
      count: results.length,
      provider,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
