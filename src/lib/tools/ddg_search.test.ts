/**
 * web/image/video search TOOL layer tests — the chat-facing contract for
 * graceful "no results" and sanitized failures.
 *
 * History: the operator-reported bug rendered in the chat as
 *   {"success":false,"output":null,"error":"Miklium HTTP 404: {\"success\":false,\"error\":\"No results found\"}"}
 * because the /api/ddg-search proxy surfaced the upstream 404 as an error and
 * the tool passed the raw string through. The route now normalizes "no
 * results" into a 200 + empty list and serves DuckDuckGo for every search
 * kind (route.test.ts covers that); these tests pin the TOOL layer's half of
 * the contract:
 *   1. empty results → success:true + count:0 + a friendly `message` (the
 *      model then says "no images found for that" instead of an error blob).
 *   2. a failed search → success:false + a SANITIZED error — provider names
 *      and raw JSON bodies never reach the model context or the chat card.
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

    const res = await imageTool().handler({ query:"xyzzy impossible query", limit: 10 }, {} as never);
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

    const res = await imageTool().handler({ query:"cat", limit: 10 }, {} as never);
    expect(res.success).toBe(true);
    const out = res.output as { results: unknown[]; count: number; provider: string };
    expect(out.count).toBe(1);
    expect(out.provider).toBe("ddg");
    expect(out.results[0]).toMatchObject({ imageUrl: "https://example.com/cat.jpg" });
  });
});

describe("image_search tool — sanitized failures", () => {
  it("maps a proxy 502 to a clean, user-facing error", async () => {
    stubProxy(
      { error: "Image search is temporarily unavailable. Please try again in a moment." },
      502,
    );

    const res = await imageTool().handler({ query:"cat", limit: 10 }, {} as never);
    expect(res.success).toBe(false);
    expect(res.output).toBeNull();
    expect(res.error).toMatch(/image search is temporarily unavailable/i);
    expect(res.error).not.toContain("Miklium");
    expect(res.error).not.toContain("miklium");
  });

  it("scrubs provider names and raw JSON even if the proxy leaks them (belt-and-suspenders)", async () => {
    // Simulates a regression upstream: the raw pre-fix error string, exactly
    // as the operator reported it. The sanitizer blocklist (which keeps the
    // old provider name on purpose) must scrub it before it reaches the chat.
    stubProxy(
      { error: 'Miklium HTTP 404: {"success":false,"error":"No results found"}' },
      502,
    );

    const res = await imageTool().handler({ query:"cat", limit: 10 }, {} as never);
    expect(res.success).toBe(false);
    expect(res.error).not.toContain("Miklium");
    expect(res.error).not.toContain('{"success"');
    expect(res.error).toMatch(/image search/i);
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
    const res = await t.handler({ query:"zzzz", limit: 10 }, {} as never);
    expect(res.success).toBe(true);
    const out = res.output as { count: number; message?: string };
    expect(out.count).toBe(0);
    expect(out.message).toMatch(/no web results found/i);
  });

  it("web: real results carry provider 'ddg' (or 'langsearch' when the user's key served)", async () => {
    stubProxy({
      query: "apollo",
      type: "web",
      results: [{ title: "Apollo 11", url: "https://en.wikipedia.org/wiki/Apollo_11" }],
      count: 1,
      provider: "ddg",
    });

    const t = getTool("web_search");
    if (!t) throw new Error("web_search tool not registered");
    const res = await t.handler({ query:"apollo", limit: 10 }, {} as never);
    expect(res.success).toBe(true);
    const out = res.output as { count: number; provider?: string };
    expect(out.count).toBe(1);
    expect(out.provider).toBe("ddg");
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
    const res = await t.handler({ query:"zzzz", limit: 10 }, {} as never);
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
    const res = await t.handler({ query:"apollo", limit: 10 }, {} as never);
    expect(res.success).toBe(true);
    const out = res.output as { count: number; provider?: string; results: Array<{ videoUrl?: string }> };
    expect(out.count).toBe(1);
    expect(out.provider).toBe("ddg");
    expect(out.results[0].videoUrl).toContain("youtube.com/watch");
  });
});
