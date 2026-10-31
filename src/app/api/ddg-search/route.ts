// ============================================================================
// Unified Web Search API.
//
// USER DIRECTIVE (2026-10-31): "Keep miklium for websearch and for image keep
// ddg" — web search runs on the Miklium Search API again (restored), while
// image and video search stay on keyless DuckDuckGo.
//
// Routing:
//   - `web`: LangSearch first when the user's own API key is supplied (BYOK —
//     decrypted from their settings on the client, sent per-request, never
//     stored), then Miklium (https://miklium.vercel.app/api/search, a
//     Yahoo-powered engine), then DuckDuckGo's keyless HTML SERP as the
//     last-chance fallback. Every leg is optional: an engine that fails,
//     rate-limits, or comes up empty just hands the query to the next one.
//   - `image`: DuckDuckGo images via @mudbill/duckduckgo-images-api
//     (src/lib/search/ddg-images.ts) — no API key, no billing. DDG is the
//     ONLY image backend (user directive); one full retry on transient
//     session-token failures.
//   - `video`: DuckDuckGo videos via the v.js JSON endpoint
//     (src/lib/search/ddg-videos.ts) — same keyless vqd handshake, one full
//     retry on transient failures.
//
// Error contract (pinned by route.test.ts):
//   - "No results" NEVER surfaces as an error: empty lists come back as
//     HTTP 200 with a friendly `note`.
//   - A backend that fails AFTER its retries also comes back as HTTP 200
//     with an empty list and a friendly "busy — try again" note. The
//     reported bug was exactly an error blob
//     (`{"success":false,"output":null,"error":"Image search is temporarily
//     unavailable…"}`) rendered in the chat; that failure shape is gone for
//     ALL search kinds.
//   - Raw provider names and JSON bodies stay in the server log only.
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
    signal: AbortSignal.timeout(10_000),
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

// ---- Miklium backend (the web engine — restored) ----

/** Miklium answers 404 {"success":false,"error":"No results found"} when a
 *  query matches nothing. That is an EMPTY outcome, not a failure — the
 *  original bug surfaced this body verbatim as a 502 error blob. */
function mikliumNoResults(status: number, body: string): boolean {
  if (status === 404 && /no results/i.test(body)) return true;
  return /"error"\s*:\s*"[^"]*no results[^"]*"/i.test(body);
}

/**
 * Call the Miklium Search API for WEB results (type "default").
 *
 * Miklium web rows: { url, snippet, type: "short"|"long", symbols, query } —
 * no title, so the domain stands in; rows are grouped by URL with the
 * longest snippet per page kept. Short snippets only (maxLargeSnippets: 0)
 * — the long ones are full-page scrapes that take far too long for a
 * result card.
 */
async function searchMikliumWeb(query: string, limit: number): Promise<SearchResult[]> {
  const res = await fetch("https://miklium.vercel.app/api/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      search: [query],
      type: "default",
      maxSmallSnippets: Math.min(limit, 10),
      maxLargeSnippets: 0,
    }),
    signal: AbortSignal.timeout(9_000),
  });

  const bodyText = await res.text().catch(() => "");

  if (mikliumNoResults(res.status, bodyText)) return [];

  if (!res.ok) {
    throw new Error(
      `Miklium web search HTTP ${res.status}: ${bodyText.slice(0, 200) || res.statusText}`,
    );
  }

  let data: { success?: boolean; error?: string; results?: Array<Record<string, unknown>> };
  try {
    data = JSON.parse(bodyText) as typeof data;
  } catch {
    throw new Error("Miklium web search returned invalid JSON");
  }
  if (data && data.success === false) {
    if (data.error && /no results/i.test(String(data.error))) return [];
    throw new Error(`Miklium web search error: ${String(data.error ?? "unknown")}`);
  }

  const byUrl = new Map<string, SearchResult>();
  for (const item of data?.results ?? []) {
    const url = String(item.url ?? "");
    if (!url) continue;
    const snippet = String(item.snippet ?? "");
    const existing = byUrl.get(url);
    if (!existing) {
      const domain = getDomain(url);
      byUrl.set(url, {
        title: domain || url,
        url,
        domain,
        description: snippet,
        icon: getFavicon(domain),
        source: domain || "Miklium",
        provider: "miklium",
      });
    } else if (snippet.length > (existing.description?.length ?? 0)) {
      existing.description = snippet;
    }
  }
  return Array.from(byUrl.values()).slice(0, limit);
}

// ---- DuckDuckGo engines with one full retry ----

/**
 * Run a DDG engine with one full retry (fresh session token) after a
 * transient failure. Returns null when BOTH attempts fail — the caller
 * degrades to the friendly "busy" note, never to an error blob.
 */
async function searchWithRetry<T>(engine: () => Promise<T[]>): Promise<T[] | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await engine();
    } catch (err) {
      console.error(
        `[ddg-search] engine attempt ${attempt}/2 failed:`,
        err instanceof Error ? err.message : String(err),
      );
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  return null;
}

// ---- Main handler ----

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const query = searchParams.get("q") || "";
  const type = searchParams.get("type") || "web";
  const limitRaw = parseInt(searchParams.get("limit") || "10", 10);
  const limit = Math.min(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 10, 50);
  const langsearchKey = searchParams.get("langsearch_key") || "";

  if (!query.trim()) {
    return NextResponse.json({ error: "Query is required" }, { status: 400 });
  }

  const kind: "web" | "image" | "video" =
    type === "image" ? "image" : type === "video" ? "video" : "web";
  const pluralLabel = kind === "image" ? "images" : kind === "video" ? "videos" : "web results";
  const singularLabel = kind === "web" ? "Web search" : kind === "image" ? "Image search" : "Video search";

  try {
    let results: SearchResult[] = [];
    let provider: "langsearch" | "miklium" | "ddg" = "ddg";
    /** True when every engine that was tried HARD-failed (as opposed to
     *  answering empty) — selects the "busy, try again" note over the
     *  "nothing matched" note. Either way: HTTP 200, never an error blob. */
    let engineFailed = false;

    if (kind === "web") {
      // 1) LangSearch — only when the user's own key is supplied (BYOK).
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
            "[web-search] LangSearch failed, trying Miklium:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      // 2) Miklium — the web engine (restored by user directive).
      if (!served) {
        try {
          const mkResults = await searchMikliumWeb(query, limit);
          if (mkResults.length > 0) {
            results = mkResults;
            provider = "miklium";
            served = true;
          }
        } catch (err) {
          console.warn(
            "[web-search] Miklium failed, falling back to DuckDuckGo:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      // 3) DuckDuckGo HTML — keyless last chance.
      if (!served) {
        try {
          results = await searchDDGWeb(query, limit);
          provider = "ddg";
        } catch (err) {
          engineFailed = true;
          console.error(
            "[web-search] DuckDuckGo fallback failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    } else if (kind === "image") {
      // Image search: DuckDuckGo ONLY (user directive). One full retry on
      // transient token failures; a hard failure degrades to the friendly
      // busy note below — never an error blob.
      provider = "ddg";
      const rows = await searchWithRetry(() => searchDDGImages(query, limit));
      if (rows === null) {
        engineFailed = true;
      } else {
        results = rows as unknown as SearchResult[];
      }
    } else {
      // Video search: DuckDuckGo v.js (keyless), same retry treatment.
      provider = "ddg";
      const rows = await searchWithRetry(() => searchDDGVideos(query, limit));
      if (rows === null) {
        engineFailed = true;
      } else {
        results = rows as unknown as SearchResult[];
      }
    }

    // Every path above converges on either a populated result set or an
    // empty one. `note` lets the tool layer (and the LLM behind it) tell
    // the user "nothing matched" — or "everything is busy, retry" — in one
    // clean sentence instead of an error blob.
    const note =
      results.length > 0
        ? undefined
        : engineFailed
          ? `${singularLabel} is busy right now — no ${pluralLabel} came back for this query. Please try again in a moment.`
          : `No ${pluralLabel} found for this query.`;

    return NextResponse.json({
      query,
      type,
      results: results.slice(0, limit),
      count: results.length,
      provider,
      ...(note ? { note } : {}),
    });
  } catch (err) {
    // Absolute last resort (unexpected explosion outside every engine
    // guard above): sanitized 502 — provider names and raw bodies stay in
    // the server log.
    return NextResponse.json({ error: sanitizedSearchError(kind, err).message }, { status: 502 });
  }
}
