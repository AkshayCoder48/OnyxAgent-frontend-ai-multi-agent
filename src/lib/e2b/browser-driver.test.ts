/**
 * Browser-driver boot hardening regression tests (the "Sync API inside the
 * asyncio loop" live incident).
 *
 * ROOT CAUSE (reproduced live before fixing): a leaked Playwright Sync
 * instance parks its dispatcher greenlet inside loop.run_until_complete()
 * and leaves the owning thread's running-loop flag set FOREVER — every
 * later sync_playwright().start() in that thread then fails instantly with
 * "It looks like you are using Playwright Sync API inside the asyncio
 * loop. Please use the Async API instead." In the driver this poisoned
 * BOTH boot attempts (cloakbrowser + chromium fallback) permanently after
 * one failed launch (e.g. stale Chromium profile SingletonLock from a
 * hard-killed browser) or after a close→reboot cycle on the fallback
 * runtime (do_close never stopped pw).
 *
 * These tests pin the four layers of the fix:
 *   1. `_unpoison_asyncio()` clears the flag before EVERY launch attempt;
 *   2. the fallback's pw is STOPPED on failure (never leaked);
 *   3. stale profile Singleton locks are cleared before launching;
 *   4. a total boot failure raises BootFailure → the reply is written →
 *      the driver EXITS (leaked resources die; the session manager boots a
 *      fresh driver for the next command).
 * Plus a LIVE python3 repro (skipped when python3/playwright are absent)
 * that exercises the driver's actual `_unpoison_asyncio` source.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_DRIVER_PY_SOURCE } from "./browser-driver";

const SRC = BROWSER_DRIVER_PY_SOURCE;

/** All occurrence indexes of a literal substring. */
function all(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return out;
}

function section(startMarker: string, endMarker: string): string {
  const s = SRC.indexOf(startMarker);
  expect(s, `${startMarker} not found`).toBeGreaterThan(-1);
  const e = SRC.indexOf(endMarker, s);
  expect(e, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(s);
  return SRC.slice(s, e);
}

describe("browser-driver boot hardening (asyncio poisoning fix)", () => {
  it("the embedded Python has no backticks / ${ (packaging constraint)", () => {
    expect(SRC).not.toContain("`");
    expect(SRC).not.toContain("${");
  });

  it("clears stale Chromium profile Singleton locks before launching", () => {
    expect(SRC).toContain("def _clear_stale_profile_locks");
    expect(SRC).toContain("SingletonLock");
    const boot = section("def boot_browser", "def ensure_pages");
    const locksAt = boot.indexOf("_clear_stale_profile_locks()");
    const cloakAt = boot.indexOf("from cloakbrowser import");
    expect(locksAt).toBeGreaterThan(-1);
    expect(cloakAt).toBeGreaterThan(-1);
    // Locks are cleared BEFORE the first launch attempt.
    expect(locksAt).toBeLessThan(cloakAt);
  });

  it("unpoisons the asyncio running-loop flag before EVERY launch attempt", () => {
    const boot = section("def boot_browser", "def ensure_pages");
    const unpoisonCalls = all(boot, "_unpoison_asyncio()");
    expect(unpoisonCalls.length).toBeGreaterThanOrEqual(3);
    const cloakImportAt = boot.indexOf("from cloakbrowser import launch_persistent_context");
    const cloakLaunchAt = boot.indexOf("context = cb_launch(");
    const fallbackStartAt = boot.indexOf("pw = sync_playwright().start()");
    expect(cloakImportAt).toBeGreaterThan(-1);
    expect(fallbackStartAt).toBeGreaterThan(cloakImportAt);
    // One call BEFORE the CloakBrowser attempt…
    expect(unpoisonCalls[0]!).toBeLessThan(cloakImportAt);
    // …one after the CloakBrowser failure but BEFORE the fallback start…
    const between = unpoisonCalls.find((i) => i > cloakLaunchAt && i < fallbackStartAt);
    expect(between).toBeDefined();
    // …and the fallback's own except path unpoisons after a failed stop.
    const fallbackExceptAt = boot.indexOf("except Exception as e:", fallbackStartAt);
    expect(fallbackExceptAt).toBeGreaterThan(-1);
    const afterFallback = unpoisonCalls.find((i) => i > fallbackExceptAt);
    expect(afterFallback).toBeDefined();
  });

  it("STOPS the fallback's playwright instance on failure (never leaks)", () => {
    const boot = section("def boot_browser", "def ensure_pages");
    const fallbackStartAt = boot.indexOf("pw = sync_playwright().start()");
    const pwStopAt = boot.indexOf("pw.stop()", fallbackStartAt);
    expect(pwStopAt).toBeGreaterThan(-1);
    // …and it happens INSIDE the failure path, after the launch attempt.
    expect(pwStopAt).toBeGreaterThan(boot.indexOf("runtime = \"chromium\""));
  });

  it("a total boot failure raises BootFailure and the driver exits AFTER writing the reply", () => {
    expect(SRC).toContain("class BootFailure(RuntimeError)");
    const boot = section("def boot_browser", "def ensure_pages");
    expect(boot).toContain("raise BootFailure(boot_error)");
    const mainFn = section("def main():", 'if __name__ == "__main__":');
    const bootFailCatch = mainFn.indexOf("except BootFailure as e:");
    const genericCatch = mainFn.indexOf("except Exception as e:", bootFailCatch);
    expect(bootFailCatch).toBeGreaterThan(-1);
    // BootFailure is caught BEFORE the generic Exception handler.
    expect(genericCatch).toBeGreaterThan(bootFailCatch);
    const resWriteAt = mainFn.indexOf("os.replace(res_path");
    const exitAt = mainFn.indexOf("os._exit(1)");
    expect(resWriteAt).toBeGreaterThan(-1);
    expect(exitAt).toBeGreaterThan(resWriteAt);
    // The exit is gated on the boot-failure flag (normal actions keep the
    // driver alive).
    expect(mainFn).toContain("if boot_failed:");
    // The reported error is marked recoverable so the model retries.
    expect(mainFn).toContain('"browser_startup_failed"');
  });

  it("do_close fully tears down (stops pw) so a close→reboot cannot poison the thread", () => {
    const doClose = section("def do_close(cmd):", "HANDLERS = {");
    expect(doClose).toContain("_reset_browser_state()");
  });

  it("a dead context (sandbox resume) is detected and rebuilt instead of erroring forever", () => {
    expect(SRC).toContain("def _context_alive");
    const boot = section("def boot_browser", "def ensure_pages");
    expect(boot).toContain("_context_alive()");
    expect(boot).toContain("_reset_browser_state()");
  });
});

// ---------------------------------------------------------------------------
// LIVE repro — runs the driver's ACTUAL _unpoison_asyncio source under a
// real playwright install. Skipped when python3 or playwright is missing.
// ---------------------------------------------------------------------------

const PY = `import asyncio as _asyncio, re, sys
src = open(sys.argv[1], "r", encoding="utf-8").read()
m = re.search(r"def _unpoison_asyncio\\(\\):.*?(?=\\ndef |\\nclass )", src, re.S)
if not m:
    print("EXTRACT:FAIL"); sys.exit(1)
# The driver's module-level "import asyncio" is NOT part of the extracted
# function — provide it, or _unpoison_asyncio's NameError gets swallowed
# by its own except:pass and the test would no-op.
ns = {"asyncio": _asyncio}
exec(m.group(0), ns)
unpoison = ns["_unpoison_asyncio"]
from playwright.sync_api import sync_playwright
# 1. start + leak (what a failed launch did pre-fix)
try:
    pw1 = sync_playwright().start()
    print("A start OK")
except Exception as e:
    print("A FAIL", str(e)[:80]); sys.exit(1)
# 2. second start in the same thread -> the live incident's error
try:
    sync_playwright().start()
    print("B NOT-POISONED")
except Exception as e:
    print("B POISONED:", "asyncio loop" in str(e))
# 3. the driver's unpoison + a fresh start -> must succeed
unpoison()
try:
    pw3 = sync_playwright().start()
    pw3.stop()
    print("C UNPOISONED-OK")
except Exception as e:
    print("C FAIL", str(e)[:80]); sys.exit(1)
`;

function probe(cmd: string[]): boolean {
  try {
    execFileSync(cmd[0]!, cmd.slice(1), { timeout: 30_000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasPython = probe(["python3", "--version"]);
const hasPlaywright = hasPython && probe(["python3", "-c", "import playwright"]);

describe.skipIf(!hasPython || !hasPlaywright)(
  "live repro: leaked sync_playwright poisons the thread; the driver's _unpoison_asyncio fixes it",
  () => {
    it(
      "start → leak → poisoned start fails → _unpoison_asyncio → start OK",
      { timeout: 60_000 },
      () => {
        const dir = mkdtempSync(join(tmpdir(), "onyx-driver-"));
        try {
          const driverPy = join(dir, "driver.py");
          const reproPy = join(dir, "repro.py");
          writeFileSync(driverPy, SRC);
          writeFileSync(reproPy, PY);
          const out = execFileSync("python3", [reproPy, driverPy], {
            timeout: 55_000,
            encoding: "utf8",
          });
          expect(out).toContain("A start OK");
          // The poisoned start must reproduce the live incident's error…
          expect(out).toContain("B POISONED: True");
          // …and the driver's actual function must clear it.
          expect(out).toContain("C UNPOISONED-OK");
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  },
);
