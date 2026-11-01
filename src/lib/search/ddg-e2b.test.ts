/**
 * Tests for the DDG-via-E2B-sandbox egress (src/lib/search/ddg-e2b.ts) —
 * the "make ddg use current acquired e2b sandbox's ip" directive.
 *
 * Everything is exercised against a stubbed global fetch standing in for
 * the internal POST /api/sandbox call (the module never imports the E2B
 * SDK — it rides the existing sandbox route). The REAL normalizers from
 * ddg-images.ts / ddg-videos.ts run unmocked, so the full pipeline
 * sandbox-stdout → raw rows → normalized results is pinned:
 *
 *   - the internal call's wire contract (URL, apiKey, action "exec",
 *     shared mode, command timeout),
 *   - command injection-safety (query travels as base64 only; quoted
 *     heredoc; validated literals),
 *   - stdout parsing: rows → normalized results with provider "ddg",
 *   - every failure shape throws (route error, non-zero exit, script-level
 *     {"error"}, invalid stdout) so the route can retry + rescue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDDGSandboxCommand,
  searchDDGImagesViaSandbox,
  searchDDGVideosViaSandbox,
} from "./ddg-e2b";

/** Captured internal /api/sandbox POST. */
interface CapturedCall {
  url: string;
  body: {
    apiKey?: string;
    action?: string;
    sandboxMode?: string;
    args?: { command?: string; timeout?: number };
  };
}

let captured: CapturedCall[];
let respond: () => Response;

function stubSandboxFetch(responder: () => Response) {
  respond = responder;
  const fetchMock = vi.fn(async (input: unknown, init?: { body?: string }) => {
    captured.push({
      url: String(input),
      body: JSON.parse((init?.body ?? "{}") as string),
    });
    return respond();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Raw i.js wire row (the shape DDG's JSON returns). */
const rawImageRow = {
  title: "A cat",
  url: "https://example.com/cat-page",
  image: "https://external-content.duckduckgo.com/iu/?u=https%3A%2F%2Fexample.com%2Fcat.jpg",
  thumbnail: "https://external-content.duckduckgo.com/iu/?u=https%3A%2F%2Fexample.com%2Fcat.jpg&f=1",
  width: 800,
  height: 600,
  source: "example.com",
};

/** Raw v.js wire row — `content` is the real video-page-URL field. */
const rawVideoRow = {
  title: "Cat video",
  content: "https://www.youtube.com/watch?v=abc",
  description: "Description of the video",
  embed_url: "https://www.youtube.com/embed/abc",
  images: { large: "https://i.ytimg.com/vi/abc/hqdefault.jpg" },
  duration: "3:21",
  publisher: "YouTube",
  uploader: "Cat Channel",
  statistics: { viewCount: 12345 },
};

beforeEach(() => {
  captured = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const OPTS = { origin: "https://app.example.com", apiKey: "e2b-test-key" };

describe("buildDDGSandboxCommand — injection safety", () => {
  it("carries the query ONLY as base64 (no raw text in the shell layer)", () => {
    const command = buildDDGSandboxCommand("cat'; rm -rf /; echo '", "image", 10);
    expect(command).not.toContain("rm -rf");
    // base64 of the query is present, kind/limit/safe are safe literals
    expect(command).toMatch(/^DDG_B64='[A-Za-z0-9+/=]+' DDG_KIND='image' DDG_LIMIT='\d+' DDG_SAFE='[\d-]+' python3 - <<'DDGPY'$/m);
  });

  it("keeps the env assignments ON the python3 command line (prefix form) — separate lines would be shell-LOCAL, never reaching the child's environment", () => {
    const command = buildDDGSandboxCommand("cat", "video", 5);
    const firstLine = command.split("\n")[0];
    // One line: all four env vars prefix the python3 invocation.
    expect(firstLine).toMatch(/^DDG_B64='[^']*' DDG_KIND='video' DDG_LIMIT='\d+' DDG_SAFE='[\d-]+' python3 - <<'DDGPY'$/);
  });

  it("SAFE SEARCH: defaults to the unfiltered p=-1 leg (operator directive; live-verified 2026-11-01) and honors DDG_SAFE_SEARCH=true", () => {
    const off = buildDDGSandboxCommand("cat", "image", 10);
    expect(off).toContain("DDG_SAFE='-1'");
    // the script maps the env to the i.js/v.js `p` param
    expect(off).toContain('os.environ.get("DDG_SAFE"');
    expect(off).toContain('"p": SAFE');

    vi.stubEnv("DDG_SAFE_SEARCH", "true");
    const on = buildDDGSandboxCommand("cat", "image", 10);
    expect(on).toContain("DDG_SAFE='1'");
    expect(on).not.toContain("DDG_SAFE='-1'");
    vi.unstubAllEnvs();
  });

  it("SAFE SEARCH: the per-call safeSearch parameter overrides the env in BOTH directions", () => {
    // true forces the filtered leg even with the env off…
    vi.stubEnv("DDG_SAFE_SEARCH", "false");
    expect(buildDDGSandboxCommand("cat", "image", 10, true)).toContain("DDG_SAFE='1'");
    // …and false forces the unfiltered leg even with the env on.
    vi.stubEnv("DDG_SAFE_SEARCH", "true");
    expect(buildDDGSandboxCommand("cat", "video", 10, false)).toContain("DDG_SAFE='-1'");
    // omitted → env decides.
    expect(buildDDGSandboxCommand("cat", "video", 10, undefined)).toContain("DDG_SAFE='1'");
    vi.unstubAllEnvs();
  });

  it("wraps the script in a QUOTED heredoc (shell never expands it)", () => {
    const command = buildDDGSandboxCommand("cat", "video", 5);
    expect(command).toContain("python3 - <<'DDGPY'");
    expect(command.trimEnd().endsWith("DDGPY")).toBe(true);
    // the script itself: stdlib-only, reads env, prints one JSON line
    expect(command).toContain("urllib.request");
    expect(command).toContain('os.environ.get("DDG_B64"');
    expect(command).toContain("duckduckgo.com");
  });

  it("over-fetches the raw pool (3x limit, floor 30, cap 150)", () => {
    expect(buildDDGSandboxCommand("q", "image", 5)).toContain("DDG_LIMIT='30'");
    expect(buildDDGSandboxCommand("q", "image", 10)).toContain("DDG_LIMIT='30'");
    expect(buildDDGSandboxCommand("q", "image", 50)).toContain("DDG_LIMIT='150'");
    expect(buildDDGSandboxCommand("q", "image", 20)).toContain("DDG_LIMIT='60'");
  });
});

describe("searchDDGImagesViaSandbox — the internal sandbox call", () => {
  it("POSTs to /api/sandbox on the given origin with the exec contract", async () => {
    stubSandboxFetch(
      () =>
        new Response(
          JSON.stringify({ sandboxId: "sbx1", stdout: JSON.stringify({ results: [rawImageRow] }), exit_code: 0 }),
          { status: 200 },
        ),
    );

    const rows = await searchDDGImagesViaSandbox("cat", 10, OPTS);

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("https://app.example.com/api/sandbox");
    expect(captured[0].body.apiKey).toBe("e2b-test-key");
    expect(captured[0].body.action).toBe("exec");
    expect(captured[0].body.sandboxMode).toBe("shared");
    expect(typeof captured[0].body.args?.command).toBe("string");
    expect(captured[0].body.args?.timeout).toBeGreaterThan(0);

    // normalized through the REAL ddg-images normalizer
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "A cat",
      imageUrl: rawImageRow.image,
      provider: "ddg",
    });
  });

  it("normalizes videos through the REAL ddg-videos normalizer", async () => {
    stubSandboxFetch(
      () =>
        new Response(
          JSON.stringify({ sandboxId: "sbx1", stdout: JSON.stringify({ results: [rawVideoRow] }), exit_code: 0 }),
          { status: 200 },
        ),
    );

    const rows = await searchDDGVideosViaSandbox("cat", 10, OPTS);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "Cat video",
      videoUrl: "https://www.youtube.com/watch?v=abc",
      provider: "ddg",
    });
  });

  it("dedupes identical binaries and caps at the limit (pool over-fetch)", async () => {
    const dupRow = { ...rawImageRow, title: "Duplicate" };
    stubSandboxFetch(
      () =>
        new Response(
          JSON.stringify({ stdout: JSON.stringify({ results: [rawImageRow, dupRow, rawImageRow, dupRow] }) }),
          { status: 200 },
        ),
    );

    const rows = await searchDDGImagesViaSandbox("cat", 1, OPTS);
    expect(rows).toHaveLength(1);
  });

  it("a script-level DDG failure ({\"error\":\"token\"}) throws — the route retries/rescues", async () => {
    stubSandboxFetch(
      () => new Response(JSON.stringify({ stdout: JSON.stringify({ error: "token", status: 403 }) }), { status: 200 }),
    );
    await expect(searchDDGImagesViaSandbox("cat", 10, OPTS)).rejects.toThrow(/DDG-in-sandbox failed: token/);
  });

  it("a blocked i.js answer (\"error\":\"blocked\") throws", async () => {
    stubSandboxFetch(
      () => new Response(JSON.stringify({ stdout: JSON.stringify({ error: "blocked", status: 403 }) }), { status: 200 }),
    );
    await expect(searchDDGVideosViaSandbox("cat", 10, OPTS)).rejects.toThrow(/blocked/);
  });

  it("a non-zero sandbox exit throws", async () => {
    stubSandboxFetch(
      () => new Response(JSON.stringify({ stdout: "python3: not found", exit_code: 127 }), { status: 200 }),
    );
    await expect(searchDDGImagesViaSandbox("cat", 10, OPTS)).rejects.toThrow(/exited 127/);
  });

  it("an /api/sandbox error body throws (e.g. 401 missing apiKey)", async () => {
    stubSandboxFetch(() => new Response(JSON.stringify({ error: "Missing apiKey" }), { status: 401 }));
    await expect(searchDDGImagesViaSandbox("cat", 10, OPTS)).rejects.toThrow(/E2B sandbox/);
  });

  it("an HTTP failure on the internal call throws", async () => {
    stubSandboxFetch(() => new Response("gateway explosion", { status: 502 }));
    await expect(searchDDGImagesViaSandbox("cat", 10, OPTS)).rejects.toThrow(/HTTP 502/);
  });

  it("invalid stdout JSON throws", async () => {
    stubSandboxFetch(() => new Response(JSON.stringify({ stdout: "not json at all" }), { status: 200 }));
    await expect(searchDDGImagesViaSandbox("cat", 10, OPTS)).rejects.toThrow(/invalid JSON/);
  });

  it("empty stdout throws", async () => {
    stubSandboxFetch(() => new Response(JSON.stringify({ stdout: "", exit_code: 0 }), { status: 200 }));
    await expect(searchDDGImagesViaSandbox("cat", 10, OPTS)).rejects.toThrow(/no output/);
  });

  it("a genuine no-match answer resolves to [] (NOT a throw)", async () => {
    stubSandboxFetch(
      () => new Response(JSON.stringify({ stdout: JSON.stringify({ results: [] }) }), { status: 200 }),
    );
    await expect(searchDDGImagesViaSandbox("zzz no match zzz", 10, OPTS)).resolves.toEqual([]);
  });
});
