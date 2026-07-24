// ============================================================================
// DuckDuckGo Real Browser Search — uses the REAL organic search results
// from duckduckgo.com/d.js (what you see in Chrome), NOT the AI Answer API.
//
// Flow:
//   1. GET https://duckduckgo.com/?q=<query>&ia=web → extract vqd token
//   2. GET https://links.duckduckgo.com/d.js?q=<query>&vqd=<token> → organic results
//   3. Parse the DDG.pageLayout.load('d', [{t:title, u:url, a:snippet}]) calls
//
// For images:
//   1. GET https://duckduckgo.com/?q=<query> → extract vqd token
//   2. GET https://duckduckgo.com/i.js?o=json&q=<query>&vqd=<token> → image results
//
// Zero npm deps, native fetch, random UA to bypass bot blocks.
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
  provider?: string;
}

// Random User-Agents to bypass DDG bot detection
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
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
 * Extract the vqd token from a DuckDuckGo page. The token is embedded in
 * the HTML/JS response and is required for all subsequent API calls (d.js,
 * i.js, v.js). We try multiple regex patterns since DDG changes the format.
 */
function extractVqd(html: string): string | null {
  // Pattern 1: vqd="1234-5678" (in HTML attributes)
  const m1 = html.match(/vqd=["']([\d-]+)["']/);
  if (m1?.[1]) return m1[1];
  // Pattern 2: vqd: "1234-5678" (in JS objects)
  const m2 = html.match(/vqd:\s*["']([\d-]+)["']/);
  if (m2?.[1]) return m2[1];
  // Pattern 3: vqd=1234-5678 (in URLs)
  const m3 = html.match(/vqd=([\d-]+)/);
  if (m3?.[1]) return m3[1];
  // Pattern 4: "vqd":"1234-5678" (JSON)
  const m4 = html.match(/"vqd"\s*:\s*"([\d-]+)"/);
  if (m4?.[1]) return m4[1];
  return null;
}

/**
 * Get the vqd token for a query by fetching the DDG search page.
 * The token is session-specific and changes per query.
 */
async function getVqd(query: string, searchType: string = "web"): Promise<string | null> {
  const iaParam = searchType === "image" ? "&iax=images&ia=images" : searchType === "video" ? "&iax=videos&ia=videos" : "";

  // Try multiple approaches to get the vqd token:
  // 1. POST to duckduckgo.com (returns vqd in the response body)
  // 2. GET duckduckgo.com/?q=... (vqd embedded in HTML)
  // 3. GET html.duckduckgo.com/html/?q=... (vqd in HTML, different format)

  // Approach 1: POST to duckduckgo.com — this is what the DDG JS does
  try {
    const postRes = await fetch("https://duckduckgo.com/", {
      method: "POST",
      headers: {
        "User-Agent": randomUA(),
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      body: `q=${encodeURIComponent(query)}${iaParam ? `&${iaParam}` : ""}`,
      redirect: "follow",
    });
    if (postRes.ok) {
      const html = await postRes.text();
      const vqd = extractVqd(html);
      if (vqd) return vqd;
    }
  } catch {}

  // Approach 2: GET duckduckgo.com/?q=...
  try {
    const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}${iaParam ? `&${iaParam}` : "&ia=web"}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": randomUA(),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    if (res.ok) {
      const html = await res.text();
      const vqd = extractVqd(html);
      if (vqd) return vqd;
    }
  } catch {}

  // Approach 3: GET html.duckduckgo.com/html/ — older endpoint, different vqd format
  try {
    const htmlRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        "User-Agent": randomUA(),
        "Accept": "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (htmlRes.ok) {
      const html = await htmlRes.text();
      const vqd = extractVqd(html);
      if (vqd) return vqd;
    }
  } catch {}

  return null;
}

/**
 * REAL organic web search via DDG's d.js endpoint.
 * This returns the same results you see in Chrome — real web links,
 * not AI summaries or Wikipedia abstracts.
 */
async function searchWebReal(query: string, limit: number): Promise<SearchResult[]> {
  const vqd = await getVqd(query, "web");
  if (!vqd) {
    // Fallback to the IA API if d.js fails
    return searchWebFallback(query, limit);
  }

  const url = `https://duckduckgo.com/d.js?q=${encodeURIComponent(query)}&vqd=${vqd}&kl=us-en&p=1&s=0&df=&vql=&ps=50&o=json&sp=0`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": randomUA(),
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://duckduckgo.com/",
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  if (!res.ok) {
    return searchWebFallback(query, limit);
  }

  const text = await res.text();
  const results: SearchResult[] = [];

  // The d.js response contains calls to DDG.pageLayout.load('d', [...])
  // Each item in the array has: { t: title, u: url, a: snippet, s: source }
  // We parse it by extracting JSON arrays from the text.

  // Try parsing as JSON first (sometimes d.js returns pure JSON)
  let items: Array<Record<string, unknown>> = [];
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) {
      items = data;
    } else if (data.results && Array.isArray(data.results)) {
      items = data.results;
    }
  } catch {
    // Not pure JSON — extract from DDG.pageLayout.load() calls
    // Pattern: DDG.pageLayout.load('d',[{...},{...}])
    const loadMatch = text.match(/DDG\.pageLayout\.load\(['"]d['"],\s*(\[[\s\S]*?\])\s*\)/);
    if (loadMatch?.[1]) {
      try {
        items = JSON.parse(loadMatch[1]);
      } catch {
        // Try line-by-line parsing as last resort
      }
    }

    // If still no items, try extracting individual result objects
    if (items.length === 0) {
      // Pattern: {"t":"Title","u":"https://...","a":"Snippet",...}
      const resultRegex = /\{"t":"([^"]+)","u":"([^"]+)","a":"([^"]*)"[^}]*\}/g;
      let match;
      while ((match = resultRegex.exec(text)) !== null) {
        items.push({ t: match[1], u: match[2], a: match[3] });
      }
    }
  }

  for (const item of items) {
    if (results.length >= limit) break;
    const title = String(item.t || item.title || "");
    const url = String(item.u || item.url || "");
    const snippet = String(item.a || item.snippet || item.abstract || "");

    // Skip empty results, ads, and DDG internal redirect links
    if (!title || !url) continue;
    if (url.includes("/y.js?") || url.includes("y.js?ad_domain")) continue; // ads

    const domain = getDomain(url);
    results.push({
      title,
      url,
      domain,
      description: snippet,
      icon: getFavicon(domain),
      source: "DuckDuckGo (organic)",
    });
  }

  // If d.js returned nothing useful, try scraping html.duckduckgo.com
  if (results.length === 0) {
    return searchHtmlScrape(query, limit);
  }

  return results;
}

/**
 * Fallback: scrape html.duckduckgo.com/html/ — this endpoint returns
 * organic results as HTML (no JS required). We parse the result links
 * and snippets from the HTML.
 */
async function searchHtmlScrape(query: string, limit: number): Promise<SearchResult[]> {
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        "User-Agent": randomUA(),
        "Accept": "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) return searchWebFallback(query, limit);

    const html = await res.text();
    const results: SearchResult[] = [];

    // Parse result blocks: <div class="result">...<a class="result__a" href="...">Title</a>...<a class="result__snippet" ...>Snippet</a>...
    // The href is a redirect URL like //duckduckgo.com/l/?uddg=ENCODED_URL
    const resultRegex = /class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)</g;
    const snippetRegex = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    const titles: Array<{ url: string; title: string }> = [];
    let match;
    while ((match = resultRegex.exec(html)) !== null) {
      let url = match[1]!;
      // Decode the redirect URL
      try {
        const uddg = url.match(/uddg=([^&]+)/);
        if (uddg) url = decodeURIComponent(uddg[1]!);
      } catch {}
      titles.push({ url, title: match[2]!.trim() });
    }

    const snippets: string[] = [];
    while ((match = snippetRegex.exec(html)) !== null) {
      snippets.push(match[1]!.replace(/<[^>]+>/g, "").trim());
    }

    for (let i = 0; i < titles.length && results.length < limit; i++) {
      const { url, title } = titles[i]!;
      if (!url || !title) continue;
      // Skip ads
      if (url.includes("/y.js?") || url.includes("y.js?ad_domain")) continue;
      const domain = getDomain(url);
      results.push({
        title,
        url,
        domain,
        description: snippets[i] || "",
        icon: getFavicon(domain),
        source: "DuckDuckGo (organic)",
      });
    }

    if (results.length > 0) return results;
  } catch {}

  // Final fallback: IA API
  return searchWebFallback(query, limit);
}

/**
 * REAL image search via DDG's i.js endpoint.
 * Returns actual image results with thumbnails — same as Chrome.
 */
async function searchImagesReal(query: string, limit: number): Promise<SearchResult[]> {
  const vqd = await getVqd(query, "image");
  if (!vqd) {
    return searchImagesFallback(query, limit);
  }

  const url = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,&p=1&s=0`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": randomUA(),
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://duckduckgo.com/",
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  if (!res.ok) {
    return searchImagesFallback(query, limit);
  }

  const data = await res.json();
  const items = data.results || [];

  return items.slice(0, limit).map((item: Record<string, unknown>) => ({
    title: String(item.title || ""),
    url: String(item.url || ""),
    imageUrl: String(item.image || ""),
    thumbnail: String(item.thumbnail || ""),
    width: Number(item.width) || undefined,
    height: Number(item.height) || undefined,
    source: String(item.source || "DuckDuckGo"),
    domain: getDomain(String(item.url || "")),
  }));
}

/**
 * REAL video search via DDG's v.js endpoint.
 */
async function searchVideosReal(query: string, limit: number): Promise<SearchResult[]> {
  const vqd = await getVqd(query, "video");
  if (!vqd) return [];

  const url = `https://duckduckgo.com/v.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,&p=1`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": randomUA(),
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Referer": "https://duckduckgo.com/",
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  if (!res.ok) return [];

  const data = await res.json();
  const items = data.results || [];

  return items.slice(0, limit).map((item: Record<string, unknown>) => ({
    title: String(item.title || ""),
    url: String(item.url || item.content || ""),
    description: String(item.description || ""),
    imageUrl: String(item.image || ""),
    thumbnail: String(item.image || ""),
    source: String(item.provider || "DuckDuckGo"),
    date: String(item.published || ""),
    domain: getDomain(String(item.url || item.content || "")),
  }));
}

// ---- Fallback functions (used when DDG organic fails) ----

async function searchWebFallback(query: string, limit: number): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  // DDG Instant Answer API
  try {
    const ddgRes = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { headers: { "User-Agent": randomUA() } },
    );
    if (ddgRes.ok) {
      const data = await ddgRes.json();
      if (data.AbstractText) {
        results.push({
          title: data.Heading || query,
          url: data.AbstractURL || "",
          description: data.AbstractText,
          source: "DuckDuckGo IA",
          icon: data.Image ? `https://duckduckgo.com${data.Image}` : undefined,
        });
      }
      if (Array.isArray(data.RelatedTopics)) {
        for (const topic of data.RelatedTopics) {
          if (results.length >= limit) break;
          if (typeof topic === "object" && topic.Text && topic.FirstURL) {
            const domain = getDomain(topic.FirstURL);
            results.push({
              title: topic.Text.split(" - ")[0] || topic.Text.slice(0, 80),
              url: topic.FirstURL,
              domain,
              description: topic.Text,
              icon: getFavicon(domain),
              source: "DuckDuckGo IA",
            });
          }
        }
      }
    }
  } catch {}

  // Wikipedia fallback
  if (results.length < limit) {
    try {
      const wikiRes = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${Math.min(limit - results.length, 10)}&origin=*`,
      );
      if (wikiRes.ok) {
        const wikiData = await wikiRes.json();
        for (const item of wikiData?.query?.search ?? []) {
          if (results.length >= limit) break;
          const title = item.title || "";
          const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
          results.push({
            title,
            url,
            domain: "en.wikipedia.org",
            description: (item.snippet || "").replace(/<[^>]+>/g, ""),
            icon: getFavicon("en.wikipedia.org"),
            source: "Wikipedia",
          });
        }
      }
    } catch {}
  }

  return results;
}

async function searchImagesFallback(query: string, limit: number): Promise<SearchResult[]> {
  try {
    const wikiRes = await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=${limit}&prop=imageinfo&iiprop=url|size&format=json&origin=*`,
    );
    if (wikiRes.ok) {
      const data = await wikiRes.json();
      const pages = data?.query?.pages ?? {};
      return Object.values(pages).map((page: unknown) => {
        const p = page as Record<string, unknown>;
        const info = (p.imageinfo as Array<Record<string, unknown>>)?.[0] ?? {};
        return {
          title: String(p.title || query),
          url: String(info.url || ""),
          imageUrl: String(info.url || ""),
          thumbnail: String(info.thumburl || info.url || ""),
          width: Number(info.width) || undefined,
          height: Number(info.height) || undefined,
          source: "Wikimedia Commons",
        };
      });
    }
  } catch {}
  return [];
}

// ---- Main handler ----

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const query = searchParams.get("q") || "";
  const type = searchParams.get("type") || "web";
  const limit = Math.min(parseInt(searchParams.get("limit") || "10", 10), 50);

  if (!query.trim()) {
    return NextResponse.json({ error: "Query is required" }, { status: 400 });
  }

  try {
    let results: SearchResult[] = [];

    if (type === "image") {
      results = await searchImagesReal(query, limit);
    } else if (type === "video") {
      results = await searchVideosReal(query, limit);
    } else {
      // Web search — use REAL organic d.js results
      results = await searchWebReal(query, limit);
    }

    return NextResponse.json({
      query,
      type,
      results: results.slice(0, limit),
      count: results.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
