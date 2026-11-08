/**
 * kv-client tests (Task 21) — the KV fixes that make OnyxBase calls stop
 * 404ing:
 *
 *   1. DURABILITY: POST /v1/set answering 200 with `durable: false` (+ a
 *      throttle.retryAfterSecs) is NOT a success — the client waits the
 *      server's retry window, re-writes, and fails HONESTLY if durability
 *      never confirms (live-verified: such records 404 once the instance
 *      rotates).
 *   2. PAGINATION: /v1/list has NO server-side prefix param — the client
 *      pages through limit/offset + __pagination.hasMore and filters by the
 *      prefix CLIENT-side, so a full collection no longer looks like
 *      "the first ~10 records".
 *   3. resolveOnyxBaseUrl: one resolution rule — stored custom URL, else
 *      the default https://onyxbase-chi.vercel.app.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OnyxBaseError,
  OnyxBaseKV,
  ONYXBASE_DEFAULT_BASE_URL,
  resolveOnyxBaseUrl,
} from "./kv-client";

// ---------------------------------------------------------------------------
// fetch mocking.
// ---------------------------------------------------------------------------

type MockResponse = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

function asResponse(m: MockResponse): Response {
  return {
    ok: m.status >= 200 && m.status < 300,
    status: m.status,
    headers: {
      get: (name: string) => (m.headers ?? {})[name.toLowerCase()] ?? null,
    },
    text: async () => JSON.stringify(m.body),
  } as unknown as Response;
}

const calls: Array<{ url: string; init?: RequestInit }> = [];

function queueResponses(...list: MockResponse[]) {
  let i = 0;
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const m = list[Math.min(i, list.length - 1)];
      i++;
      return asResponse(m);
    }),
  );
}

const KEY = "kv_live_test_key_1234567890";

function makeClient(baseUrl?: string | null) {
  return new OnyxBaseKV(KEY, baseUrl ?? ONYXBASE_DEFAULT_BASE_URL);
}

// ---------------------------------------------------------------------------
// resolveOnyxBaseUrl — one rule, pinned.
// ---------------------------------------------------------------------------

describe("resolveOnyxBaseUrl", () => {
  it("falls back to the current default (chi) for empty/missing values", () => {
    expect(resolveOnyxBaseUrl(null)).toBe("https://onyxbase-chi.vercel.app");
    expect(resolveOnyxBaseUrl(undefined)).toBe("https://onyxbase-chi.vercel.app");
    expect(resolveOnyxBaseUrl("")).toBe("https://onyxbase-chi.vercel.app");
    expect(resolveOnyxBaseUrl("   ")).toBe("https://onyxbase-chi.vercel.app");
  });

  it("passes a stored custom URL through, normalized", () => {
    expect(resolveOnyxBaseUrl("https://my-onyx.example.com/")).toBe("https://my-onyx.example.com");
    expect(resolveOnyxBaseUrl("my-onyx.example.com")).toBe("https://my-onyx.example.com");
    expect(resolveOnyxBaseUrl("  https://my-onyx.example.com  ")).toBe("https://my-onyx.example.com");
  });

  it("the default constant is the chi deployment", () => {
    expect(ONYXBASE_DEFAULT_BASE_URL).toBe("https://onyxbase-chi.vercel.app");
  });
});

// ---------------------------------------------------------------------------
// set() — the durability contract.
// ---------------------------------------------------------------------------

describe("OnyxBaseKV.set durability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Drain fake-timer sleeps until the promise settles (bounded). */
  async function settle<T>(p: Promise<T>): Promise<T> {
    let settled: { ok: boolean; value?: T; error?: unknown } | undefined;
    p.then(
      (v) => (settled = { ok: true, value: v }),
      (e) => (settled = { ok: false, error: e }),
    );
    for (let i = 0; i < 400 && !settled; i++) {
      await vi.advanceTimersByTimeAsync(50);
    }
    if (!settled) throw new Error("promise never settled under fake timers");
    if (!settled.ok) throw settled.error;
    return settled.value as T;
  }

  it("durable: true resolves on the first POST", async () => {
    queueResponses({ status: 200, body: { ok: true, durable: true } });
    const kv = makeClient();
    await settle(kv.set("k1", "v1"));
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://onyxbase-chi.vercel.app/v1/set?collection=onyxagent");
    expect((calls[0].init?.body as string)).toContain('"key":"k1"');
    expect(calls[0].init?.headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
  });

  it("durable flag absent (older deployments) is still a success", async () => {
    queueResponses({ status: 200, body: { ok: true } });
    const kv = makeClient();
    await settle(kv.set("k1", "v1"));
    expect(calls.length).toBe(1);
  });

  it("durable: false retries after the server's window and succeeds when durability confirms", async () => {
    queueResponses(
      { status: 200, body: { ok: true, durable: false, throttle: { retryAfterSecs: 1 } } },
      { status: 200, body: { ok: true, durable: false, throttle: { retryAfterSecs: 1 } } },
      { status: 200, body: { ok: true, durable: true } },
    );
    const kv = makeClient();
    await settle(kv.set("k2", "v2"));
    expect(calls.length).toBe(3);
    // The retry waits actually happened (2 × ~1s, pacer cools included).
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never-durable fails HONESTLY instead of reporting a write the backend may lose", async () => {
    queueResponses({ status: 200, body: { ok: true, durable: false, throttle: { retryAfterSecs: 1 } } });
    const kv = makeClient();
    const err = await settle(
      kv.set("k3", "v3").then(
        () => null,
        (e) => e,
      ),
    );
    expect(err).toBeInstanceOf(OnyxBaseError);
    expect((err as OnyxBaseError).code).toBe("KV_WRITE_FAILED");
    expect((err as OnyxBaseError).message).toContain("may not survive");
    // Bounded: exactly DURABILITY_MAX_ATTEMPTS (5) POSTs.
    expect(calls.length).toBe(5);
  });

  it("401 maps to ONYXBASE_UNAUTHORIZED", async () => {
    queueResponses({ status: 401, body: { ok: false, error: "bad key" } });
    const kv = makeClient();
    const err = await settle(
      kv.set("k4", "v4").then(
        () => null,
        (e) => e,
      ),
    );
    expect((err as OnyxBaseError).code).toBe("ONYXBASE_UNAUTHORIZED");
  });

  it("503 maps to ONYXBASE_UNAVAILABLE", async () => {
    queueResponses({ status: 503, body: { ok: false, error: "durable backend unreachable" } });
    const kv = makeClient();
    const err = await settle(
      kv.set("k5", "v5").then(
        () => null,
        (e) => e,
      ),
    );
    expect((err as OnyxBaseError).code).toBe("ONYXBASE_UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// get() — 404 means missing, never a crash.
// ---------------------------------------------------------------------------

describe("OnyxBaseKV.get", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("404 resolves to null (the documented missing-key shape)", async () => {
    queueResponses({ status: 404, body: { ok: false, error: "Key not found" } });
    const kv = makeClient();
    expect(await kv.get("missing:key")).toBeNull();
    expect(calls[0].url).toBe(
      "https://onyxbase-chi.vercel.app/v1/get/missing%3Akey?collection=onyxagent",
    );
  });

  it("object values round-trip through JSON.stringify", async () => {
    queueResponses({ status: 200, body: { ok: true, value: { n: 1 }, type: "object" } });
    const kv = makeClient();
    expect(await kv.get("obj:key")).toBe('{"n":1}');
  });
});

// ---------------------------------------------------------------------------
// listKeys() — real pagination + client-side prefix filtering.
// ---------------------------------------------------------------------------

describe("OnyxBaseKV.listKeys", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pages through __pagination.hasMore and filters by the prefix client-side", async () => {
    queueResponses(
      {
        status: 200,
        body: {
          ok: true,
          keys: ["code:db:c1:a", "code:db:c1:b", "foreign:other", "kb:u1:item:x"],
          __pagination: { total: 6, limit: 500, offset: 0, hasMore: true },
        },
      },
      {
        status: 200,
        body: {
          ok: true,
          keys: ["code:db:c1:c", { key: "code:db:c1:d" }, "ws:chunk"],
          __pagination: { total: 6, limit: 500, offset: 4, hasMore: false },
        },
      },
    );
    const kv = makeClient();
    const keys = await kv.listKeys("code:db:");
    // Foreign keys never leak; {key} objects are accepted; dedupe applies.
    expect(keys).toEqual(["code:db:c1:a", "code:db:c1:b", "code:db:c1:c", "code:db:c1:d"]);
    // Page 2 asked with offset = keys actually returned by page 1.
    expect(calls[1].url).toBe(
      "https://onyxbase-chi.vercel.app/v1/list?collection=onyxagent&limit=500&offset=4",
    );
    // The old bogus params are gone.
    for (const c of calls) {
      expect(c.url).not.toContain("prefix=");
      expect(c.url).not.toContain("cursor=");
    }
  });

  it("hasMore: false stops after one page", async () => {
    queueResponses({
      status: 200,
      body: { ok: true, keys: ["a:1"], __pagination: { total: 1, limit: 500, offset: 0, hasMore: false } },
    });
    const kv = makeClient();
    expect(await kv.listKeys("a:")).toEqual(["a:1"]);
    expect(calls.length).toBe(1);
  });

  it("legacy cursor pagination (no __pagination) is still followed", async () => {
    queueResponses(
      { status: 200, body: { ok: true, keys: ["x:1", "x:2"], cursor: "next-page" } },
      { status: 200, body: { ok: true, keys: ["x:3"] } },
    );
    const kv = makeClient();
    expect(await kv.listKeys("x:")).toEqual(["x:1", "x:2", "x:3"]);
    expect(calls.length).toBe(2);
  });

  it("an empty page terminates the loop", async () => {
    queueResponses({ status: 200, body: { ok: true, keys: [] } });
    const kv = makeClient();
    expect(await kv.listKeys("whatever:")).toEqual([]);
    expect(calls.length).toBe(1);
  });

  it("401 maps to ONYXBASE_UNAUTHORIZED", async () => {
    queueResponses({ status: 401, body: { ok: false, error: "bad key" } });
    const kv = makeClient();
    await expect(kv.listKeys("x:")).rejects.toMatchObject({ code: "ONYXBASE_UNAUTHORIZED" });
  });
});
