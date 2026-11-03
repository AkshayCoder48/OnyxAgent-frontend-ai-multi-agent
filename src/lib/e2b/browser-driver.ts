/**
 * The OnyxAgent BROWSER DRIVER — reimplementation (2026-11-01 PRD).
 *
 * A long-running Python process INSIDE the E2B sandbox that owns a
 * persistent-profile CloakBrowser (stealth Chromium, humanize=True) with a
 * stock-Playwright-Chromium fallback, serving the file protocol:
 *
 *   /home/user/.onyx/browser/driver.py      — this source (started detached)
 *   /home/user/.onyx/browser/cmd.json       — {id, action, …} request
 *   /home/user/.onyx/browser/res-<id>.json  — the driver's reply (atomic)
 *   /home/user/.onyx/browser/.ready         — "the loop is running" marker
 *   /home/user/.onyx/browser/.version       — driver code version stamp
 *   /home/user/.onyx/browser/events.jsonl   — structured lifecycle events
 *   /home/user/.onyx/browser/profile/       — persistent browser profile
 *   /home/user/.onyx/browser/shots/*.png    — screenshots
 *   /home/user/downloads/                   — captured browser downloads
 *
 * WHAT THIS REWRITE FIXES (the "infinite execution, no output" incident):
 *   1. WATCHDOG — every command is armed with a per-action budget. When it
 *      expires the watchdog SIGKILLs the browser process (the one reliable
 *      way to unblock ANY stuck Playwright call) and writes the timeout
 *      reply ITSELF, so the client always receives an answer even if the
 *      command loop never comes back. The startup preboot gets the same
 *      backstop (writes .boot-failed and exits the driver).
 *   2. STRUCTURED EVENTS — every lifecycle transition lands in events.jsonl
 *      (BROWSER_ACTION_START / COMPLETE / FAILED / TIMEOUT, BROWSER_READY,
 *      BROWSER_SESSION_CLOSED, …) with ids, actions, durations, runtimes.
 *   3. GUARANTEED OUTPUT — every handler returns a payload with a
 *      human-readable "output" string; the loop adds durationMs; replies
 *      are written atomically exactly once (watchdog-aware).
 *   4. The full PRD action surface (navigate / screenshot / snapshot /
 *      click / type / scroll / extract_text / inspect / wait / back /
 *      forward / close) plus the compat aliases older conversations use.
 *
 * KEPT from the battle-tested predecessor (each documents a live incident):
 *   - the asyncio un-poisoning before every Playwright launch attempt;
 *   - stale Chromium profile Singleton-lock cleanup;
 *   - BootFailure → reply written → driver exits (fresh driver next cmd);
 *   - dead-context detection + rebuild (sandbox pause/resume);
 *   - the live-cast side thread with its own CDP connection.
 *
 * SECURITY BOUNDARIES: this is an authorized automation capability. It does
 * not implement workflows to defeat CAPTCHAs, access controls,
 * authentication protections or rate limits; it respects credentials,
 * service terms and the existing OnyxAgent safety controls.
 *
 * Packaging constraint: this Python source is exported as a TS template
 * literal embedded verbatim — the source must contain NO backticks and NO
 * ${ } sequences (Python naturally has neither; keep it that way).
 */

/**
 * Driver version — stamped into /home/user/.onyx/browser/.version when the
 * driver starts. The session manager (browser-session.ts) compares the
 * RUNNING driver's stamp against this constant: a live driver with a stale
 * stamp is killed and redeployed. Bump whenever the Python source changes
 * meaningfully.
 */
export const BROWSER_DRIVER_VERSION = "2026.11.03";

/** Sandbox-side paths (shared by the client session manager and the
 *  server-side prepare hook — single source of truth). */
export const BROWSER_SANDBOX_PATHS = {
  dir: "/home/user/.onyx/browser",
  get driver() {
    return `${this.dir}/driver.py`;
  },
  get bootSh() {
    return `${this.dir}/boot.sh`;
  },
  get bootLog() {
    return `${this.dir}/boot.log`;
  },
  get installLog() {
    return `${this.dir}/boot-install.log`;
  },
  get ready() {
    return `${this.dir}/.ready`;
  },
  get version() {
    return `${this.dir}/.version`;
  },
  get cmd() {
    return `${this.dir}/cmd.json`;
  },
  get bootFailed() {
    return `${this.dir}/.boot-failed`;
  },
} as const;

// ---------------------------------------------------------------------------
// Detached spawn — the ONLY launch shape that survives E2B envd's
// post-command cleanup (live-probed 2026-11-01 against the production E2B
// template, e2b SDK 2.32):
//
//   PATTERN                                 launcher returns   process alive
//   script-PTY + nohup ... &                   ~0.2s            KILLED
//   script-PTY + setsid nohup ... &            ~0.2s            KILLED
//   script-PTY + ( ... & disown )              ~0.2s            KILLED
//   script-PTY + trap "" HUP TERM INT &        ~0.2s            KILLED
//   direct commands.run + ... & (timeout)     timeout THROWN    ALIVE
//   python Popen(start_new_session=True)        ~0.8s            ALIVE  ✓
//
// envd kills every descendant of a command that COMPLETES NORMALLY — nohup,
// setsid, disown and signal shields do NOT escape it (setsid leaves the
// process a descendant; nohup only blocks SIGHUP). A python launcher that
// Popen's the target with start_new_session=True and exits immediately
// both returns fast AND leaves the target reparented away from the command
// tree, so the cleanup walk finds nothing to kill. (A command that ends by
// TIMEOUT also fails to kill the detached target — but that shape burns
// the whole launcher timeout and throws, which is how the server-side
// prepare "worked" before: 15s wasted per sandbox creation + a false
// TimeoutError; and the CLIENT-side kick through the exec_stream PTY
// completed normally, KILLED boot.sh instantly and left the boot poll
// spinning to its 10-minute ceiling — the "use_browser runs forever"
// incident this helper exists to prevent.)
//
// Contract: cwd must exist; logPath's directory must exist; the caller
// appends ` && echo <marker>` when it needs a launch confirmation.
// ---------------------------------------------------------------------------

/** Single-quote a shell word (POSIX-safe for the values used here). */
function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/**
 * Build the sandbox-side command that spawns `argv` fully detached: the
 * launcher (python3) exits in under a second, and the spawned process runs
 * in its own session, reparented away from the command tree, with stdin
 * from /dev/null and stdout/stderr appended to `logPath`. Use this for
 * EVERY long-lived sandbox daemon (browser boot.sh, headless agent runner).
 */
export function buildDetachedSpawnCommand(opts: {
  cwd: string;
  argv: string[];
  logPath: string;
}): string {
  const py = [
    "import os,subprocess,json;",
    "subprocess.Popen(json.loads(os.environ[\"ONYX_SPAWN_ARGV\"]),",
    "stdin=subprocess.DEVNULL,",
    "stdout=open(os.environ[\"ONYX_SPAWN_LOG\"],\"ab\"),",
    "stderr=subprocess.STDOUT,",
    "start_new_session=True)",
  ].join("");
  return [
    `cd ${shellQuote(opts.cwd)}`,
    `&& ONYX_SPAWN_ARGV=${shellQuote(JSON.stringify(opts.argv))}`,
    `ONYX_SPAWN_LOG=${shellQuote(opts.logPath)}`,
    `python3 -c ${shellQuote(py)}`,
  ].join(" ");
}

/**
 * boot.sh — the sandbox-side installer + daemon launcher. Runs fully
 * DETACHED (spawned via buildDetachedSpawnCommand — see the probe notes
 * there) so it survives the HTTP request that spawned it, E2B envd's
 * post-command cleanup, and any serverless function timeout behind that
 * request.
 *
 * ZERO-STARTUP-DELAY ARCHITECTURE: the server kicks this script AT SANDBOX
 * CREATION (createAndCacheSandbox → prepareBrowserRuntime) so the runtime
 * install + the ~200 MB CloakBrowser binary download run in the background
 * WHILE the user chats — the first use_browser call then finds a ready
 * browser instead of paying the whole install behind its own timeout. The
 * client's ensureBrowserDriver uses the same script; the .boot-lock makes
 * double-kicks harmless.
 *
 * Contract with the polling client (see ensureBrowserDriver):
 *   .boot-failed  — FATAL: written with the pip log tail when the runtime
 *                   could not be installed; the client surfaces it verbatim.
 *   .ready        — SUCCESS: written by driver.py when its command loop is
 *                   up AND (preboot marker) the browser is usable.
 *   boot.log      — human-readable progress lines the client narrates live.
 *   events.jsonl  — structured install/download lifecycle events.
 *
 * Install ladder (first success wins). CRITICAL: pip and the import probe
 * MUST target the SAME interpreter — on the E2B code-interpreter template
 * a bare `pip` can install into a different Python than `python3` (the
 * kernel venv vs the system interpreter), so the install "succeeded" while
 * `python3 -c "import cloakbrowser"` failed on every ladder attempt (the
 * recurring browser_startup_failed). `python3 -m pip` is therefore the
 * PRIMARY resolver — bare pip is only a last resort. No `| tail` on the
 * pip calls — a pipe would mask pip's exit code; success is verified with
 * the import probe instead, and probe failures log the actual ImportError
 * so boot-install.log always says WHY.
 */
export const BROWSER_BOOT_SH_SOURCE = `#!/bin/bash
# Onyx sandbox browser boot — DETACHED installer + daemon launcher.
# Idempotent: the .boot-lock makes a second kick (client-side boot while the
# creation-time kick is still running) exit quietly — both see the same .ready.
cd "$(dirname "$0")" || exit 1

log() { echo "[boot \$(date +%H:%M:%S)] \$*"; }
evt() { printf '{"ts":%s000,"event":"%s"}\n' "\$(date +%s)" "\$1" >> events.jsonl 2>/dev/null || true; }

# Resolve the interpreter FIRST — every pip call AND the probe use it.
PY="python3"
command -v python3 >/dev/null 2>&1 || PY="python3.12"
command -v "\$PY" >/dev/null 2>&1 || PY="python"
log "interpreter: \$PY (\$(\$PY -V 2>&1)) at \$(command -v \$PY)"

# pip MODULE of THAT interpreter (never a bare pip binary first — it can
# target a different site-packages than \$PY reads).
if ! "\$PY" -m pip --version >/dev/null 2>&1; then
  log "\$PY -m pip unavailable — falling back to pip3/pip"
  PIP="pip3"
  command -v pip3 >/dev/null 2>&1 || PIP="pip"
else
  PIP="\$PY -m pip"
fi

# One boot at a time: a still-running earlier boot (creation-time kick +
# client kick racing) owns this sandbox — let it finish; both polls see the
# same .ready either way.
if [ -f .boot-lock ] && kill -0 "\$(cat .boot-lock 2>/dev/null)" 2>/dev/null; then
  log "another boot is already running (pid \$(cat .boot-lock)) — exiting"
  exit 0
fi
echo \$\$ > .boot-lock

log "checking the browser runtime…"
fresh_install=0
if "\$PY" -c "import cloakbrowser, playwright" >/dev/null 2>&1; then
  log "browser runtime already installed"
  evt "BROWSER_RUNTIME_PRESENT"
else
  fresh_install=1
  evt "BROWSER_DOWNLOAD_START"
  log "installing the browser runtime (first run — can take a few minutes)…"
  ok=0
  for flags in "" "--break-system-packages" "--user --break-system-packages" "--user"; do
    log "\$PIP install \${flags:-default}: cloakbrowser==0.6.1 playwright"
    if \$PIP install --quiet --no-input \$flags "cloakbrowser==0.6.1" playwright >> boot-install.log 2>&1; then
      log "pip exited 0 (\${flags:-default}) — verifying the import…"
      if "\$PY" -c "import cloakbrowser, playwright" >>boot-install.log 2>&1; then
        ok=1
        log "browser runtime installed and importable"
        evt "BROWSER_DOWNLOAD_COMPLETE"
        break
      else
        log "import probe FAILED after a successful pip run — interpreter mismatch (see boot-install.log)"
      fi
    else
      log "pip run failed (\${flags:-default}) — trying the next variant"
    fi
  done
  if [ "\$ok" != "1" ]; then
    evt "BROWSER_DOWNLOAD_FAILED"
    {
      echo "pip could not install cloakbrowser==0.6.1 + playwright into \$PY (\$(command -v \$PY), \$(\$PY -V 2>&1))."
      echo "---- probe error ----"
      "\$PY" -c "import cloakbrowser, playwright" 2>&1 | tail -n 8
      echo "---- last 40 lines of boot-install.log ----"
      tail -n 40 boot-install.log 2>/dev/null
    } > .boot-failed
    log "FATAL: browser runtime install failed (details in .boot-failed)"
    exit 1
  fi
fi

# BINARY PRE-FETCH: after a FRESH install the ~200 MB browser binaries are
# still missing — fetch them HERE (inside the detached, narrated boot
# window) instead of letting the first use_browser action pay the download
# behind its own action timeout. Best-effort: a failed pre-fetch degrades
# to the old lazy-download behavior.
if [ "\$fresh_install" = "1" ]; then
  log "pre-fetching the browser binaries (~200 MB — the slow part of a cold boot)…"
  if "\$PY" -m cloakbrowser install >> boot-install.log 2>&1; then
    log "stealth Chromium binary cached — the browser will launch instantly"
    evt "BROWSER_BINARY_CACHED"
  else
    log "cloakbrowser binary pre-fetch failed — the driver will download it on first launch"
  fi
  if "\$PY" -m playwright install chromium >> boot-install.log 2>&1; then
    log "stock Chromium (fallback runtime) cached"
  else
    log "playwright chromium pre-fetch failed — the fallback will self-install if needed"
  fi
fi

# PREBOOT MARKER: driver.py boots the BROWSER (the expensive part) before
# it writes .ready, so "boot done" means "browser USABLE": the first
# action no longer hides a ~200 MB download behind its own timeout, and a
# boot failure surfaces in the boot poll instead of an action timeout.
: > .preboot

log "starting the browser driver…"
rm -f .ready
nohup "\$PY" driver.py > driver.log 2>&1 &
log "driver launched (pid \$!) — it will preboot the browser before reporting ready"
`;

export const BROWSER_DRIVER_PY_SOURCE = String.raw`#!/usr/bin/env python3
# OnyxAgent browser driver — CloakBrowser (humanize=True) over a persistent
# profile, Playwright-driven, file-protocol command loop with a per-action
# WATCHDOG that guarantees every command eventually resolves.
import asyncio
import base64
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import traceback

DIR = "/home/user/.onyx/browser"
CMD = os.path.join(DIR, "cmd.json")
SHOTS = os.path.join(DIR, "shots")
PROFILE = os.path.join(DIR, "profile")
DOWNLOADS = "/home/user/downloads"
RECORDINGS = os.path.join(DIR, "recordings")
READY = os.path.join(DIR, ".ready")
VERSION_PATH = os.path.join(DIR, ".version")
PREBOOT = os.path.join(DIR, ".preboot")
BOOT_LOG = os.path.join(DIR, "boot.log")
BOOT_FAIL_PATH = os.path.join(DIR, ".boot-failed")
EVENTS = os.path.join(DIR, "events.jsonl")
DRIVER_VERSION = "${BROWSER_DRIVER_VERSION}"
LIVE_JSON = os.path.join(DIR, "live.json")
LIVE_JPG = os.path.join(DIR, "live.jpg")
for d in (DIR, SHOTS, DOWNLOADS, RECORDINGS):
    os.makedirs(d, exist_ok=True)

LAUNCH_ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-blink-features=AutomationControlled", "--remote-debugging-port=9222"]

context = None
pw = None
pages = []            # ordered tab list: [{ id, page }]
active_idx = 0
tab_seq = 0
shot_n = 0
session_id = "br_" + str(int(time.time() * 1000))[::-1][:8]
runtime = None
boot_error = None
console_log = []
network_log = []
seen_console = set()
ref_map = {}          # element ref -> CSS/XPath selector (from get_elements)

CONSOLE_MAX = 80
NETWORK_MAX = 60

# ── STRUCTURED EVENTS (PRD §11) ─────────────────────────────────────────────
# One JSON object per line in events.jsonl: ts + event + fields. Never
# raises, never blocks the command loop, never logs secrets — ids, actions,
# durations and runtime names only.

EVT_LOCK = threading.Lock()


def event(name, **fields):
    """Append a structured lifecycle event. Safe from any thread."""
    try:
        row = {"ts": int(time.time() * 1000), "event": str(name)}
        for k, v in fields.items():
            if v is None:
                continue
            row[k] = v
        line = json.dumps(row)
        with EVT_LOCK:
            with open(EVENTS, "a") as f:
                f.write(line + "\n")
    except Exception:
        pass


def log(msg):
    try:
        with open(os.path.join(DIR, "driver.log"), "a") as f:
            f.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), msg))
    except Exception:
        pass


def boot_log(msg):
    """Append a preboot progress line to boot.log — the file the session
    manager's boot poll narrates live (driver.log is NOT polled during
    boot). Used only by the startup PREBOOT so a cold browser download
    shows real movement in the tool UI instead of a silent spinner."""
    try:
        with open(BOOT_LOG, "a") as f:
            f.write("[driver %s] %s\n" % (time.strftime("%H:%M:%S"), msg))
    except Exception:
        pass


def record_console(etype, text):
    t = str(text or "")[:500]
    if not t:
        return
    key = etype + "|" + t
    if key in seen_console:
        return
    seen_console.add(key)
    console_log.append({"type": etype, "text": t, "ts": int(time.time())})
    if len(console_log) > CONSOLE_MAX:
        console_log.pop(0)


def record_network(entry):
    network_log.append(entry)
    if len(network_log) > NETWORK_MAX:
        network_log.pop(0)


def attach_page_listeners(p):
    def on_console(msg):
        try:
            mtype = msg.type
            if mtype in ("error", "warning"):
                record_console("warn" if mtype == "warning" else "error", msg.text)
        except Exception:
            pass

    def on_pageerror(err):
        record_console("pageerror", getattr(err, "message", str(err)))

    def on_response(resp):
        try:
            s = resp.status
            if s >= 400:
                record_network({"status": s, "url": str(resp.url)[:300], "ts": int(time.time())})
        except Exception:
            pass

    def on_requestfailed(req):
        try:
            fail = req.failure
            err = fail.error_text if fail else ""
            record_network({"status": 0, "url": str(req.url)[:300], "error": str(err or "failed"), "ts": int(time.time())})
        except Exception:
            pass

    p.on("console", on_console)
    p.on("pageerror", on_pageerror)
    p.on("response", on_response)
    p.on("requestfailed", on_requestfailed)


# ── LIVE CAST (realtime browser view) ───────────────────────────────────────
# A side thread streams JPEG frames of the ACTIVE tab via CDP
# Page.startScreencast (frames pushed on repaint) into live.jpg, while the
# main loop publishes the interaction state (cursor, action, url, title)
# into live.json after every action. The UI polls both files. The side
# thread NEVER touches the main loop's Playwright objects (sync API is
# thread-affine) — it opens its OWN connection over the CDP port instead.

LIVE_LOCK = threading.Lock()
LIVE_STATE = {
    "cursor": {"x": 640, "y": 400},
    "action": None,
    "seq": 0,
    "frameSeq": 0,
    "tab": None,
    "url": "",
    "title": "",
    "viewport": {"width": 1280, "height": 800},
    "booted": False,
    "closed": False,
    "sessionId": session_id,
    "runtime": None,
    "lastFrameAt": 0.0,
}
LIVE_DIRTY = True


def refresh_live_pages():
    """MAIN THREAD ONLY: copy the active tab's identity (url/title/
    viewport/tab id/runtime) into LIVE_STATE. Playwright's sync API is
    thread-affine, so page objects are read HERE, never in the side
    threads. Marks the state dirty; live.json lands within 100ms."""
    try:
        p = None
        with LIVE_LOCK:
            try:
                LIVE_STATE["tab"] = pages[active_idx]["id"] if pages else None
            except Exception:
                LIVE_STATE["tab"] = None
            LIVE_STATE["runtime"] = runtime
            LIVE_STATE["sessionId"] = session_id
            try:
                p = pages[active_idx]["page"] if pages else None
            except Exception:
                p = None
        if p is not None:
            try:
                url = p.url
                title = p.title()
                vs = p.viewport_size
                with LIVE_LOCK:
                    LIVE_STATE["url"] = url
                    LIVE_STATE["title"] = title
                    if vs:
                        LIVE_STATE["viewport"] = {"width": int(vs["width"]), "height": int(vs["height"])}
            except Exception:
                pass
        _mark_live_dirty()
    except Exception:
        pass


def _mark_live_dirty():
    global LIVE_DIRTY
    with LIVE_LOCK:
        LIVE_DIRTY = True


def live_pub_loop():
    """The ONLY live.json writer (single-writer — no file races): every
    100ms, when the state is dirty, snapshot LIVE_STATE + ts into
    live.json atomically. Never touches Playwright objects."""
    global LIVE_DIRTY
    while True:
        time.sleep(0.1)
        try:
            dirty = False
            snapshot = None
            with LIVE_LOCK:
                if LIVE_DIRTY:
                    dirty = True
                    LIVE_DIRTY = False
                    snapshot = dict(LIVE_STATE)
            if dirty and snapshot is not None:
                snapshot["ts"] = int(time.time() * 1000)
                tmp = LIVE_JSON + ".tmp"
                with open(tmp, "w") as f:
                    f.write(json.dumps(snapshot))
                os.replace(tmp, LIVE_JSON)
        except Exception:
            pass


def live_frame_seen():
    """LIVE THREAD: a screencast frame was captured — bump frameSeq so
    the polling reader knows a fresh live.jpg exists."""
    global LIVE_DIRTY
    with LIVE_LOCK:
        LIVE_STATE["frameSeq"] = LIVE_STATE.get("frameSeq", 0) + 1
        LIVE_STATE["lastFrameAt"] = time.time()
        LIVE_DIRTY = True


def publish_live(action=None, cursor=None):
    """MAIN THREAD: publish an interaction event (cursor in viewport px)
    and refresh the page-derived state; live.json lands within 100ms."""
    try:
        with LIVE_LOCK:
            if action is not None:
                LIVE_STATE["action"] = action
            if cursor is not None:
                try:
                    LIVE_STATE["cursor"] = {"x": int(round(cursor[0])), "y": int(round(cursor[1]))}
                except Exception:
                    pass
            LIVE_STATE["seq"] = LIVE_STATE.get("seq", 0) + 1
        refresh_live_pages()
    except Exception:
        pass


def cursor_of_box(box):
    """Center of an interacted element's box, in viewport px."""
    try:
        return (box["x"] + box["w"] / 2.0, box["y"] + box["h"] / 2.0)
    except Exception:
        return None


def mark_active_tab():
    """Stamp the ACTIVE page with a marker the live thread can find from its
    own CDP connection (exact tab matching even across duplicate URLs)."""
    try:
        p = pages[active_idx]["page"]
        p.evaluate("window.__onyx_active_tab = %r" % pages[active_idx]["id"])
    except Exception:
        pass


def live_pick_page(live_browser):
    """The live thread's page picker: marker match, then URL, then first."""
    with LIVE_LOCK:
        want_tab = LIVE_STATE.get("tab")
        want_url = LIVE_STATE.get("url") or ""
    fallback = None
    first = None
    try:
        contexts = list(live_browser.contexts)
    except Exception:
        return None
    for ctx in contexts:
        try:
            page_list = list(ctx.pages)
        except Exception:
            continue
        for p in page_list:
            if first is None:
                first = p
            try:
                if want_tab and p.evaluate("window.__onyx_active_tab || ''") == want_tab:
                    return p
            except Exception:
                pass
            try:
                if fallback is None and want_url and p.url == want_url:
                    fallback = p
            except Exception:
                pass
    return fallback if fallback is not None else first


def live_cast_loop():
    """The live-cast daemon: own CDP connection, Page.startScreencast on the
    active tab, frames → live.jpg (atomic). Reconnects forever; a failure
    here never affects the command loop."""
    while True:
        pwp = None
        try:
            from playwright.sync_api import sync_playwright
            pwp = sync_playwright().start()
            live_browser = pwp.chromium.connect_over_cdp("http://127.0.0.1:9222", timeout=8000)
            cdp = None
            watched = None
            while True:
                page = live_pick_page(live_browser)
                if page is not watched:
                    if cdp is not None:
                        try:
                            cdp.send("Page.stopScreencast")
                        except Exception:
                            pass
                        cdp = None
                    watched = page
                    if page is not None:
                        try:
                            cdp = page.context.new_cdp_session(page)

                            def _on_frame(frame, _cdp=cdp):
                                try:
                                    now = time.time()
                                    sid = frame.get("sessionId")
                                    if sid is not None:
                                        try:
                                            _cdp.send("Page.screencastFrameAck", {"sessionId": sid})
                                        except Exception:
                                            pass
                                    if now - LIVE_STATE.get("lastFrameAt", 0.0) < 0.12:
                                        return
                                    data = frame.get("data") or ""
                                    if data:
                                        tmp = LIVE_JPG + ".tmp"
                                        with open(tmp, "wb") as f:
                                            f.write(base64.b64decode(data))
                                        os.replace(tmp, LIVE_JPG)
                                        live_frame_seen()
                                except Exception:
                                    pass

                            cdp.on("Page.screencastFrame", _on_frame)
                            cdp.send("Page.startScreencast", {
                                "format": "jpeg",
                                "quality": 55,
                                "maxWidth": 1152,
                                "maxHeight": 720,
                                "everyNthFrame": 4,
                            })
                            log("live cast attached to tab")
                        except Exception as e:
                            log("live cast attach failed: %s" % e)
                            cdp = None
                time.sleep(0.5)
        except Exception as e:
            log("live cast loop: %s" % e)
        finally:
            try:
                if pwp is not None:
                    pwp.stop()
            except Exception:
                pass
        time.sleep(3.0)


class BootFailure(RuntimeError):
    """Browser boot failed after both engines. The command loop reports
    the error, then EXITS the driver process: a failed boot may leave
    leaked Playwright instances / node driver processes parked in this
    process, and the session manager boots a FRESH driver on the next
    command (the persistent profile keeps the session state)."""


def _unpoison_asyncio():
    """Clear THIS thread's running-loop flag.

    A leaked Playwright Sync instance parks its dispatcher greenlet inside
    loop.run_until_complete() and leaves the thread's running-loop flag set
    FOREVER — every later sync_playwright().start() in this thread then
    fails immediately with 'It looks like you are using Playwright Sync API
    inside the asyncio loop. Please use the Async API instead.' (verified:
    start() -> leak -> start() FAILS -> _set_running_loop(None) -> start()
    OK). The flag is cleared with the same private API Playwright itself
    uses (EventInfo.value calls asyncio._set_running_loop); per-thread, so
    the live-cast and recording threads are unaffected."""
    try:
        asyncio._set_running_loop(None)
    except Exception:
        pass
def _clear_stale_profile_locks():
    """Remove Chromium's stale ProcessSingleton locks before launching.

    A hard-killed Chromium (sandbox pause/resume, OOM, crash, watchdog
    kill) leaves Singleton{Lock,Cookie,Socket} in the profile dir — the
    next launch_persistent_context with the same user-data-dir then
    REFUSES to start, which leaked the fallback Playwright instance and
    poisoned this thread for every later boot. Orphan chromium processes
    still holding OUR profile (no live driver connection owns them — we
    are booting, so any survivor is a zombie) are reaped first."""
    try:
        out = subprocess.run(
            ["pgrep", "-f", "user-data-dir=" + PROFILE],
            capture_output=True, text=True, timeout=10,
        ).stdout.split()
        for pid in out:
            try:
                os.kill(int(pid), signal.SIGKILL)
                log("reaped orphan chromium pid %s holding the browser profile" % pid)
            except Exception:
                pass
        if out:
            time.sleep(0.4)
    except Exception:
        pass
    for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        p = os.path.join(PROFILE, name)
        try:
            if os.path.lexists(p):
                os.remove(p)
                log("removed stale profile lock: %s" % name)
        except Exception:
            pass


def _context_alive():
    """Cheap liveness probe: a REAL CDP roundtrip (page.title()). Cached
    properties like context.pages stay readable after the connection dies,
    so only a roundtrip proves the browser is still there (sandbox
    pause/resume kills the browser while the driver keeps running)."""
    if context is None:
        return False
    try:
        _ = context.pages
        if not pages:
            return True
        pages[0]["page"].title()
        return True
    except Exception as e:
        msg = str(e)
        if ("closed" in msg.lower() or "Connection" in msg
                or "EOF" in msg or "Not connected" in msg):
            return False
        # Page-level transient error on a LIVE context — do not nuke it.
        return True


def _reset_browser_state():
    """Drop a dead browser context/pages/pw so boot_browser() can rebuild
    on the persistent profile. Best-effort closes (the objects may already
    be dead — that is exactly the case being handled)."""
    global context, pw, runtime, pages, active_idx
    try:
        if context is not None:
            context.close()
    except Exception:
        pass
    context = None
    try:
        if pw is not None:
            pw.stop()
    except Exception:
        pass
    pw = None
    runtime = None
    pages = []
    active_idx = 0
    # A dead-but-unstoppable instance can leave the running-loop flag set.
    _unpoison_asyncio()


def _display_alive(n):
    """True when the X socket /tmp/.X11-unix/X<n> exists (a filesystem probe —
    needs no xset/xdpyinfo binaries)."""
    try:
        return os.path.exists(os.path.join("/tmp/.X11-unix", "X%d" % n))
    except Exception:
        return False


# HEADED MODE (user directive 2026-10-21): the browser must run with
# headless=False on a real (virtual) display — a headed stealth Chromium is
# far closer to a desktop user's browser (no headless-mode fingerprints) and
# renders exactly like the live view the Browser tab shows. Cached on the
# first boot: None = not probed yet, True = display ready (launch headed),
# False = no display possible (fall back to headless=True so the tool still
# works on lean base templates without xvfb).
HEADED = None


def _ensure_display():
    """Provide an X display for headless=False. An inherited DISPLAY wins;
    otherwise Xvfb is started on :99 (it ships with the onyx e2b template).
    Sets DISPLAY in THIS process (Chromium inherits it) and returns whether
    a display is available."""
    cur = os.environ.get("DISPLAY") or ""
    if cur.startswith(":"):
        try:
            if _display_alive(int(cur[1:].split(".")[0])):
                return True
        except Exception:
            pass
    if _display_alive(99):
        os.environ["DISPLAY"] = ":99"
        return True
    try:
        if shutil.which("Xvfb") is None:
            log("no Xvfb available — the browser falls back to headless mode")
            return False
        subprocess.Popen(
            ["Xvfb", ":99", "-screen", "0", "1280x900x24", "-nolisten", "tcp"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        for _ in range(30):
            time.sleep(0.2)
            if _display_alive(99):
                os.environ["DISPLAY"] = ":99"
                log("started Xvfb on :99 — browser runs headed (headless=False)")
                return True
    except Exception as e:
        log("Xvfb start failed: %s" % e)
    return False


def _condense_launch_error(e):
    """Extract the DIAGNOSTIC line from a Playwright launch failure.

    Playwright's exception text embeds the full chrome launch log: a wall
    of default flags first, the real stderr after. Transport truncation
    (chat UI, event slices) used to cut the message right inside the flag
    dump — the user saw "--dis..." and never the actual cause. Pull the
    lines that carry the diagnosis (stderr after 'Browser logs:',
    'Missing X server', 'shared libraries', 'not permitted', ...) to the
    FRONT so any truncation loses redundant args, not the root cause."""
    msg = str(e)
    stderr_lines = []
    other_lines = []
    for line in msg.splitlines():
        s = line.strip()
        if not s:
            continue
        low = s.lower()
        if s.startswith("<"):  # "<launching>"/"<launched>" chrome arg dump
            continue
        is_diag = ("error" in low or "missing" in low or "not permitted" in low
                   or "failed" in low or "library" in low or "sandbox" in low
                   or s.startswith("["))
        if not is_diag:
            continue
        # Real browser stderr ("- [pid=…][err] …") is the diagnosis — keep
        # it ahead of the generic Playwright headline.
        if s.startswith("-") or s.startswith("["):
            stderr_lines.append(s)
        else:
            other_lines.append(s)
    keep = stderr_lines + other_lines
    if not keep:
        return msg[:300]
    return " | ".join(keep)[:600]


def boot_browser():
    """Launch the persistent-profile browser: CloakBrowser with
    humanize=True first, stock Playwright Chromium as the fallback.

    Boot hardening (the 'Sync API inside the asyncio loop' fix):
    - stale profile locks are cleared first (a hard-killed Chromium's
      Singleton locks used to make BOTH launches fail and leak);
    - the asyncio running-loop flag is cleared before EACH attempt (a
      leaked Playwright instance from any earlier failed attempt/close
      poisons the thread forever otherwise);
    - the fallback's pw is STOPPED on failure (never leaked);
    - a dead context (sandbox resume) is detected and rebuilt;
    - a total boot failure raises BootFailure -> the driver exits after
      reporting, so the next command boots a FRESH driver.
    """
    global context, pw, runtime, boot_error, HEADED
    if context is not None:
        if _context_alive():
            return
        log("browser context is dead — rebooting (the persistent profile keeps cookies/localStorage)")
        event("BROWSER_INITIALIZATION", phase="reboot", reason="dead-context")
        _reset_browser_state()
    boot_error = None
    _clear_stale_profile_locks()
    if HEADED is None:
        HEADED = _ensure_display()
    # -- attempt 1: CloakBrowser (stealth Chromium, humanized input) ------
    _unpoison_asyncio()
    event("BROWSER_INITIALIZATION", phase="start", engine="cloakbrowser", headed=HEADED)
    try:
        from cloakbrowser import launch_persistent_context as cb_launch
        context = cb_launch(
            PROFILE,
            humanize=True,
            headless=not HEADED,
            args=LAUNCH_ARGS,
            viewport={"width": 1280, "height": 800},
        )
        runtime = "cloakbrowser"
        with LIVE_LOCK:
            LIVE_STATE["booted"] = True
            LIVE_STATE["closed"] = False
        refresh_live_pages()
        event("BROWSER_READY", runtime=runtime, headed=HEADED)
        log("booted cloakbrowser runtime (humanize=True, persistent profile)")
        return
    except Exception as e:
        # cloakbrowser stops its internal playwright instance on launch
        # failure, but that stop can itself fail (warning path) — unpoison
        # so the fallback below gets a clean thread either way.
        _unpoison_asyncio()
        boot_error = "cloakbrowser launch failed: %s" % (_condense_launch_error(e),)
        log(boot_error)
        event("BROWSER_ACTION_FAILED", phase="boot", engine="cloakbrowser", detail=_condense_launch_error(e))
    # -- attempt 2: stock Playwright Chromium (runtime-agnostic fallback) --
    _unpoison_asyncio()
    try:
        from playwright.sync_api import sync_playwright
        pw = sync_playwright().start()
        try:
            context = pw.chromium.launch_persistent_context(
                PROFILE,
                headless=not HEADED,
                args=LAUNCH_ARGS,
                viewport={"width": 1280, "height": 800},
            )
        except Exception:
            # Missing browser binaries OR missing SYSTEM LIBRARIES on a
            # fresh sandbox — install BOTH once and retry. The old
            # "playwright install chromium" only fetched the binary: on
            # lean base images (the default code-interpreter template
            # WITHOUT the custom onyx template's apt layer) the browser
            # then still failed to exec with "Failed to launch the
            # browser process" — the missing shared libs (libnss3,
            # libatk, …) were never installed. --with-deps runs the
            # distro package install (the sandbox runs as root).
            event("BROWSER_DOWNLOAD_START", phase="fallback-deps")
            subprocess.run(
                [sys.executable, "-m", "playwright", "install", "--with-deps", "chromium"],
                capture_output=True, timeout=900,
            )
            event("BROWSER_DOWNLOAD_COMPLETE", phase="fallback-deps")
            context = pw.chromium.launch_persistent_context(
                PROFILE,
                headless=not HEADED,
                args=LAUNCH_ARGS,
                viewport={"width": 1280, "height": 800},
            )
        runtime = "chromium"
        with LIVE_LOCK:
            LIVE_STATE["booted"] = True
            LIVE_STATE["closed"] = False
        refresh_live_pages()
        event("BROWSER_READY", runtime=runtime, headed=HEADED)
        log("booted standard chromium fallback runtime (persistent profile)")
    except Exception as e:
        # STOP the instance — a leaked sync_playwright() parks its greenlet
        # inside run_until_complete and leaves this thread's running-loop
        # flag set forever (every later boot then fails with 'Sync API
        # inside the asyncio loop'). stop() itself can fail — unpoison
        # again after it.
        try:
            if pw is not None:
                pw.stop()
        except Exception:
            pass
        pw = None
        _unpoison_asyncio()
        boot_error = (boot_error + " | chromium fallback failed: %s" % (e,)) if boot_error else str(e)
        event("BROWSER_ACTION_FAILED", phase="boot", engine="chromium", detail=_condense_launch_error(e))
        raise BootFailure(boot_error)


def ensure_pages():
    """Make sure at least one tab exists (persistent contexts start empty
    or with a restored page)."""
    global tab_seq, pages, active_idx
    boot_browser()
    existing = getattr(context, "pages", None) or []
    if not pages:
        for p in existing:
            tab_seq += 1
            tid = "tab_%d" % tab_seq
            attach_page_listeners(p)
            pages.append({"id": tid, "page": p})
        if not pages:
            p = context.new_page()
            tab_seq += 1
            attach_page_listeners(p)
            pages.append({"id": "tab_%d" % tab_seq, "page": p})
        active_idx = 0
    # Track popups (target=_blank) as new tabs automatically.
    try:
        context.on("page", lambda p: add_popup(p))
    except Exception:
        pass


def add_popup(p):
    global tab_seq
    tab_seq += 1
    attach_page_listeners(p)
    pages.append({"id": "tab_%d" % tab_seq, "page": p})
    log("popup tab attached: tab_%d" % tab_seq)


def active_page():
    # global is REQUIRED: this function clamps active_idx, and any assignment
    # to a name makes Python treat it as local for the WHOLE function — the
    # read in the clamp line then raised "cannot access local variable
    # 'active_idx' where it is not associated with a value" (UnboundLocal-
    # Error) on EVERY command, because state_payload() -> active_page() runs
    # for every handler reply.
    global active_idx
    ensure_pages()
    if active_idx >= len(pages):
        active_idx = len(pages) - 1
    return pages[active_idx]["page"]


def tab_summary():
    out = []
    for i, t in enumerate(pages):
        p = t["page"]
        try:
            url = p.url
        except Exception:
            url = "about:blank"
        try:
            title = p.title()
        except Exception:
            title = ""
        out.append({"tabId": t["id"], "index": i, "url": url, "title": title, "active": i == active_idx})
    return out


def state_payload(extra=None):
    p = active_page()
    try:
        url = p.url
    except Exception:
        url = "about:blank"
    try:
        title = p.title()
    except Exception:
        title = ""
    try:
        vs = p.viewport_size
        viewport = {"width": int(vs["width"]), "height": int(vs["height"])} if vs else None
    except Exception:
        viewport = None
    out = {
        "sessionId": session_id,
        "runtime": runtime,
        "url": url,
        "title": title,
        "viewport": viewport,
        "tabs": tab_summary(),
        "activeTab": active_idx,
        "tabCount": len(pages),
    }
    if extra:
        out.update(extra)
    return out


def err_payload(etype, message, recoverable=True):
    return {
        "success": False,
        "error": {"type": etype, "message": str(message)[:600], "recoverable": recoverable},
        # PRD §5: never an empty response — even failures carry a readable
        # one-line output the chat UI can render directly.
        "output": "%s: %s" % (etype, str(message)[:300]),
    }


# ── Element targeting (semantic first, CSS/XPath/ref fallback) ──

def _ref_locator(page, rid):
    """Resolve an inspect/get_elements ref ('e12') to its stored selector.
    Shared by the 'ref=e12' string form, the bare 'e12' form and the
    {"ref": "e12"} object form."""
    sel = ref_map.get(rid)
    if not sel:
        raise RuntimeError(
            "Unknown element ref: %s — the page changed since the last inspect (refs are per-inspect). "
            "Valid refs right now: %s. Call inspect/get_elements again and use a fresh ref." % (
                rid, (", ".join(sorted(ref_map.keys()))) or "none — inspect first"))
    return page.locator(sel)


def resolve_target(page, target):
    """Resolve a target spec into a Playwright locator.
    String: a selector Playwright understands (css, "text=…", "xpath=…",
    "#id", ".cls"), an inspect ref — BARE ("e12") or prefixed ("ref=e12") —
    or a stringified JSON object spec. Object: {role,name} | {text} | {label}
    | {placeholder} | {css} | {xpath} | {ref}."""
    if target is None:
        return page.locator("body")
    if isinstance(target, str):
        t = target.strip()
        if not t:
            return page.locator("body")
        if t.startswith("ref="):
            return _ref_locator(page, t[4:])
        # Bare inspect ref — "e19". The arena.ai incident (2026-11-03): the
        # model sent the ref WITHOUT the ref= prefix (the inspect output and
        # the tool docs show bare refs); it fell through to CSS, and
        # locator('e19 >> nth=0') waited 12 s for a nonexistent <e19> tag.
        if len(t) > 1 and t[0] == "e" and t[1:].isdigit():
            return _ref_locator(page, t)
        # Stringified JSON object spec — '{"label":"message"}'. The same
        # incident: the model stringified the semantic object; Playwright
        # died on 'Unsupported token "{"' parsing it as CSS. Parse it and
        # route through the object branch; anything that is not a JSON
        # object still falls through to the selector path below.
        if t.startswith("{") and t.endswith("}"):
            try:
                parsed = json.loads(t)
            except Exception:
                parsed = None
            if isinstance(parsed, dict):
                return resolve_target(page, parsed)
        if t.startswith("xpath=") or t.startswith("text=") or t.startswith("css="):
            return page.locator(t)
        return page.locator(t)
    if isinstance(target, dict):
        if target.get("ref"):
            return _ref_locator(page, str(target.get("ref")))
        if target.get("role"):
            kw = {"name": target["name"]} if target.get("name") else {}
            return page.get_by_role(str(target["role"]), **kw)
        if target.get("text"):
            return page.get_by_text(str(target["text"]), exact=False)
        if target.get("label"):
            return page.get_by_label(str(target["label"]))
        if target.get("placeholder"):
            return page.get_by_placeholder(str(target["placeholder"]))
        if target.get("alt"):
            return page.get_by_alt_text(str(target["alt"]))
        if target.get("title"):
            return page.get_by_title(str(target["title"]))
        if target.get("testId"):
            return page.get_by_test_id(str(target["testId"]))
        if target.get("css"):
            return page.locator(str(target["css"]))
        if target.get("xpath"):
            return page.locator("xpath=" + str(target["xpath"]))
        if target.get("selector"):
            return page.locator(str(target["selector"]))
    raise RuntimeError("Unsupported target: %r" % (target,))


def target_label(target):
    if isinstance(target, str):
        return target[:80]
    if isinstance(target, dict):
        for k in ("name", "text", "label", "placeholder", "alt", "title", "css", "xpath", "ref", "role", "selector"):
            if target.get(k):
                return "%s=%s" % (k, str(target[k])[:60])
    return "element"


def loc_box(loc):
    """Best-effort element bounding box in VIEWPORT pixels — the chat UI
    turns it into the computer-use cursor position (center of the box as a
    percentage of the viewport). None when the box can't be read."""
    try:
        b = loc.first.bounding_box(timeout=2000)
        if not b:
            return None
        return {
            "x": int(round(b.get("x") or 0)),
            "y": int(round(b.get("y") or 0)),
            "w": int(round(b.get("width") or 0)),
            "h": int(round(b.get("height") or 0)),
        }
    except Exception:
        return None
# In-page serializer for evaluate: DOM nodes, NodeLists, Promises, circular
# references and non-serializable values all produce USEFUL plain data
# instead of crashing the evaluation. (Kept backtick/ES-template free.)
SERIALIZER_JS = """
function __onyxSer(v, depth, seen) {
  seen = seen || new WeakSet();
  try {
    if (v === null) return null;
    var t = typeof v;
    if (t === 'string') return v.length > 4000 ? v.slice(0, 4000) + '...' : v;
    if (t === 'number' || t === 'boolean' || t === 'undefined') return v;
    if (t === 'bigint') return String(v) + 'n';
    if (t === 'symbol') return v.toString();
    if (t === 'function') return '[function ' + (v.name || 'anonymous') + ']';
    if (v instanceof Error) return v.name + ': ' + v.message;
    if (v instanceof Date) return v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (typeof Node !== 'undefined' && v instanceof Node) {
      if (v.nodeType === 1) {
        var cls = typeof v.className === 'string' ? v.className.split(/\\s+/).filter(Boolean).slice(0, 8) : [];
        var r = typeof v.getBoundingClientRect === 'function' ? v.getBoundingClientRect() : null;
        return { element: true, tag: v.tagName.toLowerCase(), id: v.id || undefined, classes: cls, text: (v.innerText || '').trim().slice(0, 200), box: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : undefined };
      }
      if (v.nodeType === 9) return '[document ' + (v.title || '') + ']';
      return '[' + (v.nodeName || 'node') + ']';
    }
    if (typeof Window !== 'undefined' && v instanceof Window) return '[window - ' + location.href + ']';
    if (seen.has(v)) return '[circular]';
    if (depth >= 4) return Array.isArray(v) ? '[array(' + v.length + ')]' : '[object]';
    seen.add(v);
    if (Array.isArray(v)) return v.slice(0, 100).map(function (x) { return __onyxSer(x, depth + 1, seen); });
    if (typeof NodeList !== 'undefined' && (v instanceof NodeList || v instanceof HTMLCollection)) { return Array.prototype.slice.call(v, 0, 100).map(function (x) { return __onyxSer(x, depth + 1, seen); }); }
    if (v && typeof v === 'object' && typeof v.length === 'number' && typeof v.item === 'function') { return Array.prototype.slice.call(v, 0, 100).map(function (x) { return __onyxSer(x, depth + 1, seen); }); }
    var out = {};
    var keys = Object.keys(v).slice(0, 30);
    for (var i = 0; i < keys.length; i++) out[keys[i]] = __onyxSer(v[keys[i]], depth + 1, seen);
    return out;
  } catch (e) {
    return '[unserializable: ' + String(e && e.message ? e.message : e) + ']';
  }
}
"""

EVAL_WRAPPER = "(async () => {\n" + SERIALIZER_JS + "\n  try {\n    let __r = eval(%s);\n    if (__r && typeof __r.then === 'function') __r = await __r;\n    return { ok: true, value: __onyxSer(__r, 0) };\n  } catch (e) {\n    return { ok: false, error: String(e && e.message ? e.message : e) };\n  }\n})()"

ELEMENTS_JS = """
(() => {
  function sel(el) {
    if (el.id) return '#' + el.id;
    var aria = el.getAttribute('aria-label');
    var tag = el.tagName.toLowerCase();
    if (aria) return tag + '[aria-label="' + aria.slice(0, 40) + '"]';
    var tname = el.getAttribute('name');
    if (tname) return tag + '[name="' + tname + '"]';
    var ph = el.getAttribute('placeholder');
    if (ph) return tag + '[placeholder="' + ph.slice(0, 30) + '"]';
    var cls = typeof el.className === 'string' ? el.className.split(/\\s+/).filter(Boolean) : [];
    if (cls.length) return tag + '.' + cls.slice(0, 2).join('.');
    var txt = (el.innerText || '').trim().slice(0, 20);
    if (txt) return tag + ':has-text("' + txt.replace(/"/g, '') + '")';
    return tag + ':nth-of-type(' + (Array.prototype.indexOf.call(el.parentNode.children, el) + 1) + ')';
  }
  var out = [];
  var nodes = document.querySelectorAll('a[href], button, input, select, textarea, [role=button], [role=link], [role=tab], [role=checkbox], [role=menuitem], [onclick], [contenteditable=true]');
  for (var el of nodes) {
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    var text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 80);
    out.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      role: el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName === 'BUTTON' || el.tagName === 'INPUT' && (el.getAttribute('type') === 'button' || el.getAttribute('type') === 'submit') ? 'button' : null),
      type: el.getAttribute('type') || null,
      name: el.getAttribute('name') || null,
      text: text || null,
      selector: sel(el),
      box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    });
    if (out.length >= 120) break;
  }
  return out;
})()
"""

# SNAPSHOT_JS (PRD §5 snapshot action): the page STRUCTURE — title,
# heading outline, element counts, the top interactive elements and a
# compact text excerpt. Cheap to evaluate, cheap to transport, and exactly
# what a model needs to plan the next interaction.
SNAPSHOT_JS = """
(() => {
  function txt(el, n) { return (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, n); }
  var headings = [];
  var hs = document.querySelectorAll('h1, h2, h3');
  for (var i = 0; i < hs.length && headings.length < 30; i++) {
    var t = txt(hs[i], 120);
    if (t) headings.push({ level: parseInt(hs[i].tagName.slice(1), 10), text: t });
  }
  var counts = { links: 0, buttons: 0, inputs: 0, images: 0 };
  document.querySelectorAll('a[href]').forEach(function () { counts.links++; });
  document.querySelectorAll('button, [role=button], input[type=button], input[type=submit]').forEach(function () { counts.buttons++; });
  document.querySelectorAll('input, textarea, select').forEach(function () { counts.inputs++; });
  document.querySelectorAll('img').forEach(function () { counts.images++; });
  var interactive = [];
  var nodes = document.querySelectorAll('a[href], button, input, select, textarea, [role=button], [onclick]');
  for (var j = 0; j < nodes.length && interactive.length < 40; j++) {
    var el = nodes[j];
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    var row = { tag: el.tagName.toLowerCase(), text: txt(el, 60) || null };
    if (el.tagName === 'A') row.href = (el.getAttribute('href') || '').slice(0, 200);
    if (el.id) row.id = el.id;
    interactive.push(row);
  }
  return {
    title: document.title || '',
    url: location.href,
    headings: headings,
    counts: counts,
    interactive: interactive,
    textExcerpt: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 1200)
  };
})()
"""

FORMS_JS = """
(() => {
  var out = [];
  var nodes = document.querySelectorAll('input, textarea, select');
  for (var el of nodes) {
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    var type = (el.getAttribute('type') || el.tagName.toLowerCase());
    if (type === 'hidden') continue;
    var lbl = '';
    try {
      if (el.labels && el.labels.length) lbl = (el.labels[0].innerText || '').trim().slice(0, 60);
    } catch (e) {}
    if (!lbl) lbl = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
    var row = { tag: el.tagName.toLowerCase(), type: type, label: lbl.slice(0, 60) || null };
    if (el.id) row.id = el.id;
    if (type === 'checkbox' || type === 'radio') row.checked = !!el.checked;
    else if (type !== 'password') row.value = String(el.value || '').slice(0, 80);
    if (el.disabled) row.disabled = true;
    if (el.tagName === 'SELECT') {
      var opts = [];
      for (var o of el.selectedOptions) opts.push(String(o.value || o.text).slice(0, 60));
      row.selected = opts.slice(0, 4);
      row.optionCount = el.options.length;
    }
    out.push(row);
    if (out.length >= 40) break;
  }
  return out;
})()
"""


def playw_err(e):
    """Map a Playwright/Python error into a structured error payload."""
    cls = type(e).__name__
    msg = str(e)
    if "Timeout" in cls or "timeout" in msg.lower():
        if "locator" in msg.lower() or "waiting for" in msg.lower():
            return err_payload("element_not_found", msg)
        return err_payload("timeout", msg)
    if "net::ERR" in msg or "Navigation failed" in msg:
        return err_payload("navigation_failed", msg)
    return err_payload("browser_error", msg, True)


# ── Cloudflare challenge settle (the "Just a moment..." incident, 2026-11-02) ──
# CloakBrowser defeats FINGERPRINT checks, but the sandbox egress is a
# datacenter IP, so Cloudflare still interstitials on IP reputation. The
# PASSIVE challenge auto-clears after ~3-10 s of JS — AFTER domcontentloaded,
# the exact moment goto() returns; without a settle the agent reads the
# interstitial and reports the page as stuck. An escalated Turnstile checkbox
# needs one real click — humanize=True makes ours pass.
CF_TITLE_MARKERS = (
    "just a moment", "attention required", "checking your browser",
    "verify you are human", "verifying you are human", "one more step",
)
CF_SELECTORS = (
    "#challenge-running", "#challenge-stage", "#challenge-form",
    "#challenge-error-text", "#cf-please-wait", "#cf-spinner-please-wait",
)
CF_IFRAME_SEL = "iframe[src*='challenges.cloudflare.com']"
MAX_TURNSTILE_CLICKS = 2


def _env_int(name, default, cap):
    """Env-tunable milliseconds, clamped to a hard cap so goto + settle can
    never exceed the action's watchdog budget."""
    try:
        raw = int(os.environ.get(name) or default)
    except Exception:
        raw = default
    return max(0, min(raw, cap))


def _challenge_level(p):
    """'interactive' (Turnstile checkbox visible), 'running' (interstitial
    shown / passive check in flight) or 'clear'. NOTE: a bare .cf-turnstile
    widget is NOT treated as a challenge — login forms embed those on real
    pages; waiting or clicking there would be wrong."""
    try:
        title = (p.title() or "").lower()
    except Exception:
        title = ""
    marker = any(m in title for m in CF_TITLE_MARKERS)
    widget = False
    try:
        widget = p.locator(CF_IFRAME_SEL).first.is_visible()
    except Exception:
        pass
    if marker:
        return "interactive" if widget else "running"
    for sel in CF_SELECTORS:
        try:
            if p.locator(sel).first.is_visible():
                return "interactive" if widget else "running"
        except Exception:
            pass
    return "clear"


def _click_turnstile(p):
    """One HUMANIZED click attempt on the Turnstile checkbox. The widget is
    cross-origin: try the checkbox inside the frame first, then the widget
    iframe itself (its label wraps the checkbox)."""
    try:
        p.frame_locator(CF_IFRAME_SEL).locator("input[type='checkbox']").first.click(timeout=4000)
        return True
    except Exception:
        pass
    try:
        p.locator(CF_IFRAME_SEL).first.click(timeout=4000)
        return True
    except Exception:
        return False


def _settle_challenge(p, budget_ms):
    """Wait out a Cloudflare interstitial; click an escalated Turnstile
    checkbox (bounded). Returns (level, status, waitedMs) where status is
    'none' | 'cleared' | 'cleared_after_click' | 'stuck' — an honest answer
    either way, never an infinite wait (budget_ms bounds the loop)."""
    started = time.time()
    clicks = 0
    if _challenge_level(p) == "clear":
        return ("clear", "none", 0)
    while True:
        level = _challenge_level(p)
        if level == "clear":
            return ("clear", "cleared" if clicks == 0 else "cleared_after_click", int((time.time() - started) * 1000))
        if level == "interactive" and clicks < MAX_TURNSTILE_CLICKS:
            clicks += 1
            if _click_turnstile(p):
                p.wait_for_timeout(2500)
                continue
        if (time.time() - started) * 1000 >= budget_ms:
            return (level, "stuck", int((time.time() - started) * 1000))
        p.wait_for_timeout(500)


def do_navigate(cmd):
    url = str(cmd.get("url") or "").strip()
    if not url:
        return err_payload("bad_request", "url is required for navigate", False)
    if not (url.startswith("http://") or url.startswith("https://") or url.startswith("file://") or url.startswith("about:")):
        url = "https://" + url
    p = active_page()
    publish_live("navigate")
    resp = p.goto(url, wait_until="domcontentloaded", timeout=45000)
    # Cloudflare settle: the passive check runs AFTER domcontentloaded (the
    # moment goto returns — exactly when the interstitial is showing). Wait
    # it out; click a Turnstile checkbox if the check escalated.
    level, status, waited = _settle_challenge(p, _env_int("ONYX_CF_SETTLE_MS", 18000, 30000))
    try:
        title = p.title()
    except Exception:
        title = ""
    out = state_payload({"success": True, "action": "navigate", "status": resp.status if resp else None})
    out["title"] = title
    out["challenge"] = status
    out["output"] = "Navigated to %s (%s)%s." % (title or url, url, " — HTTP %s" % resp.status if resp and resp.status else "")
    if status == "cleared":
        out["output"] += " Cloudflare challenge auto-cleared in %.1fs." % (waited / 1000.0)
    elif status == "cleared_after_click":
        out["output"] += " Cloudflare Turnstile cleared after a humanized click (%.1fs)." % (waited / 1000.0)
    elif status == "stuck":
        out["output"] += " The page is STILL on a Cloudflare challenge after %.0fs — wait a few seconds and read again, retry navigate once, or click the verification checkbox." % (waited / 1000.0)
    return out


def do_click(cmd):
    target = cmd.get("target")
    loc = resolve_target(active_page(), target)
    box = loc_box(loc)
    publish_live("mouse_move", cursor_of_box(box))
    loc.first.click(timeout=12000)
    active_page().wait_for_timeout(400)
    publish_live("click")
    out = state_payload({"success": True, "action": "click", "target": target_label(target)})
    if box:
        out["box"] = box
    out["output"] = "Clicked %s." % target_label(target)
    return out


def do_type(cmd):
    target = cmd.get("target")
    text = "" if cmd.get("text") is None else str(cmd.get("text"))
    clear = cmd.get("clear") is not False
    loc = resolve_target(active_page(), target)
    box = loc_box(loc)
    publish_live("mouse_move", cursor_of_box(box))
    if clear:
        loc.first.fill("", timeout=12000)
    # Humanized per-character typing when the runtime supports it
    # (CloakBrowser humanize=True); stock Playwright types instantly.
    try:
        loc.first.press_sequentially(text, delay=45, timeout=12000)
    except Exception:
        loc.first.fill(text, timeout=12000)
    if cmd.get("submit"):
        loc.first.press("Enter", timeout=8000)
        active_page().wait_for_timeout(600)
    publish_live("type")
    out = state_payload({"success": True, "action": "type", "target": target_label(target), "text": text[:80]})
    if box:
        out["box"] = box
    out["output"] = "Typed %d characters into %s%s." % (len(text), target_label(target), " and pressed Enter" if cmd.get("submit") else "")
    return out


def do_press(cmd):
    key = str(cmd.get("key") or "Enter")
    p = active_page()
    publish_live("keypress")
    p.keyboard.press(key)
    p.wait_for_timeout(300)
    out = state_payload({"success": True, "action": "press", "key": key})
    out["output"] = "Pressed %s." % key
    return out


def do_scroll(cmd):
    p = active_page()
    direction = str(cmd.get("direction") or "down")
    amount = int(cmd.get("amount") or 600)
    publish_live("scroll")
    try:
        p.mouse.wheel(amount if direction == "right" else 0, amount if direction == "down" else -amount)
    except Exception:
        p.evaluate("(d) => window.scrollBy(0, d)", amount if direction == "down" else -amount)
    p.wait_for_timeout(250)
    out = state_payload({"success": True, "action": "scroll", "direction": direction, "amount": amount})
    out["output"] = "Scrolled %s by %dpx." % (direction, amount)
    return out


def do_wait(cmd):
    p = active_page()
    ms = cmd.get("ms")
    selector = cmd.get("selector") or cmd.get("target")
    text = cmd.get("text")
    if selector:
        p.wait_for_selector(str(selector), timeout=15000)
        what = "selector %s" % str(selector)[:60]
    elif text:
        p.get_by_text(str(text)).first.wait_for(timeout=15000)
        what = "text %s" % str(text)[:60]
    else:
        ms2 = min(15000, max(0, int(ms or 1000)))
        p.wait_for_timeout(ms2)
        what = "%dms" % ms2
    out = state_payload({"success": True, "action": "wait"})
    out["output"] = "Waited for %s — condition met." % what
    return out


def do_screenshot(cmd):
    global shot_n
    p = active_page()
    shot_n += 1
    name = "shot-%d.png" % shot_n
    path = os.path.join(SHOTS, name)
    full = bool(cmd.get("fullPage"))
    p.screenshot(path=path, full_page=full)
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    out = state_payload({
        "success": True,
        "action": "screenshot",
        "path": path,
        "fullPage": full,
        "dataUrl": "data:image/png;base64," + b64,
    })
    out["output"] = "Screenshot captured to %s (%s, %d KB)." % (path, "full page" if full else "viewport", len(b64) * 3 // 4 // 1024)
    return out


# ── SCREEN RECORDING ─────────────────────────────────────────────────────
# screen_record.start/stop/status — captures the ACTIVE tab at ~2fps through
# a SIDE THREAD with its OWN CDP connection (the sync Playwright API is
# thread-affine; this is the same proven pattern as the live-cast loop), then
# assembles the frames into a playable .mp4 with the imageio-ffmpeg wheel
# (installs on demand — a static ffmpeg binary, no apt needed). Recording
# NEVER starts automatically; only when the agent explicitly asks for it.

REC_LOCK = threading.Lock()
REC = {
    "on": False,          # capturing right now
    "frames": [],         # captured jpeg frames (bytes), oldest first
    "bytes": 0,           # total captured bytes (size cap accounting)
    "started": None,      # wall-clock ms when start was requested
    "lastFrame": 0.0,     # pacing gate (min interval between kept frames)
    "thread": None,
    "stop_evt": None,
    "err": None,
}
REC_MAX_BYTES = 220 * 1024 * 1024   # ~55 min at 2fps/30KB — hard ceiling
REC_MIN_INTERVAL = 0.45             # ~2 fps keep rate


def rec_cast_loop(stop_evt):
    """The recording daemon: own CDP connection, Page.startScreencast on the
    ACTIVE tab (follows tab switches exactly like the live cast), frames
    appended into REC['frames']. Never touches the main loop's Playwright
    objects; a failure here only sets REC['err'] — the command loop is
    unaffected."""
    pwp = None
    try:
        from playwright.sync_api import sync_playwright
        pwp = sync_playwright().start()
        rec_browser = pwp.chromium.connect_over_cdp("http://127.0.0.1:9222", timeout=8000)
        cdp = None
        watched = None
        while not stop_evt.is_set():
            page = live_pick_page(rec_browser)
            if page is not watched:
                if cdp is not None:
                    try:
                        cdp.send("Page.stopScreencast")
                    except Exception:
                        pass
                    cdp = None
                watched = page
                if page is not None:
                    try:
                        cdp = page.context.new_cdp_session(page)

                        def _on_frame(frame, _cdp=cdp):
                            try:
                                sid = frame.get("sessionId")
                                if sid is not None:
                                    try:
                                        _cdp.send("Page.screencastFrameAck", {"sessionId": sid})
                                    except Exception:
                                        pass
                                with REC_LOCK:
                                    if not REC["on"]:
                                        return
                                    now = time.time()
                                    if now - REC["lastFrame"] < REC_MIN_INTERVAL:
                                        return
                                    data = frame.get("data") or ""
                                    if not data:
                                        return
                                    raw = base64.b64decode(data)
                                    if REC["bytes"] + len(raw) > REC_MAX_BYTES:
                                        REC["on"] = False
                                        REC["err"] = "recording reached its size cap (%d frames kept)" % len(REC["frames"])
                                        return
                                    REC["frames"].append(raw)
                                    REC["bytes"] += len(raw)
                                    REC["lastFrame"] = now
                            except Exception:
                                pass

                        cdp.on("Page.screencastFrame", _on_frame)
                        cdp.send("Page.startScreencast", {
                            "format": "jpeg",
                            "quality": 60,
                            "maxWidth": 1152,
                            "maxHeight": 720,
                            "everyNthFrame": 12,
                        })
                        log("screen recording attached to the active tab")
                    except Exception as e:
                        log("screen recording attach failed: %s" % e)
                        cdp = None
            time.sleep(0.5)
    except Exception as e:
        with REC_LOCK:
            REC["err"] = "recording stream failed: %s" % e
    finally:
        try:
            if pwp is not None:
                pwp.stop()
        except Exception:
            pass


def _ensure_ffmpeg():
    """imageio-ffmpeg ships a static ffmpeg binary as a wheel — install on
    demand. Returns True when the encoder is importable."""
    try:
        import imageio_ffmpeg  # noqa: F401
        return True
    except Exception:
        pass
    try:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", "imageio-ffmpeg"],
            capture_output=True, timeout=240,
        )
        import imageio_ffmpeg  # noqa: F401
        return True
    except Exception:
        return False


def do_screen_record(cmd):
    op = str(cmd.get("operation") or cmd.get("op") or "status").strip().lower()
    if op == "start":
        with REC_LOCK:
            if REC["on"]:
                return state_payload({
                    "success": True, "action": "screen_record", "operation": "start",
                    "recording": True, "startedAt": REC["started"],
                    "note": "a recording is already in progress",
                    "output": "A recording is already in progress.",
                })
            REC["on"] = True
            REC["frames"] = []
            REC["bytes"] = 0
            REC["err"] = None
            REC["started"] = int(time.time() * 1000)
            REC["lastFrame"] = 0.0
            stop_evt = threading.Event()
            REC["stop_evt"] = stop_evt
        os.makedirs(RECORDINGS, exist_ok=True)
        t = threading.Thread(target=rec_cast_loop, args=(stop_evt,), daemon=True)
        with REC_LOCK:
            REC["thread"] = t
        t.start()
        # Warm the encoder dependency in the background — it is usually
        # ready by the time recording stops.
        threading.Thread(target=_ensure_ffmpeg, daemon=True).start()
        with REC_LOCK:
            started = REC["started"]
        return state_payload({
            "success": True, "action": "screen_record", "operation": "start",
            "recording": True, "startedAt": started,
            "message": "Screen recording started — it keeps running while you continue browsing. Call screen_record with operation 'stop' to finish and get the video.",
            "output": "Screen recording started.",
        })
    if op == "stop":
        with REC_LOCK:
            if not REC["on"] and not REC["frames"]:
                return err_payload("not_recording", "No recording is in progress (call screen_record with operation 'start' first).", False)
            REC["on"] = False
            frames = list(REC["frames"])
            REC["frames"] = []
            REC["bytes"] = 0
            started = REC["started"]
            REC["started"] = None
            stop_evt = REC["stop_evt"]
            REC["stop_evt"] = None
            thread = REC["thread"]
            REC["thread"] = None
            rec_err = REC["err"]
            REC["err"] = None
        if stop_evt is not None:
            stop_evt.set()
        if thread is not None:
            thread.join(timeout=5)
        if not frames:
            return err_payload(
                "recording_failed",
                "The recording captured no frames.%s" % (" " + rec_err if rec_err else ""),
                True,
            )
        if not _ensure_ffmpeg():
            return err_payload(
                "recording_failed",
                "No video encoder is available in the sandbox (pip install imageio-ffmpeg failed) — %d frames were captured but could not be assembled into a video." % len(frames),
                True,
            )
        import imageio_ffmpeg
        tmpdir = os.path.join(RECORDINGS, "rec-%d" % int(time.time()))
        os.makedirs(tmpdir, exist_ok=True)
        out_path = os.path.join(RECORDINGS, "recording-%d.mp4" % int(time.time()))
        try:
            for i, raw in enumerate(frames):
                with open(os.path.join(tmpdir, "f%06d.jpg" % i), "wb") as f:
                    f.write(raw)
            exe = imageio_ffmpeg.get_ffmpeg_exe()
            subprocess.run(
                [exe, "-y", "-framerate", "2", "-i", os.path.join(tmpdir, "f%06d.jpg"),
                 "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_path],
                capture_output=True, timeout=900,
            )
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)
        if not os.path.exists(out_path) or os.path.getsize(out_path) < 1024:
            return err_payload("recording_failed", "Assembling the recording into a video failed.", True)
        duration = round(len(frames) / 2.0, 1)
        out = state_payload({
            "success": True, "action": "screen_record", "operation": "stop",
            "recording": False,
            "file": out_path,
            "name": os.path.basename(out_path),
            "frames": len(frames),
            "durationSec": duration,
            "sizeBytes": os.path.getsize(out_path),
            "startedAt": started,
            "message": "Screen recording saved (%s, %ss)." % (os.path.basename(out_path), duration),
        })
        out["output"] = "Screen recording saved: %s (%ss, %d frames)." % (os.path.basename(out_path), duration, len(frames))
        return out
    # status
    with REC_LOCK:
        on = REC["on"]
        n = len(REC["frames"])
        started = REC["started"]
        rec_err = REC["err"]
    out = {"success": True, "action": "screen_record", "operation": "status", "recording": on, "frames": n}
    if started:
        out["startedAt"] = started
        out["durationMs"] = int(time.time() * 1000) - started
    if rec_err:
        out["note"] = rec_err
    out["output"] = "Recording is %s (%d frames buffered)." % ("ON" if on else "off", n)
    return state_payload(out)


def do_get_page(cmd):
    p = active_page()
    # Self-healing read: if the read lands mid-challenge, wait briefly for
    # the interstitial to clear instead of returning "Just a moment..." as
    # the page's content.
    level, status, waited = _settle_challenge(p, _env_int("ONYX_CF_SETTLE_READ_MS", 8000, 12000))
    try:
        text = p.evaluate("() => document.body ? document.body.innerText : ''")
    except Exception:
        text = ""
    text = (text or "")[:6000]
    out = state_payload({"success": True, "action": "get_page", "text": text, "challenge": status})
    out["output"] = "Read %d characters of page text." % len(text)
    if status in ("cleared", "cleared_after_click"):
        out["output"] += " (a Cloudflare challenge cleared first — %.1fs)" % (waited / 1000.0)
    elif status == "stuck":
        out["output"] += " — WARNING: the page still shows a Cloudflare challenge; the text above is the interstitial, NOT the content. Wait a few seconds and read again."
    return out


def do_read(cmd):
    """Alias of get_page (unified verb surface)."""
    out = do_get_page(cmd)
    out["action"] = "read"
    return out


def do_extract_text(cmd):
    """extract_text (PRD §5): the VISIBLE page text, whitespace-normalized,
    with an honest length + truncation flag. Same engine as read/get_page
    but the PRD-canonical name and a larger budget."""
    p = active_page()
    # Self-healing read: settle a Cloudflare interstitial first (see
    # do_get_page) so the extract never returns "Just a moment...".
    level, status, waited = _settle_challenge(p, _env_int("ONYX_CF_SETTLE_READ_MS", 8000, 12000))
    try:
        text = p.evaluate("() => document.body ? document.body.innerText : ''")
    except Exception:
        text = ""
    text = (text or "").strip()
    limit = 8000
    excerpt = text[:limit]
    out = state_payload({
        "success": True,
        "action": "extract_text",
        "text": excerpt,
        "textLength": len(text),
        "truncated": len(text) > limit,
        "challenge": status,
    })
    out["output"] = "Extracted %d characters of visible text%s." % (len(text), " (truncated to %d)" % limit if len(text) > limit else "")
    if status == "stuck":
        out["output"] += " — WARNING: the page still shows a Cloudflare challenge; the text is the interstitial, NOT the content."
    return out


def do_snapshot(cmd):
    """snapshot (PRD §5): the page STRUCTURE — title, heading outline,
    element counts, top interactive elements, and a compact text excerpt."""
    p = active_page()
    try:
        snap = p.evaluate(SNAPSHOT_JS)
    except Exception as e:
        return playw_err(e)
    if not isinstance(snap, dict):
        snap = {}
    counts = snap.get("counts") or {}
    headings = snap.get("headings") or []
    interactive = snap.get("interactive") or []
    out = state_payload({
        "success": True,
        "action": "snapshot",
        "title": snap.get("title") or "",
        "headings": headings,
        "counts": counts,
        "interactive": interactive,
        "textExcerpt": snap.get("textExcerpt") or "",
    })
    out["output"] = "Page structure: %d headings, %s links, %s buttons, %s interactive elements listed." % (
        len(headings), counts.get("links", 0), counts.get("buttons", 0), len(interactive))
    return out


def do_get_elements(cmd):
    global ref_map
    p = active_page()
    limit = max(1, min(120, int(cmd.get("limit") or 60)))
    flt = str(cmd.get("filter") or "").lower()
    els = p.evaluate(ELEMENTS_JS)
    out = []
    ref_map = {}
    for i, el in enumerate(els[:limit]):
        ref = "e%d" % (i + 1)
        ref_map[ref] = el["selector"]
        row = dict(el)
        row["ref"] = ref
        if flt and flt not in (el.get("text") or "").lower() and flt not in (el.get("selector") or "").lower() and flt not in str(el.get("role") or "").lower():
            continue
        out.append(row)
    res = state_payload({"success": True, "action": "get_elements", "count": len(out), "elements": out})
    res["output"] = "Found %d interactive elements (refs e1…e%d usable as targets)." % (len(out), len(out))
    return res


def do_inspect(cmd):
    """Alias of get_elements (unified verb surface)."""
    out = do_get_elements(cmd)
    out["action"] = "inspect"
    return out


def do_forms(cmd):
    p = active_page()
    try:
        forms = p.evaluate(FORMS_JS)
    except Exception as e:
        return playw_err(e)
    out = state_payload({"success": True, "action": "forms", "count": len(forms), "forms": forms})
    out["output"] = "Found %d form controls." % len(forms)
    return out


def do_evaluate(cmd):
    code = str(cmd.get("code") or "").strip()
    if not code:
        return err_payload("bad_request", "code is required for evaluate", False)
    p = active_page()
    import json as _json
    wrapper = EVAL_WRAPPER % _json.dumps(code)
    result = p.evaluate(wrapper)
    out = state_payload({"action": "evaluate", "success": bool(result and result.get("ok"))})
    if result and result.get("ok"):
        out["value"] = result.get("value")
        out["output"] = "Evaluated JavaScript — result: %s" % _json.dumps(result.get("value"))[:400]
    else:
        out["error"] = {"type": "evaluation_failed", "message": str((result or {}).get("error") or "evaluation returned nothing"), "recoverable": True}
        out["success"] = False
        out["output"] = "JavaScript evaluation failed: %s" % str((result or {}).get("error"))[:300]
    return out


def do_select(cmd):
    target = cmd.get("target")
    loc = resolve_target(active_page(), target)
    box = loc_box(loc)
    value = cmd.get("value")
    values = cmd.get("values")
    if values is None and value is not None:
        values = [str(value)]
    publish_live("select")
    loc.first.select_option(values, timeout=12000)
    out = state_payload({"success": True, "action": "select", "target": target_label(target)})
    if box:
        out["box"] = box
    out["output"] = "Selected %s in %s." % (value if value is not None else values, target_label(target))
    return out


def do_upload(cmd):
    files = cmd.get("files") or []
    if isinstance(files, str):
        files = [files]
    paths = []
    for f in files:
        f = str(f)
        if not f.startswith("/"):
            f = os.path.join("/home/user", f)
        if not os.path.exists(f):
            return err_payload("upload_failed", "File not found in the workspace: %s" % f, False)
        paths.append(f)
    if not paths:
        return err_payload("bad_request", "files (workspace paths) are required for upload", False)
    target = cmd.get("target")
    loc = resolve_target(active_page(), target)
    box = loc_box(loc)
    publish_live("upload")
    loc.first.set_input_files(paths, timeout=15000)
    out = state_payload({"success": True, "action": "upload", "target": target_label(target), "files": [os.path.basename(x) for x in paths]})
    if box:
        out["box"] = box
    out["output"] = "Uploaded %d file(s) to %s." % (len(paths), target_label(target))
    return out


def do_download(cmd):
    p = active_page()
    url = cmd.get("url")
    target = cmd.get("target")
    publish_live("download")
    try:
        if target is not None:
            loc = resolve_target(p, target)
            with p.context.expect_download(timeout=60000) as dl_info:
                loc.first.click(timeout=12000)
        elif url:
            with p.context.expect_download(timeout=60000) as dl_info:
                p.goto(str(url), timeout=45000)
        else:
            return err_payload("bad_request", "url or target is required for download", False)
        dl = dl_info.value
        fname = dl.suggested_filename or ("download-%d.bin" % int(time.time()))
        dest = os.path.join(DOWNLOADS, fname)
        base, ext = os.path.splitext(dest)
        n = 1
        while os.path.exists(dest):
            dest = "%s-%d%s" % (base, n, ext)
            n += 1
        dl.save_as(dest)
        out = state_payload({"success": True, "action": "download", "file": dest, "name": os.path.basename(dest)})
        out["output"] = "Downloaded %s to the workspace." % os.path.basename(dest)
        return out
    except Exception as e:
        # No download event (maybe a direct file URL) — fetch it via the
        # browser's own request context so cookies/auth still apply.
        if url:
            try:
                r = p.context.request.get(str(url), timeout=45000)
                if r.ok:
                    disp = r.headers.get("content-disposition", "")
                    fname = "download-%d.bin" % int(time.time())
                    if "filename=" in disp:
                        fname = disp.split("filename=")[-1].strip('"; ')
                    dest = os.path.join(DOWNLOADS, os.path.basename(fname) or fname)
                    with open(dest, "wb") as f:
                        f.write(r.body())
                    out = state_payload({"success": True, "action": "download", "file": dest, "name": os.path.basename(dest)})
                    out["output"] = "Downloaded %s to the workspace (direct fetch)." % os.path.basename(dest)
                    return out
            except Exception as e2:
                return err_payload("download_failed", "%s | fallback: %s" % (e, e2))
        return playw_err(e)


def do_new_tab(cmd):
    global tab_seq, active_idx
    ensure_pages()
    publish_live("new_tab")
    p = context.new_page()
    tab_seq += 1
    tid = "tab_%d" % tab_seq
    attach_page_listeners(p)
    pages.append({"id": tid, "page": p})
    active_idx = len(pages) - 1
    url = cmd.get("url")
    if url:
        p.goto(str(url), wait_until="domcontentloaded", timeout=45000)
    out = state_payload({"success": True, "action": "new_tab", "tabId": tid})
    out["output"] = "Opened a new tab (%s)%s." % (tid, " at " + str(url) if url else "")
    return out


def pick_tab(cmd):
    global active_idx
    tab = cmd.get("tab")
    if tab is None:
        return None
    if isinstance(tab, (int, float)) or (isinstance(tab, str) and tab.isdigit()):
        idx = int(tab)
        if idx < 0 or idx >= len(pages):
            return err_payload("bad_request", "No tab at index %d (0-%d open)" % (idx, len(pages) - 1), False)
        active_idx = idx
        return None
    for i, t in enumerate(pages):
        if t["id"] == str(tab):
            active_idx = i
            return None
    return err_payload("bad_request", "Unknown tab id: %s" % tab, False)


def do_switch_tab(cmd):
    ensure_pages()
    publish_live("switch_tab")
    failed = pick_tab(cmd)
    if failed:
        return failed
    active_page().bring_to_front()
    out = state_payload({"success": True, "action": "switch_tab"})
    out["output"] = "Switched to tab %d of %d." % (active_idx + 1, len(pages))
    return out


def do_close_tab(cmd):
    global active_idx, tab_seq
    ensure_pages()
    target = cmd.get("tab")
    if target is None:
        idx = active_idx
    elif isinstance(target, (int, float)) or (isinstance(target, str) and str(target).isdigit()):
        idx = int(target)
    else:
        idx = None
        for i, t in enumerate(pages):
            if t["id"] == str(target):
                idx = i
                break
        if idx is None:
            return err_payload("bad_request", "Unknown tab id: %s" % target, False)
    if idx < 0 or idx >= len(pages):
        return err_payload("bad_request", "No tab at index %s" % idx, False)
    try:
        pages[idx]["page"].close()
    except Exception:
        pass
    pages.pop(idx)
    if not pages:
        p = context.new_page()
        tab_seq += 1
        attach_page_listeners(p)
        pages.append({"id": "tab_%d" % tab_seq, "page": p})
        active_idx = 0
    elif active_idx >= len(pages):
        active_idx = len(pages) - 1
    out = state_payload({"success": True, "action": "close_tab"})
    out["output"] = "Closed the tab (%d remain)." % len(pages)
    return out


def do_history(cmd):
    p = active_page()
    publish_live(str(cmd.get("action") or "refresh"))
    if cmd.get("action") == "go_back" or cmd.get("dir") == "back":
        p.go_back(timeout=30000)
        verb = "Went back"
    elif cmd.get("action") == "go_forward" or cmd.get("dir") == "forward":
        p.go_forward(timeout=30000)
        verb = "Went forward"
    else:
        p.reload(timeout=45000)
        verb = "Reloaded"
    out = state_payload({"success": True, "action": cmd.get("action") or "refresh"})
    out["output"] = "%s — now on %s." % (verb, out.get("url") or "the previous page")
    return out


def do_console(cmd):
    global console_log, seen_console
    n = max(1, min(80, int(cmd.get("limit") or 40)))
    entries = console_log[-n:]
    if cmd.get("clear"):
        console_log = []
        seen_console = set()
    out = state_payload({"success": True, "action": "console", "count": len(entries), "entries": entries})
    out["output"] = "Console log: %d entries (errors/warnings only)." % len(entries)
    return out


def do_network(cmd):
    global network_log
    n = max(1, min(60, int(cmd.get("limit") or 30)))
    entries = network_log[-n:]
    if cmd.get("clear"):
        network_log = []
    out = state_payload({"success": True, "action": "network", "count": len(entries), "entries": entries})
    out["output"] = "Network log: %d failed/blocked requests." % len(entries)
    return out


def do_state(cmd):
    out = state_payload({"success": True, "action": "get_state", "profileDir": PROFILE, "downloadsDir": DOWNLOADS})
    out["output"] = "Browser state: runtime=%s, tabs=%d, url=%s." % (runtime, len(pages), out.get("url") or "-")
    return out


def do_close(cmd):
    global context, pages, active_idx, ref_map
    # FULL teardown (asyncio-poisoning fix): stopping pw here is essential
    # when the session ran on the stock-Chromium fallback — a live pw parks
    # its greenlet inside run_until_complete and leaves the main thread's
    # running-loop flag set, so the NEXT boot_browser() (both attempts)
    # failed with 'Sync API inside the asyncio loop'.
    _reset_browser_state()
    pages = []
    active_idx = 0
    ref_map = {}
    with LIVE_LOCK:
        LIVE_STATE["closed"] = True
        LIVE_STATE["booted"] = False
        LIVE_STATE["action"] = None
    publish_live("close")
    event("BROWSER_SESSION_CLOSED", sessionId=session_id)
    return {
        "success": True,
        "action": "close",
        "message": "Browser session closed. The persistent profile was kept.",
        "output": "Browser session closed. The persistent profile was kept.",
    }


HANDLERS = {
    "navigate": do_navigate,
    "click": do_click,
    "type": do_type,
    "press": do_press,
    "scroll": do_scroll,
    "wait": do_wait,
    "screenshot": do_screenshot,
    "screen_record": do_screen_record,
    "read": do_read,
    "get_page": do_get_page,
    "extract_text": do_extract_text,
    "snapshot": do_snapshot,
    "inspect": do_inspect,
    "get_elements": do_get_elements,
    "forms": do_forms,
    "evaluate": do_evaluate,
    "select": do_select,
    "upload": do_upload,
    "download": do_download,
    "new_tab": do_new_tab,
    "switch_tab": do_switch_tab,
    "close_tab": do_close_tab,
    "go_back": lambda c: do_history(dict(c, action="go_back")),
    "go_forward": lambda c: do_history(dict(c, action="go_forward")),
    "refresh": lambda c: do_history(dict(c, action="refresh")),
    "back": lambda c: do_history(dict(c, action="go_back")),
    "forward": lambda c: do_history(dict(c, action="go_forward")),
    "reload": lambda c: do_history(dict(c, action="refresh")),
    "console": do_console,
    "network": do_network,
    "get_state": do_state,
    "close": do_close,
}
# ── PER-ACTION WATCHDOG (PRD §6: eliminate infinite execution) ─────────────
# The command loop is single-threaded (Playwright sync API is thread-affine),
# so ONE wedged Playwright call used to block the driver FOREVER — the client
# timed out, saw the process "alive", replayed, timed out again: minutes of
# silence, then a bare timeout. The watchdog closes that hole categorically:
#
#   every command is armed with a budget (ACTION_BUDGETS);
#   on expiry the watchdog (1) SIGKILLs the browser — killing the browser is
#   the ONE reliable way to unblock ANY stuck Playwright call (its websocket
#   drops and the pending API raises within seconds) — and (2) after a grace
#   window writes the timeout reply ITSELF, so the client always receives an
#   answer even if the loop never comes back. The next command reboots the
#   browser on the SAME persistent profile (cookies/localStorage kept).

ACTION_BUDGETS = {
    # navigate: 45 s goto + up to 30 s Cloudflare settle + margin — the
    # settle (ONYX_CF_SETTLE_MS) is capped at 30 s for exactly this.
    "navigate": 80, "click": 25, "type": 30, "press": 15, "scroll": 20,
    # read-path actions: up to 12 s challenge settle (ONYX_CF_SETTLE_READ_MS
    # cap) + the text extraction itself.
    "wait": 35, "screenshot": 40, "extract_text": 40, "read": 40,
    "get_page": 40, "snapshot": 30, "inspect": 30, "get_elements": 30,
    "forms": 30, "evaluate": 45, "select": 25, "upload": 60, "download": 90,
    "new_tab": 45, "switch_tab": 15, "close_tab": 15,
    "back": 30, "forward": 30, "go_back": 30, "go_forward": 30,
    "reload": 45, "refresh": 45, "console": 10, "network": 10,
    "get_state": 10, "close": 20,
    "screen_record": 300,   # 'stop' assembles a video (encoder + ffmpeg)
}
DEFAULT_ACTION_BUDGET = 60
PREBOOT_BUDGET = 300        # cold first launch may download ~200 MB

WATCHDOG_LOCK = threading.Lock()
WATCHDOG = {
    "cid": None,          # in-flight command id (or the literal "preboot")
    "action": None,
    "deadline": 0.0,      # monotonic deadline for the in-flight command
    "answered": set(),    # command ids the watchdog already answered
}


def _arm_watchdog(cid, action, budget_sec):
    with WATCHDOG_LOCK:
        WATCHDOG["cid"] = cid
        WATCHDOG["action"] = action
        WATCHDOG["deadline"] = time.monotonic() + max(5, int(budget_sec))
        WATCHDOG["answered"].discard(cid)


def _disarm_watchdog():
    with WATCHDOG_LOCK:
        WATCHDOG["cid"] = None
        WATCHDOG["deadline"] = 0.0


def _kill_browser_processes(reason):
    """SIGKILL every Chromium holding OUR profile. Returns True when at
    least one process was killed (i.e. a browser was actually running)."""
    killed = False
    try:
        out = subprocess.run(
            ["pgrep", "-f", "user-data-dir=" + PROFILE],
            capture_output=True, text=True, timeout=10,
        ).stdout.split()
        for pid in out:
            try:
                os.kill(int(pid), signal.SIGKILL)
                killed = True
            except Exception:
                pass
        if out:
            log("watchdog killed browser pid(s) %s (%s)" % (",".join(out), reason))
    except Exception:
        pass
    return killed


def _write_json_atomic(path, payload):
    """Write a JSON file atomically (tmp + rename) — concurrent writers
    (loop vs watchdog) never leave a torn file for the client to parse."""
    try:
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            f.write(json.dumps(payload))
        os.replace(tmp, path)
        return True
    except Exception:
        return False


def watchdog_loop():
    """The watchdog daemon (PRD §6/§7: every action eventually resolves;
    never leave a pending browser promise indefinitely)."""
    while True:
        time.sleep(0.5)
        try:
            with WATCHDOG_LOCK:
                cid = WATCHDOG["cid"]
                action = WATCHDOG["action"]
                deadline = WATCHDOG["deadline"]
            if not cid or deadline <= 0:
                continue
            if time.monotonic() < deadline:
                continue
            # Disarm immediately — one shot per command.
            with WATCHDOG_LOCK:
                WATCHDOG["cid"] = None
                WATCHDOG["deadline"] = 0.0
            event("BROWSER_TIMEOUT", action=action, commandId=cid)
            _kill_browser_processes("action timeout: %s" % action)
            # Grace window: the kill usually unblocks the loop, which then
            # writes its own (error) reply — or, for a wedged preboot, gets
            # past boot_browser and writes .ready. If nothing lands within
            # 20s the watchdog answers FOR it — the client always gets a
            # result. A driver that RECOVERED is never punished.
            grace = time.monotonic() + 20.0
            res_path = None if cid == "preboot" else os.path.join(DIR, "res-" + cid + ".json")
            while time.monotonic() < grace:
                if res_path and os.path.exists(res_path):
                    break
                if cid == "preboot" and os.path.exists(READY):
                    break
                time.sleep(0.5)
            if cid == "preboot":
                if os.path.exists(READY):
                    # The kill unblocked the preboot — the driver is up and
                    # healthy. Do NOT exit; serve commands normally.
                    log("watchdog: preboot recovered after the browser kill — driver stays up")
                    continue
                # Preboot wedged beyond its budget — surface it in the boot
                # poll (the client reads .boot-failed) and exit so the next
                # command boots a FRESH driver.
                try:
                    with open(BOOT_FAIL_PATH, "w") as f:
                        f.write("browser preboot timed out after %ds — the driver was restarted; the next command retries the boot\n" % PREBOOT_BUDGET)
                except Exception:
                    pass
                log("watchdog: preboot timed out — exiting driver for a fresh boot")
                os._exit(1)
            if res_path and not os.path.exists(res_path):
                payload = err_payload(
                    "timeout",
                    'Browser action "%s" exceeded its time budget; the browser process was killed to unblock it. The next action relaunches the browser automatically (the persistent profile keeps cookies and localStorage).' % action,
                    True,
                )
                if _write_json_atomic(res_path, payload):
                    with WATCHDOG_LOCK:
                        WATCHDOG["answered"].add(cid)
                        if len(WATCHDOG["answered"]) > 200:
                            WATCHDOG["answered"] = set(sorted(WATCHDOG["answered"])[-100:])
        except Exception:
            log("watchdog error: %s" % traceback.format_exc()[-200:])


def _sweep_stale_results():
    """Remove res-*.json files older than 10 minutes — orphaned replies
    (the client already timed out and moved on) must not accumulate."""
    try:
        now = time.time()
        for name in os.listdir(DIR):
            if not (name.startswith("res-") and name.endswith(".json")):
                continue
            p = os.path.join(DIR, name)
            try:
                if now - os.path.getmtime(p) > 600:
                    os.remove(p)
            except Exception:
                pass
    except Exception:
        pass


def main():
    # STARTUP PREBOOT: when boot.sh left a .preboot marker, boot the BROWSER
    # before declaring READY — "ready" then means "browser USABLE". The
    # first use_browser action no longer hides a ~200 MB binary download
    # behind its own action timeout, and launch failures surface in the boot
    # poll window (narrated via boot.log) instead of a bare action timeout.
    # A preboot failure is NOT fatal: the first command retries the boot and
    # reports the real error. The WATCHDOG covers a WEDGED preboot (writes
    # .boot-failed and exits the driver instead of hanging forever).
    event("BROWSER_DRIVER_START", version=DRIVER_VERSION, pid=os.getpid())
    if os.path.exists(PREBOOT):
        boot_log("prebooting the browser runtime (a first launch may need to download the binary)…")
        _arm_watchdog("preboot", "preboot", PREBOOT_BUDGET)
        try:
            boot_browser()
            boot_log("browser prebooted (runtime: %s) — reporting ready" % (runtime,))
        except Exception as e:
            boot_log("preboot failed: %s — the first command will retry the boot" % (e,))
        finally:
            _disarm_watchdog()
    with open(READY, "w") as f:
        f.write("1")
    with open(VERSION_PATH, "w") as f:
        f.write(DRIVER_VERSION)
    threading.Thread(target=live_pub_loop, daemon=True).start()
    threading.Thread(target=live_cast_loop, daemon=True).start()
    threading.Thread(target=watchdog_loop, daemon=True).start()
    refresh_live_pages()
    log("driver loop started (pid %d, watchdog armed)" % os.getpid())
    seen = ""
    sweep_n = 0
    while True:
        try:
            if not os.path.exists(CMD):
                time.sleep(0.3)
                continue
            with open(CMD, "r") as f:
                raw = f.read()
            cmd = json.loads(raw)
            cid = str(cmd.get("id") or "")
            if not cid or cid == seen:
                time.sleep(0.3)
                continue
            seen = cid
            action = str(cmd.get("action") or "")
            handler = HANDLERS.get(action)
            boot_failed = False
            event("BROWSER_ACTION_START", action=action, commandId=cid)
            t0 = time.time()
            if handler is None:
                result = err_payload("bad_request", "Unknown action: %s (supported: %s)" % (action, ", ".join(sorted(HANDLERS))), False)
            else:
                budget = ACTION_BUDGETS.get(action, DEFAULT_ACTION_BUDGET)
                _arm_watchdog(cid, action, budget)
                try:
                    result = handler(cmd)
                except BootFailure as e:
                    log("browser boot failure: %s" % (e,))
                    result = err_payload(
                        "browser_startup_failed",
                        "%s A fresh browser driver will start on the next command." % (e,),
                        True,
                    )
                    boot_failed = True
                except Exception as e:
                    log("action %s failed: %s" % (action, traceback.format_exc()[-400:]))
                    result = playw_err(e)
                _disarm_watchdog()
            duration_ms = int((time.time() - t0) * 1000)
            if isinstance(result, dict):
                result.setdefault("durationMs", duration_ms)
                result.setdefault("action", action)
            event(
                "BROWSER_ACTION_COMPLETE" if (isinstance(result, dict) and result.get("success")) else "BROWSER_ACTION_FAILED",
                action=action, commandId=cid, durationMs=duration_ms,
                error=(result.get("error") or {}).get("type") if isinstance(result, dict) and result.get("error") else None,
            )
            event("BROWSER_EXECUTION_COMPLETE", action=action, commandId=cid, durationMs=duration_ms)
            # Exactly-one-reply discipline: if the WATCHDOG already answered
            # this command (loop was wedged, client got the timeout), the
            # loop does NOT overwrite it — a late error would replace the
            # honest timeout diagnosis the client may still be reading.
            with WATCHDOG_LOCK:
                answered = cid in WATCHDOG["answered"]
            res_path = os.path.join(DIR, "res-" + cid + ".json")
            if not answered:
                _write_json_atomic(res_path, result)
            # BOOT-FAILURE EXIT (asyncio-poisoning fix): the reply is already
            # on disk — now exit so leaked Playwright/node resources die
            # with this process. The session manager's liveness check sees
            # a dead driver and boots a FRESH one for the next command; the
            # lock cleanup + unpoison in that fresh boot make it succeed.
            if boot_failed:
                log("exiting after browser boot failure — a fresh driver boots on the next command")
                try:
                    os.remove(READY)
                except Exception:
                    pass
                time.sleep(0.2)
                os._exit(1)
            # Live-cast upkeep: after every command the active tab marker +
            # url/title/viewport refresh so the live view tracks what the
            # agent just did, even for actions that publish nothing.
            mark_active_tab()
            refresh_live_pages()
            sweep_n += 1
            if sweep_n % 200 == 0:
                _sweep_stale_results()
        except json.JSONDecodeError:
            time.sleep(0.3)
        except Exception:
            log("loop error: %s" % traceback.format_exc()[-300:])
            time.sleep(0.5)


if __name__ == "__main__":
    main()
`;
