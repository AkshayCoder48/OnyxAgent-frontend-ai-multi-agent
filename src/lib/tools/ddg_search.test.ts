/**
 * web/image/video search TOOL layer tests — the chat-facing contract for
 * graceful degradation in ALL outcomes.
 *
 * History: the operator-reported bug rendered in the chat as
 *   {"success":false,"output":null,"error":"Image search is temporarily
 *    unavailable. Please try again in a moment."}
 * whenever the /api/ddg-search proxy 502'd. The route now returns friendly
 * notes for empty AND failed backends (route.test.ts covers that); these
 * tests pin the TOOL layer's half of the contract:
 *   1. empty results → success:true + count:0 + a friendly `message` (the
 *      model then says "no images found for that" instead of an error blob).
 *   2. even a proxy 502 / network failure → STILL success:true + a friendly
 *      "couldn't be reached, try again" message — a {"success":false,...,
 *      "error":...} blob is never emitted for any search kind (user
 *      directive: "fix this issue in all searches").
 *   3. the busy message is static text, so a regressed proxy can never leak
 *      provider names or raw JSON bodies through it.
 *
 * The proxy is reached through a stubbed global fetch (no network).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "./index"; // side-effect: registers every built-in tool
import { getTool } from "./registry";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Stub the /api/ddg-search proxy response. */
function stubProxy(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

const imageTool = () => {
  const t = getTool("image_search");
  if (!t) throw new Error("image_search tool not registered");
  return t;
};

describe("image_search tool — graceful no-results", () => {
  it("returns success:true with a friendly message when the proxy finds nothing", async () => {
    stubProxy({
      query: "xyzzy impossible query",
      type: "image",
      results: [],
      count: 0,
      provider: "ddg",
      note: "No images found for this query.",
    });

    const res = await imageTool().handler({ query: "xyzzy impossible query", limit: 10 }, {} as never);
    expect(res.success).toBe(true);
    expect(res.error).toBeUndefined();
    const out = res.output as { results: unknown[]; count: number; message?: string; provider?: string };
    expect(out.results).toEqual([]);
    expect(out.count).toBe(0);
    expect(out.message).toMatch(/no images found/i);
    expect(out.provider).toBe("ddg");
  });

  it("still passes real results through untouched", async () => {
    stubProxy({
      query: "cat",
      type: "image",
      results: [{ title: "A cat", imageUrl: "https://example.com/cat.jpg" }],
      count: 1,
      provider: "ddg",
    });

    const res = await imageTool().handler({ query: "cat", limit: 10 }, {} as never);
    expect(res.success).toBe(true);
    const out = res.output as { results: unknown[]; count: number; provider: string };
    expect(out.count).toBe(1);
    expect(out.provider).toBe("ddg");
    expect(out.results[0]).toMatchObject({ imageUrl: "https://example.com/cat.jpg" });
  });
});

describe("image_search tool — failures degrade gracefully (no error blob)", () => {
  it("maps a proxy 502 to a friendly busy notice, not the reported error blob", async () => {
    stubProxy(
      { error: "Image search is temporarily unavailable. Please try again in a moment." },
      502,
    );

    const res = await imageTool().handler({ query: "cat", limit: 10 }, {} as never);
    // THE reported bug: this used to be success:false + output:null + error.
    expect(res.success).toBe(true);
    const out = res.output as { results: unknown[]; count: number; message?: string };
    expect(out.results).toEqual([]);
    expect(out.count).toBe(0);
    expect(out.message).toMatch(/couldn't be reached just now/i);
    expect(out.message).toMatch(/try again in a moment/i);
    expect(res.error).toBeUndefined();
  });

  it("a network-level proxy failure also degrades to the friendly notice", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    );

    const res = await imageTool().handler({ query: "cat", limit: 10 }, {} as never);
    expect(res.success).toBe(true);
    const out = res.output as { results: unknown[]; count: number; message?: string };
    expect(out.results).toEqual([]);
    expect(out.message).toMatch(/couldn't be reached just now/i);
    expect(res.error).toBeUndefined();
  });

  it("never embeds upstream text — a regressed proxy cannot leak through the busy message", async () => {
    // Simulates a total upstream regression: the raw pre-fix error string,
    // exactly as the operator once reported it. The busy notice is static
    // text — nothing upstream can leak through it.
    stubProxy(
      { error: 'Miklium HTTP 404: {"success":false,"error":"No results found"}' },
      502,
    );

    const res = await imageTool().handler({ query: "cat", limit: 10 }, {} as never);
    expect(res.success).toBe(true);
    expect(res.error).toBeUndefined();
    const out = JSON.stringify(res.output);
    expect(out).not.toContain("Miklium");
    expect(out).not.toContain("miklium");
    expect(out).not.toContain('"success":false');
    expect(out).not.toContain("HTTP 404");
  });
});

describe("safeSearch parameter — the per-call flag reaches the proxy URL (user directive 2026-11-01)", () => {
  /** Capture the proxy request URL the tool issued. */
  function captureProxyUrl(): string[] {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return new Response(
          JSON.stringify({ query: "x", type: "web", results: [], count: 0, provider: "ddg" }),
          { status: 200 },
        );
      }),
    );
    return urls;
  }

  it("image_search: safeSearch true/false ride as safe_search=true/false; omitted → no param (deployment default)", async () => {
    for (const [arg, expected] of [
      [true, "safe_search=true"],
      [false, "safe_search=false"],
    ] as const) {
      const urls = captureProxyUrl();
      await imageTool().handler({ query: "cat", limit: 5, safeSearch: arg }, {} as never);
      expect(urls[0]).toContain(expected);
    }
    const urls = captureProxyUrl();
    await imageTool().handler({ query: "cat", limit: 5 }, {} as never);
    expect(urls[0]).not.toContain("safe_search");
  });

  it("string spellings a sloppy model emits ('true'/'off') normalize to the boolean param; garbage → no param", async () => {
    const truthy = captureProxyUrl();
    await imageTool().handler({ query: "cat", limit: 5, safeSearch: "true" }, {} as never);
    expect(truthy[0]).toContain("safe_search=true");

    const falsey = captureProxyUrl();
    await imageTool().handler({ query: "cat", limit: 5, safeSearch: "off" }, {} as never);
    expect(falsey[0]).toContain("safe_search=false");

    const garbage = captureProxyUrl();
    await imageTool().handler({ query: "cat", limit: 5, safeSearch: "banana" }, {} as never);
    expect(garbage[0]).not.toContain("safe_search");
  });

  it("web_search and video_search: the same safeSearch wiring", async () => {
    for (const name of ["web_search", "video_search"]) {
      const t = getTool(name);
      if (!t) throw new Error(`${name} tool not registered`);
      const urls = captureProxyUrl();
      await t.handler({ query: "cat", limit: 5, safeSearch: false }, {} as never);
      expect(urls[0]).toContain("safe_search=false");
      const urls2 = captureProxyUrl();
      await t.handler({ query: "cat", limit: 5, safeSearch: true }, {} as never);
      expect(urls2[0]).toContain("safe_search=true");
    }
  });

  it("every search tool's schema declares the safeSearch boolean parameter", () => {
    for (const name of ["web_search", "image_search", "video_search"]) {
      const t = getTool(name);
      if (!t) throw new Error(`${name} tool not registered`);
      const props = (t.parameters as { properties?: Record<string, { type?: string }> }).properties;
      expect(props.safeSearch?.type).toBe("boolean");
      expect(typeof props.safeSearch?.description).toBe("string");
    }
  });
});

describe("web_search / video_search tools — same contract", () => {
  it("web: empty results → success + friendly message", async () => {
    stubProxy({
      query: "zzzz",
      type: "web",
      results: [],
      count: 0,
      provider: "ddg",
      note: "No web results found for this query.",
    });

    const t = getTool("web_search");
    if (!t) throw new Error("web_search tool not registered");
    const res = await t.handler({ query: "zzzz", limit: 10 }, {} as never);
    expect(res.success).toBe(true);
    const out = res.output as { count: number; message?: string };
    expect(out.count).toBe(0);
    expect(out.message).toMatch(/no web results found/i);
  });

  it("web: real results carry the serving provider ('ddg', 'miklium', or 'langsearch')", async () => {
    stubProxy({
      query: "apollo",
      type: "web",
      results: [{ title: "Apollo 11", url: "https://en.wikipedia.org/wiki/Apollo_11" }],
      count: 1,
      provider: "miklium",
    });

    const t = getTool("web_search");
    if (!t) throw new Error("web_search tool not registered");
    const res = await t.handler({ query: "apollo", limit: 10 }, {} as never);
    expect(res.success).toBe(true);
    const out = res.output as { count: number; provider?: string };
    expect(out.count).toBe(1);
    expect(out.provider).toBe("miklium");
  });

  it("web: proxy failure → friendly busy notice, never an error blob", async () => {
    stubProxy({ error: "Web search is temporarily unavailable." }, 502);

    const t = getTool("web_search");
    if (!t) throw new Error("web_search tool not registered");
    const res = await t.handler({ query: "apollo", limit: 10 }, {} as never);
    expect(res.success).toBe(true);
    const out = res.output as { results: unknown[]; count: number; message?: string };
    expect(out.results).toEqual([]);
    expect(out.count).toBe(0);
    expect(out.message).toMatch(/couldn't be reached just now/i);
    expect(res.error).toBeUndefined();
  });

  it("video: empty results → success + friendly message", async () => {
    stubProxy({
      query: "zzzz",
      type: "video",
      results: [],
      count: 0,
      provider: "ddg",
      note: "No videos found for this query.",
    });

    const t = getTool("video_search");
    if (!t) throw new Error("video_search tool not registered");
    const res = await t.handler({ query: "zzzz", limit: 10 }, {} as never);
    expect(res.success).toBe(true);
    const out = res.output as { count: number; message?: string };
    expect(out.count).toBe(0);
    expect(out.message).toMatch(/no videos found/i);
  });

  it("video: real results carry provider 'ddg'", async () => {
    stubProxy({
      query: "apollo",
      type: "video",
      results: [
        {
          title: "Apollo 11 landing",
          videoUrl: "https://www.youtube.com/watch?v=ELalc0t9z9I",
          thumbUrl: "https://i.ytimg.com/vi/ELalc0t9z9I/hqdefault.jpg",
          duration: "5:32",
          channelTitle: "NASA",
        },
      ],
      count: 1,
      provider: "ddg",
    });

    const t = getTool("video_search");
    if (!t) throw new Error("video_search tool not registered");
    const res = await t.handler({ query: "apollo", limit: 10 }, {} as never);
    expect(res.success).toBe(true);
    const out = res.output as { count: number; provider?: string; results: Array<{ videoUrl?: string }> };
    expect(out.count).toBe(1);
    expect(out.provider).toBe("ddg");
    expect(out.results[0].videoUrl).toContain("youtube.com/watch");
  });

  it("video: proxy failure → friendly busy notice, never an error blob", async () => {
    stubProxy({ error: "Video search is temporarily unavailable." }, 502);

    const t = getTool("video_search");
    if (!t) throw new Error("video_search tool not registered");
    const res = await t.handler({ query: "apollo", limit: 10 }, {} as never);
    expect(res.success).toBe(true);
    const out = res.output as { results: unknown[]; count: number; message?: string };
    expect(out.results).toEqual([]);
    expect(out.message).toMatch(/couldn't be reached just now/i);
    expect(res.error).toBeUndefined();
  });
});
