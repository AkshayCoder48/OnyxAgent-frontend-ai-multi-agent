/**
 * DuckDuckGo image search tests — the `image_search` tool's backend
 * (the only image provider; the old third-party search service is gone).
 *
 * The network is fully mocked: the package's real flow is
 *   1. GET duckduckgo.com?q=<query>       → HTML containing the vqd token
 *   2. GET duckduckgo.com/i.js?…&vqd=…    → { results: DuckDuckGoImage[] }
 * Both responses are stubbed with schema-accurate fixtures, so these tests
 * prove the code path deterministically without touching the network (the
 * sandbox/CI may block duckduckgo.com egress).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeDDGImages, searchDDGImages, type DDGImage } from "./ddg-images";

// Real vqd tokens are digits+hyphens (the package extracts them with
// /vqd=([\d-]+)&/ — the same regex the python duckduckgo_search lib uses).
const SERP_HTML = `<!DOCTYPE html><html><body>
  <script src="//duckduckgo.com/ac/db.js?vqd=4-32098503961658400691&s=50"></script>
</body></html>`;

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

afterEach(() => {
  vi.restoreAllMocks();
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

describe("searchDDGImages (real package flow, mocked network)", () => {
  it("runs the SERP token page → i.js flow and normalizes the payload", async () => {
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
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: unknown) => {
      const u = String(input);
      calls.push(u);
      if (u.startsWith("https://duckduckgo.com/i.js")) {
        return new Response(
          JSON.stringify({ results: rows, next: "i.js?o=json&s=100" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(SERP_HTML, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await searchDDGImages("golden retriever puppy", 10);

    // Exactly the package's two requests: token page, then i.js with the token.
    expect(calls).toHaveLength(2);
    expect(calls[0].startsWith("https://duckduckgo.com")).toBe(true);
    expect(calls[0]).not.toContain("/i.js");
    expect(calls[0]).toContain("q=");
    expect(calls[1]).toContain("/i.js");
    expect(calls[1]).toContain("vqd=4-32098503961658400691");

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

  it("propagates token failures so the route can answer with a sanitized error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>no token here</html>", { status: 200 })),
    );
    await expect(searchDDGImages("query", 5)).rejects.toThrow("Failed to get token");
  });

  it("treats an empty i.js result set as an empty array (graceful no-results)", async () => {
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
});
