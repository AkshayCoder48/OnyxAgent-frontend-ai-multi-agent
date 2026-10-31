/**
 * /api/ddg-search regression tests — the "Miklium HTTP 404" leak.
 *
 * Operator-reported bug: when DuckDuckGo (primary image backend) failed and
 * the Miklium fallback answered
 *   404 {"success":false,"error":"No results found"}
 * the route bubbled that up verbatim as a 502, and the chat tool-result
 * card rendered the raw blob:
 *   {"success":false,"output":null,"error":"Miklium HTTP 404: …"}
 *
 * "No results" is a legitimate empty outcome, not a backend failure. These
 * tests pin the contract:
 *   1. Miklium 404 / success:false "No results found" → HTTP 200, empty
 *      results, a friendly `note`, no `error`, no provider-name/raw-JSON leak.
 *   2. Real backend failures (5xx) → 502 with a sanitized, user-facing
 *      message — raw provider details stay in the server log only.
 *   3. DDG success still passes through untouched.
 *
 * The DDG module is mocked (vi.mock) so no network is touched; Miklium is
 * reached through a stubbed global fetch with schema-accurate fixtures.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/search/ddg-images", () => ({
  searchDDGImages: vi.fn(),
}));

import { GET } from "./route";
import { searchDDGImages } from "@/lib/search/ddg-images";

type RouteRequest = Parameters<typeof GET>[0];

function mkReq(params: Record<string, string>): RouteRequest {
  const url = new URL("http://localhost/api/ddg-search");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { nextUrl: url } as unknown as RouteRequest;
}

/** Miklium fixtures — the exact wire shapes the backend emits. */
const mikliumNoResults404 = () =>
  new Response(JSON.stringify({ success: false, error: "No results found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });

const mikliumNoResults200 = () =>
  new Response(JSON.stringify({ success: false, error: "No results found" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const mikliumSuccess = (results: unknown[]) =>
  new Response(JSON.stringify({ success: true, results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** The exact image rows the old Miklium-only backend normalized. */
const mikliumImageRow = {
  imageUrl: "https://example.com/cat.jpg",
  title: "A cat",
  referenceUrl: "https://example.com/cat-page",
  size: { width: 640, height: 480 },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("image search — DDG down, Miklium fallback", () => {
  it("returns a graceful EMPTY outcome when Miklium answers 404 'No results found' (the reported bug)", async () => {
    vi.mocked(searchDDGImages).mockRejectedValue(new Error("Failed to get token"));
    vi.stubGlobal("fetch", vi.fn(async () => mikliumNoResults404()));

    const res = await GET(mkReq({ q: "xyzzy impossible query", type: "image", limit: "10" }));
    const data = await res.json();
    const bodyText = JSON.stringify(data);

    // "No results" is a success with an empty list, not an error.
    expect(res.status).toBe(200);
    expect(data.results).toEqual([]);
    expect(data.count).toBe(0);
    expect(data.note).toBeTruthy();
    expect(data.error).toBeUndefined();

    // The leak must never come back: no provider name in an error, no raw
    // upstream JSON body, no "Miklium HTTP 404" string anywhere.
    expect(bodyText).not.toContain("Miklium HTTP");
    expect(bodyText).not.toContain('"success":false');
    expect(data.note).toMatch(/no images found/i);
  });

  it("treats success:false 'No results found' on HTTP 200 the same way", async () => {
    vi.mocked(searchDDGImages).mockRejectedValue(new Error("timed out"));
    vi.stubGlobal("fetch", vi.fn(async () => mikliumNoResults200()));

    const res = await GET(mkReq({ q: "nothing matches", type: "image", limit: "5" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.results).toEqual([]);
    expect(data.count).toBe(0);
    expect(data.error).toBeUndefined();
    expect(data.note).toMatch(/no images found/i);
  });

  it("also normalizes {success:true, results:[]} into the friendly note", async () => {
    vi.mocked(searchDDGImages).mockRejectedValue(new Error("vqd failure"));
    vi.stubGlobal("fetch", vi.fn(async () => mikliumSuccess([])));

    const res = await GET(mkReq({ q: "empty upstream", type: "image", limit: "5" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.count).toBe(0);
    expect(data.note).toMatch(/no images found/i);
  });

  it("still serves Miklium image rows when the fallback has results", async () => {
    vi.mocked(searchDDGImages).mockRejectedValue(new Error("Failed to get token"));
    vi.stubGlobal("fetch", vi.fn(async () => mikliumSuccess([mikliumImageRow])));

    const res = await GET(mkReq({ q: "cat", type: "image", limit: "5" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("miklium");
    expect(data.count).toBe(1);
    expect(data.results[0]).toMatchObject({
      imageUrl: "https://example.com/cat.jpg",
      title: "A cat",
      provider: "miklium",
    });
    expect(data.note).toBeUndefined(); // note only when empty
  });

  it("sanitizes REAL backend failures — no provider name, no raw body", async () => {
    vi.mocked(searchDDGImages).mockRejectedValue(new Error("Failed to get token"));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>Internal Server Error</html>", {
            status: 500,
            headers: { "Content-Type": "text/html" },
          }),
      ),
    );

    const res = await GET(mkReq({ q: "cat", type: "image", limit: "5" }));
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.error).toMatch(/image search is temporarily unavailable/i);
    expect(data.error).not.toContain("Miklium");
    expect(data.error).not.toContain("miklium");
    expect(data.error).not.toContain("<html>");
  });
});

describe("image search — DDG healthy", () => {
  it("passes DDG results through untouched with provider 'ddg'", async () => {
    vi.mocked(searchDDGImages).mockResolvedValue([
      {
        title: "DDG hit",
        url: "https://example.com/a",
        domain: "example.com",
        imageUrl: "https://external-content.duckduckgo.com/iu/?u=https%3A%2F%2Fexample.com%2Fa.jpg",
        thumbnail: "https://external-content.duckduckgo.com/iu/?u=https%3A%2F%2Fexample.com%2Fa.jpg&f=1",
        width: 800,
        height: 600,
        source: "example.com",
        provider: "ddg" as const,
      },
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET(mkReq({ q: "dog", type: "image", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("ddg");
    expect(data.count).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled(); // Miklium never touched
  });

  it("falls back to Miklium when DDG yields an empty array", async () => {
    vi.mocked(searchDDGImages).mockResolvedValue([]);
    vi.stubGlobal("fetch", vi.fn(async () => mikliumSuccess([mikliumImageRow])));

    const res = await GET(mkReq({ q: "cat", type: "image", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("miklium");
    expect(data.count).toBe(1);
  });
});

describe("web and video search — Miklium no-results normalization", () => {
  it("web: 404 'No results found' → 200 with empty results and a note", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mikliumNoResults404()));

    const res = await GET(mkReq({ q: "zzzz no match", type: "web", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.results).toEqual([]);
    expect(data.count).toBe(0);
    expect(data.note).toMatch(/no web results found/i);
    expect(data.error).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("Miklium HTTP");
  });

  it("video: 404 'No results found' → 200 with empty results and a note", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mikliumNoResults404()));

    const res = await GET(mkReq({ q: "zzzz no match", type: "video", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.results).toEqual([]);
    expect(data.count).toBe(0);
    expect(data.note).toMatch(/no videos found/i);
    expect(data.error).toBeUndefined();
  });

  it("video: real 500 failure → sanitized 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Bad Gateway", { status: 502 })),
    );

    const res = await GET(mkReq({ q: "cat video", type: "video", limit: "10" }));
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.error).toMatch(/video search is temporarily unavailable/i);
    expect(data.error).not.toContain("Miklium");
  });
});
