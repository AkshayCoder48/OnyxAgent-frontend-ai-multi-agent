/**
 * /api/ddg-search tests — the DuckDuckGo-only search contract.
 *
 * History: the route once had a third-party "Miklium" fallback whose 404
 * {"success":false,"error":"No results found"} answer leaked into the chat
 * verbatim as a 502 error blob. Miklium is now REMOVED entirely — web,
 * image, and video search are all DuckDuckGo (web: LangSearch first when
 * the user's own key is supplied, else DDG HTML search).
 *
 * These tests pin the contract:
 *   1. Empty results ("nothing matched") → HTTP 200, empty list, a friendly
 *      `note`, no `error`, no provider-name/raw-JSON leak.
 *   2. Real backend failures (throws, rate-limit blocks) → 502 with a
 *      sanitized, user-facing message — raw provider details stay server-side.
 *   3. No request may EVER go to the old third-party search host.
 *
 * All DDG modules are mocked (vi.mock) so no network is touched; LangSearch
 * is reached through a stubbed global fetch with schema-accurate fixtures.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/search/ddg-images", () => ({
  searchDDGImages: vi.fn(),
}));
vi.mock("@/lib/search/ddg-web", () => ({
  searchDDGWeb: vi.fn(),
}));
vi.mock("@/lib/search/ddg-videos", () => ({
  searchDDGVideos: vi.fn(),
}));

import { GET } from "./route";
import { searchDDGImages } from "@/lib/search/ddg-images";
import { searchDDGWeb } from "@/lib/search/ddg-web";
import { searchDDGVideos } from "@/lib/search/ddg-videos";

type RouteRequest = Parameters<typeof GET>[0];

function mkReq(params: Record<string, string>): RouteRequest {
  const url = new URL("http://localhost/api/ddg-search");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { nextUrl: url } as unknown as RouteRequest;
}

/** A DDG image row in the normalized shape ddg-images.ts emits. */
const ddgImageRow = {
  title: "A cat",
  url: "https://example.com/cat-page",
  domain: "example.com",
  imageUrl: "https://external-content.duckduckgo.com/iu/?u=https%3A%2F%2Fexample.com%2Fcat.jpg",
  thumbnail: "https://external-content.duckduckgo.com/iu/?u=https%3A%2F%2Fexample.com%2Fcat.jpg&f=1",
  width: 800,
  height: 600,
  source: "example.com",
  provider: "ddg",
};

/** A DDG web row in the normalized shape ddg-web.ts emits. */
const ddgWebRow = {
  title: "Apollo 11 - Wikipedia",
  url: "https://en.wikipedia.org/wiki/Apollo_11",
  domain: "en.wikipedia.org",
  description: "Apollo 11 was the American spaceflight that first landed humans on the Moon.",
  icon: "https://external-content.duckduckgo.com/ip3/en.wikipedia.org.ico",
  source: "en.wikipedia.org",
  provider: "ddg",
};

/** A DDG video row in the normalized shape ddg-videos.ts emits. */
const ddgVideoRow = {
  title: "Apollo 11 landing",
  url: "https://www.youtube.com/watch?v=ELalc0t9z9I",
  domain: "youtube.com",
  description: "Original footage",
  imageUrl: "https://i.ytimg.com/vi/ELalc0t9z9I/hqdefault.jpg",
  thumbnail: "https://i.ytimg.com/vi/ELalc0t9z9I/hqdefault.jpg",
  thumbUrl: "https://i.ytimg.com/vi/ELalc0t9z9I/hqdefault.jpg",
  videoUrl: "https://www.youtube.com/watch?v=ELalc0t9z9I",
  duration: "5:32",
  source: "NASA",
  channelTitle: "NASA",
  viewCount: "1234567",
  provider: "ddg",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe("image search — DuckDuckGo only", () => {
  it("returns a graceful EMPTY outcome when DDG finds nothing (the reported bug)", async () => {
    vi.mocked(searchDDGImages).mockResolvedValue([]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET(mkReq({ q: "xyzzy impossible query", type: "image", limit: "10" }));
    const data = await res.json();
    const bodyText = JSON.stringify(data);

    // "No results" is a success with an empty list, not an error.
    expect(res.status).toBe(200);
    expect(data.results).toEqual([]);
    expect(data.count).toBe(0);
    expect(data.note).toBeTruthy();
    expect(data.error).toBeUndefined();
    expect(data.provider).toBe("ddg");

    // The leak must never come back: no provider name in an error, no raw
    // upstream JSON body, no third-party host ever contacted.
    expect(bodyText).not.toContain("Miklium");
    expect(bodyText).not.toContain('"success":false');
    expect(data.note).toMatch(/no images found/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes DDG results through untouched with provider 'ddg'", async () => {
    vi.mocked(searchDDGImages).mockResolvedValue([ddgImageRow]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET(mkReq({ q: "cat", type: "image", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("ddg");
    expect(data.count).toBe(1);
    expect(data.results[0]).toMatchObject({
      imageUrl: ddgImageRow.imageUrl,
      title: "A cat",
      provider: "ddg",
    });
    expect(data.note).toBeUndefined(); // note only when empty
    expect(fetchMock).not.toHaveBeenCalled(); // no third-party host touched
  });

  it("sanitizes REAL DDG failures — no provider name, no raw body, 502", async () => {
    vi.mocked(searchDDGImages).mockRejectedValue(new Error("Failed to get token"));
    vi.stubGlobal("fetch", vi.fn());

    const res = await GET(mkReq({ q: "cat", type: "image", limit: "5" }));
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.error).toMatch(/image search is temporarily unavailable/i);
    expect(data.error).not.toContain("Miklium");
    expect(data.error).not.toContain("miklium");
    expect(data.error).not.toContain("token");
  });
});

// ---------------------------------------------------------------------------

describe("web search — LangSearch (BYOK) with DuckDuckGo fallback", () => {
  it("uses DuckDuckGo when no LangSearch key is supplied", async () => {
    vi.mocked(searchDDGWeb).mockResolvedValue([ddgWebRow]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET(mkReq({ q: "apollo 11", type: "web", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("ddg");
    expect(data.count).toBe(1);
    expect(searchDDGWeb).toHaveBeenCalledWith("apollo 11", 10);
    expect(fetchMock).not.toHaveBeenCalled(); // LangSearch never contacted
  });

  it("prefers LangSearch when the user's key is supplied and it has results", async () => {
    vi.mocked(searchDDGWeb).mockResolvedValue([ddgWebRow]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                webPages: {
                  value: [
                    {
                      name: "Apollo 11 | NASA",
                      url: "https://www.nasa.gov/apollo-11",
                      summary: "Apollo 11 landed the first humans on the Moon.",
                    },
                  ],
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    const res = await GET(
      mkReq({ q: "apollo 11", type: "web", limit: "10", langsearch_key: "user-key" }),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("langsearch");
    expect(data.count).toBe(1);
    expect(data.results[0]).toMatchObject({ url: "https://www.nasa.gov/apollo-11" });
    expect(searchDDGWeb).not.toHaveBeenCalled();
  });

  it("falls back to DuckDuckGo when LangSearch fails", async () => {
    vi.mocked(searchDDGWeb).mockResolvedValue([ddgWebRow]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    );

    const res = await GET(
      mkReq({ q: "apollo 11", type: "web", limit: "10", langsearch_key: "bad-key" }),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("ddg");
    expect(searchDDGWeb).toHaveBeenCalledWith("apollo 11", 10);
  });

  it("falls back to DuckDuckGo when LangSearch returns nothing", async () => {
    vi.mocked(searchDDGWeb).mockResolvedValue([ddgWebRow]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { webPages: { value: [] } } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const res = await GET(
      mkReq({ q: "apollo 11", type: "web", limit: "10", langsearch_key: "user-key" }),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("ddg");
  });

  it("empty DDG web results → 200 with note, never an error", async () => {
    vi.mocked(searchDDGWeb).mockResolvedValue([]);

    const res = await GET(mkReq({ q: "zzzz no match", type: "web", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.results).toEqual([]);
    expect(data.count).toBe(0);
    expect(data.note).toMatch(/no web results found/i);
    expect(data.error).toBeUndefined();
  });

  it("DDG web failure (rate-limited) → sanitized 502, no provider name", async () => {
    vi.mocked(searchDDGWeb).mockRejectedValue(
      new Error("DuckDuckGo web search is rate-limited right now"),
    );

    const res = await GET(mkReq({ q: "apollo", type: "web", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.error).toMatch(/web search is temporarily unavailable/i);
    expect(data.error).not.toContain("DuckDuckGo");
    expect(data.error).not.toContain("rate");
  });
});

// ---------------------------------------------------------------------------

describe("video search — DuckDuckGo only", () => {
  it("passes normalized v.js rows through with provider 'ddg'", async () => {
    vi.mocked(searchDDGVideos).mockResolvedValue([ddgVideoRow]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET(mkReq({ q: "apollo landing footage", type: "video", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("ddg");
    expect(data.count).toBe(1);
    expect(data.results[0]).toMatchObject({
      videoUrl: "https://www.youtube.com/watch?v=ELalc0t9z9I",
      duration: "5:32",
      channelTitle: "NASA",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("empty video results → 200 with note", async () => {
    vi.mocked(searchDDGVideos).mockResolvedValue([]);

    const res = await GET(mkReq({ q: "zzzz no match", type: "video", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.results).toEqual([]);
    expect(data.count).toBe(0);
    expect(data.note).toMatch(/no videos found/i);
    expect(data.error).toBeUndefined();
  });

  it("video backend failure → sanitized 502, no provider name", async () => {
    vi.mocked(searchDDGVideos).mockRejectedValue(new Error("DuckDuckGo token unavailable"));

    const res = await GET(mkReq({ q: "cat video", type: "video", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.error).toMatch(/video search is temporarily unavailable/i);
    expect(data.error).not.toContain("DuckDuckGo");
    expect(data.error).not.toContain("token");
  });
});

// ---------------------------------------------------------------------------

describe("hard guarantee — the removed third-party search host is never contacted", () => {
  it("no fetch call ever targets the old search service, on any type", async () => {
    vi.mocked(searchDDGImages).mockResolvedValue([]);
    vi.mocked(searchDDGWeb).mockResolvedValue([]);
    vi.mocked(searchDDGVideos).mockResolvedValue([]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const type of ["web", "image", "video"]) {
      await GET(mkReq({ q: "anything", type, limit: "5" }));
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty query with 400", async () => {
    const res = await GET(mkReq({ q: "   ", type: "web", limit: "5" }));
    expect(res.status).toBe(400);
  });
});
