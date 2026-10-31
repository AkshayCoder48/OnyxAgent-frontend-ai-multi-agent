/**
 * DUCKDUCKGO VIDEO SEARCH — keyless video backend for the `video_search`
 * tool (the Miklium replacement). Uses DuckDuckGo's own JSON results
 * endpoint (`https://duckduckgo.com/v.js`), fetched exactly the way
 * duckduckgo.com's results page does it:
 *
 *   1. GET `https://duckduckgo.com/?q=<query>` → scrape the per-query `vqd`
 *      session token out of the HTML (same handshake the
 *      @mudbill/duckduckgo-images-api package uses for i.js).
 *   2. GET `https://duckduckgo.com/v.js?o=json&q=<query>&l=us-en&vqd=<token>&f=,,,,&p=1`
 *      → `{ results: [...], next: … }` with real video rows (YouTube, Vimeo,
 *      Dailymotion…): url, title, description, duration, publisher, view
 *      counts, and a thumbnail (`content`).
 *
 * Layering (mirrors src/lib/search/ddg-images.ts conventions):
 *   - PURE (unit-tested with fixture JSON, no network):
 *     youtubeThumbFor — derives a YouTube thumbnail from a watch URL.
 *     formatDDGDuration — seconds ("325") → "5:25"; "5:25" passes through.
 *     normalizeDDGVideos — maps v.js rows onto the exact result shape the
 *       video tool-call payload and the chat VideoSearchResults card expect.
 *   - NETWORK: searchDDGVideos — the two-step handshake with an 8s ceiling.
 *
 * Honesty rules:
 *   - `content` is a thumbnail URL when it is http(s); when it is missing or
 *     a non-URL blob, we derive a YouTube thumbnail from the video URL and
 *     otherwise ship an empty thumbnail (the card renders a placeholder).
 *   - Empty results is a legitimate outcome (success, empty list). Only
 *     network/token failures throw — the caller sanitizes those.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One row of DuckDuckGo's v.js video response. Field names follow the wire
 * format; every field is optional at the row level and validated during
 * normalization.
 */
export interface DDGVideo {
  /** Video page URL (YouTube watch link, Vimeo, Dailymotion, …) */
  url?: string;
  title?: string;
  description?: string;
  /** Thumbnail URL (sometimes a non-URL blob — normalized away) */
  content?: string;
  /** Duration — "h:mm:ss" / "m:ss" string, or whole seconds as a number */
  duration?: string | number;
  /** Source platform ("youtube", "vimeo", …) */
  encoder?: string;
  /** Channel / publisher name */
  publisher?: string;
  /** Publish date (loose formats) */
  published?: string;
  statistics?: {
    viewCount?: number | string;
    likeCount?: number | string;
    datePublished?: string;
  };
  width?: number;
  height?: number;
}

/**
 * One normalized video result — the same fields the video card in
 * src/components/chat/tool-results.tsx renders (videoUrl / thumbUrl /
 * title / description / duration / channelTitle / viewCount / likeCount),
 * plus the generic search-result fields (url / domain / source / provider).
 */
export interface DDGVideoResult {
  title: string;
  url: string;
  domain?: string;
  description?: string;
  imageUrl?: string;
  thumbnail?: string;
  videoUrl: string;
  thumbUrl?: string;
  duration?: string;
  source?: string;
  channelTitle?: string;
  viewCount?: string;
  likeCount?: string;
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
 * Derive a YouTube thumbnail URL from a watch/shorts link.
 * img.youtube.com thumbnails are public, keyless, and stable — the standard
 * fallback when DDG's `content` field is missing or not an http(s) URL.
 */
export function youtubeThumbFor(url: string): string {
  const m = url.match(
    /(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/,
  );
  return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : "";
}

/** Format a duration for the card badge: seconds → "h:mm:ss" / "m:ss". */
export function formatDDGDuration(duration: string | number | undefined): string {
  if (duration === undefined || duration === null) return "";
  if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
    const s = Math.round(duration);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${m}:${String(sec).padStart(2, "0")}`;
  }
  const text = String(duration).trim();
  return /^\d+(:\d{1,2}){1,2}$/.test(text) ? text : "";
}

/**
 * Normalize raw v.js rows into the video card's result shape. Dedupes by
 * video URL, drops rows without a usable video link, caps at `limit`.
 */
export function normalizeDDGVideos(raw: DDGVideo[], limit: number): DDGVideoResult[] {
  const seen = new Set<string>();
  const results: DDGVideoResult[] = [];

  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const videoUrl = typeof v.url === "string" ? v.url : "";
    if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) continue;
    if (seen.has(videoUrl)) continue;
    seen.add(videoUrl);

    // Thumbnail: content when it is an http(s) URL, else a derived YouTube
    // thumb, else empty (the card shows the play-icon placeholder).
    const content = typeof v.content === "string" ? v.content : "";
    const thumb = /^https?:\/\//i.test(content) ? content : youtubeThumbFor(videoUrl);

    const domain = getDomain(videoUrl);
    const channelTitle = typeof v.publisher === "string" ? v.publisher : "";
    const viewCount = v.statistics?.viewCount;
    const likeCount = v.statistics?.likeCount;
    const duration = formatDDGDuration(v.duration);

    results.push({
      title: typeof v.title === "string" ? v.title : "",
      url: videoUrl,
      domain,
      description: typeof v.description === "string" ? v.description : "",
      ...(thumb ? { imageUrl: thumb, thumbnail: thumb, thumbUrl: thumb } : {}),
      videoUrl,
      ...(duration ? { duration } : {}),
      source: channelTitle || domain,
      ...(channelTitle ? { channelTitle } : {}),
      ...(viewCount !== undefined && viewCount !== null && String(viewCount) !== ""
        ? { viewCount: String(viewCount) }
        : {}),
      ...(likeCount !== undefined && likeCount !== null && String(likeCount) !== ""
        ? { likeCount: String(likeCount) }
        : {}),
      provider: "ddg",
    });
    if (results.length >= limit) break;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Network layer
// ---------------------------------------------------------------------------

/** Headers that mimic duckduckgo.com's own results-page requests. */
const DDG_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en",
  Referer: "https://duckduckgo.com/",
};

/** Safe search ON — filters adult content; the responsible default. */
const DDG_SAFE = true;

/** Hard ceiling for the whole handshake (token + v.js). */
const DDG_TIMEOUT_MS = 8_000;

function ddgTimeout(): Promise<never> {
  return new Promise((_, reject) => {
    const t = setTimeout(
      () => reject(new Error(`DuckDuckGo video search timed out after ${DDG_TIMEOUT_MS}ms`)),
      DDG_TIMEOUT_MS,
    );
    (t as { unref?: () => void }).unref?.();
  });
}

/**
 * Fetch the per-query `vqd` session token from duckduckgo.com's HTML (the
 * same token @mudbill/duckduckgo-images-api uses for image search).
 */
export async function getVqdToken(query: string): Promise<string> {
  const res = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, {
    headers: DDG_HEADERS,
  });
  if (!res.ok) {
    throw new Error(`DuckDuckGo token request HTTP ${res.status}`);
  }
  const html = await res.text().catch(() => "");
  const token = html.match(/vqd=([\d-]+)/)?.[1] || "";
  if (!token) {
    throw new Error("DuckDuckGo token unavailable");
  }
  return token;
}

/**
 * Search DuckDuckGo for videos via the v.js JSON endpoint and normalize.
 *
 * The WHOLE handshake (token page + v.js) races the 8s ceiling — a fetch
 * whose host silently drops SYNs never resolves otherwise. Throws when the
 * token handshake fails, the request times out, or DDG answers with a
 * non-OK status. An empty result set parses to an EMPTY array — a
 * legitimate "nothing matched" outcome, not a failure.
 */
export async function searchDDGVideos(query: string, limit: number): Promise<DDGVideoResult[]> {
  return Promise.race([searchDDGVideosInner(query, limit), ddgTimeout()]);
}

async function searchDDGVideosInner(query: string, limit: number): Promise<DDGVideoResult[]> {
  const token = await getVqdToken(query);

  const params = new URLSearchParams({
    o: "json",
    q: query,
    l: "us-en",
    vqd: token,
    f: ",,,,",
    p: DDG_SAFE ? "1" : "-1",
  });
  const res = await fetch(`https://duckduckgo.com/v.js?${params.toString()}`, {
    headers: DDG_HEADERS,
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo video search HTTP ${res.status}`);
  }
  const data = (await res.json().catch(() => null)) as { results?: DDGVideo[] } | null;
  const rows = Array.isArray(data?.results) ? (data?.results as DDGVideo[]) : [];
  return normalizeDDGVideos(rows, limit);
}
