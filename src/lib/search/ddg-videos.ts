/**
 * DUCKDUCKGO VIDEO SEARCH — keyless video backend for the `video_search`
 * tool. Uses DuckDuckGo's own JSON results endpoint
 * (`https://duckduckgo.com/v.js`), fetched exactly the way
 * duckduckgo.com's results page does it:
 *
 *   1. GET `https://duckduckgo.com/?q=<query>` → scrape the per-query `vqd`
 *      session token out of the HTML — via the shared browser-grade client
 *      in src/lib/search/ddg-vqd.ts (cached tokens, soft-block detection,
 *      abort-safe; the same handshake image search now uses for i.js).
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
 *   - NETWORK: searchDDGVideos — the two-step handshake with an 8s ceiling,
 *     one fresh-token retry when DDG's anti-bot soft-blocks (202/403/
 *     challenge) the endpoint.
 *
 * Honesty rules:
 *   - `content` IS the video page URL (verified live); thumbnails come from
 *     the row's `images` object (bing.net CDN). When no usable thumbnail
 *     exists we derive a YouTube one from the video URL, else ship empty
 *     (the card renders the play-icon placeholder).
 *   - Empty results is a legitimate outcome (success, empty list). Only
 *     network/token failures and surviving blocks throw — the caller
 *     sanitizes those.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One row of DuckDuckGo's v.js video response, exactly as the wire serves
 * it (verified live 2026-11-01 — the previous interface invented a `url`
 * field the endpoint never sends, so every live row was dropped and video
 * search silently returned "no results" forever):
 *   { content, description, duration, embed_html, embed_url, image_token,
 *     images: {large,medium,small,motion}, provider, published, publisher,
 *     statistics: {viewCount}, thumbnail_height, thumbnail_width, title,
 *     uploader }
 * `url` is tolerated for fixture/back-compat only. Every field is optional
 * at the row level and validated during normalization.
 */
export interface DDGVideo {
  /** Video page URL — THIS is the real field (YouTube watch link, Vimeo, …) */
  content?: string;
  /** Fixture/back-compat alternate for the video URL (not sent by v.js) */
  url?: string;
  title?: string;
  description?: string;
  /** Duration — "h:mm:ss" / "m:ss" string, or whole seconds as a number */
  duration?: string | number;
  /** Thumbnails at several sizes (bing.net CDN via DDG) */
  images?: {
    large?: string;
    medium?: string;
    small?: string;
    motion?: string;
  };
  /** Channel name ("NASA") — the human creator */
  uploader?: string;
  /** Platform ("YouTube", "Vimeo") — NOT the channel */
  publisher?: string;
  /** Upstream provider ("Bing") */
  provider?: string;
  /** Publish date (loose ISO-ish formats) */
  published?: string;
  statistics?: {
    viewCount?: number | string;
    likeCount?: number | string;
    datePublished?: string;
  };
  thumbnail_width?: number;
  thumbnail_height?: number;
  /** Legacy tolerated (old fixtures) */
  encoder?: string;
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
 * fallback when the row carries no usable `images` thumbnail.
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
 * Pick the best thumbnail URL from a v.js row's `images` object
 * (large → medium → small → motion), validating it is http(s).
 */
export function thumbnailFromImages(images: DDGVideo["images"]): string {
  if (!images || typeof images !== "object") return "";
  const candidates = [images.large, images.medium, images.small, images.motion];
  for (const c of candidates) {
    if (typeof c === "string" && /^https?:\/\//i.test(c)) return c;
  }
  return "";
}

/**
 * Normalize raw v.js rows into the video card's result shape. Dedupes by
 * video URL, drops rows without a usable video link, caps at `limit`.
 *
 * Field mapping (verified against live v.js responses):
 *   videoUrl  ← content (the real field; `url` tolerated for old fixtures)
 *   thumbnail ← images.large/medium/small, else a derived YouTube thumb
 *   channel   ← uploader (the channel name; `publisher` is the PLATFORM)
 *   stats     ← statistics.viewCount / likeCount
 */
export function normalizeDDGVideos(raw: DDGVideo[], limit: number): DDGVideoResult[] {
  const seen = new Set<string>();
  const results: DDGVideoResult[] = [];

  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    // v.js puts the video page URL in `content`; the legacy `url` field is
    // tolerated so old fixtures keep exercising the same path.
    const videoUrl =
      typeof v.content === "string" && /^https?:\/\//i.test(v.content)
        ? v.content
        : typeof v.url === "string" && /^https?:\/\//i.test(v.url)
          ? v.url
          : "";
    if (!videoUrl) continue;
    if (seen.has(videoUrl)) continue;
    seen.add(videoUrl);

    // Thumbnail: the row's own images, else a derived YouTube thumb, else
    // empty (the card shows the play-icon placeholder).
    const thumb = thumbnailFromImages(v.images) || youtubeThumbFor(videoUrl);

    const domain = getDomain(videoUrl);
    const channelTitle =
      typeof v.uploader === "string" && v.uploader ? v.uploader : (v.publisher ?? "");
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

import {
  DDGBlockedError,
  DDG_XHR_HEADERS,
  getVqdToken as getVqdTokenShared,
  isDDGBlocked,
} from "./ddg-vqd";

/** Backoff before the one soft-block retry — lets the WAF window breathe. */
const RETRY_BACKOFF_MS = 600;

/** Safe search ON — filters adult content; the responsible default. */
const DDG_SAFE = true;

/** Hard ceiling for the whole handshake (token + v.js + retry). */
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
 * Fetch the per-query `vqd` session token (shared browser-grade client in
 * src/lib/search/ddg-vqd.ts — cached, soft-block aware, abort-safe).
 */
export async function getVqdToken(query: string): Promise<string> {
  return getVqdTokenShared(query);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/**
 * Search DuckDuckGo for videos via the v.js JSON endpoint and normalize.
 *
 * The WHOLE handshake (token page + v.js) races the 8s ceiling — a fetch
 * whose host silently drops SYNs never resolves otherwise. A soft-blocked
 * response (HTTP 202/403 or the challenge body — note 202 counts as `ok`
 * for fetch, so it must be checked explicitly) retries ONCE with a fresh
 * token; a block that survives the retry throws, as do timeouts and hard
 * HTTP errors. An empty 200 result set parses to an EMPTY array — a
 * legitimate "nothing matched" outcome, not a failure.
 */
export async function searchDDGVideos(query: string, limit: number): Promise<DDGVideoResult[]> {
  return Promise.race([searchDDGVideosInner(query, limit), ddgTimeout()]);
}

async function searchDDGVideosInner(query: string, limit: number): Promise<DDGVideoResult[]> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const fresh = attempt > 1; // retry path: never reuse the blocked session
    try {
      const token = await getVqdTokenShared(query, { fresh });

      const params = new URLSearchParams({
        o: "json",
        q: query,
        l: "us-en",
        vqd: token,
        f: ",,,,",
        p: DDG_SAFE ? "1" : "-1",
      });
      const res = await fetch(`https://duckduckgo.com/v.js?${params.toString()}`, {
        headers: DDG_XHR_HEADERS,
      });
      const body = await res.text().catch(() => "");

      if (isDDGBlocked(res.status, body)) {
        throw new DDGBlockedError("v.js");
      }
      if (!res.ok) {
        throw new Error(`DuckDuckGo video search HTTP ${res.status}`);
      }

      let data: { results?: DDGVideo[] } | null;
      try {
        data = JSON.parse(body) as { results?: DDGVideo[] } | null;
      } catch {
        throw new Error("DuckDuckGo video search returned invalid JSON");
      }
      const rows = Array.isArray(data?.results) ? (data?.results as DDGVideo[]) : [];
      return normalizeDDGVideos(rows, limit);
    } catch (err) {
      if (err instanceof DDGBlockedError && attempt < 2) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      throw err;
    }
  }
  /* istanbul ignore next -- for-loop guarantees a return or throw */
  throw new Error("DuckDuckGo video search failed");
}
