/**
 * The OnyxAgent BROWSER DRIVER — a long-running Python process INSIDE the
 * E2B sandbox that owns a persistent-profile Chromium and serves the same
 * file protocol the old Node web-session driver used:
 *
 *   /home/user/.onyx/browser/driver.py     — this source (started detached)
 *   /home/user/.onyx/browser/cmd.json      — {id, action, …} request
 *   /home/user/.onyx/browser/res-<id>.json — the driver's reply
 *   /home/user/.onyx/browser/.ready        — "the loop is running" marker
 *   /home/user/.onyx/browser/profile/      — persistent browser profile
 *   /home/user/.onyx/browser/shots/*.png   — screenshots
 *   /home/user/downloads/                  — captured browser downloads
 *
 * RUNTIME ABSTRACTION (PRD §5/§32): the primary engine is CloakBrowser —
 * a stealth-patched Chromium driven through Playwright semantics, launched
 * with `humanize=True` (human-like mouse curves, per-character typing,
 * realistic scroll — a browser-runtime feature for legitimate automation,
 * testing, browsing and QA). When CloakBrowser is unavailable (install or
 * launch failure, licensing/deployment change) the driver falls back to
 * STOCK Playwright Chromium. The AI-facing `use_browser` schema never
 * changes — the runtime is an internal detail the model never sees.
 *
 * SECURITY BOUNDARIES (PRD §29): this is an authorized automation
 * capability. It does not implement workflows to defeat CAPTCHAs, access
 * controls, authentication protections or rate limits; it respects
 * credentials, service terms and the existing OnyxAgent safety controls.
 *
 * Packaging constraint: this Python source is exported as a TS template
 * literal AND interpolated into bg-agent-script.ts via JSON.stringify —
 * the source must contain NO backticks and NO ${ } sequences (Python
 * naturally has neither; keep it that way).
 */
export const BROWSER_DRIVER_PY_SOURCE = String.raw`#!/usr/bin/env python3
# OnyxAgent browser driver — CloakBrowser (humanize=True) over a persistent
# profile, Playwright-driven, file-protocol command loop.
import base64
import json
import os
import shutil
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

# ── LIVE CAST (realtime browser view, PRD §2-§4) ────────────────────────────
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


def log(msg):
    try:
        with open(os.path.join(DIR, "driver.log"), "a") as f:
            f.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), msg))
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


def boot_browser():
    """Launch the persistent-profile browser: CloakBrowser with
    humanize=True first, stock Playwright Chromium as the fallback."""
    global context, pw, runtime, boot_error
    if context is not None:
        return
    # -- attempt 1: CloakBrowser (stealth Chromium, humanized input) ------
    try:
        from cloakbrowser import launch_persistent_context as cb_launch
        context = cb_launch(
            PROFILE,
            humanize=True,
            headless=True,
            args=LAUNCH_ARGS,
            viewport={"width": 1280, "height": 800},
        )
        runtime = "cloakbrowser"
        with LIVE_LOCK:
            LIVE_STATE["booted"] = True
            LIVE_STATE["closed"] = False
        refresh_live_pages()
        log("booted cloakbrowser runtime (humanize=True, persistent profile)")
        return
    except Exception as e:
        boot_error = "cloakbrowser launch failed: %s" % (e,)
        log(boot_error)
    # -- attempt 2: stock Playwright Chromium (runtime-agnostic fallback) --
    try:
        from playwright.sync_api import sync_playwright
        pw = sync_playwright().start()
        try:
            context = pw.chromium.launch_persistent_context(
                PROFILE,
                headless=True,
                args=LAUNCH_ARGS,
                viewport={"width": 1280, "height": 800},
            )
        except Exception:
            # Missing browser binaries on a fresh sandbox — install once.
            subprocess.run(
                [sys.executable, "-m", "playwright", "install", "chromium"],
                capture_output=True, timeout=900,
            )
            context = pw.chromium.launch_persistent_context(
                PROFILE,
                headless=True,
                args=LAUNCH_ARGS,
                viewport={"width": 1280, "height": 800},
            )
        runtime = "chromium"
        with LIVE_LOCK:
            LIVE_STATE["booted"] = True
            LIVE_STATE["closed"] = False
        refresh_live_pages()
        log("booted standard chromium fallback runtime (persistent profile)")
    except Exception as e:
        boot_error = (boot_error + " | chromium fallback failed: %s" % (e,)) if boot_error else str(e)
        raise RuntimeError(boot_error)


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
    return {"success": False, "error": {"type": etype, "message": str(message)[:600], "recoverable": recoverable}}


# ── Element targeting (PRD §11: semantic first, CSS/XPath/ref fallback) ──

def resolve_target(page, target):
    """Resolve a target spec into a Playwright locator.
    String: a selector Playwright understands (css, "text=…", "xpath=…",
    "#id", ".cls"). Object: {role,name} | {text} | {label} | {placeholder}
    | {css} | {xpath} | {ref}."""
    if target is None:
        return page.locator("body")
    if isinstance(target, str):
        t = target.strip()
        if not t:
            return page.locator("body")
        if t.startswith("ref="):
            sel = ref_map.get(t[4:])
            if not sel:
                raise RuntimeError("Unknown element ref: %s (call get_elements first)" % t)
            return page.locator(sel)
        if t.startswith("xpath=") or t.startswith("text=") or t.startswith("css="):
            return page.locator(t)
        return page.locator(t)
    if isinstance(target, dict):
        if target.get("ref"):
            sel = ref_map.get(str(target.get("ref")))
            if not sel:
                raise RuntimeError("Unknown element ref: %s (call get_elements first)" % target.get("ref"))
            return page.locator(sel)
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


def do_navigate(cmd):
    url = str(cmd.get("url") or "").strip()
    if not url:
        return err_payload("bad_request", "url is required for navigate", False)
    if not (url.startswith("http://") or url.startswith("https://") or url.startswith("file://") or url.startswith("about:")):
        url = "https://" + url
    p = active_page()
    publish_live("navigate")
    resp = p.goto(url, wait_until="domcontentloaded", timeout=45000)
    try:
        title = p.title()
    except Exception:
        title = ""
    out = state_payload({"success": True, "action": "navigate", "status": resp.status if resp else None})
    out["title"] = title
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
    return out


def do_press(cmd):
    key = str(cmd.get("key") or "Enter")
    p = active_page()
    publish_live("keypress")
    p.keyboard.press(key)
    p.wait_for_timeout(300)
    return state_payload({"success": True, "action": "press", "key": key})


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
    return state_payload({"success": True, "action": "scroll", "direction": direction, "amount": amount})


def do_wait(cmd):
    p = active_page()
    ms = cmd.get("ms")
    selector = cmd.get("selector") or cmd.get("target")
    text = cmd.get("text")
    if selector:
        p.wait_for_selector(str(selector), timeout=15000)
    elif text:
        p.get_by_text(str(text)).first.wait_for(timeout=15000)
    else:
        p.wait_for_timeout(min(15000, max(0, int(ms or 1000))))
    return state_payload({"success": True, "action": "wait"})


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
    return state_payload({
        "success": True,
        "action": "screenshot",
        "path": path,
        "fullPage": full,
        "dataUrl": "data:image/png;base64," + b64,
    })


# ── SCREEN RECORDING (PRD §6) ─────────────────────────────────────────────
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
        return state_payload({
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
    return state_payload(out)


def do_get_page(cmd):
    p = active_page()
    try:
        text = p.evaluate("() => document.body ? document.body.innerText : ''")
    except Exception:
        text = ""
    text = (text or "")[:6000]
    return state_payload({"success": True, "action": "get_page", "text": text})


def do_read(cmd):
    """Alias of get_page (PRD §3 unified verb surface)."""
    out = do_get_page(cmd)
    out["action"] = "read"
    return out


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
    return state_payload({"success": True, "action": "get_elements", "count": len(out), "elements": out})


def do_inspect(cmd):
    """Alias of get_elements (PRD §3 unified verb surface)."""
    out = do_get_elements(cmd)
    out["action"] = "inspect"
    return out


def do_snapshot(cmd):
    """STRUCTURED PAGE SNAPSHOT (PRD §5) — a machine-readable representation
    of the current page optimized for agent reasoning: URL + title +
    viewport, visible text, interactive elements (with refs the agent can
    target in subsequent actions), ARIA hints and form field state, all in
    ONE payload. Refs stay compatible with click/type/select targets."""
    global ref_map
    p = active_page()
    limit = max(1, min(160, int(cmd.get("limit") or 80)))
    flt = str(cmd.get("filter") or "").lower()
    els = p.evaluate(ELEMENTS_JS)
    ref_map = {}
    elements = []
    for i, el in enumerate(els[:limit]):
        ref = "e%d" % (i + 1)
        ref_map[ref] = el["selector"]
        if flt and flt not in (el.get("text") or "").lower() and flt not in (el.get("selector") or "").lower() and flt not in str(el.get("role") or "").lower():
            continue
        row = {
            "ref": ref,
            "tag": el.get("tag"),
            "role": el.get("role"),
            "text": (el.get("text") or "")[:90] or None,
            "selector": el.get("selector"),
        }
        if el.get("type"):
            row["type"] = el.get("type")
        if el.get("name"):
            row["name"] = el.get("name")
        if el.get("box"):
            row["box"] = el.get("box")
        elements.append(row)
    try:
        text = p.evaluate("() => document.body ? document.body.innerText : ''")
    except Exception:
        text = ""
    try:
        forms = p.evaluate(FORMS_JS) or []
    except Exception:
        forms = []
    return state_payload({
        "success": True,
        "action": "snapshot",
        "text": (text or "")[:6000],
        "count": len(elements),
        "elements": elements,
        "forms": forms,
    })


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
    else:
        out["error"] = {"type": "evaluation_failed", "message": str((result or {}).get("error") or "evaluation returned nothing"), "recoverable": True}
        out["success"] = False
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
        return state_payload({"success": True, "action": "download", "file": dest, "name": os.path.basename(dest)})
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
                    return state_payload({"success": True, "action": "download", "file": dest, "name": os.path.basename(dest)})
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
    return state_payload({"success": True, "action": "new_tab", "tabId": tid})


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
    return state_payload({"success": True, "action": "switch_tab"})


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
    return state_payload({"success": True, "action": "close_tab"})


def do_history(cmd):
    p = active_page()
    publish_live(str(cmd.get("action") or "refresh"))
    if cmd.get("action") == "go_back" or cmd.get("dir") == "back":
        p.go_back(timeout=30000)
    elif cmd.get("action") == "go_forward" or cmd.get("dir") == "forward":
        p.go_forward(timeout=30000)
    else:
        p.reload(timeout=45000)
    return state_payload({"success": True, "action": cmd.get("action") or "refresh"})


def do_console(cmd):
    global console_log, seen_console
    n = max(1, min(80, int(cmd.get("limit") or 40)))
    entries = console_log[-n:]
    if cmd.get("clear"):
        console_log = []
        seen_console = set()
    return state_payload({"success": True, "action": "console", "count": len(entries), "entries": entries})


def do_network(cmd):
    global network_log
    n = max(1, min(60, int(cmd.get("limit") or 30)))
    entries = network_log[-n:]
    if cmd.get("clear"):
        network_log = []
    return state_payload({"success": True, "action": "network", "count": len(entries), "entries": entries})


def do_state(cmd):
    return state_payload({"success": True, "action": "get_state", "profileDir": PROFILE, "downloadsDir": DOWNLOADS})


def do_close(cmd):
    global context, pages, active_idx, ref_map
    try:
        if context is not None:
            context.close()
    except Exception:
        pass
    context = None
    pages = []
    active_idx = 0
    ref_map = {}
    with LIVE_LOCK:
        LIVE_STATE["closed"] = True
        LIVE_STATE["booted"] = False
        LIVE_STATE["action"] = None
    publish_live("close")
    return {"success": True, "action": "close", "message": "Browser session closed. The persistent profile was kept."}


HANDLERS = {
    "navigate": do_navigate,
    "click": do_click,
    "type": do_type,
    "press": do_press,
    "scroll": do_scroll,
    "wait": do_wait,
    "screenshot": do_screenshot,
    "screen_record": do_screen_record,
    "snapshot": do_snapshot,
    "read": do_read,
    "get_page": do_get_page,
    "inspect": do_inspect,
    "get_elements": do_get_elements,
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


def main():
    with open(READY, "w") as f:
        f.write("1")
    threading.Thread(target=live_pub_loop, daemon=True).start()
    threading.Thread(target=live_cast_loop, daemon=True).start()
    refresh_live_pages()
    log("driver loop started (pid %d)" % os.getpid())
    seen = ""
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
            if handler is None:
                result = err_payload("bad_request", "Unknown action: %s" % action, False)
            else:
                try:
                    result = handler(cmd)
                except Exception as e:
                    log("action %s failed: %s" % (action, traceback.format_exc()[-400:]))
                    result = playw_err(e)
            res_path = os.path.join(DIR, "res-" + cid + ".json")
            with open(res_path + ".tmp", "w") as f:
                f.write(json.dumps(result))
            os.replace(res_path + ".tmp", res_path)
            # Live-cast upkeep (PRD §2-§4): after every command the active
            # tab marker + url/title/viewport refresh so the live view tracks
            # what the agent just did, even for actions that publish nothing.
            mark_active_tab()
            refresh_live_pages()
        except json.JSONDecodeError:
            time.sleep(0.3)
        except Exception:
            log("loop error: %s" % traceback.format_exc()[-300:])
            time.sleep(0.5)


if __name__ == "__main__":
    main()
`;
