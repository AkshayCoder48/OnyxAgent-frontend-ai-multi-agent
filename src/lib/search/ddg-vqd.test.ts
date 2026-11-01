/**
 * Shared DuckDuckGo vqd session-client tests — the handshake both image
 * (i.js) and video (v.js) search depend on.
 *
 * The network is fully mocked (stubbed global fetch): the real flow is
 *   1. GET duckduckgo.com/?q=<query> → HTML embedding the vqd token
 * and the cache/soft-block semantics are exercised deterministically.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearVqdCache,
  extractVqd,
  getVqdToken,
  isDDGBlocked,
  DDGBlockedError,
  DDG_HTML_HEADERS,
  DDG_XHR_HEADERS,
} from "./ddg-vqd";

// The two token shapes DDG serves in the wild (the retired package's regex
// only matched the second — one root cause of the image-search outage).
const SERP_QUOTED = `<html><body><script>window.vqd = "4-264060408678648278323627634281741567781";</script></body></html>`;
const SERP_BARE = `<!DOCTYPE html><html><body>
  <script src="//duckduckgo.com/ac/db.js?vqd=4-32098503961658400691&s=50"></script>
</body></html>`;

const CHALLENGE_BODY = JSON.stringify({
  challenge: { cc: "sre", gk: "d4cd0dabcf4caa22ad92fab40844c786", i: "3" },
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearVqdCache();
});

describe("extractVqd (pure)", () => {
  it("reads the quoted attribute form DDG currently serves", () => {
    expect(extractVqd(SERP_QUOTED)).toBe("4-264060408678648278323627634281741567781");
  });

  it("reads the bare query-string form older pages served", () => {
    expect(extractVqd(SERP_BARE)).toBe("4-32098503961658400691");
  });

  it("returns '' for pages without a token (challenge pages)", () => {
    expect(extractVqd("<html>anomaly detected</html>")).toBe("");
    expect(extractVqd("")).toBe("");
  });
});

describe("isDDGBlocked (pure)", () => {
  it("flags the soft-block statuses (202, 403)", () => {
    expect(isDDGBlocked(202, "")).toBe(true);
    expect(isDDGBlocked(403, "")).toBe(true);
  });

  it("flags anomaly/challenge/rate-limit bodies at any status", () => {
    expect(isDDGBlocked(200, CHALLENGE_BODY)).toBe(true);
    expect(isDDGBlocked(200, "<html>anomaly detected</html>")).toBe(true);
    expect(isDDGBlocked(200, "rate limit exceeded")).toBe(true);
  });

  it("passes clean responses and truncates the scan to the first 2KB", () => {
    expect(isDDGBlocked(200, JSON.stringify({ results: [] }))).toBe(false);
    expect(isDDGBlocked(200, "x".repeat(3000) + "anomaly")).toBe(false);
  });
});

describe("getVqdToken (mocked network)", () => {
  it("sends browser-grade headers on the token page", async () => {
    const fetchMock = vi.fn(async () => new Response(SERP_BARE, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await getVqdToken("cats");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/Chrome\/126/);
    expect(headers["sec-fetch-mode"]).toBe("navigate");
    expect(headers["Accept"]).toContain("text/html");
  });

  it("caches the token per query: a second call makes no network request", async () => {
    const fetchMock = vi.fn(async () => new Response(SERP_BARE, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const t1 = await getVqdToken("cats");
    const t2 = await getVqdToken("cats");

    expect(t1).toBe(t2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A different query misses the cache and re-bootstraps.
    await getVqdToken("dogs");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("opts.fresh bypasses the cache and re-bootstraps", async () => {
    const fetchMock = vi.fn(async () => new Response(SERP_BARE, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await getVqdToken("cats");
    await getVqdToken("cats", { fresh: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws DDGBlockedError when the token page is soft-blocked (202)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(CHALLENGE_BODY, { status: 202 })),
    );
    await expect(getVqdToken("cats")).rejects.toThrow(DDGBlockedError);
  });

  it("throws a plain Error when the page is reachable but tokenless", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>no token</html>", { status: 200 })),
    );
    await expect(getVqdToken("cats")).rejects.toThrow("token unavailable");
  });
});

describe("exported header profiles", () => {
  it("XHR headers identify as a same-origin JSON fetch", () => {
    expect(DDG_XHR_HEADERS["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(DDG_XHR_HEADERS["Referer"]).toBe("https://duckduckgo.com/");
    expect(DDG_XHR_HEADERS["sec-fetch-site"]).toBe("same-origin");
    expect(DDG_HTML_HEADERS["Referer"]).toBeUndefined();
  });
});
