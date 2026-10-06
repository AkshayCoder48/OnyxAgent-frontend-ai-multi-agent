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
import subprocess
import sys
import time
import traceback

DIR = "/home/user/.onyx/browser"
CMD = os.path.join(DIR, "cmd.json")
SHOTS = os.path.join(DIR, "shots")
PROFILE = os.path.join(DIR, "profile")
DOWNLOADS = "/home/user/downloads"
READY = os.path.join(DIR, ".ready")
for d in (DIR, SHOTS, DOWNLOADS):
    os.makedirs(d, exist_ok=True)

LAUNCH_ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-blink-features=AutomationControlled"]

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
    loc.first.click(timeout=12000)
    active_page().wait_for_timeout(400)
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
    out = state_payload({"success": True, "action": "type", "target": target_label(target), "text": text[:80]})
    if box:
        out["box"] = box
    return out


def do_press(cmd):
    key = str(cmd.get("key") or "Enter")
    p = active_page()
    p.keyboard.press(key)
    p.wait_for_timeout(300)
    return state_payload({"success": True, "action": "press", "key": key})


def do_scroll(cmd):
    p = active_page()
    direction = str(cmd.get("direction") or "down")
    amount = int(cmd.get("amount") or 600)
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


def do_get_page(cmd):
    p = active_page()
    try:
        text = p.evaluate("() => document.body ? document.body.innerText : ''")
    except Exception:
        text = ""
    text = (text or "")[:6000]
    return state_payload({"success": True, "action": "get_page", "text": text})


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
    loc.first.set_input_files(paths, timeout=15000)
    out = state_payload({"success": True, "action": "upload", "target": target_label(target), "files": [os.path.basename(x) for x in paths]})
    if box:
        out["box"] = box
    return out


def do_download(cmd):
    p = active_page()
    url = cmd.get("url")
    target = cmd.get("target")
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
    return {"success": True, "action": "close", "message": "Browser session closed. The persistent profile was kept."}


HANDLERS = {
    "navigate": do_navigate,
    "click": do_click,
    "type": do_type,
    "press": do_press,
    "scroll": do_scroll,
    "wait": do_wait,
    "screenshot": do_screenshot,
    "get_page": do_get_page,
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
    "console": do_console,
    "network": do_network,
    "get_state": do_state,
    "close": do_close,
}


def main():
    with open(READY, "w") as f:
        f.write("1")
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
        except json.JSONDecodeError:
            time.sleep(0.3)
        except Exception:
            log("loop error: %s" % traceback.format_exc()[-300:])
            time.sleep(0.5)


if __name__ == "__main__":
    main()
`;
