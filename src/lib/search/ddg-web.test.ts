/**
 * DuckDuckGo WEB search tests — the keyless backend that replaced the old
 * third-party search service for `web_search` (when no LangSearch key is set).
 *
 * The network is fully mocked: the real flow is
 *   POST html.duckduckgo.com/html/  (form: q, kl=wt-wt)  → HTML SERP
 * The parser is PURE (parseDDGWebHtml / unwrapDDGUrl / isDDGSoftBlocked run
 * against fixture HTML copied from the endpoint's real markup shape), so the
 * tests prove the code path deterministically without touching the network
 * (the sandbox/CI may block duckduckgo.com egress).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isDDGSoftBlocked,
  parseDDGWebHtml,
  searchDDGWeb,
  unwrapDDGUrl,
} from "./ddg-web";

/** Realistic DDG HTML SERP markup (trimmed to the parts we parse). */
const SERP_HTML = `<!DOCTYPE html><html><body>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FApollo_11&amp;rut=abc">Apollo 11 - <b>Wikipedia</b></a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FApollo_11&amp;rut=abc">Apollo 11 was the American spaceflight that first landed humans on the Moon.</a>
</div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="https://www.nasa.gov/mission/apollo-11/">Apollo 11 | NASA</a>
  </h2>
  <a class="result__snippet" href="https://www.nasa.gov/mission/apollo-11/">Mission overview, crew, and landing site details.</a>
</div>
<div class="result result--ad ad-sponsored">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/y.js?ad_domain=example.com&u3=https%3A%2F%2Fad.example.com%2Ftracker">Buy Apollo stuff</a>
</div>
</body></html>`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("unwrapDDGUrl (pure)", () => {
  it("resolves protocol-relative click-redirect wrappers to the real target", () => {
    expect(unwrapDDGUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x")).toBe(
      "https://example.com/a",
    );
  });

  it("resolves absolute redirect wrappers too", () => {
    expect(unwrapDDGUrl("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa")).toBe(
      "https://example.com/a",
    );
  });

  it("passes plain URLs through unchanged", () => {
    expect(unwrapDDGUrl("https://example.com/page")).toBe("https://example.com/page");
  });

  it("tolerates empty and garbage input", () => {
    expect(unwrapDDGUrl("")).toBe("");
    expect(unwrapDDGUrl("not a url")).toBe("not a url");
  });
});

describe("parseDDGWebHtml (pure)", () => {
  it("extracts titles, real URLs (redirects unwrapped), domains, and snippets; skips y.js ad rows", () => {
    const out = parseDDGWebHtml(SERP_HTML, 10);
    expect(out).toHaveLength(2); // the ad row (y.js tracker href) is excluded
    expect(out[0]).toMatchObject({
      title: "Apollo 11 - Wikipedia",
      url: "https://en.wikipedia.org/wiki/Apollo_11",
      domain: "en.wikipedia.org",
      description: "Apollo 11 was the American spaceflight that first landed humans on the Moon.",
      provider: "ddg",
    });
    expect(out[1]).toMatchObject({
      title: "Apollo 11 | NASA",
      url: "https://www.nasa.gov/mission/apollo-11/",
      domain: "nasa.gov",
      description: "Mission overview, crew, and landing site details.",
    });
  });

  it("decodes HTML entities and strips nested tags from titles", () => {
    const html = `<a class="result__a" href="https://example.com/a?q=1&amp;x=2">A &amp; B &lt;tag&gt;</a>`;
    const [r] = parseDDGWebHtml(html, 5);
    expect(r.title).toBe("A & B <tag>");
  });

  it("dedupes by final URL and drops rows without an http(s) target", () => {
    const html = `
      <a class="result__a" href="https://example.com/a">First</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Duplicate</a>
      <a class="result__a" href="javascript:void(0)">Junk</a>
      <a class="result__a" href="mailto:someone@example.com">Mail</a>`;
    const out = parseDDGWebHtml(html, 10);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("First");
  });

  it("caps at the limit", () => {
    const html = Array.from(
      { length: 5 },
      (_, i) => `<a class="result__a" href="https://example.com/${i}">R${i}</a>`,
    ).join("");
    expect(parseDDGWebHtml(html, 3)).toHaveLength(3);
  });

  it("returns [] for an empty page, a no-results page, and garbage", () => {
    expect(parseDDGWebHtml("", 10)).toEqual([]);
    expect(parseDDGWebHtml("<html><body>No results.</body></html>", 10)).toEqual([]);
    expect(parseDDGWebHtml("<<<not html>>>", 10)).toEqual([]);
  });
});

describe("isDDGSoftBlocked (pure)", () => {
  it("flags 202 and 403 statuses regardless of body", () => {
    expect(isDDGSoftBlocked(202, "")).toBe(true);
    expect(isDDGSoftBlocked(403, "")).toBe(true);
  });

  it("flags anomaly/ratelimit challenge bodies", () => {
    expect(isDDGSoftBlocked(200, "<html>If this persists, please let us know: anomaly…")).toBe(true);
    expect(isDDGSoftBlocked(200, "ratelimit")).toBe(true);
  });

  it("does not flag a normal SERP", () => {
    expect(isDDGSoftBlocked(200, SERP_HTML)).toBe(false);
  });
});

describe("searchDDGWeb (network flow, mocked fetch)", () => {
  it("POSTs the query and normalizes the SERP (ads excluded)", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(SERP_HTML, { status: 200, headers: { "Content-Type": "text/html" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await searchDDGWeb("apollo 11", 10);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://html.duckduckgo.com/html/");
    expect(calls[0].init?.method).toBe("POST");
    expect(String(calls[0].init?.body)).toContain("q=apollo+11");
    expect(out).toHaveLength(2);
    expect(out[0].url).toBe("https://en.wikipedia.org/wiki/Apollo_11");
  });

  it("throws (rate-limited) on a 202 soft block instead of returning empty results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>anomaly</html>", { status: 202 })),
    );
    await expect(searchDDGWeb("query", 5)).rejects.toThrow(/rate-limited/i);
  });

  it("throws on a 5xx upstream failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Internal Server Error", { status: 500 })),
    );
    await expect(searchDDGWeb("query", 5)).rejects.toThrow(/HTTP 500/);
  });

  it("parses a no-results SERP into an empty array (not an error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            '<html><body><div class="links links_main"><h3>No results</h3></div></body></html>',
            { status: 200 },
          ),
      ),
    );
    expect(await searchDDGWeb("zzzz nothing", 5)).toEqual([]);
  });

  it("races an 8s timeout instead of hanging on dropped egress", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.useFakeTimers();
    try {
      const p = searchDDGWeb("query", 5);
      const assertion = expect(p).rejects.toThrow(/timed out after 8000ms/);
      await vi.advanceTimersByTimeAsync(8100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
