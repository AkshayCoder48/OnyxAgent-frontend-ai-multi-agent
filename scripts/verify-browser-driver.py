#!/usr/bin/env python3
"""verify-browser-driver.py — offline verification of the sandbox browser
driver (CloakBrowser + E2B reimplementation, 2026-11-01).

Extracts the embedded Python driver from src/lib/e2b/browser-driver.ts and
exercises it WITHOUT an E2B account or a real browser:

  Part A — the per-action WATCHDOG: an expired command gets the timeout
  reply written by the watchdog itself (the guarantee that a wedged command
  loop can never leave the client without an answer), the BROWSER_TIMEOUT
  event lands in events.jsonl, and a disarmed command is never answered.

  Part B — the COMMAND LOOP with a stubbed Playwright page: cmd.json in →
  structured res-<id>.json out (success + output + durationMs), the PRD
  action surface (navigate / extract_text / snapshot), unknown-action
  enumeration, and the ACTION_START / COMPLETE / FAILED /
  EXECUTION_COMPLETE lifecycle events.

Usage:  python3 scripts/verify-browser-driver.py
Exit:   0 = all checks passed, 1 = failures (printed).
"""
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ---------------------------------------------------------------------------
# Extraction + import (paths redirected so the module loads locally)
# ---------------------------------------------------------------------------

def extract_driver_source():
    ts = open(os.path.join(REPO, "src/lib/e2b/browser-driver.ts"), encoding="utf-8").read()
    m = re.search(r"export const BROWSER_DRIVER_PY_SOURCE = String\.raw`", ts)
    assert m, "driver source marker not found"
    start = m.end()
    end = ts.index("`;", start)
    src = ts[start:end]
    return src.replace("${BROWSER_DRIVER_VERSION}", "test-version")


def import_driver(src):
    """Write the source with /home/user paths redirected to a temp dir and
    import it as a module (the __main__ guard keeps the loop from starting)."""
    tmp = tempfile.mkdtemp(prefix="onyx-driver-verify-")
    src = src.replace('DIR = "/home/user/.onyx/browser"', "DIR = %r" % os.path.join(tmp, "browser"))
    src = src.replace('DOWNLOADS = "/home/user/downloads"', "DOWNLOADS = %r" % os.path.join(tmp, "downloads"))
    src = src.replace('f = os.path.join("/home/user", f)', "f = os.path.join(%r, f)" % tmp)
    mod_path = os.path.join(tmp, "driver.py")
    open(mod_path, "w", encoding="utf-8").write(src)
    sys.path.insert(0, tmp)
    import driver  # noqa: E402
    return driver, tmp


# ---------------------------------------------------------------------------
# Part A — the watchdog
# ---------------------------------------------------------------------------

def run_watchdog_checks(driver):
    failures = []

    # T1: an expired command gets the watchdog's timeout reply.
    driver._arm_watchdog("ctest1", "navigate", 1)  # 1s budget
    threading.Thread(target=driver.watchdog_loop, daemon=True).start()
    res_path = os.path.join(driver.DIR, "res-ctest1.json")
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and not os.path.exists(res_path):
        time.sleep(0.2)
    if not os.path.exists(res_path):
        failures.append("watchdog never answered the expired command")
    else:
        payload = json.load(open(res_path))
        ok = (
            payload.get("success") is False
            and payload.get("error", {}).get("type") == "timeout"
            and isinstance(payload.get("output"), str)
            and len(payload["output"]) > 0
            and payload["error"]["message"].find("navigate") != -1
        )
        print("  T1 watchdog timeout reply:", "OK" if ok else "BAD: %s" % json.dumps(payload)[:300])
        if not ok:
            failures.append("timeout payload malformed")
        with driver.WATCHDOG_LOCK:
            answered = "ctest1" in driver.WATCHDOG["answered"]
        print("  T1 command marked answered:", "OK" if answered else "FAIL")
        if not answered:
            failures.append("watchdog did not mark the command answered")

    # T2: events.jsonl records the BROWSER_TIMEOUT transition.
    got_timeout_event = False
    try:
        for line in open(os.path.join(driver.DIR, "events.jsonl")):
            row = json.loads(line)
            if row.get("event") == "BROWSER_TIMEOUT" and row.get("commandId") == "ctest1":
                got_timeout_event = True
    except FileNotFoundError:
        pass
    print("  T2 BROWSER_TIMEOUT event logged:", "OK" if got_timeout_event else "FAIL")
    if not got_timeout_event:
        failures.append("no BROWSER_TIMEOUT event")

    # T3: disarm cancels the pending shot.
    driver._arm_watchdog("ctest3", "click", 1)
    driver._disarm_watchdog()
    time.sleep(2.5)
    res3 = os.path.join(driver.DIR, "res-ctest3.json")
    print("  T3 disarmed command NOT answered:", "OK" if not os.path.exists(res3) else "FAIL")
    if os.path.exists(res3):
        failures.append("watchdog answered a disarmed command")

    # T4: atomic write helper.
    p4 = os.path.join(driver.DIR, "res-ctest4.json")
    driver._write_json_atomic(p4, {"success": True, "output": "x"})
    ok4 = json.load(open(p4)).get("output") == "x"
    print("  T4 atomic write:", "OK" if ok4 else "FAIL")
    if not ok4:
        failures.append("atomic write")

    return failures


# ---------------------------------------------------------------------------
# Part B — the command loop with a stubbed Playwright page
# ---------------------------------------------------------------------------

class FakeResp:
    status = 200


class FakePage:
    url = "https://example.com/"

    def title(self):
        return "Example Domain"

    @property
    def viewport_size(self):
        return {"width": 1280, "height": 800}

    def evaluate(self, script, *args):
        # Order matters: the snapshot script ALSO contains innerText, so the
        # specific markers are checked first.
        if "textExcerpt" in str(script):
            return {
                "title": "Example Domain", "url": "https://example.com/",
                "headings": [{"level": 1, "text": "Example Domain"}],
                "counts": {"links": 1, "buttons": 0, "inputs": 0, "images": 0},
                "interactive": [{"tag": "a", "text": "More information...", "href": "/"}],
                "textExcerpt": "Example Domain - for use in illustrative examples.",
            }
        if "__onyxSer" in str(script):
            return {"ok": True, "value": 42}
        if "innerText" in str(script):
            return "Example Domain\n\nThis domain is for use in illustrative examples."
        return "PAGE TEXT"

    def goto(self, url, **kw):
        self.url = url
        return FakeResp()

    def wait_for_timeout(self, ms):
        time.sleep(min(ms, 50) / 1000.0)


def run_loop_checks(driver):
    failures = []

    driver.boot_browser = lambda: None
    driver.context = None
    driver.pages = [{"id": "tab_1", "page": FakePage()}]
    driver.runtime = "cloakbrowser"

    threading.Thread(target=driver.main, daemon=True).start()
    time.sleep(0.8)  # let it stamp .ready + start the side threads

    def run_cmd(cmd):
        cid = cmd["id"]
        p = os.path.join(driver.DIR, "cmd.json")
        tmpf = p + ".tmp"
        with open(tmpf, "w") as f:
            json.dump(cmd, f)
        os.replace(tmpf, p)
        res = os.path.join(driver.DIR, "res-" + cid + ".json")
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not os.path.exists(res):
            time.sleep(0.1)
        if not os.path.exists(res):
            return None
        payload = json.load(open(res))
        try:
            os.remove(res)
        except OSError:
            pass
        return payload

    # 1. navigate
    r = run_cmd({"id": "l1", "action": "navigate", "url": "https://example.com"})
    ok = r and r.get("success") is True and r.get("title") == "Example Domain" \
        and isinstance(r.get("output"), str) and len(r["output"]) > 0 \
        and isinstance(r.get("durationMs"), int)
    print("  navigate:", "OK" if ok else "BAD %s" % json.dumps(r)[:300])
    if not ok:
        failures.append("navigate")

    # 2. extract_text
    r = run_cmd({"id": "l2", "action": "extract_text"})
    ok = r and r.get("success") is True and "illustrative" in (r.get("text") or "") \
        and r.get("textLength", 0) > 40 and bool(r.get("output"))
    print("  extract_text:", "OK" if ok else "BAD %s" % json.dumps(r)[:300])
    if not ok:
        failures.append("extract_text")

    # 3. snapshot (the re-added PRD action)
    r = run_cmd({"id": "l3", "action": "snapshot"})
    ok = r and r.get("success") is True and r.get("headings") \
        and r.get("counts", {}).get("links") == 1 and r.get("interactive") and bool(r.get("output"))
    print("  snapshot:", "OK" if ok else "BAD %s" % json.dumps(r)[:300])
    if not ok:
        failures.append("snapshot")

    # 4. unknown action enumerates the supported set
    r = run_cmd({"id": "l4", "action": "teleport"})
    ok = r and r.get("success") is False \
        and "supported" in (r.get("error", {}).get("message") or "").lower() \
        and "navigate" in (r.get("error", {}).get("message") or "")
    print("  unknown action:", "OK" if ok else "BAD %s" % json.dumps(r)[:300])
    if not ok:
        failures.append("unknown action")

    # 5. events.jsonl lifecycle
    names = []
    try:
        for line in open(os.path.join(driver.DIR, "events.jsonl")):
            names.append(json.loads(line).get("event"))
    except FileNotFoundError:
        pass
    need = ["BROWSER_DRIVER_START", "BROWSER_ACTION_START", "BROWSER_ACTION_COMPLETE",
            "BROWSER_EXECUTION_COMPLETE", "BROWSER_ACTION_FAILED"]
    missing = [n for n in need if n not in names]
    print("  events:", "OK" if not missing else "MISSING %s (got %s)" % (missing, names))
    if missing:
        failures.append("events missing %s" % missing)

    # 6. version stamp + ready
    ready_ok = os.path.exists(os.path.join(driver.DIR, ".ready"))
    version_ok = open(os.path.join(driver.DIR, ".version")).read().strip() == "test-version"
    print("  ready stamp:", ready_ok, "| version:", version_ok)
    if not (ready_ok and version_ok):
        failures.append("ready/version stamps")

    return failures


def main():
    print("== verify-browser-driver: extracting the embedded Python driver ==")
    src = extract_driver_source()
    print("== Part A: per-action watchdog ==")
    driver_a, tmp_a = import_driver(src)
    failures_a = run_watchdog_checks(driver_a)
    print("== Part B: command loop (stubbed page) ==")
    driver_b, tmp_b = import_driver(src)
    failures_b = run_loop_checks(driver_b)
    shutil.rmtree(tmp_a, ignore_errors=True)
    shutil.rmtree(tmp_b, ignore_errors=True)
    all_failures = ["[watchdog] %s" % x for x in failures_a] + ["[loop] %s" % x for x in failures_b]
    print()
    print("FAILURES:", all_failures if all_failures else "none")
    sys.exit(1 if all_failures else 0)


if __name__ == "__main__":
    main()
