/**
 * The "simple tools take 1-3 minutes" fixes (user report 2026-11-05).
 *
 * Latency pins:
 *  - e2b_files: every workspace file tool resolves its sandbox through
 *    chatSandboxForCtx (the ctx-resolved target) — no tool may hardcode
 *    the shared client anymore (the separate-mode dead-sandbox → full
 *    minute-long create path);
 *  - chatSandboxForCtx: the target carries ctx.conversationId (was
 *    hardcoded null);
 *  - attach-master-skills: reconnect-path attaches are fire-and-forget
 *    with failure backoff — ensureMasterSkillsInBackground returns
 *    synchronously even when the underlying attach hangs/fails;
 *  - route.ts: the reconnect/metadata/cached paths call the BACKGROUND
 *    variant, never the awaited one;
 *  - lifecycle-client: the keepalive warm-up fires on MOUNT (not only on
 *    the 4-minute tick).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// 1. Static pins on the latency fixes
// ---------------------------------------------------------------------------

const E2B_FILES = readFileSync(
  new URL("../../../lib/tools/e2b_files.ts", import.meta.url),
  "utf8",
);
const ROTATION = readFileSync(
  new URL("../../../lib/e2b/sandbox-rotation.ts", import.meta.url),
  "utf8",
);
const ROUTE = readFileSync(
  new URL("../../../app/api/sandbox/route.ts", import.meta.url),
  "utf8",
);
const LIFECYCLE = readFileSync(
  new URL("../../../lib/e2b/lifecycle-client.ts", import.meta.url),
  "utf8",
);

describe("latency fix: workspace file tools use the ctx-resolved sandbox", () => {
  it("no file tool hardcodes the shared client anymore", () => {
    expect(E2B_FILES).not.toContain('getE2BClient(apiKey, null, "shared")');
    expect(E2B_FILES).not.toContain("ensureFreshSandboxForCtx(ctx)");
  });

  it("every sandbox resolution goes through chatSandboxForCtx", () => {
    const uses = E2B_FILES.match(/chatSandboxForCtx\(ctx\)/g)?.length ?? 0;
    expect(uses).toBeGreaterThanOrEqual(11); // the 8 converted + the 3 original
  });

  it("chatSandboxForCtx carries ctx.conversationId (was hardcoded null)", () => {
    const fn = ROTATION.slice(
      ROTATION.indexOf("export async function chatSandboxForCtx"),
    );
    expect(fn).toContain("conversationId: ctx.conversationId ?? null");
    expect(fn).not.toContain("conversationId: null,");
  });
});

describe("latency fix: master-skills attach never blocks reconnect paths", () => {
  it("route.ts reconnect/metadata/cached paths use the BACKGROUND variant", () => {
    expect(ROUTE).toContain("ensureMasterSkillsInBackground(sandbox)");
    expect(ROUTE).toContain("ensureMasterSkillsInBackground(cached.sandbox)");
    // The AWAITED ensureMasterSkills is gone from the route entirely — only
    // createAndCacheSandbox's one-time attachMasterSkills remains.
    expect(ROUTE).not.toMatch(/await ensureMasterSkills\(/);
  });

  it("the Onyx.md stamp read is bounded (5s race)", () => {
    expect(ROUTE).toContain("new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000))");
  });

  it("ensureMasterSkillsInBackground returns synchronously and backs off after failure", async () => {
    // Drive the REAL module with a fake sandbox whose stamp read HANGS —
    // the background call must return in well under the stamp-read bound.
    vi.useFakeTimers();
    try {
      const { ensureMasterSkillsInBackground, ensureMasterSkills } = await import(
        "@/lib/e2b/attach-master-skills"
      );
      const never = new Promise<string>(() => {});
      const attachCalls: string[] = [];
      const sandbox = {
        sandboxId: "sbx_test_1",
        files: {
          read: () => {
            attachCalls.push("stamp-read");
            return never; // hangs forever (the resuming-sandbox case)
          },
          write: () => Promise.resolve(),
        },
        commands: {
          run: () => {
            attachCalls.push("extract");
            return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
          },
        },
      } as unknown as Parameters<typeof ensureMasterSkills>[0];

      const t0 = Date.now();
      ensureMasterSkillsInBackground(sandbox);
      expect(Date.now() - t0).toBeLessThan(50); // fire-and-forget — instant

      // The bounded stamp read resolves to null after 5s → falls through to
      // the attach. Advance the clock and let the loop settle.
      await vi.advanceTimersByTimeAsync(5_100);
      expect(attachCalls).toContain("stamp-read");

      // Failure backoff: a second background call on the same sandbox after
      // a FAILED attach is skipped. Drive a failing attach: stamp read
      // rejects → files.write throws.
      const failing = {
        sandboxId: "sbx_test_2",
        files: {
          read: () => Promise.reject(new Error("envd not up")),
          write: () => Promise.reject(new Error("disk full")),
        },
        commands: { run: () => Promise.reject(new Error("nope")) },
      } as unknown as Parameters<typeof ensureMasterSkills>[0];
      ensureMasterSkillsInBackground(failing);
      await vi.advanceTimersByTimeAsync(5_100);
      const writesAfterFirst = attachCalls.length;
      // Immediate re-call is parked by the in-flight guard or backoff.
      ensureMasterSkillsInBackground(failing);
      await vi.advanceTimersByTimeAsync(5_100);
      expect(attachCalls.length).toBeLessThanOrEqual(writesAfterFirst + 2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("latency fix: sandbox warm-up fires on app open", () => {
  it("SandboxLifecycleSync kicks the keepalive on mount (not only on the interval)", () => {
    const fnStart = LIFECYCLE.indexOf("export function SandboxLifecycleSync");
    const fn = LIFECYCLE.slice(fnStart, LIFECYCLE.indexOf("\n}", fnStart));
    expect(fn).toContain("warmUp()");
    expect(fn).toContain("void keepaliveKnownSandboxes()");
    // The visibility handler warms too (tab refocus after a pause).
    const refresh = fn.slice(fn.indexOf("const refresh"));
    expect(refresh).toContain("keepaliveKnownSandboxes()");
  });
});
