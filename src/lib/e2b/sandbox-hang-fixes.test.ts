// @vitest-environment jsdom
/**
 * The "first tool call hangs forever / takes 2-6 minutes" fixes (user report
 * 2026-11-28), behavior + static pins.
 *
 * Root causes fixed:
 *  1. E2BClient.call ran bare fetch()s with NO deadline — a stalled
 *     connection hung the tool call forever AND pinned every coalesced
 *     caller onto the dead promise. Every call now races an
 *     AbortController (DEFAULT_CALL_TIMEOUT_MS, 120s) and surfaces a
 *     descriptive E2BError on timeout.
 *  2. The rotation fetch in sandbox-rotation.ts had the same disease while
 *     holding the per-target rotation mutex — one wedged rotation
 *     deadlocked EVERY subsequent tool call in the session. Now bounded
 *     (ROTATION_CALL_TIMEOUT_MS, 10 min — rotation is real work).
 *  3. Nothing created the sandbox until the first tool call paid the whole
 *     cold start inline. prewarmSandbox() kicks ensureFreshSandbox AT CHAT
 *     START (chat-workspace mount), deduped + failure-swallowing; the lazy
 *     tool path remains the fallback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Static pins (source contracts) ─────────────────────────────────────────
// cwd-relative (NOT import.meta.url): this file runs under jsdom, where the
// module URL is http-served and `new URL(...)` isn't a file:// URL.
const CLIENT = readFileSync(resolve(process.cwd(), "src/lib/e2b/client.ts"), "utf8");
const ROTATION = readFileSync(
  resolve(process.cwd(), "src/lib/e2b/sandbox-rotation.ts"),
  "utf8",
);
const WORKSPACE = readFileSync(
  resolve(process.cwd(), "src/components/chat/chat-workspace.tsx"),
  "utf8",
);

describe("static: every /api/sandbox fetch is deadline-bounded", () => {
  it("client.ts aborts stalled calls (the forever-hang fix)", () => {
    expect(CLIENT).toContain("DEFAULT_CALL_TIMEOUT_MS = 120_000");
    expect(CLIENT).toContain("controller.abort()");
    // The coalesced wrapper threads the budget through.
    expect(CLIENT).toMatch(
      /private async call<T>\(\s*action: string,\s*args: Record<string, unknown> = \{\},\s*timeoutMs = DEFAULT_CALL_TIMEOUT_MS,/,
    );
  });

  it("sandbox-rotation.ts bounds the rotate fetch (the mutex-deadlock fix)", () => {
    expect(ROTATION).toContain("ROTATION_CALL_TIMEOUT_MS = 10 * 60 * 1000");
    expect(ROTATION).toContain("signal: controller.signal");
  });

  it("chat-workspace prewarms the sandbox at mount (chat start, not first message)", () => {
    expect(WORKSPACE).toContain("prewarmSandbox({ userId: prewarmUserId })");
    // Gated on auth resolution — the key is per-user.
    expect(WORKSPACE).toContain("if (!prewarmAuthResolved) return;");
  });
});

// ── Behavior: the prewarm module ───────────────────────────────────────────
// Import AFTER stubbing globals where needed; the module reads localStorage
// (sandbox ids) and fetch (create calls) — both stubbed below.

const realFetch = globalThis.fetch;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("prewarmSandbox", () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
  });

  it("returns false (and fetches nothing) when no user / no key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // No vault key service answer — the module imports settingsService
    // dynamically; stub it to resolve empty.
    vi.doMock("@/lib/services", () => ({
      settingsService: {
        getDecryptedSandboxKey: vi.fn(async () => null),
      },
    }));
    vi.doMock("@/stores", () => ({
      useAuthStore: { getState: () => ({ user: null }) },
    }));
    vi.doMock("./env-key", () => ({
      getEffectiveE2BKey: vi.fn(async () => null),
    }));
    const { prewarmSandbox } = await import("./sandbox-rotation");
    const ok = await prewarmSandbox({});
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("kicks exactly ONE create for concurrent callers (dedupe) and warms", async () => {
    const createCalls: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      createCalls.push(body);
      // The create action → resolve with a sandbox id.
      if (body.action === "create") {
        return jsonRes({ sandboxId: "sbx-prewarm-1" });
      }
      return jsonRes({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.doMock("@/lib/services", () => ({
      settingsService: {
        getDecryptedSandboxKey: vi.fn(async () => "e2b_test_key"),
      },
    }));
    vi.doMock("@/stores", () => ({
      useAuthStore: { getState: () => ({ user: { id: "u1" } }) },
    }));
    // vi.resetModules() does NOT clear the doMock registry — re-mock the
    // key resolver in EVERY test that expects a key, or the previous
    // test's null-mock leaks in.
    vi.doMock("./env-key", () => ({
      getEffectiveE2BKey: vi.fn(async () => "e2b_test_key"),
    }));
    const { prewarmSandbox } = await import("./sandbox-rotation");

    // Two concurrent prewarms (StrictMode double-mount) + a settled await.
    const [a, b] = await Promise.all([
      prewarmSandbox({ userId: "u1" }),
      prewarmSandbox({ userId: "u1" }),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    // ONE create round-trip — the second caller shared the in-flight kick.
    const creates = createCalls.filter((c) => c.action === "create");
    expect(creates).toHaveLength(1);

    // Warmed recently → a THIRD prewarm is a no-op (no extra create).
    const c = await prewarmSandbox({ userId: "u1" });
    expect(c).toBe(true);
    expect(createCalls.filter((x) => x.action === "create")).toHaveLength(1);
  });

  it("never throws on a failed create — returns false, tools stay the fallback", async () => {
    const fetchMock = vi.fn(async () => jsonRes({ error: "boom" }, 500));
    vi.stubGlobal("fetch", fetchMock);
    vi.doMock("@/lib/services", () => ({
      settingsService: {
        getDecryptedSandboxKey: vi.fn(async () => "e2b_test_key"),
      },
    }));
    vi.doMock("@/stores", () => ({
      useAuthStore: { getState: () => ({ user: { id: "u1" } }) },
    }));
    vi.doMock("./env-key", () => ({
      getEffectiveE2BKey: vi.fn(async () => "e2b_test_key"),
    }));
    const { prewarmSandbox } = await import("./sandbox-rotation");
    const ok = await prewarmSandbox({ userId: "u1" });
    expect(ok).toBe(false);
    // The create WAS attempted (key resolved) — the failure is what made
    // it report not-warm, not a missing key.
    expect(fetchMock).toHaveBeenCalled();
  });
});

// ── Behavior: the client timeout (fake timers; the abort fires) ────────────
describe("E2BClient call timeout", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a stalled /api/sandbox call rejects after the budget instead of hanging forever", async () => {
    // A fetch that only ever settles when its AbortSignal fires — the
    // browser-native behavior the fix relies on (the pre-fix code with a
    // plain never-settling promise would hang FOREVER).
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const e = new Error("The operation was aborted");
              e.name = "AbortError";
              reject(e);
            });
          }),
      ),
    );
    const { getE2BClient, DEFAULT_CALL_TIMEOUT_MS } = await import("./client");
    const client = getE2BClient("e2b_timeout_key");

    const promise = client.listFiles("/home/user");
    const assertion = promise.then(
      () => {
        throw new Error("expected the stalled call to reject");
      },
      (err: unknown) => {
        expect((err as Error).message).toContain("timed out");
        expect((err as { status?: number }).status).toBe(408);
      },
    );
    // Advance past the budget — the AbortController must fire.
    await vi.advanceTimersByTimeAsync(DEFAULT_CALL_TIMEOUT_MS + 50);
    await assertion;
  });

  it("frees the coalescing slot after a timeout — the NEXT identical call starts fresh", async () => {
    let calls = 0;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      calls++;
      if (calls === 1) {
        // First call stalls until aborted…
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const e = new Error("The operation was aborted");
            e.name = "AbortError";
            reject(e);
          });
        });
      }
      // …the retry answers fast.
      return Promise.resolve(
        jsonRes({ items: [{ path: "/home/user/a.txt", type: "file" }] }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getE2BClient, DEFAULT_CALL_TIMEOUT_MS } = await import("./client");
    const client = getE2BClient("e2b_coalesce_key");

    const first = client.listFiles("/home/user");
    const firstAssert = first.then(
      () => {
        throw new Error("expected the stalled call to reject");
      },
      (err: unknown) => {
        expect((err as Error).message).toContain("timed out");
      },
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_CALL_TIMEOUT_MS + 50);
    await firstAssert;

    // Same args, same client — must NOT be pinned onto the dead promise.
    const entries = await client.listFiles("/home/user");
    expect(entries).toEqual([{ path: "/home/user/a.txt", type: "file" }]);
    expect(calls).toBe(2);
  });
});
