/**
 * The web-session driver — a long-running Node process INSIDE the
 * E2B sandbox that owns a headless Chromium (Playwright) and serves a tiny
 * file protocol:
 *
 *   /home/user/.onyx/websession/driver.mjs    — this source (started detached)
 *   /home/user/.onyx/websession/cmd.json      — {id, action, …} request
 *   /home/user/.onyx/websession/res-<id>.json — the driver's reply
 *   /home/user/.onyx/websession/shots/*.png   — screenshots
 *   /home/user/.onyx/websession/.ready        — "the loop is running" marker
 *
 * Embedded by bg-agent-script.ts inside a String.raw template literal — it
 * is interpolated into the background runner so start_web_session /
 * manage_web_session execute NATIVELY inside the sandbox and keep working
 * when the browser tab is closed:
 *
 *   CONSTRAINT: this source must contain NO backticks and NO ${ } sequences
 *   — a nested backtick would terminate the host template, and ${ would be
 *   interpolated by it. Use string concatenation only.
 */
export const WEB_SESSION_DRIVER_SOURCE = String.raw`#!/usr/bin/env node
// Web-session driver — file-protocol Playwright runner.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "/home/user/.onyx/websession";
const CMD = join(DIR, "cmd.json");
const SHOTS = join(DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

let seen = "";
let browser = null;
let page = null;
let shotN = 0;

// ── Diagnostics capture ─────────────────────────────────────────────
// Bounded ring buffers attached to every page: console errors/warnings,
// uncaught page errors, failed network responses. Deduplicated by message
// text so a repeating error never floods the log.
let consoleLog = [];
let networkLog = [];
const seenConsole = new Set();
const CONSOLE_MAX = 80;
const NETWORK_MAX = 60;

function recordConsole(type, text) {
  const t = String(text ?? "").slice(0, 500);
  if (!t) return;
  const key = type + "|" + t;
  if (seenConsole.has(key)) return;
  seenConsole.add(key);
  consoleLog.push({ type: type, text: t, ts: Date.now() });
  if (consoleLog.length > CONSOLE_MAX) consoleLog.shift();
}

function recordNetwork(entry) {
  networkLog.push(entry);
  if (networkLog.length > NETWORK_MAX) networkLog.shift();
}

function attachDiagnostics(p) {
  p.on("console", (msg) => {
    const type = msg.type();
    if (type !== "error" && type !== "warning") return;
    recordConsole(type === "warning" ? "warn" : "error", msg.text());
  });
  p.on("pageerror", (err) => {
    recordConsole("pageerror", err && err.message ? err.message : String(err));
  });
  p.on("response", (resp) => {
    const s = resp.status();
    if (s >= 400) {
      recordNetwork({ status: s, url: String(resp.url()).slice(0, 300), ts: Date.now() });
    }
  });
  p.on("requestfailed", (req) => {
    const failure = req.failure ? req.failure() : null;
    recordNetwork({ status: 0, url: String(req.url()).slice(0, 300), error: failure ? String(failure.errorText || "") : "failed", ts: Date.now() });
  });
}

// In-page serializer for the eval action: DOM nodes,
// NodeLists, Promises, circular references and non-serializable values all
// produce USEFUL plain data instead of crashing the evaluation.
// (Array-join, not a template literal — the hosts embed this file inside a
// String.raw template, so a nested back-tick or a dollar-brace sequence
// would terminate it. Neither appears anywhere in this source.)
const SERIALIZER_SRC = [
  "function __onyxSer(v, depth, seen) {",
  "  seen = seen || new WeakSet();",
  "  try {",
  "    if (v === null) return null;",
  "    var t = typeof v;",
  "    if (t === 'string') return v.length > 4000 ? v.slice(0, 4000) + '...' : v;",
  "    if (t === 'number' || t === 'boolean' || t === 'undefined') return v;",
  "    if (t === 'bigint') return String(v) + 'n';",
  "    if (t === 'symbol') return v.toString();",
  "    if (t === 'function') return '[function ' + (v.name || 'anonymous') + ']';",
  "    if (v instanceof Error) return v.name + ': ' + v.message;",
  "    if (v instanceof Date) return v.toISOString();",
  "    if (v instanceof RegExp) return String(v);",
  "    if (typeof Node !== 'undefined' && v instanceof Node) {",
  "      if (v.nodeType === 1) {",
  "        var cls = typeof v.className === 'string' ? v.className.split(/\\s+/).filter(Boolean).slice(0, 8) : [];",
  "        var r = typeof v.getBoundingClientRect === 'function' ? v.getBoundingClientRect() : null;",
  "        return { element: true, tag: v.tagName.toLowerCase(), id: v.id || undefined, classes: cls, text: (v.innerText || '').trim().slice(0, 200), box: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : undefined };",
  "      }",
  "      if (v.nodeType === 9) return '[document ' + (v.title || '') + ']';",
  "      return '[' + (v.nodeName || 'node') + ']';",
  "    }",
  "    if (typeof Window !== 'undefined' && v instanceof Window) return '[window - ' + location.href + ']';",
  "    if (seen.has(v)) return '[circular]';",
  "    if (depth >= 4) return Array.isArray(v) ? '[array(' + v.length + ')]' : '[object]';",
  "    seen.add(v);",
  "    if (Array.isArray(v)) return v.slice(0, 100).map(function (x) { return __onyxSer(x, depth + 1, seen); });",
  "    if (typeof NodeList !== 'undefined' && (v instanceof NodeList || v instanceof HTMLCollection)) { return Array.prototype.slice.call(v, 0, 100).map(function (x) { return __onyxSer(x, depth + 1, seen); }); }",
  "    if (v && typeof v === 'object' && typeof v.length === 'number' && typeof v.item === 'function') { return Array.prototype.slice.call(v, 0, 100).map(function (x) { return __onyxSer(x, depth + 1, seen); }); }",
  "    var out = {};",
  "    var keys = Object.keys(v).slice(0, 30);",
  "    for (var i = 0; i < keys.length; i++) out[keys[i]] = __onyxSer(v[keys[i]], depth + 1, seen);",
  "    return out;",
  "  } catch (e) {",
  "    return '[unserializable: ' + String(e && e.message ? e.message : e) + ']';",
  "  }",
  "}",
].join("\n");

async function getBrowser() {
  if (browser) return browser;
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  return browser;
}

async function getPage() {
  if (page) return page;
  const b = await getBrowser();
  page = await b.newPage({ viewport: { width: 1280, height: 800 } });
  attachDiagnostics(page);
  return page;
}

async function handle(cmd) {
  const p = await getPage();
  switch (cmd.action) {
    case "navigate": {
      const resp = await p.goto(cmd.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return { ok: true, action: "navigate", url: p.url(), status: resp ? resp.status() : null, title: await p.title() };
    }
    case "click": {
      await p.click(cmd.selector, { timeout: 10000 });
      await p.waitForTimeout(400);
      return { ok: true, action: "click", selector: cmd.selector, url: p.url() };
    }
    case "type": {
      await p.fill(cmd.selector, String(cmd.text ?? ""), { timeout: 10000 });
      return { ok: true, action: "type", selector: cmd.selector };
    }
    case "press": {
      await p.press(cmd.selector || "body", cmd.key, { timeout: 10000 });
      return { ok: true, action: "press", key: cmd.key };
    }
    case "screenshot": {
      shotN += 1;
      const name = "shot-" + shotN + ".png";
      const path = join(SHOTS, name);
      await p.screenshot({ path, fullPage: !!cmd.fullPage });
      const buf = readFileSync(path);
      return { ok: true, action: "screenshot", path, dataUrl: "data:image/png;base64," + buf.toString("base64") };
    }
    case "extract": {
      const text = cmd.selector ? await p.textContent(cmd.selector, { timeout: 10000 }).catch(() => null) : await p.evaluate(() => document.body.innerText);
      return { ok: true, action: "extract", text: (text || "").slice(0, 8000) };
    }
    case "title": {
      return { ok: true, action: "title", title: await p.title() };
    }
    case "content": {
      const html = await p.content();
      return { ok: true, action: "content", html: html.slice(0, 40000) };
    }
    case "status": {
      return { ok: true, action: "status", alive: !!browser && browser.isConnected(), url: page ? page.url() : null };
    }
    case "eval": {
      // eval: REAL JavaScript execution in the
      // live page. eval() supports expressions AND statements; the result
      // (incl. awaited Promises) is serialized in-page by __onyxSer so DOM
      // nodes, NodeLists and circular values return useful data.
      const code = String(cmd.code ?? "");
      if (!code.trim()) return { ok: false, error: "'code' is required for eval." };
      const wrapper =
        "(async () => {\n" +
        SERIALIZER_SRC +
        "\n  try {\n" +
        "    let __r = eval(" + JSON.stringify(code) + ");\n" +
        "    if (__r && typeof __r.then === 'function') __r = await __r;\n" +
        "    return { ok: true, value: __onyxSer(__r, 0) };\n" +
        "  } catch (e) {\n" +
        "    return { ok: false, error: String(e && e.message ? e.message : e) };\n" +
        "  }\n" +
        "})()";
      const result = await p.evaluate(wrapper);
      return Object.assign({ action: "eval", url: p.url() }, result || { ok: false, error: "evaluation returned nothing" });
    }
    case "els": {
      // Element inventory: the interactive elements
      // of the current page with stable selectors + a11y info — the data
      // behind element tagging.
      const limit = Math.max(1, Math.min(200, Number(cmd.limit) || 80));
      const els = await p.evaluate("(() => {\n" +
        "  function sel(el) {\n" +
        "    if (el.id) return '#' + el.id;\n" +
        "    var aria = el.getAttribute('aria-label');\n" +
        "    var tag = el.tagName.toLowerCase();\n" +
        "    if (aria) return tag + '[aria-label=\"' + aria.slice(0, 40) + '\"]';\n" +
        "    var cls = typeof el.className === 'string' ? el.className.split(/\\s+/).filter(Boolean) : [];\n" +
        "    if (cls.length) return tag + '.' + cls.slice(0, 2).join('.');\n" +
        "    var name = el.getAttribute('name');\n" +
        "    if (name) return tag + '[name=\"' + name + '\"]';\n" +
        "    var txt = (el.innerText || '').trim().slice(0, 20);\n" +
        "    if (txt) return tag + ':has-text(\"' + txt.replace(/\"/g, '') + '\")';\n" +
        "    return tag + ':nth-of-type(' + (Array.prototype.indexOf.call(el.parentNode.children, el) + 1) + ')';\n" +
        "  }\n" +
        "  var out = [];\n" +
        "  var nodes = document.querySelectorAll('button, a[href], input, select, textarea, [role=button], [role=link], [role=tab], [onclick], [tabindex]');\n" +
        "  for (var el of nodes) {\n" +
        "    var r = el.getBoundingClientRect();\n" +
        "    if (r.width === 0 && r.height === 0) continue;\n" +
        "    var text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 80);\n" +
        "    out.push({ tag: el.tagName.toLowerCase(), id: el.id || null, classes: (typeof el.className === 'string' ? el.className : '').split(/\\s+/).filter(Boolean).slice(0, 6), role: el.getAttribute('role') || null, type: el.getAttribute('type') || null, name: el.getAttribute('name') || null, text: text || null, selector: sel(el), box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });\n" +
        "    if (out.length >= " + limit + ") break;\n" +
        "  }\n" +
        "  return out;\n" +
        "})()");
      return { ok: true, action: "els", url: p.url(), count: els.length, elements: els };
    }
    case "console": {
      const entries = consoleLog.slice(-Math.max(1, Math.min(80, Number(cmd.limit) || 40)));
      if (cmd.clear) {
        consoleLog = [];
        seenConsole.clear();
      }
      return { ok: true, action: "console", count: entries.length, entries: entries };
    }
    case "network": {
      const entries = networkLog.slice(-Math.max(1, Math.min(60, Number(cmd.limit) || 30)));
      if (cmd.clear) {
        networkLog = [];
      }
      return { ok: true, action: "network", count: entries.length, entries: entries };
    }
    case "close": {
      if (browser) { await browser.close().catch(() => {}); }
      browser = null; page = null;
      return { ok: true, action: "close" };
    }
    default:
      return { ok: false, error: "Unknown action " + cmd.action };
  }
}

async function main() {
  writeFileSync(join(DIR, ".ready"), "1");
  for (;;) {
    if (!existsSync(CMD)) { await new Promise(r => setTimeout(r, 300)); continue; }
    let cmd;
    try { cmd = JSON.parse(readFileSync(CMD, "utf8")); } catch { await new Promise(r => setTimeout(r, 300)); continue; }
    const id = String(cmd.id || "");
    if (!id || id === seen) { await new Promise(r => setTimeout(r, 300)); continue; }
    seen = id;
    let result;
    try { result = await handle(cmd); }
    catch (err) { result = { ok: false, error: err && err.message ? err.message : String(err) }; }
    writeFileSync(join(DIR, "res-" + id + ".json"), JSON.stringify(result));
  }
}

main().catch((err) => { console.error("driver fatal:", err); process.exit(1); });
`;
