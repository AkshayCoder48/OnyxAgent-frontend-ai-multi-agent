/**
 * DuckDuckGo VIDEO search tests — the keyless v.js backend that replaced the
 * old third-party search service for `video_search`.
 *
 * The network is fully mocked: the real flow is
 *   1. GET duckduckgo.com/?q=<query>       → HTML containing the vqd token
 *   2. GET duckduckgo.com/v.js?…&vqd=…    → { results: DDGVideo[] }
 * Both responses are stubbed with schema-accurate fixtures, so these tests
 * prove the code path deterministically without touching the network (the
 * sandbox/CI may block duckduckgo.com egress).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatDDGDuration,
  normalizeDDGVideos,
  searchDDGVideos,
  youtubeThumbFor,
  type DDGVideo,
} from "./ddg-videos";
import { clearVqdCache } from "./ddg-vqd";

// Real vqd tokens are digits+hyphens (the shared ddg-vqd client accepts
// both this query-string form and the quoted attribute form DDG now serves).
const SERP_HTML = `<!DOCTYPE html><html><body>
  <script src="//duckduckgo.com/ac/db.js?vqd=4-32098503961658400691&s=50"></script>
</body></html>`;

// Fixture factory matching the REAL v.js wire schema (verified live
// 2026-11-01): `content` is the video URL, thumbnails live in `images`,
// `uploader` is the channel, `publisher` is the platform.
const mkVideo = (over: Partial<DDGVideo> = {}): DDGVideo => ({
  content: "https://www.youtube.com/watch?v=ELalc0t9z9I",
  title: "Apollo 11 Moon Landing",
  description: "Original NASA footage of the landing.",
  duration: "5:32",
  images: {
    large: "https://tse4.mm.bing.net/th/id/OVP.Apollo?t=large",
    medium: "https://tse4.mm.bing.net/th/id/OVP.Apollo?t=medium",
    small: "https://tse4.mm.bing.net/th/id/OVP.Apollo?t=small",
  },
  uploader: "NASA",
  publisher: "YouTube",
  provider: "Bing",
  published: "2011-05-06",
  statistics: { viewCount: 1234567, likeCount: 9876 },
  ...over,
});

beforeEach(() => {
  clearVqdCache(); // the shared vqd client caches tokens across calls
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("youtubeThumbFor (pure)", () => {
  it("derives a thumbnail from watch, shorts, embed, and youtu.be links", () => {
    expect(youtubeThumbFor("https://www.youtube.com/watch?v=ELalc0t9z9I&t=30")).toBe(
      "https://i.ytimg.com/vi/ELalc0t9z9I/hqdefault.jpg",
    );
    expect(youtubeThumbFor("https://www.youtube.com/shorts/abc123XYZ_-")).toBe(
      "https://i.ytimg.com/vi/abc123XYZ_-/hqdefault.jpg",
    );
    expect(youtubeThumbFor("https://youtu.be/dQw4w9WgXcQ")).toBe(
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    );
    expect(youtubeThumbFor("https://www.youtube.com/embed/XkYuUDQyZ5M")).toBe(
      "https://i.ytimg.com/vi/XkYuUDQyZ5M/hqdefault.jpg",
    );
  });

  it("returns '' for non-YouTube URLs", () => {
    expect(youtubeThumbFor("https://vimeo.com/12345")).toBe("");
    expect(youtubeThumbFor("")).toBe("");
  });
});

describe("formatDDGDuration (pure)", () => {
  it("passes clock formats through", () => {
    expect(formatDDGDuration("5:32")).toBe("5:32");
    expect(formatDDGDuration("1:02:03")).toBe("1:02:03");
  });

  it("converts whole seconds to m:ss / h:mm:ss", () => {
    expect(formatDDGDuration(332)).toBe("5:32");
    expect(formatDDGDuration(3723)).toBe("1:02:03");
  });

  it("returns '' for garbage and empty values", () => {
    expect(formatDDGDuration(undefined)).toBe("");
    expect(formatDDGDuration("about 5 minutes")).toBe("");
    expect(formatDDGDuration(-1)).toBe("");
  });
});

describe("normalizeDDGVideos (pure)", () => {
  it("maps real-shape v.js rows onto the video card's result shape", () => {
    const [r] = normalizeDDGVideos([mkVideo()], 10);
    expect(r).toMatchObject({
      title: "Apollo 11 Moon Landing",
      url: "https://www.youtube.com/watch?v=ELalc0t9z9I",
      videoUrl: "https://www.youtube.com/watch?v=ELalc0t9z9I",
      domain: "youtube.com",
      description: "Original NASA footage of the landing.",
      thumbUrl: "https://tse4.mm.bing.net/th/id/OVP.Apollo?t=large",
      imageUrl: "https://tse4.mm.bing.net/th/id/OVP.Apollo?t=large",
      duration: "5:32",
      source: "NASA",
      channelTitle: "NASA",
      viewCount: "1234567",
      likeCount: "9876",
      provider: "ddg",
    });
  });

  it("derives a YouTube thumbnail when the row carries no usable images", () => {
    const [a] = normalizeDDGVideos([mkVideo({ images: undefined })], 10);
    expect(a.thumbUrl).toBe("https://i.ytimg.com/vi/ELalc0t9z9I/hqdefault.jpg");

    const [b] = normalizeDDGVideos(
      [mkVideo({ images: { large: "data:image/png;base64,AAAA" } })],
      10,
    );
    expect(b.thumbUrl).toBe("https://i.ytimg.com/vi/ELalc0t9z9I/hqdefault.jpg");
  });

  it("prefers images.large, falling back through medium/small", () => {
    const [a] = normalizeDDGVideos(
      [mkVideo({ images: { medium: "https://cdn.example/med.jpg" } })],
      10,
    );
    expect(a.thumbUrl).toBe("https://cdn.example/med.jpg");
  });

  it("maps a non-YouTube row: video URL from content, domain from it", () => {
    const [r] = normalizeDDGVideos(
      [
        mkVideo({
          content: "https://vimeo.com/12345",
          images: { large: "https://i.vimeocdn.com/video/t.jpg" },
          uploader: "Vimeo Staff",
          publisher: "Vimeo",
        }),
      ],
      10,
    );
    expect(r.videoUrl).toBe("https://vimeo.com/12345");
    expect(r.thumbUrl).toBe("https://i.vimeocdn.com/video/t.jpg");
    expect(r.domain).toBe("vimeo.com");
    expect(r.channelTitle).toBe("Vimeo Staff");
  });

  it("falls back to the legacy `url` field when content is absent (fixtures)", () => {
    const [r] = normalizeDDGVideos(
      [mkVideo({ content: undefined, url: "https://www.youtube.com/watch?v=legacy1" })],
      10,
    );
    expect(r.videoUrl).toBe("https://www.youtube.com/watch?v=legacy1");
  });

  it("dedupes by video URL, drops rows without an http(s) video URL, caps at limit", () => {
    const rows = [
      mkVideo(),
      mkVideo({ title: "duplicate" }),
      mkVideo({ content: "not-a-url" }),
      mkVideo({ content: "https://www.youtube.com/watch?v=2", images: undefined }),
      mkVideo({ content: "https://www.youtube.com/watch?v=3", images: undefined }),
    ];
    const out = normalizeDDGVideos(rows, 2);
    expect(out).toHaveLength(2);
    expect(out[0].title).toBe("Apollo 11 Moon Landing");
    expect(out[1].videoUrl).toContain("v=2");
  });

  it("omits duration/thumb/stats keys cleanly when the row lacks them", () => {
    const [r] = normalizeDDGVideos(
      [
        {
          url: "https://vimeo.com/12345",
          title: "Bare row",
        },
      ],
      10,
    );
    expect(r.duration).toBeUndefined();
    expect(r.thumbUrl).toBeUndefined();
    expect(r.viewCount).toBeUndefined();
    expect(r.channelTitle).toBeUndefined();
    expect(r.source).toBe("vimeo.com");
  });
});

describe("searchDDGVideos (network flow, mocked fetch)", () => {
  it("runs the token page → v.js flow and normalizes the payload", async () => {
    const rows = [
      mkVideo(),
      mkVideo({ content: "https://vimeo.com/777", title: "Vimeo copy", uploader: "Vimeo Picks" }),
    ];
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: unknown) => {
      const u = String(input);
      calls.push(u);
      if (u.startsWith("https://duckduckgo.com/v.js")) {
        return new Response(JSON.stringify({ results: rows, next: "v.js?o=json&s=60" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(SERP_HTML, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await searchDDGVideos("apollo landing", 10);

    // Exactly two requests: the token page, then v.js carrying the token.
    expect(calls).toHaveLength(2);
    expect(calls[0].startsWith("https://duckduckgo.com/?q=")).toBe(true);
    expect(calls[1]).toContain("https://duckduckgo.com/v.js?");
    expect(calls[1]).toContain("vqd=4-32098503961658400691");
    expect(calls[1]).toContain("q=apollo+landing");
    expect(calls[1]).toContain("p=1"); // safe search on

    expect(out).toHaveLength(2);
    expect(out.every((r) => r.provider === "ddg")).toBe(true);
    expect(out[0]).toMatchObject({
      title: "Apollo 11 Moon Landing",
      videoUrl: "https://www.youtube.com/watch?v=ELalc0t9z9I",
      duration: "5:32",
    });
  });

  it("throws when the token page has no vqd token (sanitized upstream)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>no token here</html>", { status: 200 })),
    );
    await expect(searchDDGVideos("query", 5)).rejects.toThrow("token unavailable");
  });

  it("treats an empty v.js result set as an empty array (graceful no-results)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const u = String(input);
        if (u.startsWith("https://duckduckgo.com/v.js")) {
          return new Response(JSON.stringify({ results: [], next: "" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(SERP_HTML, { status: 200 });
      }),
    );
    expect(await searchDDGVideos("zzzz nothing", 5)).toEqual([]);
  });

  it("retries ONCE with a fresh token after an anti-bot soft block (202), then succeeds", async () => {
    const CHALLENGE_BODY = JSON.stringify({
      challenge: { cc: "sre", gk: "d4cd0dabcf4caa22ad92fab40844c786", i: "3" },
    });
    let vjsSeen = 0;
    const fetchMock = vi.fn(async (input: unknown) => {
      const u = String(input);
      if (u.startsWith("https://duckduckgo.com/v.js")) {
        vjsSeen++;
        if (vjsSeen === 1) {
          // HTTP 202 counts as `ok` for fetch — the soft-block check must
          // be explicit or a block is misread as "no results".
          return new Response(CHALLENGE_BODY, { status: 202 });
        }
        return new Response(
          JSON.stringify({ results: [mkVideo()], next: "" }),
          { status: 200 },
        );
      }
      return new Response(SERP_HTML, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await searchDDGVideos("cats", 5);

    expect(out).toHaveLength(1);
    // token + v.js(blocked) + fresh token + v.js(ok)
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("throws on a non-OK v.js status after exhausting the fresh-token retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const u = String(input);
        if (u.startsWith("https://duckduckgo.com/v.js")) {
          return new Response("Forbidden", { status: 403 });
        }
        return new Response(SERP_HTML, { status: 200 });
      }),
    );
    // 403 is DDG's anti-bot shape now — one fresh-token retry, then an
    // honest failure the route degrades to the friendly "busy" note.
    await expect(searchDDGVideos("query", 5)).rejects.toThrow(/blocked/i);
  });

  it("races an 8s timeout instead of hanging on dropped egress", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.useFakeTimers();
    try {
      const p = searchDDGVideos("query", 5);
      const assertion = expect(p).rejects.toThrow(/timed out after 8000ms/);
      await vi.advanceTimersByTimeAsync(8100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
