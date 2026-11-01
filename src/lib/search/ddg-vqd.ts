/**
 * SHARED DUCKDUCKGO `vqd` SESSION CLIENT — the handshake both image (i.js)
 * and video (v.js) search need before DDG will serve JSON results.
 *
 * WHY THIS MODULE EXISTS (the image-search outage of 2026-10-31):
 *   The previous implementation delegated to
 *   `@mudbill/duckduckgo-images-api`, whose token bootstrap sends NO request
 *   headers at all (Node's default `undici` user-agent — an instant bot
 *   tell), whose i.js requests identify as Chrome/55 (2017), and whose token
 *   regex (`vqd=([\d-]+)&`) misses DDG's current quoted form
 *   (`vqd="4-264…"`). Combined with DDG's IP-reputation WAF on shared
 *   serverless egress (Vercel functions share IPs with thousands of apps),
 *   the endpoint intermittently answers with an anti-bot `challenge` JSON or
 *   HTTP 202 + zero results — surfacing in chat as "Image search is
 *   temporarily unavailable". Verified live: with browser-grade headers the
 *   SAME handshake that i.js rejects works fine for v.js, and the html SERP
 *   endpoint (no vqd needed) keeps answering — so the fix is header
 *   fidelity + token reuse + soft-block awareness, not a different scraper.
 *
 *   No npm package escapes this: `ddgs` (EudaLabs, Nov 2024), and
 *   `duck-duck-scrape` (Jan 2025) all hit the same vqd + i.js endpoints with
 *   the same IP exposure. An in-house client (this file) is the reliable
 *   path — it also matches the working in-house v.js engine's approach.
 *
 * Design (mirrors Python's `ddgs` library, the most battle-tested client):
 *   - Browser-grade headers on BOTH the token page and the JSON endpoints.
 *   - Token cache: per-query entries with a TTL (vqd tokens stay valid for
 *     roughly 15 minutes), so repeated searches of a query skip the
 *     challenge-prone token page entirely on warm instances.
 *   - `isDDGBlocked()` recognizes DDG's three soft-block shapes — HTTP 202,
 *     HTTP 403, and the anomaly/challenge body — so callers can retry with
 *     a fresh token + backoff instead of misreading a block as "no results".
 *   - Every fetch carries its own AbortSignal timeout; no request can hang.
 */

// ---------------------------------------------------------------------------
// Soft-block detection (shared by the token page and the JSON endpoints)
// ---------------------------------------------------------------------------

/**
 * Detect DuckDuckGo's anti-bot soft block: HTTP 202 (the "anomaly" page),
 * HTTP 403, or a challenge/rate-limit body. A blocked response must be
 * retried with a fresh token after backoff — NEVER treated as an empty
 * result set, and NEVER surfaced raw.
 */
export function isDDGBlocked(status: number, body: string): boolean {
  if (status === 202 || status === 403) return true;
  return /anomaly|ratelimit|rate limit|challenge|\\"cc\\":\s*\\"sre\\"/i.test(body.slice(0, 2000));
}

// ---------------------------------------------------------------------------
// Headers (browser-grade — the whole point of this module)
// ---------------------------------------------------------------------------

/** Modern desktop Chrome UA — DDG's WAF flags default Node/undici agents. */
export const DDG_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Headers for the HTML token page — a top-level document navigation. */
export const DDG_HTML_HEADERS: Record<string, string> = {
  "User-Agent": DDG_USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
};

/** Headers for the i.js / v.js JSON endpoints — a same-origin XHR. */
export const DDG_XHR_HEADERS: Record<string, string> = {
  "User-Agent": DDG_USER_AGENT,
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://duckduckgo.com/",
  "X-Requested-With": "XMLHttpRequest",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

/** vqd tokens live ~15 minutes; expire ours a minute early, defensively. */
const VQD_TTL_MS = 14 * 60 * 1000;

interface CachedToken {
  token: string;
  query: string;
  expiresAt: number;
}

/** Per-query cache (same keying as Python ddgs). Warm-instance only. */
const tokenCache = new Map<string, CachedToken>();

/** True when a cache entry is still within its TTL. */
function cacheHit(entry: CachedToken | undefined): entry is CachedToken {
  return !!entry && entry.expiresAt > Date.now();
}

/**
 * Drop every cached token. Exported for tests and for callers that learn
 * (e.g. via a soft block) that the session went bad.
 */
export function clearVqdCache(): void {
  tokenCache.clear();
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

/**
 * Extract the `vqd` session token from a DDG HTML page.
 *
 * Two shapes appear in the wild (both handled, unlike the package's
 * `vqd=([\d-]+)&` which only matched the query-string form):
 *   - attribute/quoted form:  vqd="4-264060408678648278323627634281741567781"
 *   - query-string form:      …&vqd=4-32098503961658400691&s=50…
 */
export function extractVqd(html: string): string {
  if (!html) return "";
  // Whitespace-tolerant so both `vqd="…"` (attribute) and `vqd = "…"`
  // (inline JS assignment) shapes match.
  const quoted = html.match(/vqd\s*=\s*"([0-9-]+)"/);
  if (quoted?.[1]) return quoted[1];
  const bare = html.match(/vqd=([0-9-]+)/);
  return bare?.[1] ?? "";
}

// ---------------------------------------------------------------------------
// Token fetch (network)
// ---------------------------------------------------------------------------

/** Per-request ceiling; the caller's engine deadline races the whole flow. */
const TOKEN_FETCH_TIMEOUT_MS = 5_000;

/** Custom error so callers can tell "blocked" from "no token on page". */
export class DDGBlockedError extends Error {
  constructor(where: string) {
    super(`DuckDuckGo blocked the ${where} request (anti-bot)`);
    this.name = "DDGBlockedError";
  }
}

/**
 * Fetch the per-query `vqd` session token from duckduckgo.com's HTML.
 *
 * Serves from the per-query cache when the entry is fresh, unless
 * `opts.fresh` forces a network bootstrap (used by retry paths that suspect
 * the session went bad). Throws DDGBlockedError on a soft-blocked token
 * page and a plain Error when the page is reachable but carries no token.
 */
export async function getVqdToken(query: string, opts?: { fresh?: boolean }): Promise<string> {
  if (!opts?.fresh) {
    const cached = tokenCache.get(query);
    if (cacheHit(cached)) return cached.token;
  }

  const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: DDG_HTML_HEADERS,
    signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
  });
  const html = await res.text().catch(() => "");

  if (isDDGBlocked(res.status, html)) {
    throw new DDGBlockedError("token");
  }
  if (!res.ok) {
    throw new Error(`DuckDuckGo token request HTTP ${res.status}`);
  }

  const token = extractVqd(html);
  if (!token) {
    throw new Error("DuckDuckGo token unavailable");
  }

  tokenCache.set(query, { token, query, expiresAt: Date.now() + VQD_TTL_MS });
  return token;
}
