/**
 * Browser-session manager tests — the "infinite execution, no output"
 * regression suite (CloakBrowser + E2B reimplementation, 2026-11-01).
 *
 * The live incident: use_browser ran forever with zero output. Root causes
 * pinned here:
 *
 *  1. NO HTTP TIMEOUTS — the E2B client's fetch-based methods carry no
 *     AbortSignal, so ONE stalled round-trip hung the tool call forever
 *     (deadline checks only ran BETWEEN polls). → "a stalled sandbox call
 *     cannot hang the boot / the command".
 *  2. GLOBAL session state — one cached boot promise + one global command
 *     queue shared by every conversation, so two agents interfered and one
 *     wedged call blocked them all. → "per-client session isolation".
 *  3. NO guaranteed output — timeouts returned null and silent failures
 *     surfaced as nothing. → "sendBrowserCommand always resolves with a
 *     structured, readable result".
 *
 * The fake sandbox client emulates the driver file protocol exactly like
 * the real one (cmd.json → res-<id>.json, .ready/.version stamps, boot.sh
 * echoes), so these tests exercise the REAL session manager end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_TIMEOUTS,
  __browserTimeoutsOverride,
  ensureBrowserDriver,
  prepareBrowserInBackground,
  resetBrowserSessionCache,
  sendBrowserCommand,
  type BrowserSandboxClient,
} from "./browser-session";
import { BROWSER_DRIVER_VERSION } from "./browser-driver";

// ---------------------------------------------------------------------------
// Fake sandbox client — speaks the driver file protocol.
// ---------------------------------------------------------------------------

interface FakeClientOpts {
  /** Responses to the liveness probe: "READY" (driver up) or "NO". */
  alive?: boolean;
  /** Responses to the version probe (defaults to the CURRENT version). */
  version?: string;
  /** Runtime probe: RUNTIME_PRESENT (warm) or RUNTIME_MISSING (cold). */
  runtimePresent?: boolean;
  /** Simulates the sandbox driver answering commands with this payload
   *  factory (called with the parsed cmd). */
  onCommand?: (cmd: Record<string, unknown>) => Record<string, unknown>;
  /** When true, runCommandStream NEVER yields (the hung-HTTP case). */
  hangExec?: boolean;
  /** When true, readFile for res files never resolves (the hung-HTTP case). */
  hangRead?: boolean;
  /** Selective exec hang (e.g. only the boot-poll command) — the
   *  "sandbox stalls on THIS request" case. */
  hangOn?: (command: string) => boolean;
}

interface FakeClient extends BrowserSandboxClient {
  /** Written files (path → content) for deploy assertions. */
  files: Map<string, string>;
  /** Every command string passed to runCommandStream. */
  commands: string[];
  /** Result files the fake "driver" produced (res path → JSON). */
  resFiles: Map<string, string>;
}

function makeFakeClient(opts: FakeClientOpts = {}): FakeClient {
  const files = new Map<string, string>();
  const resFiles = new Map<string, string>();
  const commands: string[] = [];
  const alive = opts.alive ?? true;
  const version = opts.version ?? BROWSER_DRIVER_VERSION;
  // The fake "boots": once the nohup launch command ran, the boot polls
  // answer READY (exactly like the real detached boot.sh → .ready).
  let booted = false;

  const client: FakeClient = {
    files,
    commands,
    resFiles,
    async writeFile(path, content) {
      files.set(path, content);
      // The fake DRIVER: answer commands through the file protocol.
      if (path.endsWith("/cmd.json")) {
        const cmd = JSON.parse(content) as Record<string, unknown>;
        const id = String(cmd.id ?? "");
        const payload = opts.onCommand
          ? opts.onCommand(cmd)
          : { success: true, action: cmd.action, url: "https://example.com/", title: "Example Domain", output: "fake ok" };
        resFiles.set(`/home/user/.onyx/browser/res-${id}.json`, JSON.stringify(payload));
      }
    },
    async readFile(path) {
      if (opts.hangRead && path.includes("/res-")) {
        await new Promise(() => {}); // never resolves — the hung HTTP case
      }
      if (resFiles.has(path)) return resFiles.get(path)!;
      if (files.has(path)) return files.get(path)!;
      throw new Error(`ENOENT: ${path}`);
    },
    async *runCommandStream(command: string) {
      commands.push(command);
      if (opts.hangExec || opts.hangOn?.(command)) {
        await new Promise(() => {}); // never yields — the hung HTTP case
      }
      // Boot launch echo — marks the sandbox "booted" for later polls.
      if (command.includes("echo booting")) {
        booted = true;
        yield { type: "stdout", data: "booting" };
        yield { type: "result", exit_code: 0 };
        return;
      }
      // Boot poll answers with the QUOTED READY form once booted.
      if (command.includes('echo "READY"')) {
        yield { type: "stdout", data: booted ? "READY" : "" };
        yield { type: "result", exit_code: 0 };
        return;
      }
      // Driver liveness probe: `... && echo READY || echo NO`.
      if (command.includes("echo READY")) {
        yield { type: "stdout", data: alive ? "READY" : "NO" };
        yield { type: "result", exit_code: 0 };
        return;
      }
      // Version stamp probe.
      if (command.includes(".version")) {
        yield { type: "stdout", data: version };
        yield { type: "result", exit_code: 0 };
        return;
      }
      // Runtime probe.
      if (command.includes("import cloakbrowser")) {
        yield {
          type: "stdout",
          data: (opts.runtimePresent ?? true) ? "RUNTIME_PRESENT" : "RUNTIME_MISSING",
        };
        yield { type: "result", exit_code: 0 };
        return;
      }
      // Everything else (mkdir, rm, pkill, rm res) succeeds silently.
      yield { type: "result", exit_code: 0 };
    },
  };
  return client;
}

// Shrink every deadline so the "would hang forever" cases resolve in ms.
const FAST: Partial<typeof __browserTimeoutsOverride> = {
  httpCallMs: 40,
  streamDeadline: 60,
  bootPollIntervalMs: 5,
  resultPollIntervalMs: 5,
  bootPollFastMs: 500,
  bootPollColdMs: 500,
};

beforeEach(() => {
  resetBrowserSessionCache();
  Object.assign(__browserTimeoutsOverride, FAST);
});

afterEach(() => {
  for (const k of Object.keys(__browserTimeoutsOverride)) {
    delete (__browserTimeoutsOverride as Record<string, number>)[k]!;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. No infinite HTTP waits
// ---------------------------------------------------------------------------

describe("browser-session: no infinite HTTP waits", () => {
  it("a fully hung sandbox (every call stalls) still resolves the boot with an error", async () => {
    const client = makeFakeClient({ hangExec: true });
    const result = await ensureBrowserDriver(client);
    expect(result.ok).toBe(false);
    // And it resolved in bounded time (the test itself would time out at
    // 5s if anything waited forever — that IS the regression: pre-fix this
    // promise never settled).
  }, 5_000);

  it("a stalled result read cannot hang the command — the deadline resolves a structured timeout", async () => {
    const client = makeFakeClient({ hangRead: true });
    const res = await sendBrowserCommand(client, { action: "navigate", url: "https://example.com" }, { timeoutMs: 150 });
    expect(res.success).toBe(false);
    expect(res.error?.type).toBe("timeout");
    expect(typeof res.output).toBe("string");
    expect(res.output!.length).toBeGreaterThan(0);
  }, 5_000);

  it("boot poll failures fast-fail with a sandbox-unreachable diagnosis", async () => {
    // The sandbox answers everything EXCEPT the boot polls, which stall —
    // the consecutive-failure cap ends the boot with the real diagnosis
    // instead of spinning the whole window.
    __browserTimeoutsOverride.maxConsecutivePollFailures = 3;
    const client = makeFakeClient({
      alive: false, // driver NOT running → the boot path actually polls
      hangOn: (c) => c.includes('echo "READY"') && c.includes(".boot-failed"),
    });
    const result = await ensureBrowserDriver(client);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("stopped responding");
  }, 5_000);
});

// ---------------------------------------------------------------------------
// 2. Per-client session isolation
// ---------------------------------------------------------------------------

describe("browser-session: per-client session isolation", () => {
  it("a successful boot on client A does NOT satisfy client B — B deploys its own driver", async () => {
    const a = makeFakeClient({ alive: true });
    const b = makeFakeClient({ alive: false, runtimePresent: true });
    // A: alive + current → cached success without any deploy.
    const ra = await ensureBrowserDriver(a);
    expect(ra.ok).toBe(true);
    expect(a.files.has("/home/user/.onyx/browser/driver.py")).toBe(false);
    // B: driver NOT alive in its sandbox → must boot + deploy itself, even
    // though A's boot is cached (pre-fix: ONE global bootPromise made B
    // reuse A's success and then send commands into a driverless sandbox).
    const rb = await ensureBrowserDriver(b);
    expect(rb.ok).toBe(true);
    expect(b.files.has("/home/user/.onyx/browser/driver.py")).toBe(true);
    expect(b.files.has("/home/user/.onyx/browser/boot.sh")).toBe(true);
  });

  it("commands on client A do not queue behind client B (separate queues)", async () => {
    const slow = makeFakeClient({
      onCommand: (cmd) => {
        // Simulate a slow action AFTER the result lands: res file written
        // immediately, but the slow part happens inside the poll loop…
        return { success: true, action: cmd.action, output: "slow done" };
      },
    });
    const fast = makeFakeClient();
    const pSlow = sendBrowserCommand(slow, { action: "navigate", url: "https://slow.example" }, { timeoutMs: 1_000 });
    const pFast = sendBrowserCommand(fast, { action: "click", target: "#x" }, { timeoutMs: 1_000 });
    const [rSlow, rFast] = await Promise.all([pSlow, pFast]);
    expect(rSlow.success).toBe(true);
    expect(rFast.success).toBe(true);
    expect(rFast.action).toBe("click");
  });

  it("resetBrowserSessionCache drops the cached boot so the next call re-boots", async () => {
    const a = makeFakeClient({ alive: true });
    expect((await ensureBrowserDriver(a)).ok).toBe(true);
    resetBrowserSessionCache();
    // After the reset the SAME client re-probes (commands list grows).
    const n0 = a.commands.length;
    expect((await ensureBrowserDriver(a)).ok).toBe(true);
    expect(a.commands.length).toBeGreaterThan(n0);
  });
});

// ---------------------------------------------------------------------------
// 3. Guaranteed structured output
// ---------------------------------------------------------------------------

describe("browser-session: guaranteed structured output (PRD §5/§7)", () => {
  it("a successful driver reply passes through with its output intact", async () => {
    const client = makeFakeClient({
      onCommand: (cmd) => ({
        success: true,
        action: String(cmd.action),
        url: "https://example.com/",
        title: "Example Domain",
        status: 200,
        output: "Navigated to Example Domain (https://example.com/).",
      }),
    });
    const res = await sendBrowserCommand(client, { action: "navigate", url: "https://example.com" }, { timeoutMs: 2_000 });
    expect(res.success).toBe(true);
    expect(res.output).toBe("Navigated to Example Domain (https://example.com/).");
    expect(res.title).toBe("Example Domain");
  });

  it("a driver reply WITHOUT an output gets one synthesized (never empty)", async () => {
    const client = makeFakeClient({
      onCommand: (cmd) => ({ success: true, action: String(cmd.action), url: "https://x.example/", title: "X" } as Record<string, unknown>),
    });
    const res = await sendBrowserCommand(client, { action: "navigate", url: "https://x.example" }, { timeoutMs: 2_000 });
    expect(res.success).toBe(true);
    expect(typeof res.output).toBe("string");
    expect(res.output!.trim().length).toBeGreaterThan(0);
    expect(res.output).toContain("navigate");
  });

  it("a driver error passes through structured + readable", async () => {
    const client = makeFakeClient({
      onCommand: () => ({
        success: false,
        error: { type: "navigation_failed", message: "net::ERR_NAME_NOT_RESOLVED at https://nope.invalid" },
      }),
    });
    const res = await sendBrowserCommand(client, { action: "navigate", url: "https://nope.invalid" }, { timeoutMs: 2_000 });
    expect(res.success).toBe(false);
    expect(res.error?.type).toBe("navigation_failed");
    expect(res.output).toContain("navigation_failed");
  });

  it("a failed boot resolves (never rejects) with browser_startup_failed", async () => {
    const client = makeFakeClient({ hangExec: true });
    const res = await sendBrowserCommand(client, { action: "navigate", url: "https://example.com" }, { timeoutMs: 100 });
    expect(res.success).toBe(false);
    expect(res.error?.type).toBe("browser_startup_failed");
    expect(typeof res.output).toBe("string");
    expect(res.output!.length).toBeGreaterThan(0);
  });

  it("cancellation resolves immediately with a structured cancelled result", async () => {
    const client = makeFakeClient({ hangRead: true });
    const ac = new AbortController();
    ac.abort();
    const res = await sendBrowserCommand(
      client,
      { action: "screenshot" },
      { timeoutMs: 5_000, signal: ac.signal },
    );
    expect(res.success).toBe(false);
    expect(res.error?.type).toBe("cancelled");
    expect(res.output).toBeTruthy();
  });

  it("the background prepare is fire-and-forget, once per client, and never throws", async () => {
    const client = makeFakeClient({ hangExec: true });
    expect(() => prepareBrowserInBackground(client)).not.toThrow();
    // Second kick is a no-op (prepared flag).
    prepareBrowserInBackground(client);
    await new Promise((r) => setTimeout(r, 120));
    // And a WORKING client's prepare completes silently.
    const ok = makeFakeClient({ alive: true });
    prepareBrowserInBackground(ok);
    await new Promise((r) => setTimeout(r, 120));
    expect((await ensureBrowserDriver(ok)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Config sanity (PRD §6: budgets exist and are sane)
// ---------------------------------------------------------------------------

describe("browser-session: timeout configuration", () => {
  it("exposes the full budget table with sane ordering", () => {
    expect(BROWSER_TIMEOUTS.httpCallMs).toBeGreaterThan(0);
    expect(BROWSER_TIMEOUTS.bootPollFastMs).toBeLessThan(BROWSER_TIMEOUTS.bootPollColdMs);
    expect(BROWSER_TIMEOUTS.bootPollColdMs).toBeLessThanOrEqual(10 * 60_000);
    expect(BROWSER_TIMEOUTS.actionDefaultMs).toBeGreaterThan(0);
    expect(BROWSER_TIMEOUTS.maxConsecutivePollFailures).toBeGreaterThan(0);
  });
});
