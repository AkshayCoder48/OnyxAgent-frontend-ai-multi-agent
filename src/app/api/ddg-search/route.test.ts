/**
 * /api/ddg-search tests — the search contract after the Miklium restore.
 *
 * USER DIRECTIVE (2026-10-31): "Keep miklium for websearch and for image keep
 * ddg" + "fix this issue in all searches" — the reported bug rendered as
 *   {"success":false,"output":null,"error":"Image search is temporarily
 *    unavailable. Please try again in a moment."}
 * i.e. ANY {"success":false,...,"error":...} blob reaching the chat.
 *
 * Routing under test:
 *   - web: LangSearch (user's own key, BYOK) → Miklium (restored) → DDG HTML
 *   - image: DuckDuckGo PRIMARY (one full retry) → Miklium images rescue
 *   - video: DuckDuckGo PRIMARY (one full retry) → Miklium videos rescue
 *
 * The Miklium media rescue exists because DDG's anti-bot WAF hard-blocks
 * shared datacenter egress IPs (the 2026-11-01 outage: 100% of image/video
 * probes failed on the Vercel deployment from residential IPs worked fine).
 * No npm package escapes an egress-IP block — the rescue engine does.
 *
 * Contract pinned here:
 *   1. "No results" → HTTP 200, empty list, friendly `note`, no `error`.
 *   2. A backend failing AFTER its retry → STILL HTTP 200 with a friendly
 *      "busy — try again" note. The failure-blob shape is gone for every
 *      search kind.
 *   3. Miklium's 404 {"success":false,"error":"No results found"} answer is
 *      an EMPTY outcome that cascades to DuckDuckGo — never an error, and
 *      never a verbatim leak into the response.
 *   4. Raw provider names / JSON bodies stay server-side (server log only).
 *
 * DDG modules are mocked (vi.mock) so no network is touched; Miklium and
 * LangSearch are reached through a URL-routing stubbed global fetch with
 * schema-accurate fixtures.
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
vi.mock("@/lib/search/miklium-media", () => ({
  searchMikliumImages: vi.fn(),
  searchMikliumVideos: vi.fn(),
}));

import { GET } from "./route";
import { searchDDGImages } from "@/lib/search/ddg-images";
import { searchDDGWeb } from "@/lib/search/ddg-web";
import { searchDDGVideos } from "@/lib/search/ddg-videos";
import { searchMikliumImages, searchMikliumVideos } from "@/lib/search/miklium-media";

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

/** A Miklium image row in the normalized shape miklium-media.ts emits. */
const mikliumImageRow = {
  title: "A sunset over the ocean",
  url: "https://www.seaart.ai/explore/detail/abc",
  domain: "seaart.ai",
  imageUrl: "https://image.cdn2.seaart.ai/sunset-over-ocean.webp",
  thumbnail: "https://image.cdn2.seaart.ai/sunset-over-ocean.webp",
  width: 4096,
  height: 4096,
  source: "seaart.ai",
  provider: "miklium",
};

/** A Miklium video row in the normalized shape miklium-media.ts emits. */
const mikliumVideoRow = {
  title: "Blastoff! SpaceX launches Starlink satellites",
  url: "https://www.youtube.com/watch?v=SIMnxI_DU6s",
  domain: "youtube.com",
  description: "A SpaceX Falcon 9 rocket launched 27 Starlink satellites.",
  imageUrl: "https://up.yimg.com/ib/th?id=OVF.iaFYmFf5&pid=Api&h=360&w=480",
  thumbnail: "https://up.yimg.com/ib/th?id=OVF.iaFYmFf5&pid=Api&h=360&w=480",
  thumbUrl: "https://up.yimg.com/ib/th?id=OVF.iaFYmFf5&pid=Api&h=360&w=480",
  videoUrl: "https://www.youtube.com/watch?v=SIMnxI_DU6s",
  duration: "2:45",
  source: "youtube.com",
  provider: "miklium",
};

/** Miklium web rows: { url, snippet, type, symbols, query } — no title. */
const mikliumWebFixture = {
  success: true,
  results: [
    {
      url: "https://en.wikipedia.org/wiki/Apollo_11",
      snippet: "Apollo 11 was the American spaceflight that first landed humans on the Moon.",
      type: "short",
      symbols: 74,
      query: "apollo 11",
    },
    {
      url: "https://www.nasa.gov/apollo-11",
      snippet: "NASA's Apollo 11 mission landed the first humans on the Moon in July 1969.",
      type: "short",
      symbols: 79,
      query: "apollo 11",
    },
  ],
};

/** The notorious Miklium empty-answer: HTTP 404 + this body used to leak
 *  verbatim as a 502 error blob. */
const mikliumNoResultsFixture = {
  success: false,
  error: "No results found",
};

/**
 * Stub the global fetch with URL-routing handlers. Any URL without a
 * matching handler answers 599 so an unexpected upstream call fails loudly.
 */
function stubUpstream(
  handlers: Array<{ url: string; respond: () => Response }>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? "");
    for (const h of handlers) {
      if (url.includes(h.url)) return h.respond();
    }
    return new Response("unexpected upstream call", { status: 599 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe("web search — Miklium is the engine (restored), DDG the fallback", () => {
  it("serves Miklium web results with provider 'miklium'", async () => {
    vi.mocked(searchDDGWeb).mockResolvedValue([ddgWebRow]);
    const fetchMock = stubUpstream([
      { url: "miklium.vercel.app/api/search", respond: () => jsonResponse(mikliumWebFixture) },
    ]);

    const res = await GET(mkReq({ q: "apollo 11", type: "web", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("miklium");
    expect(data.count).toBe(2);
    // Miklium returns no titles — the domain stands in.
    expect(data.results[0]).toMatchObject({
      title: "en.wikipedia.org",
      url: "https://en.wikipedia.org/wiki/Apollo_11",
      description: "Apollo 11 was the American spaceflight that first landed humans on the Moon.",
      provider: "miklium",
    });
    expect(data.note).toBeUndefined();
    expect(searchDDGWeb).not.toHaveBeenCalled(); // Miklium served — no fallback
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Miklium 404 'No results found' → cascades to DuckDuckGo, never an error", async () => {
    vi.mocked(searchDDGWeb).mockResolvedValue([ddgWebRow]);
    const fetchMock = stubUpstream([
      {
        url: "miklium.vercel.app/api/search",
        respond: () => jsonResponse(mikliumNoResultsFixture, 404),
      },
    ]);

    const res = await GET(mkReq({ q: "obscure query", type: "web", limit: "10" }));
    const data = await res.json();
    const bodyText = JSON.stringify(data);

    expect(res.status).toBe(200);
    expect(data.provider).toBe("ddg");
    expect(data.count).toBe(1);
    expect(searchDDGWeb).toHaveBeenCalledWith("obscure query", 10);
    // The historical leak must not come back — not the provider error
    // string, not the raw upstream JSON, not a failure shape at all.
    expect(data.error).toBeUndefined();
    expect(bodyText).not.toContain("No results found");
    expect(bodyText).not.toContain('"success":false');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Miklium hard failure → DuckDuckGo fallback still serves the query", async () => {
    vi.mocked(searchDDGWeb).mockResolvedValue([ddgWebRow]);
    stubUpstream([
      { url: "miklium.vercel.app/api/search", respond: () => jsonResponse({}, 503) },
    ]);

    const res = await GET(mkReq({ q: "apollo 11", type: "web", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("ddg");
    expect(data.count).toBe(1);
    expect(data.error).toBeUndefined();
  });

  it("Miklium and DuckDuckGo both empty → 200 + friendly note", async () => {
    vi.mocked(searchDDGWeb).mockResolvedValue([]);
    stubUpstream([
      { url: "miklium.vercel.app/api/search", respond: () => jsonResponse(mikliumNoResultsFixture, 404) },
    ]);

    const res = await GET(mkReq({ q: "zzzz no match", type: "web", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.results).toEqual([]);
    expect(data.count).toBe(0);
    expect(data.note).toMatch(/no web results found/i);
    expect(data.error).toBeUndefined();
  });

  it("every web engine hard-fails → STILL 200 + busy note, never an error blob (the reported bug)", async () => {
    vi.mocked(searchDDGWeb).mockRejectedValue(new Error("DuckDuckGo web search is rate-limited right now"));
    stubUpstream([
      { url: "miklium.vercel.app/api/search", respond: () => jsonResponse({}, 500) },
    ]);

    const res = await GET(mkReq({ q: "apollo 11", type: "web", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.results).toEqual([]);
    expect(data.count).toBe(0);
    expect(data.note).toMatch(/busy right now/i);
    expect(data.note).toMatch(/try again in a moment/i);
    expect(data.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("web search — LangSearch (BYOK) stays in front when the user's key is set", () => {
  const langsearchFixture = {
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
  };

  it("prefers LangSearch when the key is supplied and it has results", async () => {
    vi.mocked(searchDDGWeb).mockResolvedValue([ddgWebRow]);
    const fetchMock = stubUpstream([
      { url: "api.langsearch.com/v1/web-search", respond: () => jsonResponse(langsearchFixture) },
    ]);

    const res = await GET(
      mkReq({ q: "apollo 11", type: "web", limit: "10", langsearch_key: "user-key" }),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("langsearch");
    expect(data.count).toBe(1);
    expect(data.results[0]).toMatchObject({ url: "https://www.nasa.gov/apollo-11" });
    expect(searchDDGWeb).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1); // LangSearch only — Miklium untouched
  });

  it("LangSearch fails → Miklium takes over", async () => {
    vi.mocked(searchDDGWeb).mockResolvedValue([ddgWebRow]);
    const fetchMock = stubUpstream([
      { url: "api.langsearch.com/v1/web-search", respond: () => new Response("Unauthorized", { status: 401 }) },
      { url: "miklium.vercel.app/api/search", respond: () => jsonResponse(mikliumWebFixture) },
    ]);

    const res = await GET(
      mkReq({ q: "apollo 11", type: "web", limit: "10", langsearch_key: "bad-key" }),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("miklium");
    expect(data.count).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("LangSearch returns nothing → Miklium takes over", async () => {
    vi.mocked(searchDDGWeb).mockResolvedValue([ddgWebRow]);
    stubUpstream([
      { url: "api.langsearch.com/v1/web-search", respond: () => jsonResponse({ data: { webPages: { value: [] } } }) },
      { url: "miklium.vercel.app/api/search", respond: () => jsonResponse(mikliumWebFixture) },
    ]);

    const res = await GET(
      mkReq({ q: "apollo 11", type: "web", limit: "10", langsearch_key: "user-key" }),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("miklium");
  });
});

// ---------------------------------------------------------------------------

describe("image search — DuckDuckGo primary, Miklium images the rescue", () => {
  it("returns a graceful EMPTY outcome when both engines find nothing", async () => {
    vi.mocked(searchDDGImages).mockResolvedValue([]);
    vi.mocked(searchMikliumImages).mockResolvedValue([]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET(mkReq({ q: "xyzzy impossible query", type: "image", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.results).toEqual([]);
    expect(data.count).toBe(0);
    expect(data.note).toMatch(/no images found/i);
    expect(data.error).toBeUndefined();
    // Miklium was the last engine to ANSWER (DDG found nothing, Miklium
    // found nothing) — the provider field says so honestly.
    expect(data.provider).toBe("miklium");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(searchMikliumImages).toHaveBeenCalledTimes(1);
  });

  it("passes DDG results through untouched with provider 'ddg' — Miklium never contacted", async () => {
    vi.mocked(searchDDGImages).mockResolvedValue([ddgImageRow]);
    vi.mocked(searchMikliumImages).mockResolvedValue([mikliumImageRow]);
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
    expect(data.note).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    // DDG-first directive: when DDG serves, the rescue engine is untouched.
    expect(searchMikliumImages).not.toHaveBeenCalled();
  });

  it("DDG hard-fails (datacenter egress) → Miklium rescues, provider 'miklium'", async () => {
    // THE outage scenario: DDG's WAF blocks the server's egress IP, so
    // every vqd/i.js attempt fails. Miklium answers from those same IPs.
    vi.mocked(searchDDGImages).mockRejectedValue(new Error("Failed to get token"));
    vi.mocked(searchMikliumImages).mockResolvedValue([mikliumImageRow]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET(mkReq({ q: "sunset", type: "image", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("miklium");
    expect(data.count).toBe(1);
    expect(data.results[0]).toMatchObject({
      imageUrl: mikliumImageRow.imageUrl,
      title: "A sunset over the ocean",
      url: "https://www.seaart.ai/explore/detail/abc",
      provider: "miklium",
    });
    expect(data.note).toBeUndefined();
    expect(data.error).toBeUndefined();
    // One full DDG retry happened before the rescue took over.
    expect(searchDDGImages).toHaveBeenCalledTimes(2);
    expect(searchMikliumImages).toHaveBeenCalledTimes(1);
  });

  it("DDG answers empty → Miklium still rescues (different index, more results)", async () => {
    vi.mocked(searchDDGImages).mockResolvedValue([]);
    vi.mocked(searchMikliumImages).mockResolvedValue([mikliumImageRow]);

    const res = await GET(mkReq({ q: "sunset", type: "image", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("miklium");
    expect(data.count).toBe(1);
    expect(data.note).toBeUndefined();
  });

  it("DDG hard-fails AND Miklium answers empty → 'no images found' (honest, not busy)", async () => {
    vi.mocked(searchDDGImages).mockRejectedValue(new Error("Failed to get token"));
    vi.mocked(searchMikliumImages).mockResolvedValue([]);

    const res = await GET(mkReq({ q: "zzzz no match", type: "image", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.results).toEqual([]);
    expect(data.note).toMatch(/no images found/i);
    expect(data.note).not.toMatch(/busy/i);
    expect(data.error).toBeUndefined();
  });

  it("DDG and Miklium BOTH hard-fail → STILL 200 + friendly busy note — NOT the reported error blob", async () => {
    // THE reported bug: this exact scenario used to 502 and the tool layer
    // rendered '{"success":false,"output":null,"error":"Image search is
    // temporarily unavailable. Please try again in a moment."}' in the chat.
    vi.mocked(searchDDGImages).mockRejectedValue(new Error("Failed to get token"));
    vi.mocked(searchMikliumImages).mockRejectedValue(new Error("Miklium images search HTTP 503"));
    vi.stubGlobal("fetch", vi.fn());

    const res = await GET(mkReq({ q: "cat", type: "image", limit: "5" }));
    const data = await res.json();
    const bodyText = JSON.stringify(data);

    expect(res.status).toBe(200);
    expect(data.results).toEqual([]);
    expect(data.count).toBe(0);
    expect(data.note).toMatch(/busy right now/i);
    expect(data.note).toMatch(/try again in a moment/i);
    expect(data.error).toBeUndefined();
    expect(bodyText).not.toContain("temporarily unavailable");
    expect(bodyText).not.toContain('"success":false');
    expect(bodyText).not.toContain("token");
    // One full DDG retry happened before giving up on both engines.
    expect(searchDDGImages).toHaveBeenCalledTimes(2);
    expect(searchMikliumImages).toHaveBeenCalledTimes(1);
  });

  it("a transient first-attempt failure recovers on the retry (no rescue needed)", async () => {
    vi.mocked(searchDDGImages)
      .mockRejectedValueOnce(new Error("Failed to get token"))
      .mockResolvedValueOnce([ddgImageRow]);

    const res = await GET(mkReq({ q: "cat", type: "image", limit: "5" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.count).toBe(1);
    expect(data.provider).toBe("ddg");
    expect(data.note).toBeUndefined();
    expect(searchDDGImages).toHaveBeenCalledTimes(2);
    expect(searchMikliumImages).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("video search — DDG primary, Miklium videos the rescue", () => {
  it("passes normalized v.js rows through with provider 'ddg' — Miklium never contacted", async () => {
    vi.mocked(searchDDGVideos).mockResolvedValue([ddgVideoRow]);
    vi.mocked(searchMikliumVideos).mockResolvedValue([mikliumVideoRow]);
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
    expect(searchMikliumVideos).not.toHaveBeenCalled();
  });

  it("empty video results from both engines → 200 with note", async () => {
    vi.mocked(searchDDGVideos).mockResolvedValue([]);
    vi.mocked(searchMikliumVideos).mockResolvedValue([]);

    const res = await GET(mkReq({ q: "zzzz no match", type: "video", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.results).toEqual([]);
    expect(data.count).toBe(0);
    expect(data.note).toMatch(/no videos found/i);
    expect(data.error).toBeUndefined();
  });

  it("DDG hard-fails (datacenter egress) → Miklium videos rescue the query", async () => {
    vi.mocked(searchDDGVideos).mockRejectedValue(new Error("DuckDuckGo token unavailable"));
    vi.mocked(searchMikliumVideos).mockResolvedValue([mikliumVideoRow]);

    const res = await GET(mkReq({ q: "cat video", type: "video", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("miklium");
    expect(data.count).toBe(1);
    expect(data.results[0]).toMatchObject({
      videoUrl: "https://www.youtube.com/watch?v=SIMnxI_DU6s",
      duration: "2:45",
    });
    expect(data.note).toBeUndefined();
    expect(searchDDGVideos).toHaveBeenCalledTimes(2);
    expect(searchMikliumVideos).toHaveBeenCalledTimes(1);
  });

  it("DDG and Miklium both hard-fail → retried, then 200 + busy note, never an error blob", async () => {
    vi.mocked(searchDDGVideos).mockRejectedValue(new Error("DuckDuckGo token unavailable"));
    vi.mocked(searchMikliumVideos).mockRejectedValue(new Error("Miklium videos search HTTP 500"));

    const res = await GET(mkReq({ q: "cat video", type: "video", limit: "10" }));
    const data = await res.json();
    const bodyText = JSON.stringify(data);

    expect(res.status).toBe(200);
    expect(data.results).toEqual([]);
    expect(data.note).toMatch(/busy right now/i);
    expect(data.note).toMatch(/try again in a moment/i);
    expect(data.error).toBeUndefined();
    expect(bodyText).not.toContain('"success":false');
    expect(bodyText).not.toContain("token");
    expect(searchDDGVideos).toHaveBeenCalledTimes(2);
    expect(searchMikliumVideos).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------

describe("hard guarantees", () => {
  it("when DDG serves images/videos, the Miklium rescue is never contacted (DDG-first directive)", async () => {
    vi.mocked(searchDDGImages).mockResolvedValue([ddgImageRow]);
    vi.mocked(searchDDGVideos).mockResolvedValue([ddgVideoRow]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await GET(mkReq({ q: "anything", type: "image", limit: "5" }));
    await GET(mkReq({ q: "anything", type: "video", limit: "5" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(searchMikliumImages).not.toHaveBeenCalled();
    expect(searchMikliumVideos).not.toHaveBeenCalled();
  });

  it("rejects an empty query with 400", async () => {
    const res = await GET(mkReq({ q: "   ", type: "web", limit: "5" }));
    expect(res.status).toBe(400);
  });
});
