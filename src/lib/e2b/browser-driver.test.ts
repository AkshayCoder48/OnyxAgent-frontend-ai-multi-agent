/**
 * Browser-driver regression tests (CloakBrowser + E2B reimplementation,
 * 2026-11-01).
 *
 * Layer 1 — the ORIGINAL boot-hardening suite (the "Sync API inside the
 * asyncio loop" live incident): a leaked Playwright Sync instance parks its
 * dispatcher greenlet inside loop.run_until_complete() and leaves the owning
 * thread's running-loop flag set FOREVER. These pin the four layers of that
 * fix (unpoison before every attempt / stop the fallback's pw / clear stale
 * profile locks / BootFailure → reply → exit).
 *
 * Layer 2 — the REIMPLEMENTATION invariants (the "runs forever, no output"
 * incident): the per-action watchdog, the structured event log, the
 * guaranteed-output contract, and the full PRD action surface.
 *
 * Plus a LIVE python3 repro (skipped when python3/playwright are absent)
 * that exercises the driver's actual `_unpoison_asyncio` source.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_DRIVER_PY_SOURCE, BROWSER_DRIVER_VERSION, BROWSER_BOOT_SH_SOURCE } from "./browser-driver";

const SRC = BROWSER_DRIVER_PY_SOURCE;
const BOOT = BROWSER_BOOT_SH_SOURCE;

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

  it("the version stamp is interpolated into the driver source", () => {
    expect(SRC).toContain(`DRIVER_VERSION = "${BROWSER_DRIVER_VERSION}"`);
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
    expect(pwStopAt).toBeGreaterThan(boot.indexOf('runtime = "chromium"'));
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
    // The reply is written (atomically) BEFORE the exit.
    const resWriteAt = mainFn.indexOf("_write_json_atomic(res_path, result)");
    const exitAt = mainFn.indexOf("os._exit(1)");
    expect(resWriteAt).toBeGreaterThan(-1);
    expect(exitAt).toBeGreaterThan(resWriteAt);
    // The exit is gated on the boot-failure flag (normal actions keep the
    // driver alive) — and the flag is initialized for EVERY command path.
    expect(mainFn).toContain("if boot_failed:");
    expect(mainFn).toContain("boot_failed = False");
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

describe("browser-driver watchdog (infinite-execution elimination)", () => {
  it("arms a per-command watchdog with an action budget and disarms after the handler", () => {
    const mainFn = section("def main():", 'if __name__ == "__main__":');
    expect(mainFn).toContain("_arm_watchdog(cid, action, budget)");
    // Disarmed in the FINALLY path of preboot AND right after the handler.
    expect(all(SRC, "_disarm_watchdog()").length).toBeGreaterThanOrEqual(2);
  });

  it("the watchdog kills the wedged browser AND answers the client itself", () => {
    const wd = section("def watchdog_loop", "def _sweep_stale_results");
    // Kill the browser to unblock ANY stuck Playwright call…
    expect(wd).toContain("_kill_browser_processes(");
    // …and after the grace window, write the timeout reply for the client.
    expect(wd).toContain('_write_json_atomic(res_path, payload)');
    expect(wd).toContain('"timeout"');
    expect(wd).toContain('WATCHDOG["answered"].add(cid)');
  });

  it("a wedged PREBOOT writes .boot-failed and exits the driver (never hangs .ready)", () => {
    const wd = section("def watchdog_loop", "def _sweep_stale_results");
    expect(wd).toContain('cid == "preboot"');
    expect(wd).toContain("BOOT_FAIL_PATH");
    const mainFn = section("def main():", 'if __name__ == "__main__":');
    expect(mainFn).toContain('_arm_watchdog("preboot", "preboot", PREBOOT_BUDGET)');
  });

  it("every action has a budget (PRD §6: configurable, no indefinite waits)", () => {
    const budgets = section("ACTION_BUDGETS = {", "DEFAULT_ACTION_BUDGET");
    for (const a of ["navigate", "screenshot", "snapshot", "click", "type", "scroll", "extract_text", "inspect", "wait", "back", "forward", "close"]) {
      expect(budgets).toContain(`"${a}"`);
    }
    expect(SRC).toContain("budget = ACTION_BUDGETS.get(action, DEFAULT_ACTION_BUDGET)");
  });

  it("the loop never overwrites a watchdog answer (exactly-one-reply discipline)", () => {
    const mainFn = section("def main():", 'if __name__ == "__main__":');
    expect(mainFn).toContain('answered = cid in WATCHDOG["answered"]');
    expect(mainFn).toContain("if not answered:");
  });
});

describe("browser-driver guaranteed output + structured events (PRD §5/§11)", () => {
  it("errors carry a readable output line — never an empty failure payload", () => {
    const errFn = section("def err_payload", "# ── Element targeting");
    expect(errFn).toContain('"output"');
  });

  it("every handler result is stamped with action + durationMs", () => {
    const mainFn = section("def main():", 'if __name__ == "__main__":');
    expect(mainFn).toContain('result.setdefault("durationMs", duration_ms)');
    expect(mainFn).toContain('result.setdefault("action", action)');
  });

  it("replies are written atomically (torn-file immunity loop vs watchdog)", () => {
    expect(SRC).toContain("def _write_json_atomic");
    const fn = section("def _write_json_atomic", "def watchdog_loop");
    expect(fn).toContain("os.replace(tmp, path)");
  });

  it("structured lifecycle events are logged for every transition", () => {
    expect(SRC).toContain("def event(");
    expect(SRC).toContain('EVENTS = os.path.join(DIR, "events.jsonl")');
    for (const ev of [
      "BROWSER_DRIVER_START",
      "BROWSER_INITIALIZATION",
      "BROWSER_READY",
      "BROWSER_DOWNLOAD_START",
      "BROWSER_DOWNLOAD_COMPLETE",
      "BROWSER_ACTION_START",
      "BROWSER_ACTION_COMPLETE",
      "BROWSER_ACTION_FAILED",
      "BROWSER_TIMEOUT",
      "BROWSER_SESSION_CLOSED",
      "BROWSER_EXECUTION_COMPLETE",
    ]) {
      expect(SRC).toContain(ev);
    }
  });

  it("the full PRD action surface is registered (plus compat aliases)", () => {
    const handlers = section("HANDLERS = {", "# ── PER-ACTION WATCHDOG");
    for (const a of [
      "navigate", "screenshot", "snapshot", "click", "type", "scroll",
      "extract_text", "inspect", "wait", "back", "forward", "close",
      // compat aliases — old conversations keep working
      "read", "get_page", "get_elements", "press", "evaluate", "select",
      "upload", "download", "new_tab", "switch_tab", "close_tab",
      "go_back", "go_forward", "reload", "refresh", "screen_record",
    ]) {
      expect(handlers).toContain(`"${a}"`);
    }
    // snapshot is a REAL handler now (it was removed 2026-10-21 and
    // re-added by this reimplementation).
    expect(SRC).toContain("def do_snapshot");
    expect(SRC).toContain("def do_extract_text");
    // No stale "snapshot no longer exists" redirect may remain.
    expect(SRC).not.toContain("The snapshot action no longer exists");
  });
});

describe("browser-driver boot.sh (creation-time parallel prepare)", () => {
  it("is valid bash with no backticks (command substitution uses $(…))", () => {
    expect(BOOT).toContain("#!/bin/bash");
    expect(BOOT).not.toContain("`");
    // NOTE: ${flags:-default} bash parameter expansion is LEGITIMATE here —
    // the no-"${" packaging constraint applies to the PYTHON source only
    // (String.raw template); boot.sh is a normal template literal where
    // every $ is escaped as \$.
  });

  it("is idempotent — a second kick waits on the .boot-lock instead of double-booting", () => {
    expect(BOOT).toContain(".boot-lock");
    expect(BOOT).toContain("another boot is already running");
  });

  it("emits structured download events and pre-fetches the binaries", () => {
    expect(BOOT).toContain("BROWSER_DOWNLOAD_START");
    expect(BOOT).toContain("BROWSER_DOWNLOAD_COMPLETE");
    expect(BOOT).toContain("BROWSER_BINARY_CACHED");
    expect(BOOT).toContain("cloakbrowser install");
    expect(BOOT).toContain("playwright install chromium");
  });

  it("writes the .preboot marker so .ready means 'browser usable'", () => {
    expect(BOOT).toContain(": > .preboot");
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
