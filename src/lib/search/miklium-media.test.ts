/**
 * Miklium media search tests — the image/video RESCUE engine.
 *
 * Contract under test (mirrors the web client's rules, which the original
 * bug pinned down):
 *   1. "No results" (404 body OR 200 success:false) → [] — an EMPTY
 *      outcome, never a throw, never a leaked error string.
 *   2. Hard failures (5xx, invalid JSON, success:false with another
 *      error) → THROW so the route can pick the "busy" note honestly.
 *   3. Rows normalize to the SAME shapes the DDG engines emit (title,
 *      url = reference page, imageUrl, dimensions / videoUrl, thumbUrl,
 *      duration) so carousels render both engines identically.
 *   4. Dedupe by binary image URL / video URL; junk rows (non-http,
 *      missing URL) are dropped; `limit` is respected.
 *
 * Pure fetch-stub tests — no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { searchMikliumImages, searchMikliumVideos } from "./miklium-media";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Miklium image rows in the live wire format. */
const imageFixture = {
  success: true,
  results: [
    {
      imageUrl: "https://image.cdn2.seaart.ai/sunset-over-ocean.webp",
      title: "Arafed view of a sunset over the ocean with a beach and waves - SeaArt AI",
      referenceUrl: "https://www.seaart.ai/explore/detail/ci2naip4msb5tip88v9g",
      size: { width: 4096, height: 4096 },
      query: "sunset",
    },
    {
      imageUrl: "https://wallpapers.com/images/hd/golden-hour.jpg",
      title: "Golden hour wallpaper",
      referenceUrl: "https://wallpapers.com/sunset",
      size: { width: 1200, height: 800 },
      query: "sunset",
    },
  ],
};

/** Miklium video rows in the live wire format. */
const videoFixture = {
  success: true,
  results: [
    {
      videoUrl: "https://www.youtube.com/watch?v=SIMnxI_DU6s",
      thumbUrl: "https://up.yimg.com/ib/th?id=OVF.iaFYmFf5&pid=Api&h=360&w=480",
      title: "Blastoff! SpaceX launches Starlink satellites",
      description: "A SpaceX Falcon 9 rocket launched 27 Starlink satellites.",
      duration: "2:45",
      query: "space launch",
    },
    {
      videoUrl: "https://www.tiktok.com/@nolanreid7/video/7701776077491850504",
      thumbUrl: "https://up.yimg.com/ib/th?id=OVF.jEiUPLclbBt3Q&pid=Api&h=520&w=292",
      title: "Wait for the whole sunset: relaxing sunset video",
      description: "Watch the full sunset clip.",
      duration: "0:30",
      query: "space launch",
    },
  ],
};

function stubFetch(respond: () => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => respond());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastRequestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls[0];
  const init = call?.[1] as { body?: string } | undefined;
  return init?.body ? JSON.parse(init.body) : {};
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe("searchMikliumImages", () => {
  it("normalizes rows to the DDG image shape (reference page as url, dimensions kept)", async () => {
    const fetchMock = stubFetch(() => jsonResponse(imageFixture));

    const rows = await searchMikliumImages("sunset", 10);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      title: "Arafed view of a sunset over the ocean with a beach and waves - SeaArt AI",
      url: "https://www.seaart.ai/explore/detail/ci2naip4msb5tip88v9g",
      domain: "seaart.ai",
      imageUrl: "https://image.cdn2.seaart.ai/sunset-over-ocean.webp",
      thumbnail: "https://image.cdn2.seaart.ai/sunset-over-ocean.webp",
      width: 4096,
      height: 4096,
      source: "seaart.ai",
      provider: "miklium",
    });
    // Request shape: type "images", maxResults clamped to the limit.
    expect(lastRequestBody(fetchMock)).toEqual({
      search: ["sunset"],
      type: "images",
      maxResults: 10,
    });
  });

  it("caps maxResults at 50 (the live per-call ceiling)", async () => {
    const fetchMock = stubFetch(() => jsonResponse(imageFixture));
    await searchMikliumImages("sunset", 500);
    expect(lastRequestBody(fetchMock).maxResults).toBe(50);
  });

  it("404 'No results found' → [] (empty outcome, never an error)", async () => {
    stubFetch(() =>
      jsonResponse({ success: false, error: "No results found" }, 404),
    );
    const rows = await searchMikliumImages("zzzz no match", 10);
    expect(rows).toEqual([]);
  });

  it("200 success:false 'No results found' → [] too", async () => {
    stubFetch(() =>
      jsonResponse({ success: false, error: "No results found" }),
    );
    const rows = await searchMikliumImages("zzzz no match", 10);
    expect(rows).toEqual([]);
  });

  it("hard HTTP failure → throws (status only, no provider body leak)", async () => {
    stubFetch(() => jsonResponse({}, 503));
    await expect(searchMikliumImages("sunset", 10)).rejects.toThrow(
      "Miklium images search HTTP 503",
    );
  });

  it("success:false with another error → throws", async () => {
    stubFetch(() =>
      jsonResponse({ success: false, error: "upstream timeout" }),
    );
    await expect(searchMikliumImages("sunset", 10)).rejects.toThrow(
      /upstream timeout/,
    );
  });

  it("invalid JSON → throws", async () => {
    stubFetch(() => new Response("<html>gateway error</html>", { status: 200 }));
    await expect(searchMikliumImages("sunset", 10)).rejects.toThrow(
      /invalid JSON/,
    );
  });

  it("drops junk rows (non-http imageUrl, missing imageUrl) and dedupes by imageUrl", async () => {
    stubFetch(() =>
      jsonResponse({
        success: true,
        results: [
          { imageUrl: "ftp://not-http.example/x.jpg", title: "bad scheme" },
          { title: "no imageUrl at all" },
          imageFixture.results[0],
          imageFixture.results[0], // duplicate image URL
          { imageUrl: "https://cdn.example.com/ok.png", referenceUrl: "javascript:alert(1)" },
        ],
      }),
    );

    const rows = await searchMikliumImages("sunset", 10);

    expect(rows).toHaveLength(2);
    expect(rows[0].imageUrl).toBe("https://image.cdn2.seaart.ai/sunset-over-ocean.webp");
    // A bad referenceUrl falls back to the image URL itself (never a
    // javascript: URL).
    expect(rows[1].url).toBe("https://cdn.example.com/ok.png");
  });

  it("respects the limit", async () => {
    stubFetch(() => jsonResponse(imageFixture));
    const rows = await searchMikliumImages("sunset", 1);
    expect(rows).toHaveLength(1);
  });

  it("a row missing its title falls back to the reference domain", async () => {
    stubFetch(() =>
      jsonResponse({
        success: true,
        results: [
          {
            imageUrl: "https://cdn.example.com/no-title.jpg",
            referenceUrl: "https://www.example.com/page",
            size: { width: 640, height: 480 },
          },
        ],
      }),
    );
    const rows = await searchMikliumImages("sunset", 10);
    expect(rows[0].title).toBe("example.com");
  });
});

// ---------------------------------------------------------------------------

describe("searchMikliumVideos", () => {
  it("normalizes rows to the DDG video shape (videoUrl, thumbUrl, duration)", async () => {
    const fetchMock = stubFetch(() => jsonResponse(videoFixture));

    const rows = await searchMikliumVideos("space launch", 10);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
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
    });
    expect(lastRequestBody(fetchMock)).toEqual({
      search: ["space launch"],
      type: "videos",
      maxResults: 10,
    });
  });

  it("404 'No results found' → []", async () => {
    stubFetch(() => jsonResponse({ success: false, error: "No results found" }, 404));
    const rows = await searchMikliumVideos("zzzz", 10);
    expect(rows).toEqual([]);
  });

  it("hard HTTP failure → throws (status only)", async () => {
    stubFetch(() => jsonResponse({}, 500));
    await expect(searchMikliumVideos("space", 10)).rejects.toThrow(
      "Miklium videos search HTTP 500",
    );
  });

  it("drops non-http videoUrls and dedupes by videoUrl", async () => {
    stubFetch(() =>
      jsonResponse({
        success: true,
        results: [
          { videoUrl: "javascript:alert(1)", title: "bad scheme" },
          { title: "no videoUrl" },
          videoFixture.results[0],
          videoFixture.results[0],
        ],
      }),
    );
    const rows = await searchMikliumVideos("space", 10);
    expect(rows).toHaveLength(1);
  });

  it("rows without a thumbUrl still serve (no thumbnail keys)", async () => {
    stubFetch(() =>
      jsonResponse({
        success: true,
        results: [
          {
            videoUrl: "https://www.youtube.com/watch?v=abc123",
            title: "No thumbnail row",
            duration: "1:00",
          },
        ],
      }),
    );
    const rows = await searchMikliumVideos("space", 10);
    expect(rows[0].thumbUrl).toBeUndefined();
    expect(rows[0].thumbnail).toBeUndefined();
    expect(rows[0].videoUrl).toBe("https://www.youtube.com/watch?v=abc123");
  });
});
