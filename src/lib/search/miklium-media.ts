/**
 * MIKLIUM MEDIA SEARCH — the keyless RESCUE engine for image and video
 * search when DuckDuckGo's vqd/i.js/v.js handshake is unreachable.
 *
 * WHY THIS MODULE EXISTS (the image-search outage of 2026-11-01):
 *   DuckDuckGo's anti-bot WAF hard-blocks shared datacenter egress IPs.
 *   On the Vercel deployment every image AND video probe failed (5/5
 *   image, 1/1 video: "Image search is busy right now — no images came
 *   back") while the exact same in-house client served 53 images / 504ms
 *   from a residential IP. The block is on the EGRESS IP, not the client —
 *   which also means NO npm package can fix it: `duck-duck-scrape`,
 *   `ddgs`, and `@mudbill/duckduckgo-images-api` all hit the same
 *   duckduckgo.com endpoints from the same blocked IP. (On top of that,
 *   the mudbill package sends no headers on its token bootstrap and its
 *   token regex misses DDG's current quoted `vqd="…"` form.)
 *
 *   Miklium (https://miklium.vercel.app/api/search — the Yahoo-powered
 *   engine that already serves WEB search from those same datacenter IPs)
 *   also answers `type: "images"` / `type: "videos"`. Verified live:
 *   50 images / ~840ms, 50 videos / ~1075ms, including bulk `maxResults`
 *   up to 50. So the architecture becomes:
 *
 *     image: DuckDuckGo PRIMARY (self-hosted/local runs — user directive
 *            "for image keep ddg") → Miklium images RESCUE (hosted
 *            datacenter egress) → friendly "busy" note only when BOTH fail.
 *     video: same shape with Miklium videos as the rescue engine.
 *
 * Wire format (per Miklium's contract, also seen in this repo's history
 * at commits 934f991 / d14f20c):
 *   POST /api/search { search: [query], type: "images"|"videos", maxResults }
 *   Images: { success, results: [{ imageUrl, title, referenceUrl,
 *             size: { width, height }, query }] }
 *   Videos: { success, results: [{ videoUrl, thumbUrl, title, description,
 *             duration, query, additionalData? }] }
 *   Empty answer: HTTP 404 + {"success":false,"error":"No results found"}
 *   — an EMPTY outcome that cascades, never an error (same rule as web).
 *
 * Honesty rules (identical to the web client in the route):
 *   - "No results" → [] (the caller keeps cascading / shows the friendly
 *     note); a hard failure THROWS so the route can pick the "busy" note.
 *   - No upstream text is embedded in errors beyond a status code — raw
 *     provider JSON never reaches the chat.
 *   - Every fetch races an AbortSignal timeout; nothing can hang.
 */

/** Shared request ceiling — matches the /api/ddg-search route budget. */
const REQUEST_TIMEOUT_MS = 9_000;

/** Miklium answers 50 rows per media call (verified live); the route's
 *  public limit cap is also 50, so one call covers every bulk request. */
const MAX_RESULTS_CAP = 50;

// ---------------------------------------------------------------------------
// Normalized row shapes (match what the DDG engines emit, so the route and
// the chat carousels treat both engines identically)
// ---------------------------------------------------------------------------

/** One normalized image row — same fields a DDG image result carries. */
export interface MikliumImageRow {
  title: string;
  /** Reference (source) page URL — NOT the binary image URL */
  url: string;
  domain?: string;
  /** Binary image URL */
  imageUrl: string;
  /** Miklium gives no separate thumb — the image itself stands in */
  thumbnail?: string;
  width?: number;
  height?: number;
  source?: string;
  provider: "miklium";
}

/** One normalized video row — same fields a DDG video result carries. */
export interface MikliumVideoRow {
  title: string;
  /** The video page URL (watch link) */
  url: string;
  domain?: string;
  description?: string;
  /** Thumbnail URL */
  imageUrl?: string;
  thumbnail?: string;
  thumbUrl?: string;
  videoUrl: string;
  duration?: string;
  source?: string;
  provider: "miklium";
}

// ---------------------------------------------------------------------------
// Shared request plumbing
// ---------------------------------------------------------------------------

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Miklium's empty-answer shape: 404 + "No results found", or the same
 *  error in a 200 body. An EMPTY outcome — never a failure (web rule). */
function mikliumNoResults(status: number, body: string): boolean {
  if (status === 404 && /no results/i.test(body)) return true;
  return /"error"\s*:\s*"[^"]*no results[^"]*"/i.test(body);
}

interface MikliumResponse {
  success?: boolean;
  error?: string;
  results?: Array<Record<string, unknown>>;
}

/** POST one media query; parse + validate the shared envelope. */
async function postMikliumSearch(
  query: string,
  type: "images" | "videos",
  limit: number,
): Promise<MikliumResponse> {
  const res = await fetch("https://miklium.vercel.app/api/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      search: [query],
      type,
      maxResults: Math.min(Math.max(limit, 1), MAX_RESULTS_CAP),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const bodyText = await res.text().catch(() => "");

  if (mikliumNoResults(res.status, bodyText)) {
    return { success: true, results: [] };
  }
  if (!res.ok) {
    // Status code only — raw provider JSON stays in the server log.
    throw new Error(`Miklium ${type} search HTTP ${res.status}`);
  }

  let data: MikliumResponse;
  try {
    data = JSON.parse(bodyText) as MikliumResponse;
  } catch {
    throw new Error(`Miklium ${type} search returned invalid JSON`);
  }
  if (data && data.success === false) {
    if (data.error && /no results/i.test(String(data.error))) {
      return { success: true, results: [] };
    }
    throw new Error(`Miklium ${type} search error: ${String(data.error ?? "unknown")}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Image engine
// ---------------------------------------------------------------------------

/**
 * Search images via Miklium (Yahoo-powered, keyless).
 *
 * Returns [] when the query matches nothing (a legitimate empty outcome —
 * the caller shows the friendly "no images found" note, or keeps
 * cascading). THROWS when the engine is unreachable, so the caller can
 * distinguish "engine busy" from "nothing matched".
 */
export async function searchMikliumImages(query: string, limit: number): Promise<MikliumImageRow[]> {
  const data = await postMikliumSearch(query, "images", limit);
  if (!Array.isArray(data.results)) return [];

  const seen = new Set<string>();
  const results: MikliumImageRow[] = [];
  for (const item of data.results) {
    const imageUrl = typeof item.imageUrl === "string" ? item.imageUrl : "";
    if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) continue;
    if (seen.has(imageUrl)) continue;
    seen.add(imageUrl);

    const referenceUrl =
      typeof item.referenceUrl === "string" && /^https?:\/\//i.test(item.referenceUrl)
        ? item.referenceUrl
        : imageUrl;
    const domain = getDomain(referenceUrl);
    const size =
      item.size && typeof item.size === "object"
        ? (item.size as { width?: unknown; height?: unknown })
        : {};
    const width = typeof size.width === "number" ? size.width : undefined;
    const height = typeof size.height === "number" ? size.height : undefined;

    results.push({
      title: typeof item.title === "string" && item.title ? item.title : domain || "Image result",
      url: referenceUrl,
      ...(domain ? { domain } : {}),
      imageUrl,
      thumbnail: imageUrl,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      source: domain || "Miklium",
      provider: "miklium",
    });
    if (results.length >= limit) break;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Video engine
// ---------------------------------------------------------------------------

/**
 * Search videos via Miklium (Yahoo-powered, keyless).
 *
 * Same contract as searchMikliumImages: [] = nothing matched, throw =
 * engine unreachable.
 */
export async function searchMikliumVideos(query: string, limit: number): Promise<MikliumVideoRow[]> {
  const data = await postMikliumSearch(query, "videos", limit);
  if (!Array.isArray(data.results)) return [];

  const seen = new Set<string>();
  const results: MikliumVideoRow[] = [];
  for (const item of data.results) {
    const videoUrl = typeof item.videoUrl === "string" ? item.videoUrl : "";
    if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) continue;
    if (seen.has(videoUrl)) continue;
    seen.add(videoUrl);

    const domain = getDomain(videoUrl);
    const thumbUrl = typeof item.thumbUrl === "string" && /^https?:\/\//i.test(item.thumbUrl)
      ? item.thumbUrl
      : undefined;

    results.push({
      title: typeof item.title === "string" && item.title ? item.title : domain || "Video result",
      url: videoUrl,
      ...(domain ? { domain } : {}),
      ...(typeof item.description === "string" && item.description
        ? { description: item.description }
        : {}),
      ...(thumbUrl ? { imageUrl: thumbUrl, thumbnail: thumbUrl, thumbUrl } : {}),
      videoUrl,
      ...(typeof item.duration === "string" && item.duration ? { duration: item.duration } : {}),
      source: domain || "Miklium",
      provider: "miklium",
    });
    if (results.length >= limit) break;
  }
  return results;
}
