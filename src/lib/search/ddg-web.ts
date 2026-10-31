/**
 * DUCKDUCKGO WEB SEARCH — keyless text-search backend for the `web_search`
 * tool (the Miklium replacement). Scrapes DuckDuckGo's server-rendered HTML
 * endpoint (`https://html.duckduckgo.com/html/`), which needs neither an API
 * key nor the `vqd` session token used by the i.js/v.js JSON endpoints —
 * one POST, parse the SERP, done.
 *
 * Layering (mirrors src/lib/search/ddg-images.ts conventions):
 *   - PURE (unit-tested with fixture HTML, no network):
 *     unwrapDDGUrl — resolves DDG's click-redirect links
 *       (`//duckduckgo.com/l/?uddg=<urlencoded>`) back to the real target URL.
 *     parseDDGWebHtml — extracts `.result` rows (title / href / snippet) into
 *       the normalized result shape the `/api/ddg-search` route serves.
 *   - NETWORK: searchDDGWeb — POSTs the query, detects DDG's soft rate-limit
 *     block (HTTP 202 "anomaly" page), and normalizes the rows.
 *
 * Honesty rules:
 *   - DDG routes result clicks through `/l/?uddg=…` redirect wrappers; the
 *     destination is that one URL-encoded parameter. We unwrap it so the
 *     card links land on the real page, never on a DDG redirect.
 *   - HTTP 202 with an anomaly/ratelimit body is a soft block, not "no
 *     results": it must surface as a sanitized failure upstream (the caller
 *     decides), never as an empty-but-successful search.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One normalized web result — the shape /api/ddg-search serves to clients. */
export interface DDGWebResult {
  title: string;
  url: string;
  domain?: string;
  description?: string;
  icon?: string;
  source?: string;
  provider: "ddg";
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Favicon via DDG's public icon CDN (same one Miklium-era results used). */
function faviconFor(domain: string): string {
  if (!domain) return "";
  return `https://external-content.duckduckgo.com/ip3/${domain}.ico`;
}

/**
 * Resolve a DuckDuckGo result href to the real destination URL.
 *
 * DDG wraps result links as `/l/?uddg=<urlencoded real url>&rut=…` (sometimes
 * protocol-relative `//duckduckgo.com/l/?…`, sometimes absolute). Only
 * absolute, protocol-relative, and root-relative hrefs are resolvable —
 * anything else (javascript:, mailto:, garbage) passes through untouched so
 * the caller's http(s) filter drops it instead of fabricating a URL.
 */
export function unwrapDDGUrl(href: string): string {
  if (!href) return "";
  if (!/^(https?:)?\/\//i.test(href) && !href.startsWith("/")) return href;
  try {
    const abs = href.startsWith("//") ? `https:${href}` : href;
    const u = new URL(abs, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (u.pathname === "/l/" && uddg) return uddg;
    return u.toString();
  } catch {
    return href;
  }
}

/** Decode the handful of entities DDG's HTML markup uses in titles/snippets. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract one anchor's `href` attribute value (no HTML parser dependency).
 * Matches double-quoted, single-quoted, and unquoted attribute forms.
 */
function attrOf(tag: string, attr: string): string {
  const m =
    tag.match(new RegExp(`${attr}="([^"]*)"`)) ||
    tag.match(new RegExp(`${attr}='([^']*)'`)) ||
    tag.match(new RegExp(`${attr}=([^\\s>]+)`));
  return m ? (m[1] ?? "") : "";
}

/**
 * Parse DuckDuckGo's HTML SERP into normalized results.
 *
 * Result rows look like:
 *   <div class="result results_links results_links_deep web-result">…
 *     <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=…">Title</a>
 *     <a class="result__snippet" href="…">Snippet text…</a>
 *
 * Rows without a usable http(s) target are dropped; duplicates by URL are
 * deduped; the list is capped at `limit`.
 */
export function parseDDGWebHtml(html: string, limit: number): DDGWebResult[] {
  if (!html) return [];
  const seen = new Set<string>();
  const results: DDGWebResult[] = [];

  // Every result anchor, in SERP order.
  const anchors = html.match(/<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi) || [];

  for (const anchorTag of anchors) {
    const href = attrOf(anchorTag, "href");
    if (!href) continue;
    // Ad rows click through duckduckgo.com/y.js trackers — skip them.
    if (/duckduckgo\.com\/y\.js/i.test(href)) continue;
    const url = unwrapDDGUrl(href);
    if (!/^https?:\/\//i.test(url)) continue; // skip ad/redirect junk
    if (seen.has(url)) continue;
    seen.add(url);

    // Inner text of the anchor = title (strip nested tags like <b>).
    const inner = anchorTag.replace(/<[^>]+>/g, " ");
    const title = decodeEntities(inner);
    if (!title) continue;

    results.push({
      title,
      url,
      domain: getDomain(url),
      description: "",
      icon: faviconFor(getDomain(url)),
      source: getDomain(url),
      provider: "ddg",
    });
    if (results.length >= limit) break;
  }

  // Second pass: attach snippets. DDG renders snippets as their own anchors
  // (class result__snippet) in the same order as result links; pair them by
  // the nearest preceding result URL when possible, else by order.
  const snippets = html.match(/<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi) || [];
  snippets.slice(0, results.length).forEach((snip, i) => {
    const text = decodeEntities(snip.replace(/<[^>]+>/g, " "));
    if (text && results[i]) results[i].description = text;
  });

  return results;
}

/**
 * Detect DDG's soft rate-limit / bot-challenge response: HTTP 202 with a
 * near-empty body (an "anomaly" page). Must NOT be treated as "no results".
 */
export function isDDGSoftBlocked(status: number, body: string): boolean {
  if (status === 202) return true;
  if (status === 403) return true;
  return /anomaly|ratelimit|rate limit|challenge/i.test(body.slice(0, 2000));
}

// ---------------------------------------------------------------------------
// Network layer
// ---------------------------------------------------------------------------

/** Desktop UA — the HTML endpoint serves real SERP markup to browsers. */
const DDG_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Hard ceiling for the whole round-trip (same budget as image search). */
const DDG_TIMEOUT_MS = 8_000;

function ddgTimeout(): Promise<never> {
  return new Promise((_, reject) => {
    const t = setTimeout(
      () => reject(new Error(`DuckDuckGo web search timed out after ${DDG_TIMEOUT_MS}ms`)),
      DDG_TIMEOUT_MS,
    );
    // Don't hold the event loop (or the vitest worker) open for the losing
    // timer; works in Node and Bun, no-op in browsers.
    (t as { unref?: () => void }).unref?.();
  });
}

/**
 * Search DuckDuckGo's web index and normalize the results.
 *
 * Raced against the timeout (the endpoint has no abort-signal support worth
 * wiring for a single POST). Throws on network failure, timeout, or DDG's
 * soft rate-limit block — the caller (/api/ddg-search) turns that into a
 * sanitized user-facing message. A query that simply matches nothing parses
 * to an EMPTY array.
 */
export async function searchDDGWeb(query: string, limit: number): Promise<DDGWebResult[]> {
  const body = new URLSearchParams({ q: query, kl: "wt-wt" }); // wt-wt = no region bias
  const res = await Promise.race([
    fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": DDG_UA,
        Accept: "text/html",
      },
      body: body.toString(),
    }),
    ddgTimeout(),
  ]);

  const html = await res.text().catch(() => "");

  if (isDDGSoftBlocked(res.status, html)) {
    throw new Error("DuckDuckGo web search is rate-limited right now");
  }
  if (!res.ok) {
    throw new Error(`DuckDuckGo web search HTTP ${res.status}`);
  }

  return parseDDGWebHtml(html, limit);
}
