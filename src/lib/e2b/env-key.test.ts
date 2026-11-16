// @vitest-environment jsdom
/**
 * getEffectiveE2BKey env-lane resilience: a TRANSIENT /api/sandbox fetch
 * failure (serverless cold start, network blip) must not resolve the key to
 * null for the whole session — the old negative cache disabled the zero-config
 * lane (no reattach after refresh, no dispatch) until the next reload.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchCalls: Array<Response | Error> = [];

function stubFetch(script: Array<Response | Error>) {
  fetchCalls.length = 0;
  fetchCalls.push(...script);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const next = fetchCalls.shift();
      if (next instanceof Error) throw next;
      return next;
    }),
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(async () => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("getEffectiveE2BKey — transient env-check failures", () => {
  it("retries once and resolves the sentinel when the first fetch throws but the second answers", async () => {
    stubFetch([new Error("cold start connection refused"), json({ hasEnvKey: true })]);
    const { getEffectiveE2BKey } = await import("./env-key");
    const key = await getEffectiveE2BKey("user_1");
    expect(key).toBe("USE_SERVER_ENV");
  });

  it("retries when the first response is unparseable garbage", async () => {
    stubFetch([
      new Response("<<bad gateway html>>", { status: 502 }),
      json({ hasEnvKey: true }),
    ]);
    const { getEffectiveE2BKey } = await import("./env-key");
    const key = await getEffectiveE2BKey("user_1");
    expect(key).toBe("USE_SERVER_ENV");
  });

  it("does NOT cache a failed check — the next call refetches", async () => {
    stubFetch([new Error("blip"), json({ hasEnvKey: true }), json({ hasEnvKey: true })]);
    const { getEffectiveE2BKey, serverHasE2bEnvKey } = await import("./env-key");
    // First resolution: throw → retry → true (sentinel).
    expect(await getEffectiveE2BKey("user_1")).toBe("USE_SERVER_ENV");
    // A later check must still answer true from a REAL response (cache only
    // holds confirmed answers).
    expect(await serverHasE2bEnvKey()).toBe(true);
  });

  it("returns null honestly when the server CONFIRMED it has no env key", async () => {
    stubFetch([json({ hasEnvKey: false }), json({ hasEnvKey: false })]);
    const { getEffectiveE2BKey } = await import("./env-key");
    const key = await getEffectiveE2BKey("user_1");
    expect(key).toBeNull();
  });
});
