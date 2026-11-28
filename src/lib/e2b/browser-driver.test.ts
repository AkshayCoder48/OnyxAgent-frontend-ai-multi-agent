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
    const cloakLaunchAt = boot.indexOf("_launch_with_profile_retry(");
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

describe("browser-driver remember_page (KB auto-ingest, 2026-11-05)", () => {
  it("do_remember_page captures title/url/40k text + the nav log", () => {
    const fn = section("def do_remember_page(cmd):", "def do_snapshot(cmd):");
    // settle the challenge first (the read path), like extract_text
    expect(fn.indexOf("_settle_challenge")).toBeLessThan(fn.indexOf("document.body"));
    // generous budget — far beyond the read excerpt budgets
    expect(fn).toContain("limit = 40000");
    // the capture payload carries the browse history for KB ingestion
    expect(fn).toContain('"navLog": list(nav_log)');
    expect(fn).toContain('"title"');
    expect(fn).toContain('"text"');
    // honest stuck-challenge warning, same as extract_text
    expect(fn).toContain("the text is the interstitial, NOT the content");
  });

  it("every successful navigate appends to the nav log (browse history)", () => {
    const fn = section("def do_navigate(cmd):", "def do_click(cmd):");
    expect(fn).toContain('nav_log.append({"url": p.url, "title": title, "ts":');
    // the log is bounded
    expect(fn).toContain("del nav_log[:-NAV_LOG_MAX]");
    expect(SRC).toContain("NAV_LOG_MAX = 120");
  });

  it("remember_page is handler-registered and budgeted", () => {
    const handlers = section("HANDLERS = {", "# ── PER-ACTION WATCHDOG");
    expect(handlers).toContain('"remember_page": do_remember_page');
    const budgets = section("ACTION_BUDGETS = {", "DEFAULT_ACTION_BUDGET");
    expect(budgets).toContain('"remember_page": 40');
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

describe("browser-driver Cloudflare challenge settle (the 'Just a moment' incident)", () => {
  it("detects the interstitial by title + full-page selectors — a bare embedded .cf-turnstile widget is NOT a challenge", () => {
    expect(SRC).toContain("CF_TITLE_MARKERS");
    expect(SRC).toContain("CF_SELECTORS");
    expect(SRC).toContain("CF_IFRAME_SEL");
    const markers = section("CF_TITLE_MARKERS = (", ")");
    expect(markers).toContain('"just a moment"');
    expect(markers).not.toContain("cf-turnstile");
    const selectors = section("CF_SELECTORS = (", ")");
    expect(selectors).toContain('"#challenge-running"');
    expect(selectors).not.toContain("cf-turnstile");
  });

  it("navigate settles AFTER goto; reads settle BEFORE extracting text", () => {
    const nav = section("def do_navigate", "def do_click");
    const gotoAt = nav.indexOf("p.goto(url");
    const settleAt = nav.indexOf("_settle_challenge(p,");
    expect(gotoAt).toBeGreaterThan(-1);
    expect(settleAt).toBeGreaterThan(gotoAt);

    const read = section("def do_get_page", "def do_read");
    const rSettleAt = read.indexOf("_settle_challenge(p,");
    const rEvalAt = read.indexOf("document.body");
    expect(rSettleAt).toBeGreaterThan(-1);
    expect(rSettleAt).toBeLessThan(rEvalAt);

    const ex = section("def do_extract_text", "def do_snapshot");
    const eSettleAt = ex.indexOf("_settle_challenge(p,");
    const eEvalAt = ex.indexOf("document.body");
    expect(eSettleAt).toBeGreaterThan(-1);
    expect(eSettleAt).toBeLessThan(eEvalAt);
  });

  it("Turnstile clicks are humanized locator clicks AND bounded", () => {
    expect(SRC).toContain("MAX_TURNSTILE_CLICKS = 2");
    const settle = section("def _settle_challenge", "def do_navigate");
    expect(settle).toContain("clicks < MAX_TURNSTILE_CLICKS");
    const turnstile = section("def _click_turnstile", "def _settle_challenge");
    expect(turnstile).toContain(".first.click(timeout=4000)");
  });

  it("settle budgets are env-tunable and capped so goto + settle fits the watchdog budget", () => {
    const nav = section("def do_navigate", "def do_click");
    expect(nav).toContain('_env_int("ONYX_CF_SETTLE_MS", 18000, 30000)');
    expect(SRC).toContain('_env_int("ONYX_CF_SETTLE_READ_MS", 8000, 12000)');
    const budgets = section("ACTION_BUDGETS = {", "DEFAULT_ACTION_BUDGET");
    expect(budgets).toContain('"navigate": 80'); // 45 s goto + 30 s settle cap
    expect(budgets).toContain('"extract_text": 40');
    expect(budgets).toContain('"read": 40');
    expect(budgets).toContain('"get_page": 40'); // 12 s settle cap + extraction
  });

  it("the reply carries an honest challenge status, never a silent interstitial", () => {
    const nav = section("def do_navigate", "def do_click");
    expect(nav).toContain('out["challenge"] = status');
    expect(nav).toContain("cleared_after_click");
    expect(nav).toContain("STILL on a Cloudflare challenge");
    const read = section("def do_get_page", "def do_read");
    expect(read).toContain('"challenge": status');
    expect(read).toContain("the interstitial, NOT the content");
    const ex = section("def do_extract_text", "def do_snapshot");
    expect(ex).toContain('"challenge": status');
  });
});

describe("browser-driver target resolution (the arena.ai 'e19' + stringified-JSON incident)", () => {
  it("resolves BARE inspect refs — 'e19' routes to the ref map, not a CSS tag selector", () => {
    const resolve = section("def resolve_target", "def target_label");
    expect(resolve).toContain('if t.startswith("ref="):');
    // The bare-ref branch: e + digits, BEFORE the CSS fallthrough.
    const bareAt = resolve.indexOf('t[0] == "e" and t[1:].isdigit()');
    const cssFallAt = resolve.indexOf('if t.startswith("xpath=")');
    expect(bareAt).toBeGreaterThan(-1);
    expect(cssFallAt).toBeGreaterThan(bareAt);
    expect(resolve).toContain("_ref_locator(page, t)");
  });

  it("parses stringified JSON object targets instead of feeding them to CSS", () => {
    const resolve = section("def resolve_target", "def target_label");
    expect(resolve).toContain('t.startswith("{") and t.endswith("}")');
    expect(resolve).toContain("json.loads(t)");
    expect(resolve).toContain("return resolve_target(page, parsed)");
    // The JSON branch must sit BEFORE the selector fallthrough.
    const jsonAt = resolve.indexOf('t.startswith("{")');
    const cssFallAt = resolve.indexOf('if t.startswith("xpath=")');
    expect(jsonAt).toBeGreaterThan(-1);
    expect(jsonAt).toBeLessThan(cssFallAt);
  });

  it("all three ref forms share _ref_locator, whose error lists the live valid refs", () => {
    const refLoc = section("def _ref_locator", "def resolve_target");
    expect(refLoc).toContain("ref_map.get(rid)");
    expect(refLoc).toContain("Call inspect/get_elements again");
    expect(refLoc).toContain("sorted(ref_map.keys())");
    const resolve = section("def resolve_target", "def target_label");
    // ref=e12 (string), e12 (bare), {"ref": "e12"} (object) — one resolver.
    expect(resolve.match(/_ref_locator\(/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

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

// ─────────────────────────────────────────────────────────────────────────────
// ENGINE LADDER (the "browser shows Chromium" fix, 2026-11-24): the driver
// boots cloakbrowser ONLY when a license key exists (0.7.3 gates every
// launch behind one), falls back to patchright (free Apache-2.0 patched
// Playwright — presents as real Chrome), and only then to stock Chromium.
// boot.sh installs the pinned trio and pre-fetches patchright's binary
// FIRST.
// ─────────────────────────────────────────────────────────────────────────────
describe("browser-driver engine ladder (cloak-if-licensed → patchright → chromium)", () => {
  it("boot_browser tries the engines in ladder ORDER", () => {
    const boot = section("def boot_browser", "def ensure_pages");
    const cloakAt = boot.indexOf("from cloakbrowser import launch_persistent_context as cb_launch");
    const patchAt = boot.indexOf("from patchright.sync_api import sync_playwright as pr_sync");
    const stockAt = boot.indexOf("from playwright.sync_api import sync_playwright");
    expect(cloakAt).toBeGreaterThan(-1);
    expect(patchAt).toBeGreaterThan(-1);
    expect(stockAt).toBeGreaterThan(-1);
    expect(cloakAt).toBeLessThan(patchAt);
    expect(patchAt).toBeLessThan(stockAt);
  });

  it("the cloakbrowser rung only launches when a license key exists", () => {
    const boot = section("def boot_browser", "def ensure_pages");
    // Key resolution (env + cloakbrowser's own resolver) gates the attempt.
    expect(boot).toContain('os.environ.get("CLOAKBROWSER_LICENSE_KEY", "").strip()');
    expect(boot).toContain("resolve_license_key as _cb_key");
    // The gate wraps the launch: 'if cloak_key:' before the cb_launch import.
    const gateAt = boot.indexOf("if cloak_key:");
    const importAt = boot.indexOf("from cloakbrowser import launch_persistent_context as cb_launch");
    expect(gateAt).toBeGreaterThan(-1);
    expect(importAt).toBeGreaterThan(gateAt);
    // Skipping (no key) logs and falls through — no BootFailure raise on skip.
    expect(boot).toContain('log("no cloakbrowser license key');
  });

  it("runtime names identify the actual engine (cloakbrowser / patchright / chromium)", () => {
    const boot = section("def boot_browser", "def ensure_pages");
    expect(boot).toContain('runtime = "cloakbrowser"');
    expect(boot).toContain('runtime = "patchright"');
    expect(boot).toContain('runtime = "chromium"');
    // READY bookkeeping is shared: _mark_ready(rt) emits BROWSER_READY with
    // the engine's runtime name, and every rung routes through it.
    const markFnAt = boot.indexOf("def _mark_ready(rt):");
    expect(markFnAt).toBeGreaterThan(-1);
    const marks = all(boot, "_mark_ready(");
    expect(marks.length).toBeGreaterThanOrEqual(4); // def + 3 call sites
    // The mark emits with the EXACT runtime string passed in.
    expect(boot).toContain('event("BROWSER_READY", runtime=rt, headed=HEADED)');
  });

  it("the patchright rung self-installs its binary when missing (like stock chromium)", () => {
    const boot = section("def boot_browser", "def ensure_pages");
    const patchSection = boot.slice(
      boot.indexOf("attempt 2: patchright"),
      boot.indexOf("attempt 3: stock Playwright"),
    );
    expect(patchSection).toContain('"-m", "patchright", "install", "chromium"');
    // A failed patchright rung STOPs its playwright instance (never leaks).
    expect(patchSection).toContain("pw.stop()");
  });

  it("humanized typing still prefers press_sequentially (all engines support it)", () => {
    expect(SRC).toContain("press_sequentially");
  });
});

describe("browser-driver boot.sh engine ladder install", () => {
  it("installs the pinned trio (cloakbrowser + patchright + playwright range)", () => {
    expect(BOOT).toContain("cloakbrowser==0.7.3");
    expect(BOOT).toContain("patchright==1.64.4");
    expect(BOOT).toContain("playwright>=1.53,<1.66");
  });

  it("pre-fetches the patchright stealth binary FIRST (the free engine)", () => {
    const patchFetchAt = BOOT.indexOf("-m patchright install chromium");
    const stockFetchAt = BOOT.indexOf("-m playwright install chromium");
    expect(patchFetchAt).toBeGreaterThan(-1);
    expect(stockFetchAt).toBeGreaterThan(-1);
    expect(patchFetchAt).toBeLessThan(stockFetchAt);
    // The cloakbrowser binary fetch is gated on a license key being present.
    expect(BOOT).toContain("CLOAKBROWSER_LICENSE_KEY");
  });

  it("runtime probe accepts EITHER patchright or the cloak pair as warm", () => {
    expect(BOOT).toContain("import patchright");
  });
});

// ── CLOAK LICENSE PLUMBING + THE 'no running event loop' FIX (Task 51) ──────
// Two regressions pinned here:
//   1. cloakbrowser 0.7.3 monkey-patches time.sleep (_pumping_sleep →
//      owner._sync) while a humanized context is open. After the watchdog
//      SIGKILLs the browser or the context dies, the patch pointed at the
//      dead loop — the driver's own time.sleep(0.3) poll then raised
//      'no running event loop' / 'Event loop is closed' or busy-wedged the
//      command loop forever.
//   2. The license key configured in Settings never REACHED the sandbox:
//      execInSandbox never forwarded envs, so boot.sh skipped the cloak
//      binary pre-fetch and the driver ladder fell to patchright even for
//      licensed users.
describe("browser-driver: the 'no running event loop' fix (cloak sleep patch)", () => {
  it("restores the REAL time.sleep when cloak owners die (_untrack_cloak_sleep_owners)", () => {
    expect(SRC).toContain("def _untrack_cloak_sleep_owners");
    // It goes through cloak's OWN API (idempotent, no-op when absent)…
    expect(SRC).toContain("_untrack_sleep_owner");
    // …and force-restores the real sleep if anything remains patched.
    expect(SRC).toContain("_real_sleep");
  });

  it("captures the OS-level sleep reference BEFORE any cloak import can patch it", () => {
    expect(SRC).toContain("_REAL_SLEEP = time.sleep");
    const captureAt = SRC.indexOf("_REAL_SLEEP = time.sleep");
    const firstCloakImportAt = SRC.indexOf("from cloakbrowser import");
    expect(captureAt).toBeGreaterThan(-1);
    expect(firstCloakImportAt).toBeGreaterThan(captureAt);
  });

  it("_reset_browser_state clears BOTH hazards (sleep patch + loop flag)", () => {
    const fn = section("def _reset_browser_state", "def _display_alive");
    const untrackAt = fn.indexOf("_untrack_cloak_sleep_owners()");
    const unpoisonAt = fn.indexOf("_unpoison_asyncio()");
    expect(untrackAt).toBeGreaterThan(-1);
    expect(unpoisonAt).toBeGreaterThan(-1);
    // Untrack FIRST (a patched sleep must not survive into the unpoison).
    expect(untrackAt).toBeLessThan(unpoisonAt);
  });

  it("the command loop polls through _safe_sleep (self-healing, retries once)", () => {
    expect(SRC).toContain("def _safe_sleep");
    // The definition retries through the CAPTURED real sleep after
    // restoring — never through the (possibly still-patched) name.
    const fnAt = SRC.indexOf("def _safe_sleep");
    const fn = SRC.slice(fnAt, SRC.indexOf("def boot_browser", fnAt));
    expect(fn).toContain("_untrack_cloak_sleep_owners()");
    expect(fn).toContain("_REAL_SLEEP(seconds)");
    // All short-sleep sites in the command loop route through it (two
    // idle polls + the JSONDecodeError handler), and the error handler
    // too — a poisoned sleep must never fire anywhere in the loop.
    const loop = section("log(\"driver loop started", "if __name__");
    const polls = all(loop, "_safe_sleep(0.3)");
    expect(polls.length).toBe(3);
    expect(loop).toContain("_safe_sleep(0.5)");
    expect(loop).not.toMatch(/[^_a-zA-Z]time\.sleep\(0\.[35]\)/);
  });
});

describe("browser-driver: the cloak license key reaches the sandbox", () => {
  it("boot_browser persists a seen license to cloak's own default file (cross-boot)", () => {
    const boot = section("def boot_browser", "def ensure_pages");
    // The key is resolved from env OR cloak's resolver…
    expect(boot).toContain('os.environ.get("CLOAKBROWSER_LICENSE_KEY"');
    // …and once seen, persisted via cloak's own save (0600, default file —
    // the Pro binary reads it directly on later boots without env re-forward).
    expect(boot).toContain("save_license_key as _cb_save");
    expect(boot).toContain("_cb_save(cloak_key)");
    // Never logged: the persist failure logs the ERROR, never the key.
    const persistSlice = boot.slice(
      boot.indexOf("save_license_key as _cb_save"),
      boot.indexOf("_unpoison_asyncio()", boot.indexOf("save_license_key as _cb_save")),
    );
    expect(persistSlice).not.toMatch(/log\([^)]*cloak_key/);
  });
});

// ── CLOAK COMPLETION (Task 54: "re read cloak implementation and add
// completely") — the missing pieces of the cloakbrowser 0.7.3 integration
// found by reading the module's real API surface: a pre-launch license
// VALIDATION gate (validate_license: 24h cache, stale-fallback), explicit
// license_key= on the launch (one key source), geoip fingerprint
// coherence, and CloakBrowserLicenseError-specific diagnosis (Pro binary
// exit codes 76-79). Also the residual 'no running event loop': the Task
// 51 fix only hardened the command-loop poll; NINE other raw time.sleep
// sites (live-cast threads, watchdog daemon, boot waits, profile cleanup)
// still hit cloak's stale monkey-patch after a browser kill.
describe("browser-driver: cloak completion (license gate + tuned launch)", () => {
  it("validates the license BEFORE launching cloak (a bad key skips straight to patchright)", () => {
    const boot = section("def boot_browser", "def ensure_pages");
    expect(boot).toContain("validate_license as _cb_validate");
    // The gate runs BEFORE the launch import and before the key is even
    // persisted (no point caching a rejected key).
    const gateAt = boot.indexOf("validate_license as _cb_validate");
    const importAt = boot.indexOf("from cloakbrowser import launch_persistent_context as cb_launch");
    const persistAt = boot.indexOf("save_license_key as _cb_save");
    expect(importAt).toBeGreaterThan(gateAt);
    expect(persistAt).toBeGreaterThan(gateAt);
    // A definitive invalid answer disables the cloak rung for the process…
    expect(boot).toContain("cloak_disabled = True");
    // …but a server-unreachable (None) result does NOT (offline sandboxes
    // still launch — the launch itself re-checks).
    expect(boot).toMatch(/info is not None and not info\.valid/);
  });

  it("passes license_key explicitly to the launch (one authoritative key source)", () => {
    const boot = section("def boot_browser", "def ensure_pages");
    // Task 55 wrapped the launch in _launch_with_profile_retry (lambda) —
    // anchor on the rung's import, not the old cb_launch( call.
    const launch = boot.slice(
      boot.indexOf("from cloakbrowser import launch_persistent_context as cb_launch"),
      boot.indexOf("runtime = \"cloakbrowser\""),
    );
    expect(launch).toContain("license_key=cloak_key");
  });

  it("enables geoip fingerprint coherence (timezone/locale follow the egress IP)", () => {
    const boot = section("def boot_browser", "def ensure_pages");
    const launch = boot.slice(
      boot.indexOf("from cloakbrowser import launch_persistent_context as cb_launch"),
      boot.indexOf("runtime = \"cloakbrowser\""),
    );
    expect(launch).toContain("geoip=True");
    // …but does NOT override locale/timezone/user_agent piecemeal (cloak's
    // own fingerprint coherence owns the set — one override breaks it).
    expect(launch).not.toMatch(/locale\s*=/);
    expect(launch).not.toMatch(/timezone\s*=/);
    expect(launch).not.toMatch(/user_agent\s*=/);
  });

  it("diagnoses CloakBrowserLicenseError distinctly from launch failures", () => {
    const boot = section("def boot_browser", "def ensure_pages");
    // The Pro binary's license exit codes (76-79) arrive as
    // CloakBrowserLicenseError — matched by type name (the class cannot be
    // imported before the module is known-present)…
    expect(boot).toContain('type(e).__name__ == "CloakBrowserLicenseError"');
    // …logged with the license diagnosis (pointing at Settings → Browser)
    // instead of a generic launch-failed string.
    expect(boot).toContain("cloakbrowser LICENSE failure");
    // And the generic path survives for genuine launch failures.
    expect(boot).toContain("cloakbrowser launch failed:");
  });
});

describe("browser-driver: EVERY sleep survives the stale cloak patch (Task 54 residual fix)", () => {
  it("no raw time.sleep( call sites remain outside _safe_sleep/_REAL_SLEEP", () => {
    // The python driver body: every sleep site must route through
    // _safe_sleep so cloak's dead-loop patch can never wedge ANY thread —
    // the live-cast flusher/attach loops, the watchdog daemon, the boot
    // waits and the profile cleanup all run OUTSIDE the command loop the
    // Task 51 fix covered.
    //
    // Line-based scan of the driver source (SRC IS the python template):
    // a raw sleep is an EXECUTION line starting with optional whitespace
    // then `time.sleep(`. Comment/docstring mentions of time.sleep never
    // start a line that way, and `_REAL_SLEEP = time.sleep` is excluded
    // by name.
    const lines = SRC.split("\n");
    const raw: number[] = [];
    lines.forEach((l, i) => {
      if (/^\s*time\.sleep\(/.test(l)) raw.push(i);
    });
    // The ONE survivor is the try-arm inside _safe_sleep itself.
    expect(raw.length).toBe(1);
    const fnStart = lines.findIndex((l) => l.startsWith("def _safe_sleep"));
    const fnEnd = lines.findIndex((l, i) => i > fnStart && /^def /.test(l));
    expect(raw[0]!).toBeGreaterThan(fnStart);
    expect(raw[0]!).toBeLessThan(fnEnd);
    // The captured real-sleep reference survives (the retry arm).
    expect(SRC).toContain("_REAL_SLEEP = time.sleep");
  });

  it("the forever-loops (watchdog daemon, live-cast) use _safe_sleep", () => {
    // Watchdog daemon: a 0.5s poll that runs for the process lifetime —
    // if it ever hits the stale patch raw, the watchdog dies silently and
    // pending actions hang forever (exactly the class of wedge Task 51
    // fixed for the command loop).
    expect(SRC).toContain("def watchdog_loop");
    const wdStart = SRC.indexOf("def watchdog_loop");
    const wdEnd = SRC.indexOf("\ndef ", wdStart + 4);
    const wd = SRC.slice(wdStart, wdEnd);
    expect(wd).toContain("_safe_sleep(0.5)");
    expect(wd).not.toMatch(/^\s*time\.sleep\(/m);
    // Live-cast threads: the flusher poll + the attach/retry backoffs.
    const liveStart = SRC.indexOf("def live_cast_loop");
    const liveEnd = SRC.indexOf("\ndef ", liveStart + 4);
    const live = SRC.slice(liveStart, liveEnd);
    expect(live).toContain("_safe_sleep(");
    expect(live).not.toMatch(/^\s*time\.sleep\(/m);
  });
});

// ── TASK 55: the residual 'no running event loop' + 'profile is already
// in use' browser_startup_failed reports (2026-11-28) ──────────────────────
// Two NEW failure classes the ladder hardening didn't cover:
//   1. DEAD-LOOP AT THE HANDLER BOUNDARY: an action ran against a cloak
//      context whose asyncio loop already died (watchdog kill / crash /
//      sandbox pause). cloak's patched dispatcher raised the RAW asyncio
//      error ('no running event loop' / 'Event loop is closed' / task
//      'attached to a different loop') — which fell into the generic
//      except → playw_err → browser_error with NO recovery: every later
//      command hit the same dead context.
//   2. PROFILE-IN-USE ACROSS RUNGS: locks were cleared ONCE at
//      boot_browser() entry, but each rung spawns/tears down its OWN
//      chrome (a failed cloak launch leaves children mid-teardown when
//      the patchright rung fires), and SIGKILL releases the
//      SingletonSocket asynchronously — the 0.4s settle raced the
//      ProcessSingleton handshake → 'Opening in existing browser session'.
describe("browser-driver: dead-loop recovery at the command boundary (Task 55)", () => {
  it("classifies the dead-loop signature distinctly (_is_dead_loop_error + browser_disconnected)", () => {
    expect(SRC).toContain("def _is_dead_loop_error");
    const fn = section("def _is_dead_loop_error", "def _env_int");
    // All four asyncio death signatures are recognized…
    expect(fn).toContain("no running event loop");
    expect(fn).toContain("event loop is closed");
    expect(fn).toContain("attached to a different loop");
    expect(fn).toContain("event loop is bound");
    // …and playw_err routes them to browser_disconnected BEFORE the
    // generic browser_error bucket.
    const playw = section("def playw_err", "def _is_dead_loop_error");
    expect(playw.indexOf("_is_dead_loop_error")).toBeLessThan(playw.indexOf('"browser_error"'));
    // (playw_err calls the checker FIRST — before the timeout/net checks —
    // so the raw asyncio error can never masquerade as a locator timeout.)
    expect(playw).toContain('"browser_disconnected"');
  });

  it("the command loop RESETS + RETRIES the handler once on the dead-loop signature", () => {
    const loop = section("log(\"driver loop started", "if __name__");
    // Detection in the generic except…
    expect(loop).toContain("except Exception as e:");
    expect(loop).toContain("_is_dead_loop_error(str(e))");
    // …full state reset (drops the dead context, restores the real sleep,
    // clears the poisoned loop flag)…
    expect(loop).toContain("_reset_browser_state()");
    // …ONE same-command retry, with its own BootFailure handling so a
    // failed reboot reports browser_startup_failed (not a crash).
    expect(loop).toContain("dead-loop-retry");
    expect(loop).toContain("BROWSER_ACTION_COMPLETE\", phase=\"dead-loop-retry-recovered");
    expect(loop).toContain("after dead-loop reset");
  });
});

describe("browser-driver: profile-in-use recovery on EVERY engine rung (Task 55)", () => {
  it("reaps orphans with VERIFICATION (kill rounds + poll, not a fixed 0.4s settle)", () => {
    expect(SRC).toContain("def _reap_orphan_chromium(verify_sec=3.0)");
    const fn = section("def _reap_orphan_chromium", "def _is_profile_in_use_error");
    // Kill rounds cover respawning crashpad handlers; the verify poll
    // waits for the OS to actually release the SingletonSocket.
    expect(fn).toContain("for _ in range(6):");
    expect(fn).toMatch(/while time\.time\(\) < deadline/);
    expect(fn).toContain("verified gone");
  });

  it("recognizes Chromium's ProcessSingleton refusal message", () => {
    expect(SRC).toContain("def _is_profile_in_use_error");
    const fn = section("def _is_profile_in_use_error", "def _launch_with_profile_retry");
    expect(fn).toContain("opening in existing browser session");
    expect(fn).toContain("profile is already in use");
    expect(fn).toContain("processsingleton");
  });

  it("EVERY launch site goes through _launch_with_profile_retry (reap+clear before, retry once on refusal)", () => {
    const fn = section("def _launch_with_profile_retry", "def _clear_stale_profile_locks");
    // Reap + lock-clear BEFORE the first attempt and again before the retry…
    expect(fn).toContain("_reap_orphan_chromium()");
    expect(fn).toContain("_clear_stale_profile_locks()");
    expect(fn).toContain("profile-in-use-retry");
    // …and the retry re-raises anything that is NOT the refusal (missing
    // libs must still fall through the ladder).
    expect(fn).toContain("return launch_fn()");
    // ALL FIVE launch sites are wrapped (3 rungs + 2 post-install
    // retries): no direct launch_persistent_context call remains outside
    // a lambda passed to the wrapper.
    const wrapped = all(SRC, "_launch_with_profile_retry(").length;
    expect(wrapped).toBeGreaterThanOrEqual(6); // def + 5 call sites
    const bare = SRC.split("\n").filter(
      (l) =>
        /launch_persistent_context\(/.test(l) &&
        !/lambda|import|def |launch_fn/.test(l),
    );
    expect(bare).toEqual([]);
  });

  it("boot_browser reaps with verification up front too (before the ladder)", () => {
    const boot = section("def boot_browser", "def ensure_pages");
    const reapAt = boot.indexOf("_reap_orphan_chromium()");
    const cloakAt = boot.indexOf("from cloakbrowser import launch_persistent_context as cb_launch");
    expect(reapAt).toBeGreaterThan(-1);
    expect(cloakAt).toBeGreaterThan(reapAt);
  });
});
