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
 *   - image/video: DuckDuckGo executed INSIDE the acquired E2B sandbox
 *     (primary — user directive 2026-11-01: "make ddg use current acquired
 *     e2b sandbox's ip; if e2b not configured then miklium works"), the
 *     DDG_PROXY_BASE relay direct engine when configured, and Miklium as
 *     the rescue. With neither an E2B key nor a relay, DDG never runs at
 *     all — Miklium serves.
 *   - egress: on the relay leg the caller's public IP is forwarded to the
 *     DDG engines (X-Forwarded-For semantics — the "no datacenter IP
 *     involved" directive), never a private IP, and
 *     DDG_FORWARD_CLIENT_IP=false disables it.
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/lib/search/ddg-e2b", () => ({
  searchDDGImagesViaSandbox: vi.fn(),
  searchDDGVideosViaSandbox: vi.fn(),
}));

import { GET } from "./route";
import { searchDDGImages } from "@/lib/search/ddg-images";
import { searchDDGWeb } from "@/lib/search/ddg-web";
import { searchDDGVideos } from "@/lib/search/ddg-videos";
import { searchMikliumImages, searchMikliumVideos } from "@/lib/search/miklium-media";
import {
  searchDDGImagesViaSandbox,
  searchDDGVideosViaSandbox,
} from "@/lib/search/ddg-e2b";

type RouteRequest = Parameters<typeof GET>[0];

function mkReq(params: Record<string, string>, headers: Record<string, string> = {}): RouteRequest {
  const url = new URL("http://localhost/api/ddg-search");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { nextUrl: url, headers: new Headers(headers) } as unknown as RouteRequest;
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
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

// The E2B sandbox / relay / self-origin knobs select the DDG egress leg —
// keep them unset by default so every test pins the leg it means to.
beforeEach(() => {
  delete process.env.E2B_API_KEY;
  delete process.env.DDG_PROXY_BASE;
  delete process.env.APP_URL;
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

describe("image search — DDG inside the acquired E2B sandbox (primary), Miklium the rescue", () => {
  it("sandbox DDG serves → results pass through with provider 'ddg'; direct engine + Miklium untouched", async () => {
    vi.mocked(searchDDGImagesViaSandbox).mockResolvedValue([ddgImageRow]);
    vi.mocked(searchMikliumImages).mockResolvedValue([mikliumImageRow]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET(mkReq({ q: "cat", type: "image", limit: "10", e2b_api_key: "e2b-key-1" }));
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
    // The handshake ran INSIDE the sandbox — on the request's origin, with
    // the caller's BYOK key.
    expect(searchDDGImagesViaSandbox).toHaveBeenCalledWith("cat", 10, {
      origin: "http://localhost",
      apiKey: "e2b-key-1",
    });
    // Sandbox-first directive: the direct (datacenter-egress) engine and the
    // rescue engine are both untouched when the sandbox serves.
    expect(searchDDGImages).not.toHaveBeenCalled();
    expect(searchMikliumImages).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the server's E2B_API_KEY enables the sandbox leg without a BYOK param", async () => {
    vi.stubEnv("E2B_API_KEY", "server-e2b-key");
    vi.mocked(searchDDGImagesViaSandbox).mockResolvedValue([ddgImageRow]);

    const res = await GET(mkReq({ q: "cat", type: "image", limit: "10" }));
    const data = await res.json();

    expect(data.provider).toBe("ddg");
    expect(searchDDGImagesViaSandbox).toHaveBeenCalledWith("cat", 10, {
      origin: "http://localhost",
      apiKey: "server-e2b-key",
    });
    expect(searchDDGImages).not.toHaveBeenCalled();
  });

  it("no E2B key and no relay → DDG NEVER runs (not even direct), Miklium serves — the user directive", async () => {
    vi.mocked(searchMikliumImages).mockResolvedValue([mikliumImageRow]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET(mkReq({ q: "cat", type: "image", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("miklium");
    expect(data.count).toBe(1);
    expect(data.results[0]).toMatchObject({ provider: "miklium" });
    // "if e2b not configured then miklium works" — no DDG attempt at all.
    expect(searchDDGImagesViaSandbox).not.toHaveBeenCalled();
    expect(searchDDGImages).not.toHaveBeenCalled();
    expect(searchMikliumImages).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DDG_PROXY_BASE configured (no E2B) → the direct engine serves through the relay", async () => {
    vi.stubEnv("DDG_PROXY_BASE", "https://relay.example.com/ddg");
    vi.mocked(searchDDGImages).mockResolvedValue([ddgImageRow]);
    vi.mocked(searchMikliumImages).mockResolvedValue([mikliumImageRow]);

    const res = await GET(mkReq({ q: "cat", type: "image", limit: "10" }));
    const data = await res.json();

    expect(data.provider).toBe("ddg");
    expect(searchDDGImages).toHaveBeenCalledWith("cat", 10, { clientIp: undefined });
    expect(searchDDGImagesViaSandbox).not.toHaveBeenCalled();
    expect(searchMikliumImages).not.toHaveBeenCalled();
  });

  it("sandbox DDG hard-fails → Miklium rescues, provider 'miklium'", async () => {
    // The outage shape when the sandbox itself is unreachable (quota, cold
    // boot failure) — Miklium keeps image search alive.
    vi.mocked(searchDDGImagesViaSandbox).mockRejectedValue(new Error("E2B sandbox call HTTP 401"));
    vi.mocked(searchMikliumImages).mockResolvedValue([mikliumImageRow]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET(mkReq({ q: "sunset", type: "image", limit: "10", e2b_api_key: "k" }));
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
    // One full sandbox retry happened before the rescue took over.
    expect(searchDDGImagesViaSandbox).toHaveBeenCalledTimes(2);
    expect(searchMikliumImages).toHaveBeenCalledTimes(1);
  });

  it("sandbox DDG answers empty → Miklium still rescues (different index, more results)", async () => {
    vi.mocked(searchDDGImagesViaSandbox).mockResolvedValue([]);
    vi.mocked(searchMikliumImages).mockResolvedValue([mikliumImageRow]);

    const res = await GET(mkReq({ q: "sunset", type: "image", limit: "10", e2b_api_key: "k" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("miklium");
    expect(data.count).toBe(1);
    expect(data.note).toBeUndefined();
  });

  it("sandbox DDG hard-fails AND Miklium answers empty → 'no images found' (honest, not busy)", async () => {
    vi.mocked(searchDDGImagesViaSandbox).mockRejectedValue(new Error("DDG-in-sandbox failed: token"));
    vi.mocked(searchMikliumImages).mockResolvedValue([]);

    const res = await GET(mkReq({ q: "zzzz no match", type: "image", limit: "10", e2b_api_key: "k" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.results).toEqual([]);
    expect(data.note).toMatch(/no images found/i);
    expect(data.note).not.toMatch(/busy/i);
    expect(data.error).toBeUndefined();
  });

  it("sandbox DDG and Miklium BOTH hard-fail → STILL 200 + friendly busy note — NOT the reported error blob", async () => {
    // THE reported bug: this exact scenario used to 502 and the tool layer
    // rendered '{"success":false,"output":null,"error":"Image search is
    // temporarily unavailable. Please try again in a moment."}' in the chat.
    vi.mocked(searchDDGImagesViaSandbox).mockRejectedValue(new Error("DDG-in-sandbox failed: blocked"));
    vi.mocked(searchMikliumImages).mockRejectedValue(new Error("Miklium images search HTTP 503"));
    vi.stubGlobal("fetch", vi.fn());

    const res = await GET(mkReq({ q: "cat", type: "image", limit: "5", e2b_api_key: "k" }));
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
    expect(bodyText).not.toContain("blocked");
    // One full sandbox retry happened before giving up on both engines.
    expect(searchDDGImagesViaSandbox).toHaveBeenCalledTimes(2);
    expect(searchMikliumImages).toHaveBeenCalledTimes(1);
  });

  it("a transient first-attempt sandbox failure recovers on the retry (no rescue needed)", async () => {
    vi.mocked(searchDDGImagesViaSandbox)
      .mockRejectedValueOnce(new Error("E2B sandbox call HTTP 502"))
      .mockResolvedValueOnce([ddgImageRow]);

    const res = await GET(mkReq({ q: "cat", type: "image", limit: "5", e2b_api_key: "k" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.count).toBe(1);
    expect(data.provider).toBe("ddg");
    expect(data.note).toBeUndefined();
    expect(searchDDGImagesViaSandbox).toHaveBeenCalledTimes(2);
    expect(searchMikliumImages).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("video search — DDG inside the acquired E2B sandbox, Miklium videos the rescue", () => {
  it("sandbox DDG serves v.js rows → provider 'ddg' — direct engine + Miklium never contacted", async () => {
    vi.mocked(searchDDGVideosViaSandbox).mockResolvedValue([ddgVideoRow]);
    vi.mocked(searchMikliumVideos).mockResolvedValue([mikliumVideoRow]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET(
      mkReq({ q: "apollo landing footage", type: "video", limit: "10", e2b_api_key: "e2b-key-1" }),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("ddg");
    expect(data.count).toBe(1);
    expect(data.results[0]).toMatchObject({
      videoUrl: "https://www.youtube.com/watch?v=ELalc0t9z9I",
      duration: "5:32",
      channelTitle: "NASA",
    });
    expect(searchDDGVideosViaSandbox).toHaveBeenCalledWith("apollo landing footage", 10, {
      origin: "http://localhost",
      apiKey: "e2b-key-1",
    });
    expect(searchDDGVideos).not.toHaveBeenCalled();
    expect(searchMikliumVideos).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no E2B key and no relay → DDG never runs; Miklium serves videos (the user directive)", async () => {
    vi.mocked(searchMikliumVideos).mockResolvedValue([mikliumVideoRow]);

    const res = await GET(mkReq({ q: "cat video", type: "video", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("miklium");
    expect(data.count).toBe(1);
    expect(searchDDGVideosViaSandbox).not.toHaveBeenCalled();
    expect(searchDDGVideos).not.toHaveBeenCalled();
  });

  it("sandbox DDG empty + Miklium empty → 200 with the friendly no-results note", async () => {
    vi.mocked(searchDDGVideosViaSandbox).mockResolvedValue([]);
    vi.mocked(searchMikliumVideos).mockResolvedValue([]);

    const res = await GET(mkReq({ q: "zzzz no match", type: "video", limit: "10", e2b_api_key: "k" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.results).toEqual([]);
    expect(data.count).toBe(0);
    expect(data.note).toMatch(/no videos found/i);
    expect(data.error).toBeUndefined();
  });

  it("sandbox DDG hard-fails → Miklium videos rescue the query", async () => {
    vi.mocked(searchDDGVideosViaSandbox).mockRejectedValue(new Error("DDG-in-sandbox failed: token"));
    vi.mocked(searchMikliumVideos).mockResolvedValue([mikliumVideoRow]);

    const res = await GET(mkReq({ q: "cat video", type: "video", limit: "10", e2b_api_key: "k" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("miklium");
    expect(data.count).toBe(1);
    expect(data.results[0]).toMatchObject({
      videoUrl: "https://www.youtube.com/watch?v=SIMnxI_DU6s",
      duration: "2:45",
    });
    expect(data.note).toBeUndefined();
    expect(searchDDGVideosViaSandbox).toHaveBeenCalledTimes(2);
    expect(searchMikliumVideos).toHaveBeenCalledTimes(1);
  });

  it("sandbox DDG and Miklium both hard-fail → retried, then 200 + busy note, never an error blob", async () => {
    vi.mocked(searchDDGVideosViaSandbox).mockRejectedValue(new Error("E2B sandbox call HTTP 502"));
    vi.mocked(searchMikliumVideos).mockRejectedValue(new Error("Miklium videos search HTTP 500"));

    const res = await GET(mkReq({ q: "cat video", type: "video", limit: "10", e2b_api_key: "k" }));
    const data = await res.json();
    const bodyText = JSON.stringify(data);

    expect(res.status).toBe(200);
    expect(data.results).toEqual([]);
    expect(data.note).toMatch(/busy right now/i);
    expect(data.note).toMatch(/try again in a moment/i);
    expect(data.error).toBeUndefined();
    expect(bodyText).not.toContain('"success":false');
    expect(bodyText).not.toContain("token");
    expect(searchDDGVideosViaSandbox).toHaveBeenCalledTimes(2);
    expect(searchMikliumVideos).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------

describe("hard guarantees", () => {
  it("when sandbox DDG serves images/videos, the Miklium rescue is never contacted (DDG-first directive)", async () => {
    vi.mocked(searchDDGImagesViaSandbox).mockResolvedValue([ddgImageRow]);
    vi.mocked(searchDDGVideosViaSandbox).mockResolvedValue([ddgVideoRow]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await GET(mkReq({ q: "anything", type: "image", limit: "5", e2b_api_key: "k" }));
    await GET(mkReq({ q: "anything", type: "video", limit: "5", e2b_api_key: "k" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(searchDDGImages).not.toHaveBeenCalled();
    expect(searchDDGVideos).not.toHaveBeenCalled();
    expect(searchMikliumImages).not.toHaveBeenCalled();
    expect(searchMikliumVideos).not.toHaveBeenCalled();
  });

  it("rejects an empty query with 400", async () => {
    const res = await GET(mkReq({ q: "   ", type: "web", limit: "5" }));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe("egress — on the relay leg, the caller's public IP is forwarded to the DDG engines", () => {
  // These assertions target the DIRECT engine (the DDG_PROXY_BASE relay
  // leg) — with the E2B sandbox as the primary egress, the direct engine
  // only runs when the relay is configured.
  const RELAY = "https://relay.example.com/ddg";

  it("forwards the FIRST entry of the XFF chain to the image and video engines", async () => {
    vi.stubEnv("DDG_PROXY_BASE", RELAY);
    vi.mocked(searchDDGImages).mockResolvedValue([ddgImageRow]);
    vi.mocked(searchDDGVideos).mockResolvedValue([ddgVideoRow]);

    const headers = { "x-forwarded-for": "203.0.113.7, 10.0.0.1, 192.168.0.5" };
    await GET(mkReq({ q: "cats", type: "image", limit: "10" }, headers));
    await GET(mkReq({ q: "cats", type: "video", limit: "10" }, headers));

    expect(searchDDGImages).toHaveBeenCalledWith("cats", 10, { clientIp: "203.0.113.7" });
    expect(searchDDGVideos).toHaveBeenCalledWith("cats", 10, { clientIp: "203.0.113.7" });
  });

  it("prefers x-vercel-forwarded-for over x-forwarded-for and x-real-ip", async () => {
    vi.stubEnv("DDG_PROXY_BASE", RELAY);
    vi.mocked(searchDDGImages).mockResolvedValue([ddgImageRow]);

    await GET(
      mkReq(
        { q: "cats", type: "image", limit: "10" },
        {
          "x-vercel-forwarded-for": "198.51.100.3",
          "x-forwarded-for": "203.0.113.7, 172.18.0.9",
          "x-real-ip": "192.168.0.1",
        },
      ),
    );

    expect(searchDDGImages).toHaveBeenCalledWith("cats", 10, { clientIp: "198.51.100.3" });
  });

  it("NEVER forwards a private/loopback caller IP (local dev stays silent)", async () => {
    vi.stubEnv("DDG_PROXY_BASE", RELAY);
    vi.mocked(searchDDGImages).mockResolvedValue([ddgImageRow]);

    await GET(
      mkReq({ q: "cats", type: "image", limit: "10" }, { "x-forwarded-for": "192.168.1.5, 203.0.113.7" }),
    );
    await GET(mkReq({ q: "cats", type: "image", limit: "10" }, { "x-real-ip": "127.0.0.1" }));

    expect(searchDDGImages).toHaveBeenNthCalledWith(1, "cats", 10, { clientIp: undefined });
    expect(searchDDGImages).toHaveBeenNthCalledWith(2, "cats", 10, { clientIp: undefined });
  });

  it("forwards a bare IPv6 caller from the XFF chain", async () => {
    vi.stubEnv("DDG_PROXY_BASE", RELAY);
    vi.mocked(searchDDGVideos).mockResolvedValue([ddgVideoRow]);

    await GET(
      mkReq({ q: "cats", type: "video", limit: "10" }, { "x-forwarded-for": "2607:f8b0:4004:800::1, 10.0.0.9" }),
    );

    expect(searchDDGVideos).toHaveBeenCalledWith("cats", 10, {
      clientIp: "2607:f8b0:4004:800::1",
    });
  });

  it("DDG_FORWARD_CLIENT_IP=false disables forwarding entirely (privacy kill-switch)", async () => {
    vi.stubEnv("DDG_PROXY_BASE", RELAY);
    vi.stubEnv("DDG_FORWARD_CLIENT_IP", "false");
    vi.mocked(searchDDGImages).mockResolvedValue([ddgImageRow]);

    await GET(
      mkReq({ q: "cats", type: "image", limit: "10" }, { "x-forwarded-for": "203.0.113.7" }),
    );

    expect(searchDDGImages).toHaveBeenCalledWith("cats", 10, { clientIp: undefined });
  });

  it("requests without proxy headers (or without a Headers object) forward nothing", async () => {
    vi.stubEnv("DDG_PROXY_BASE", RELAY);
    vi.mocked(searchDDGImages).mockResolvedValue([ddgImageRow]);

    await GET(mkReq({ q: "cats", type: "image", limit: "10" }));

    expect(searchDDGImages).toHaveBeenCalledWith("cats", 10, { clientIp: undefined });
  });
});
