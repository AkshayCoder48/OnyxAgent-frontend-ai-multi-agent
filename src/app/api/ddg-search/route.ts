// ============================================================================
// Unified Web Search API — LangSearch (optional, user-supplied key) for web,
// DuckDuckGo for everything else. Miklium is fully removed.
//
// Routing:
//   - `web`: When the client passes `langsearch_key` (the user's decrypted
//     LangSearch API key — BYOK, fetched from their encrypted settings),
//     queries go through LangSearch's hybrid keyword+vector search API at
//     https://api.langsearch.com/v1/web-search (enhanced results with
//     long-text summaries). When no key is set, or LangSearch errors out /
//     returns nothing, the keyless DuckDuckGo HTML search serves the query.
//   - `image`: DuckDuckGo images via @mudbill/duckduckgo-images-api
//     (src/lib/search/ddg-images.ts) — no API key, no billing, real DDG
//     thumbnails and dimensions. DDG is the ONLY image backend: an empty
//     result set is a legitimate "no images found" outcome.
//   - `video`: DuckDuckGo videos via the v.js JSON endpoint
//     (src/lib/search/ddg-videos.ts) — same keyless vqd-token handshake,
//     real durations, thumbnails, channel and view counts.
//
// Error contract (pinned by route.test.ts):
//   - "No results" NEVER surfaces as an error: empty lists come back as
//     HTTP 200 with a friendly `note`.
//   - Real backend failures come back as HTTP 502 with a sanitized,
//     user-facing message — raw provider names and JSON bodies stay in the
//     server log only.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { searchDDGImages } from "@/lib/search/ddg-images";
import { searchDDGWeb } from "@/lib/search/ddg-web";
import { searchDDGVideos } from "@/lib/search/ddg-videos";

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

/**
 * Wrap an upstream failure in a clean, user-facing message. Raw provider
 * names and JSON bodies must NEVER reach the chat — they leak into the
 * tool-result card verbatim otherwise. Full detail goes to the server log.
 */
function sanitizedSearchError(kind: "web" | "image" | "video", err: unknown): Error {
  const label = kind === "web" ? "Web search" : kind === "image" ? "Image search" : "Video search";
  const raw = err instanceof Error ? err.message : String(err);
  console.error(`[ddg-search] ${label} failed:`, raw);
  return new Error(`${label} is temporarily unavailable. Please try again in a moment.`);
}

// ---- LangSearch backend (optional, when the user's API key is supplied) ----

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
    let provider: "langsearch" | "ddg" = "ddg";

    if (type === "web") {
      // Web search: LangSearch first when the user's own key is available
      // (BYOK), else — and whenever LangSearch comes up empty or fails —
      // the keyless DuckDuckGo HTML search.
      let served = false;
      if (langsearchKey) {
        try {
          const lsResults = await searchLangSearch(query, langsearchKey, limit);
          if (lsResults.length > 0) {
            results = lsResults;
            provider = "langsearch";
            served = true;
          }
        } catch (err) {
          console.warn(
            "[web-search] LangSearch failed, falling back to DuckDuckGo:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      if (!served) {
        results = await searchDDGWeb(query, limit);
      }
    } else if (type === "image") {
      // Image search: DuckDuckGo only. An empty set is a legitimate
      // "no images found" outcome — surfaced below as a friendly note,
      // never as an error.
      results = await searchDDGImages(query, limit);
    } else if (type === "video") {
      // Video search: DuckDuckGo videos (keyless vqd + v.js handshake).
      results = await searchDDGVideos(query, limit);
    } else {
      // Unknown type — default to web
      results = await searchDDGWeb(query, limit);
    }

    // Every path above converges on either a populated result set or an
    // empty one. `note` lets the tool layer (and the LLM behind it) tell
    // the user "nothing matched" in one clean sentence instead of an
    // error blob.
    const kindLabel = type === "image" ? "images" : type === "video" ? "videos" : "web results";
    return NextResponse.json({
      query,
      type,
      results: results.slice(0, limit),
      count: results.length,
      provider,
      ...(results.length === 0 ? { note: `No ${kindLabel} found for this query.` } : {}),
    });
  } catch (err) {
    // Sanitize: raw upstream messages (provider names, JSON bodies) stay in
    // the server log; the client gets a clean, retry-friendly sentence.
    const kind = type === "image" ? "image" : type === "video" ? "video" : "web";
    return NextResponse.json({ error: sanitizedSearchError(kind, err).message }, { status: 502 });
  }
}
