/**
 * DuckDuckGo image search tests — the `image_search` tool's backend
 * (the only image provider, DDG per user directive).
 *
 * The network is fully mocked: the in-house client's real flow is
 *   1. GET duckduckgo.com/?q=<query>       → HTML containing the vqd token
 *   2. GET duckduckgo.com/i.js?…&vqd=…&s=0 → { results: DDGImage[], next }
 *   3. (bulk) repeat i.js at the `next` cursor until `limit` rows
 * Both responses are stubbed with schema-accurate fixtures, so these tests
 * prove the code path deterministically without touching the network (the
 * sandbox/CI may block duckduckgo.com egress — and DDG's anti-bot makes
 * live e2e flaky by design).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeDDGImages, searchDDGImages, type DDGImage } from "./ddg-images";
import { clearVqdCache } from "./ddg-vqd";

// Real vqd tokens are digits+hyphens. The bare query-string form:
const SERP_HTML = `<!DOCTYPE html><html><body>
  <script src="//duckduckgo.com/ac/db.js?vqd=4-32098503961658400691&s=50"></script>
</body></html>`;

const SERP_HTML_BLOCKED = `<!DOCTYPE html><html><body>
  <script src="//duckduckgo.com/ac/db.js?vqd=4-99999999999999999999&s=50"></script>
</body></html>`;

const CHALLENGE_BODY = JSON.stringify({
  challenge: { cc: "sre", gk: "d4cd0dabcf4caa22ad92fab40844c786", i: "3" },
});

const mkImage = (over: Partial<DDGImage> = {}): DDGImage => ({
  height: 600,
  width: 800,
  image: "https://external-content.duckduckgo.com/iu/?u=https%3A%2F%2Fexample.com%2Fa.jpg",
  source: "example.com",
  thumbnail:
    "https://external-content.duckduckgo.com/iu/?u=https%3A%2F%2Fexample.com%2Fa.jpg&f=1",
  title: "An example image",
  url: "https://example.com/a",
  ...over,
});

beforeEach(() => {
  clearVqdCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("normalizeDDGImages (pure)", () => {
  it("maps DuckDuckGoImage rows onto the normalized result shape", () => {
    const [r] = normalizeDDGImages([mkImage()], 10);
    expect(r).toEqual({
      title: "An example image",
      url: "https://example.com/a",
      domain: "example.com",
      imageUrl: mkImage().image,
      thumbnail: mkImage().thumbnail,
      width: 800,
      height: 600,
      source: "example.com",
      provider: "ddg",
    });
  });

  it("emits exactly the field set the chat ImageSearchResults carousel reads", () => {
    const [r] = normalizeDDGImages([mkImage()], 10);
    expect(Object.keys(r).sort()).toEqual(
      [
        "title",
        "url",
        "domain",
        "imageUrl",
        "thumbnail",
        "width",
        "height",
        "source",
        "provider",
      ].sort(),
    );
  });

  it("dedupes by binary image URL and drops rows without one", () => {
    const rows = [
      mkImage(),
      mkImage({ title: "duplicate binary" }),
      mkImage({ image: "", title: "no image url" }),
      mkImage({ image: "https://cdn.example/b.jpg", url: "https://example.com/b" }),
    ];
    const out = normalizeDDGImages(rows, 10);
    expect(out).toHaveLength(2);
    expect(out[1].imageUrl).toBe("https://cdn.example/b.jpg");
  });

  it("falls back to the image URL when the reference page or thumbnail is missing", () => {
    const [r] = normalizeDDGImages(
      [mkImage({ url: "", thumbnail: "" })],
      10,
    );
    expect(r.url).toBe(r.imageUrl);
    expect(r.thumbnail).toBe(r.imageUrl);
    expect(r.domain).toBe("external-content.duckduckgo.com");
  });

  it("caps at the limit and treats non-numeric dimensions as undefined", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      mkImage({ image: `https://cdn.example/${i}.jpg` }),
    );
    expect(normalizeDDGImages(rows, 3)).toHaveLength(3);
    const [r] = normalizeDDGImages([mkImage({ width: 0, height: Number.NaN })], 10);
    expect(r.width).toBeUndefined();
    expect(r.height).toBeUndefined();
  });
});

describe("searchDDGImages (in-house client flow, mocked network)", () => {
  it("runs the token page → i.js flow with browser headers and normalizes", async () => {
    const rows = [
      mkImage(),
      mkImage({
        image: "https://cdn.example/b.jpg",
        thumbnail: "https://cdn.example/b-thumb.jpg",
        title: "Second image",
        url: "https://example.com/b",
        width: 1200,
        height: 800,
      }),
    ];
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const u = String(input);
      calls.push([u, init]);
      if (u.startsWith("https://duckduckgo.com/i.js")) {
        return new Response(JSON.stringify({ results: rows, next: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(SERP_HTML, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await searchDDGImages("golden retriever puppy", 10);

    // Exactly two requests: the token page, then i.js with the token.
    expect(calls).toHaveLength(2);
    expect(calls[0][0].startsWith("https://duckduckgo.com")).toBe(true);
    expect(calls[0][0]).not.toContain("/i.js");
    expect(calls[0][0]).toContain("q=");
    // Browser-grade headers on BOTH legs (the retired package sent none on
    // the token page — the root cause of the intermittent outage).
    expect((calls[0][1]?.headers as Record<string, string>)["User-Agent"]).toMatch(
      /Chrome\/126/,
    );
    expect(calls[1][0]).toContain("/i.js");
    expect(calls[1][0]).toContain("vqd=4-32098503961658400691");
    expect(calls[1][0]).toContain("p=1"); // safe search on
    expect((calls[1][1]?.headers as Record<string, string>)["X-Requested-With"]).toBe(
      "XMLHttpRequest",
    );

    expect(out).toHaveLength(2);
    expect(out.every((r) => r.provider === "ddg")).toBe(true);
    expect(out[1]).toMatchObject({
      title: "Second image",
      imageUrl: "https://cdn.example/b.jpg",
      thumbnail: "https://cdn.example/b-thumb.jpg",
      width: 1200,
      height: 800,
    });
  });

  it("BULK: pages through the `next` cursor until the limit is filled", async () => {
    // Page 1: two rows + a cursor; page 2 (s=100): one more row, no cursor.
    const page1 = [
      mkImage({ image: "https://cdn.example/p1-a.jpg" }),
      mkImage({ image: "https://cdn.example/p1-b.jpg" }),
    ];
    const page2 = [mkImage({ image: "https://cdn.example/p2-a.jpg" })];
    const ijsCalls: string[] = [];
    const fetchMock = vi.fn(async (input: unknown) => {
      const u = String(input);
      if (u.startsWith("https://duckduckgo.com/i.js")) {
        ijsCalls.push(u);
        if (u.includes("s=100")) {
          return new Response(JSON.stringify({ results: page2, next: "" }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            results: page1,
            next: "i.js?o=json&q=cats&l=us-en&f=,,,,&p=1&s=100",
          }),
          { status: 200 },
        );
      }
      return new Response(SERP_HTML, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await searchDDGImages("cats", 3);

    expect(ijsCalls).toHaveLength(2);
    expect(ijsCalls[1]).toContain("s=100");
    // The cursor's dropped vqd param is re-pinned with the live token.
    expect(ijsCalls[1]).toContain("vqd=4-32098503961658400691");
    expect(out).toHaveLength(3);
    expect(out[2].imageUrl).toBe("https://cdn.example/p2-a.jpg");
  });

  it("retries ONCE with a fresh token after an anti-bot soft block, then succeeds", async () => {
    let ijsSeen = 0;
    const fetchMock = vi.fn(async (input: unknown) => {
      const u = String(input);
      if (u.startsWith("https://duckduckgo.com/i.js")) {
        ijsSeen++;
        if (ijsSeen === 1) {
          // HTTP 202 with a challenge body — DDG's anti-bot soft block
          // (202 counts as `ok` for fetch, so the check must be explicit).
          return new Response(CHALLENGE_BODY, { status: 202 });
        }
        return new Response(
          JSON.stringify({ results: [mkImage()], next: "" }),
          { status: 200 },
        );
      }
      return new Response(SERP_HTML, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await searchDDGImages("cats", 5);

    // token + i.js(blocked) + fresh token + i.js(ok)
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(out).toHaveLength(1);
    expect(out[0].provider).toBe("ddg");
  });

  it("propagates the failure when the block survives the fresh-token retry", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const u = String(input);
      if (u.startsWith("https://duckduckgo.com/i.js")) {
        return new Response(CHALLENGE_BODY, { status: 202 });
      }
      return new Response(SERP_HTML_BLOCKED, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchDDGImages("query", 5)).rejects.toThrow(/blocked/i);
    // token + i.js, then fresh token + i.js — then it gives up honestly.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("propagates token failures so the route can answer with a sanitized error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>no token here</html>", { status: 200 })),
    );
    await expect(searchDDGImages("query", 5)).rejects.toThrow("token unavailable");
  });

  it("treats an empty 200 i.js result set as an empty array (graceful no-results)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const u = String(input);
        if (u.startsWith("https://duckduckgo.com/i.js")) {
          return new Response(JSON.stringify({ results: [], next: "" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(SERP_HTML, { status: 200 });
      }),
    );
    expect(await searchDDGImages("query", 5)).toEqual([]);
  });

  it("races an 8s timeout instead of hanging on dropped egress", async () => {
    // A fetch whose host silently drops SYNs never resolves in Node's TCP
    // retransmission loop (~2min) — the race must reject at 8s so the route
    // answers well inside its 30s maxDuration.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.useFakeTimers();
    try {
      const p = searchDDGImages("query", 5);
      const assertion = expect(p).rejects.toThrow(/timed out after 8000ms/);
      await vi.advanceTimersByTimeAsync(8100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("EGRESS: forwards the caller's IP and routes via DDG_PROXY_BASE on every leg", async () => {
    // The "no datacenter IP involved" mechanics end-to-end: with a relay
    // configured, BOTH the token page and i.js go through the relay, and
    // the caller's public IP rides along as the standard proxy headers.
    vi.stubEnv("DDG_PROXY_BASE", "https://home.example.com/ddg");
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const u = String(input);
      calls.push([u, init]);
      if (u.startsWith("https://home.example.com/ddg/i.js")) {
        return new Response(JSON.stringify({ results: [mkImage()], next: "" }), {
          status: 200,
        });
      }
      return new Response(SERP_HTML, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await searchDDGImages("cats", 5, { clientIp: "203.0.113.7" });

    expect(calls).toHaveLength(2);
    // Token page: relay URL + forwarded client IP alongside browser headers.
    expect(calls[0][0]).toBe("https://home.example.com/ddg/?q=cats");
    const tokenHeaders = calls[0][1]?.headers as Record<string, string>;
    expect(tokenHeaders["X-Forwarded-For"]).toBe("203.0.113.7");
    expect(tokenHeaders["X-Real-IP"]).toBe("203.0.113.7");
    expect(tokenHeaders.Forwarded).toBe("for=203.0.113.7");
    expect(tokenHeaders["User-Agent"]).toMatch(/Chrome\/126/);
    // i.js: relay URL + the same forwarded headers.
    expect(calls[1][0]).toContain("https://home.example.com/ddg/i.js?");
    expect(calls[1][0]).toContain("vqd=4-32098503961658400691");
    const ijsHeaders = calls[1][1]?.headers as Record<string, string>;
    expect(ijsHeaders["X-Forwarded-For"]).toBe("203.0.113.7");
    expect(ijsHeaders["X-Requested-With"]).toBe("XMLHttpRequest");
  });

  it("EGRESS: no clientIp → no forwarding headers, direct duckduckgo.com URLs", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const u = String(input);
      calls.push([u, init]);
      if (u.startsWith("https://duckduckgo.com/i.js")) {
        return new Response(JSON.stringify({ results: [mkImage()], next: "" }), {
          status: 200,
        });
      }
      return new Response(SERP_HTML, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await searchDDGImages("cats", 5);

    expect(calls[0][0]).toBe("https://duckduckgo.com/?q=cats");
    const tokenHeaders = calls[0][1]?.headers as Record<string, string>;
    expect(tokenHeaders["X-Forwarded-For"]).toBeUndefined();
    expect(tokenHeaders.Forwarded).toBeUndefined();
    expect(calls[1][0]).toContain("https://duckduckgo.com/i.js?");
  });
});
