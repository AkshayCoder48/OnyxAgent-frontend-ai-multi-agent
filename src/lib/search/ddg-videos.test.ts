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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatDDGDuration,
  normalizeDDGVideos,
  searchDDGVideos,
  youtubeThumbFor,
  type DDGVideo,
} from "./ddg-videos";

// Real vqd tokens are digits+hyphens (the @mudbill images package extracts
// them with /vqd=([\d-]+)&/ — the same token format the v.js handshake uses).
const SERP_HTML = `<!DOCTYPE html><html><body>
  <script src="//duckduckgo.com/ac/db.js?vqd=4-32098503961658400691&s=50"></script>
</body></html>`;

const mkVideo = (over: Partial<DDGVideo> = {}): DDGVideo => ({
  url: "https://www.youtube.com/watch?v=ELalc0t9z9I",
  title: "Apollo 11 Moon Landing",
  description: "Original NASA footage of the landing.",
  content: "https://i.ytimg.com/vi/ELalc0t9z9I/hqdefault.jpg",
  duration: "5:32",
  encoder: "youtube",
  publisher: "NASA",
  published: "2011-05-06",
  statistics: { viewCount: 1234567, likeCount: 9876 },
  ...over,
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
  it("maps v.js rows onto the video card's result shape", () => {
    const [r] = normalizeDDGVideos([mkVideo()], 10);
    expect(r).toMatchObject({
      title: "Apollo 11 Moon Landing",
      url: "https://www.youtube.com/watch?v=ELalc0t9z9I",
      videoUrl: "https://www.youtube.com/watch?v=ELalc0t9z9I",
      domain: "youtube.com",
      description: "Original NASA footage of the landing.",
      thumbUrl: "https://i.ytimg.com/vi/ELalc0t9z9I/hqdefault.jpg",
      imageUrl: "https://i.ytimg.com/vi/ELalc0t9z9I/hqdefault.jpg",
      duration: "5:32",
      source: "NASA",
      channelTitle: "NASA",
      viewCount: "1234567",
      likeCount: "9876",
      provider: "ddg",
    });
  });

  it("derives a YouTube thumbnail when content is missing or not a URL", () => {
    const [a] = normalizeDDGVideos([mkVideo({ content: undefined })], 10);
    expect(a.thumbUrl).toBe("https://i.ytimg.com/vi/ELalc0t9z9I/hqdefault.jpg");

    const [b] = normalizeDDGVideos([mkVideo({ content: "data:image/png;base64,AAAA" })], 10);
    expect(b.thumbUrl).toBe("https://i.ytimg.com/vi/ELalc0t9z9I/hqdefault.jpg");
  });

  it("keeps a non-YouTube provider's content URL when it IS http(s)", () => {
    const [r] = normalizeDDGVideos(
      [mkVideo({ url: "https://vimeo.com/12345", content: "https://i.vimeocdn.com/video/t.jpg" })],
      10,
    );
    expect(r.thumbUrl).toBe("https://i.vimeocdn.com/video/t.jpg");
    expect(r.domain).toBe("vimeo.com");
  });

  it("dedupes by video URL, drops rows without an http(s) video URL, caps at limit", () => {
    const rows = [
      mkVideo(),
      mkVideo({ title: "duplicate" }),
      mkVideo({ url: "not-a-url" }),
      mkVideo({ url: "https://www.youtube.com/watch?v=2", content: undefined }),
      mkVideo({ url: "https://www.youtube.com/watch?v=3", content: undefined }),
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
    const rows = [mkVideo(), mkVideo({ url: "https://vimeo.com/777", title: "Vimeo copy" })];
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

  it("throws on a non-OK v.js status", async () => {
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
    await expect(searchDDGVideos("query", 5)).rejects.toThrow(/HTTP 403/);
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
