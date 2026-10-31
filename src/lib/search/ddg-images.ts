/**
 * DUCKDUCKGO IMAGE SEARCH — new primary backend for the `image_search` tool,
 * replacing Miklium images. Uses `@mudbill/duckduckgo-images-api`, which
 * scrapes DuckDuckGo's official image-search endpoint (`duckduckgo.com/i.js`)
 * through a short-lived `vqd` session token — no API key, no billing.
 *
 * Layering (mirrors src/lib/search/search.ts conventions):
 *   - PURE (unit-tested with a mocked fetch, no network):
 *     normalizeDDGImages — maps the package's DuckDuckGoImage rows onto the
 *     exact SearchResult shape the Miklium backend used to emit
 *     ({ title, url, domain, imageUrl, thumbnail, width, height, source,
 *     provider }), so the `image_search` tool-call payload and the chat
 *     ImageSearchResults carousel render identically to before.
 *   - NETWORK: searchDDGImages — calls the package's imageSearch() with
 *     safe search on and retries enabled, then normalizes.
 *
 * Honesty rules:
 *   - DDG image/thumbnail URLs come back through DDG's own CDN
 *     (external-content.duckduckgo.com/iu/?u=…), which is public and
 *     browser-loadable. We pass them through untouched.
 *   - The package swallows per-request failures after its retries and just
 *     returns fewer results (only a failed token lookup throws), so callers
 *     must treat an EMPTY array as "backend down" and fall back to Miklium —
 *     exactly what /api/ddg-search does.
 */

import { imageSearch } from "@mudbill/duckduckgo-images-api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One row of DuckDuckGo's i.js image response. Matches the package's
 * `DuckDuckGoImage` interface field-for-field (the package doesn't
 * re-export the type from its entrypoint, so it is declared locally).
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
 * Normalized image result — the same fields the Miklium image backend
 * emitted, so downstream consumers (the /api/ddg-search route, the
 * `image_search` tool payload, and the chat ImageSearchResults carousel)
 * keep working unchanged.
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
 * Normalize raw DuckDuckGo image rows into the Miklium-compatible
 * SearchResult shape. Dedupes by binary image URL, drops rows without a
 * usable image URL, and caps at `limit`.
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

/** Safe search ON — filters adult content; the responsible default for an
 *  end-user product (one-word change to disable). */
const DDG_SAFE_SEARCH = true;

/** Hard ceiling for the whole DDG round-trip (vqd token + i.js). The package
 *  has no abort-signal support, so we race it: a dropped-SYN egress path
 *  otherwise hangs ~2 minutes in Node's TCP retransmission loop, which
 *  would blow /api/ddg-search's maxDuration (30s) before the Miklium
 *  fallback ever runs. Live DDG round-trips measured ~0.6s. */
const DDG_TIMEOUT_MS = 8_000;

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

/**
 * Search DuckDuckGo for images and normalize to the Miklium-compatible
 * result shape.
 *
 * Throws when DDG cannot be contacted for a session token, when the request
 * exceeds DDG_TIMEOUT_MS, or when the package gives up; after the token
 * lookup, per-request failures are retried internally by the package and
 * can legitimately yield an EMPTY array — callers should fall back to
 * Miklium on throw OR empty.
 */
export async function searchDDGImages(query: string, limit: number): Promise<DDGImageResult[]> {
  const raw = await Promise.race([
    imageSearch({
      query,
      safe: DDG_SAFE_SEARCH,
      retries: 2,
      iterations: 1, // one pass = up to 100 raw rows; we slice to `limit`
    }),
    ddgTimeout(),
  ]);
  return normalizeDDGImages((raw ?? []) as unknown as DDGImage[], limit);
}
