/**
 * DUCKDUCKGO IMAGE SEARCH — the `image_search` tool's backend (DDG ONLY, per
 * user directive 2026-10-31: "for image keep ddg").
 *
 * IN-HOUSE CLIENT (v3, 2026-11-01) — the @mudbill/duckduckgo-images-api
 * dependency is GONE. Root cause it carried (verified live against DDG):
 *   1. Its token bootstrap sent NO headers — Node's default undici UA is an
 *      instant bot tell, so DDG's anti-bot served a challenge page with no
 *      `vqd` token → "Failed to get token" on a shared/datacenter IP.
 *   2. Its i.js UA was Chrome/55 (2017) — another red flag.
 *   3. Its token regex missed DDG's current quoted form (`vqd="4-…"`).
 *   4. No timeouts, no token reuse, no soft-block awareness: a 202/anomaly
 *      response was retried with the SAME dead token, then misread as
 *      "no results" or thrown as an outage.
 *
 * This client instead (the same discipline the in-house v.js engine already
 * used successfully):
 *   - Browser-grade headers everywhere (shared ddg-vqd module).
 *   - Token cache (TTL ~14 min) so warm instances rarely re-bootstrap.
 *   - DDG's soft block (HTTP 202/403/challenge JSON) is detected, and
 *     retried ONCE with a fresh token after backoff — never misread as
 *     "no results".
 *   - BULK support: pages through i.js's `next` cursor (≈100 rows/page) up
 *     to MAX_PAGES pages, filling large `limit`s from multiple pages.
 *   - Every fetch has an AbortSignal; the whole call races an 8s deadline.
 *
 * Layering (unchanged shape, so /api/ddg-search and the chat's
 * ImageSearchResults carousel keep working):
 *   - PURE (unit-tested with fixtures, no network): normalizeDDGImages.
 *   - NETWORK: searchDDGImages — token → i.js (→ next pages) → normalize.
 *
 * Honesty rules:
 *   - DDG image/thumbnail URLs come back through DDG's own CDN
 *     (external-content.duckduckgo.com/iu/?u=…), public and
 *     browser-loadable. Passed through untouched.
 *   - A 200 response with an empty `results` array is a legitimate "no
 *     images found" outcome (returns [], callers show the friendly note);
 *     a BLOCKED response throws so the route can retry/degrade honestly.
 */

import { DDGBlockedError, DDG_XHR_HEADERS, getVqdToken, isDDGBlocked } from "./ddg-vqd";
import {
  buildForwardedHeaders,
  ddgSafeSearchParam,
  ddgUrl,
  type DDGEgressOptions,
} from "./ddg-egress";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One row of DuckDuckGo's i.js image response (the wire format
 * @mudbill/duckduckgo-images-api also produced — kept so fixtures and the
 * chat carousel contract stay valid).
 */
export interface DDGImage {
  /** Height of image in pixels */
  height: number;
  /** Width of image in pixels */
  width: number;
  /** Image URL (DDG CDN proxy: external-content.duckduckgo.com/iu/?u=…) */
  image: string;
  /** Domain where DuckDuckGo found the image */
  source: string;
  /** A smaller thumbnail of the image (DDG CDN) */
  thumbnail: string;
  /** Title of the web page where the image was found */
  title: string;
  /** URL of the web page where the image was found */
  url: string;
}

/**
 * Normalized image result — the fields downstream consumers (the
 * /api/ddg-search route, the `image_search` tool payload, and the chat
 * ImageSearchResults carousel) render.
 */
export interface DDGImageResult {
  title: string;
  /** Reference (source) page URL — NOT the binary image URL */
  url: string;
  domain?: string;
  /** Binary image URL (DDG CDN) */
  imageUrl: string;
  /** Smaller thumbnail URL (DDG CDN) */
  thumbnail: string;
  width?: number;
  height?: number;
  /** Hostname of the reference page */
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

/**
 * Normalize raw DuckDuckGo image rows into the normalized SearchResult
 * shape. Dedupes by binary image URL, drops rows without a usable image
 * URL, and caps at `limit`.
 */
export function normalizeDDGImages(raw: DDGImage[], limit: number): DDGImageResult[] {
  const seen = new Set<string>();
  const results: DDGImageResult[] = [];
  for (const img of raw) {
    if (!img || typeof img.image !== "string" || !img.image) continue;
    if (seen.has(img.image)) continue; // dedupe identical binaries
    seen.add(img.image);

    // DDG's `url` is the reference page; fall back to the image itself
    // when it's missing so "Open source" links still resolve.
    const refUrl = typeof img.url === "string" && img.url ? img.url : img.image;
    const domain = getDomain(refUrl);

    results.push({
      title: typeof img.title === "string" ? img.title : "",
      url: refUrl,
      domain,
      imageUrl: img.image,
      thumbnail: typeof img.thumbnail === "string" && img.thumbnail ? img.thumbnail : img.image,
      width: Number(img.width) || undefined,
      height: Number(img.height) || undefined,
      source: domain || (typeof img.source === "string" ? img.source : ""),
      provider: "ddg",
    });
    if (results.length >= limit) break;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Network layer
// ---------------------------------------------------------------------------

/** Safe-search flag for i.js — OFF by default (p=-1, unfiltered: DDG must
 *  return the same rows duckduckgo.com serves with safe search disabled;
 *  live-verified 2026-11-01 that the shipped p=1 silently stripped the
 *  adult-content rows). DDG_SAFE_SEARCH=true turns the filter back on for
 *  the whole deployment. See ddg-egress.ts. */

/** Hard ceiling for the whole DDG round-trip (token + all i.js pages +
 *  retry). Live round-trips measure ~0.6s/page; the ceiling exists so a
 *  dropped-SYN egress path can't hang the call — it would otherwise sit in
 *  Node's TCP retransmission loop for ~2 minutes and blow
 *  /api/ddg-search's maxDuration (30s). */
const DDG_TIMEOUT_MS = 8_000;

/** Per-fetch ceiling (token page and each i.js page). */
const FETCH_TIMEOUT_MS = 5_000;

/** Backoff before the one soft-block retry — lets the WAF window breathe. */
const RETRY_BACKOFF_MS = 600;

/** Bulk ceiling: i.js pages hold ~100 rows; 3 pages fill any limit≤50. */
const MAX_PAGES = 3;

function ddgTimeout(): Promise<never> {
  return new Promise((_, reject) => {
    const t = setTimeout(
      () => reject(new Error(`DuckDuckGo image search timed out after ${DDG_TIMEOUT_MS}ms`)),
      DDG_TIMEOUT_MS,
    );
    // Don't hold the event loop (or the vitest worker) open for the losing
    // timer; works in Node and Bun, no-op in browsers.
    (t as { unref?: () => void }).unref?.();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/**
 * One i.js page. Returns `{ rows, next }` — `next` is DDG's cursor for the
 * next page (a relative URL whose `vqd` param we re-pin, since DDG drops
 * it), or "" on the last page.
 *
 * `clientIp` (the end user's public IP) rides along as the standard
 * X-Forwarded-For / X-Real-IP / Forwarded headers; the URL itself routes
 * through ddgUrl() so a DDG_PROXY_BASE relay takes the whole handshake off
 * the datacenter egress. See ddg-egress.ts.
 *
 * Throws DDGBlockedError when the response carries DDG's anti-bot shape
 * (202/403/challenge JSON) so the retry path can refresh the session.
 * A 200 with an empty `results` array resolves to zero rows — a genuine
 * "nothing matched" outcome.
 */
async function fetchImagePage(
  query: string,
  vqd: string,
  start: number,
  clientIp?: string,
): Promise<{ rows: DDGImage[]; next: string }> {
  const params = new URLSearchParams({
    o: "json",
    q: query,
    l: "us-en",
    vqd,
    f: ",,,,",
    p: ddgSafeSearchParam(),
    s: String(start),
  });
  const res = await fetch(ddgUrl(`/i.js?${params.toString()}`), {
    headers: { ...DDG_XHR_HEADERS, ...buildForwardedHeaders(clientIp) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await res.text().catch(() => "");

  if (isDDGBlocked(res.status, body)) {
    throw new DDGBlockedError("i.js");
  }
  if (!res.ok) {
    throw new Error(`DuckDuckGo image search HTTP ${res.status}`);
  }

  let data: { results?: unknown; next?: unknown };
  try {
    data = JSON.parse(body) as typeof data;
  } catch {
    throw new Error("DuckDuckGo image search returned invalid JSON");
  }
  const rows = Array.isArray(data?.results) ? (data.results as DDGImage[]) : [];

  // DDG's `next` cursor is relative ("i.js?o=json&q=…&s=100…"), sometimes
  // empty. Re-pin the token (DDG omits it from the cursor) and absolutize
  // (ddgUrl("/") keeps relay routing correct for relative resolution).
  let next = "";
  if (typeof data?.next === "string" && data.next) {
    try {
      const u = new URL(data.next, ddgUrl("/"));
      u.searchParams.set("vqd", vqd);
      next = u.toString();
    } catch {
      next = "";
    }
  }
  return { rows, next };
}

/**
 * Search DuckDuckGo for images and normalize to the SearchResult shape.
 *
 * Flow: (cached or fresh) vqd token → i.js page(s) via the `next` cursor
 * until `limit` rows or MAX_PAGES → normalize. A soft-blocked response
 * (DDGBlockedError) retries the whole flow once with a FRESH token after
 * `RETRY_BACKOFF_MS` — the token cache is bypassed so the retry isn't
 * poisoned by the blocked session.
 *
 * `opts.clientIp` (the end user's public IP, when forwardable) is attached
 * to every request as the standard proxy-forwarding headers, and the URLs
 * honor DDG_PROXY_BASE — the "no datacenter IP involved" egress options
 * (see ddg-egress.ts).
 *
 * Throws on token failure, timeout, or a block that survives the retry —
 * the route's retry + graceful "busy" note handle those. A query that
 * simply matches nothing resolves to an EMPTY array.
 */
export async function searchDDGImages(
  query: string,
  limit: number,
  opts?: DDGEgressOptions,
): Promise<DDGImageResult[]> {
  return Promise.race([searchDDGImagesInner(query, limit, opts), ddgTimeout()]);
}

async function searchDDGImagesInner(
  query: string,
  limit: number,
  opts?: DDGEgressOptions,
): Promise<DDGImageResult[]> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const fresh = attempt > 1; // retry path: never reuse the blocked session
    try {
      const vqd = await getVqdToken(query, { fresh, clientIp: opts?.clientIp });
      const raw: DDGImage[] = [];

      // Bulk: walk i.js pages via DDG's `next` cursor until we have enough
      // rows (each page holds ~100). The cursor's `s` param is the start
      // offset for the following page.
      let start = 0;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const fetched = await fetchImagePage(query, vqd, start, opts?.clientIp);
        raw.push(...fetched.rows);
        if (fetched.rows.length === 0) break; // last page / nothing matched
        if (raw.length >= limit) break; // bulk satisfied
        if (!fetched.next) break; // no cursor → single page of results
        try {
          start = Number(new URL(fetched.next).searchParams.get("s") ?? "0") || start + 100;
        } catch {
          start += 100;
        }
      }

      return normalizeDDGImages(raw, limit);
    } catch (err) {
      // Only the anti-block shape merits a retry with a fresh session;
      // everything else (timeout, bad JSON, hard HTTP error) propagates.
      if (err instanceof DDGBlockedError && attempt < 2) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      throw err;
    }
  }
  /* istanbul ignore next -- for-loop guarantees a return or throw */
  throw new Error("DuckDuckGo image search failed");
}
