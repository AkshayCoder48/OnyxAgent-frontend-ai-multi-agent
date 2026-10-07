/**
 * The background agent runner v2 — TRUE TOKEN STREAMING. A self-contained
 * Node ESM script that runs INSIDE the E2B sandbox as a background command
 * (`commands.run("node …", { background: true, timeoutMs: 0 })`).
 *
 * Why inside the sandbox? E2B sandboxes are server-side VMs: they keep
 * running after the browser disconnects. The agent loop CONTINUES while the
 * browser is closed; when the user comes back, the app reconnects and
 * replays the progress this script wrote.
 *
 * v2 — the streaming rewrite (the old runner awaited `res.json()` and wrote
 * ONE monolithic "reasoning" + ONE "text" event per round, which made the
 * UI render whole rounds at once):
 *   1. The LLM call is STREAMING (stream:true + Accept: text/event-stream)
 *      with an incremental SSE parser (persistent buffer, \n\n and
 *      \r\n\r\n frame boundaries, TextDecoder stream:true for split
 *      multibyte UTF-8, [DONE] handling, idle watchdog).
 *   2. Fine-grained events: `reasoning_delta` / `text_delta` /
 *      `tool_call_delta` / `tool_call` / `tool_result` / `status` / `done` /
 *      `error`, emitted 1:1 with each upstream SSE delta (NO coalescing —
 *      the provider's native chunk granularity flows through unchanged).
 *   3. A LIVE think-region router mirrors the in-browser runtime: models
 *      that think inside `content` (think tags, or the "Reasoning: …
 *      Answer: …" prefix style) stream into reasoning_delta WHILE the
 *      tokens arrive — the panel grows live, not at round end.
 *   4. The event log is APPEND-ONLY (`.onyx/runs/<runId>/events.jsonl` —
 *      O(1) appends, crash-relaunchable via seq continuity) with a tiny
 *      state.json mirror (status + conversation + todos) and a legacy
 *      bg-state.json pointer.
 *   5. Every event carries `ts` (runner wall-clock) + `seq` (monotonic), so
 *      duration badges reflect when things ACTUALLY happened inside the
 *      sandbox, not when the browser happened to poll.
 *   6. Providers that reject stream:true with 4xx (or answer
 *      Content-Type: application/json) fall back to a non-streaming call
 *      whose complete message is re-fed through the SAME delta pipeline —
 *      one honest bulk delivery, no fake typing.
 *   7. Retries (5xx/429/network, exponential backoff) happen BEFORE any
 *      content streams — no duplicate deltas. Mid-stream failures flush the
 *      partial content and preserve it.
 */

import { ONYX_MD_DIGEST_TOOLS } from "@/lib/agent/onyx-md-digest";
// The CloakBrowser browser driver (Python), shared verbatim with the
// browser-side use_browser tool — interpolated into the runner below so
// use_browser runs NATIVELY inside the sandbox.
import { BROWSER_DRIVER_PY_SOURCE } from "@/lib/e2b/browser-driver";

export const BG_AGENT_SCRIPT = String.raw`
// OnyxAgent background runner v2 — STREAMING. Executes INSIDE the E2B sandbox.
// Started as: node bg-agent.mjs <runId>
//
import fs from "node:fs/promises";
import { exec } from "node:child_process";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

const HOME = "/home/user";
const STATE_DIR = path.join(HOME, ".onyx");
const RUNS_DIR = path.join(STATE_DIR, "runs");
const LEGACY_POINTER = path.join(STATE_DIR, "bg-state.json");

let STATE_FILE = "";
let EVENTS_FILE = "";
let SEQ = 0;
// Serialized event appends — each appendFile is one atomic line write; the
// chain keeps STRICT call order in the log (seq == file order).
let emitChain = Promise.resolve();

const cap = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "\n... (truncated)" : s);
/** Error-detail cleaner: gateways answer 4xx/5xx with HTML error pages —
 *  strip tags so the user sees a readable one-line reason, not a wall of
 *  markup. Also adds the base-URL hint for 404s (root-vs-API confusion).
 *
 *  ENVELOPE PARSING (LLM HTTP 400 fix): many OpenAI-compatible gateways
 *  wrap failures as {"success":false,"error":{"message":…,"code":…,
 *  "details":…}} — the actionable part (details/param/why) often lives
 *  one level deeper than the generic message ("Something was wrong with
 *  the input data"). Surface message + code + details when present so the
 *  user gets an actionable error instead of an opaque BAD_REQUEST. */
const cleanDetail = (s, status) => {
  let t = String(s ?? "");
  if (/^\s*(<!DOCTYPE|<html)/i.test(t)) t = "(HTML error page)";
  // JSON envelope ({"success":false,"error":{...}} / {"error":{...}}) —
  // extract message + code + details into one readable line.
  if (/^\s*\{/.test(t)) {
    try {
      const o = JSON.parse(t);
      const e = o && typeof o === "object" && o.error && typeof o.error === "object" ? o.error : null;
      if (e) {
        const parts = [];
        if (typeof e.message === "string" && e.message) parts.push(e.message);
        if (typeof o.code === "string" && o.code) parts.push("(" + o.code + ")");
        if (typeof e.code === "string" && e.code && !parts.some((p) => p.includes(e.code))) parts.push("(" + e.code + ")");
        // 'details' (fastapi-style validation) + 'param' (openai-style) both
        // name the offending field — they are the "check the details" payload.
        const details = e.details ?? e.detail ?? e.errors;
        if (details !== undefined && details !== null) {
          let dStr = "";
          try { dStr = typeof details === "string" ? details : JSON.stringify(details); } catch { dStr = String(details); }
          if (dStr && dStr !== "[]") parts.push("— details: " + cap(dStr, 220));
        }
        if (typeof e.param === "string" && e.param) parts.push("— field: " + e.param);
        if (parts.length) {
          t = parts.join(" ");
        }
      }
    } catch { /* not JSON — fall through to tag stripping */ }
  }
  t = t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  t = cap(t, 400);
  if (status === 404 && !t) {
    t = "endpoint not found — check the provider Base URL (the app calls {base}/chat/completions)";
  }
  return t;
};

/** Sanitized request-shape context appended to 4xx errors so the user (and
 *  bug reports) can see WHAT was being sent without ever leaking keys or
 *  message content: round, message count, tool count, param keys.
 *  (NOTE: this file is a String.raw template literal — no backticks and no
 *  dollar-brace interpolation inside script code; plain concatenation only.) */
const requestShapeHint = (state, round, body) => {
  try {
    const msgs = Array.isArray(state.messages) ? state.messages.length : 0;
    const tools = Array.isArray(body.tools) ? body.tools.length : 0;
    const keys = Object.keys(body).filter((k) => k !== "messages" && k !== "tools").join(",");
    return " [request: round " + round + ", " + msgs + " messages, " + tools + " tools, params: " + keys + "]";
  } catch { return ""; }
};

/** Parse an HTTP-400 error body naming an unsupported parameter
 *  ({"error":{"code":"unsupported_parameter","param":"temperature"}} or
 *  plain text "The parameter 'temperature' is not supported") → the param
 *  name, or null. Used by the request self-healing retry. */
const parseUnsupportedParam = (t) => {
  if (!t) return null;
  if (!/unsupported[ _-]?param|not supported by this model/i.test(t)) return null;
  try {
    const o = JSON.parse(String(t));
    const e = o && o.error ? o.error : o;
    if (e && typeof e === "object") {
      const code = typeof e.code === "string" ? e.code.toLowerCase().replace(/[ _-]/g, "") : "";
      if ((code === "unsupportedparameter" || code === "invalidparameter") && typeof e.param === "string" && e.param) return e.param;
    }
  } catch {}
  const m = String(t).match(/parameter ['"]([a-z_]+)['"] (?:is )?not supported/i);
  return m ? m[1] : null;
};

const safePath = (p) => {
  if (typeof p !== "string" || !p.trim()) return null;
  const cleaned = p.trim().replace(/^\/+/, "");
  const abs = path.resolve(HOME, cleaned);
  if (!abs.startsWith(HOME)) return null;
  return abs;
};

// Magic-byte image sniffing for preview_image's workspace-path support —
// mirrors src/lib/tools/image-sources.ts sniffImageMime (the file's
// extension is never trusted, the CONTENT decides).
const sniffImageMime = (buf) => {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  return null;
};

// ── TOOL-ARG REPAIR (PRD "Create File causes provider SSE failure") ──────
// Self-contained mirror of src/lib/agent/tool-args.ts (this script is
// standalone by design, like the param policy above).
//
// Tool arguments stream across MANY SSE chunks; a stream cut mid-argument
// leaves e.g. '{"path": "/home/user/gym_cutting_diet.md' — invalid JSON.
// Previously that raw string was (a) EXECUTED as {_raw:…} → the tool saw
// args.path === undefined → "Invalid path", and (b) REPLAYED VERBATIM as
// tool_calls[].function.arguments on the next round → the gateway failed
// every subsequent request with "JSON error injected into SSE stream" and
// the retry loop burned all attempts on a poisoned history.
//
// repairJsonArgs closes what truncation left open (string literal first,
// then open containers, dangling commas trimmed) and returns a PARSEABLE
// string, or null when the payload is unrecoverable.
const repairJsonArgs = (raw) => {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const text = raw.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; escaped = false; }
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      const open = stack.pop();
      if (open === undefined) return null;
      if ((open === "{" && ch !== "}") || (open === "[" && ch !== "]")) return null;
    }
  }
  let candidate = text;
  if (inString) {
    if (escaped) candidate = candidate.slice(0, -1);
    candidate += '"';
  }
  candidate = candidate.replace(/,\s*$/, "");
  for (let i = stack.length - 1; i >= 0; i--) candidate += stack[i] === "{" ? "}" : "]";
  try { JSON.parse(candidate); return candidate; } catch { return null; }
};

// Parse + repair a tool-call argument string. NEVER throws. Returns
// { args, malformed, raw } — malformed:true means the payload was invalid;
// args holds the REPAIRED object when repair worked, {} when it did not.
const parseToolArgsSafe = (raw) => {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { args: {}, malformed: false, raw: "{}" };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { args: parsed, malformed: false, raw: text };
    }
  } catch {}
  const repaired = repairJsonArgs(text);
  if (repaired !== null) {
    try {
      const parsed = JSON.parse(repaired);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { args: parsed, malformed: true, raw: text };
      }
    } catch {}
  }
  return { args: {}, malformed: true, raw: text };
};

// Arguments safe to replay on the wire: repaired copy when possible, valid
// "{}" when not. The raw truncated text NEVER goes back to the provider.
const wireSafeArgs = (raw) => {
  const parsed = parseToolArgsSafe(raw);
  if (!parsed.malformed) return JSON.stringify(parsed.args);
  if (Object.keys(parsed.args).length > 0) return JSON.stringify(parsed.args);
  return "{}";
};

// The structured tool result a malformed call resolves to — fed back
// through the NORMAL tool-result protocol so the model can re-issue the
// call (a tool failure never escalates into a provider error/retry).
const malformedArgsResult = (raw) => ({
  error: {
    code: "MALFORMED_TOOL_ARGUMENTS",
    message: "The tool call arguments arrived truncated or malformed and could not be parsed. Re-issue the complete tool call with valid JSON arguments.",
    raw: typeof raw === "string" && raw.length > 500 ? raw.slice(0, 500) + "…" : raw,
  },
});

// Sanitize a messages array for the wire: ANY assistant tool_calls entry
// whose arguments do not parse gets valid "{}" (or the repaired copy).
// Defense-in-depth so a poisoned history can never wedge the retry loop —
// run before EVERY provider request.
const sanitizeToolCallHistory = (msgs) => {
  if (!Array.isArray(msgs)) return msgs;
  return msgs.map((m) => {
    if (!m || m.role !== "assistant" || !Array.isArray(m.tool_calls)) return m;
    let changed = false;
    const tool_calls = m.tool_calls.map((tc) => {
      if (!tc || !tc.function || typeof tc.function.arguments !== "string") return tc;
      try { JSON.parse(tc.function.arguments); return tc; } catch {}
      changed = true;
      return { ...tc, function: { ...tc.function, arguments: wireSafeArgs(tc.function.arguments) } };
    });
    return changed ? { ...m, tool_calls } : m;
  });
};

async function readState() {
  // BOOT RESILIENCE (PRD "System Not Found Error"): a crash-recovery resume
  // can point at a run dir whose state.json was never written (killed
  // between mkdir and write), and a half-written file must never crash the
  // runner with a raw ENOENT. Missing/corrupt → a minimal boot state; the
  // first writeState recreates the file.
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const st = JSON.parse(raw);
    // Param bans survive state.json round-trips as a plain array.
    if (!Array.isArray(st.paramBans)) st.paramBans = [];
    return st;
  } catch {
    return { status: "running", messages: [], paramBans: [] };
  }
}

/** Friendly fs error text — raw Node codes ("ENOENT") and platform phrasings
 *  ("The system cannot find the file specified") become actionable tool
 *  errors the model can actually reason about (PRD TR-2). */
const friendlyErr = (e) => {
  const code = e && typeof e.code === "string" ? e.code : "";
  if (code === "ENOENT") return "not found (no such file or folder)";
  if (code === "EISDIR") return "path is a folder, not a file";
  if (code === "ENOTDIR") return "path is not a folder (a parent segment is a file)";
  if (code === "EEXIST") return "already exists";
  if (code === "EACCES" || code === "EPERM") return "permission denied";
  if (code) return code;
  const msg = e && e.message ? String(e.message) : "";
  if (/ENOENT|cannot find the file/i.test(msg)) return "not found (no such file or folder)";
  return cap(msg || "unknown error", 160);
};

async function writeState(state) {
  const tmp = STATE_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state));
  await fs.rename(tmp, STATE_FILE);
}

/** Append one event to the run's append-only log (O(1), order-serialized). */
function emitEvent(ev) {
  ev.ts = Date.now();
  ev.seq = ++SEQ;
  emitChain = emitChain
    .then(() => fs.appendFile(EVENTS_FILE, JSON.stringify(ev) + "\n"))
    .catch(() => {});
  return emitChain;
}

/** Terminal status → state.json mirror + legacy pointer. */
async function setTerminal(status, contentOrError) {
  try {
    const state = await readState();
    state.status = status;
    if (status === "done") state.content = contentOrError ?? "";
    if (status === "error") state.error = contentOrError ?? "Unknown error";
    await writeState(state);
  } catch {}
  try {
    const p = JSON.parse(await fs.readFile(LEGACY_POINTER, "utf8"));
    p.status = status;
    await fs.writeFile(LEGACY_POINTER, JSON.stringify(p));
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Delta emitters: TOKEN-FAITHFUL pass-through ───────────────────────
// The previous DeltaBatcher (60ms/400c text, 100ms/500c reasoning) coalesced
// the upstream's word-level SSE bursts into sentence/paragraph-sized events
// — the root cause of "paragraph at once" streaming. There is now ZERO
// coalescing on the text/reasoning path: each extracted SSE delta becomes
// an event the moment it arrives. (No render-spam risk: delivery batches
// events per bg_wait poll and the frontend flushes once per batch.)
// Each appendFile is one atomic line write; the chain keeps STRICT call
// order in the log (seq == file order). settle = await emitChain.

// ── Live think-region router ────────────────────────────────────────────
// Models that think INSIDE content. Two shapes:
//   A) Tag regions:  … 
//      Text before the opener streams as text; the region streams as
//      reasoning_delta LIVE; the closer returns to text mode. The tail is
//      held ONLY while it could still become a (split) tag — exact prefix
//      matching, so a tail with no tag prefix emits immediately.
//   B) Prefix style: the round's first text starts with "Reasoning:" — all
//      text is held until an "Answer:"-family marker; pre-marker text
//      streams as reasoning, post-marker as text. If the stream ends with
//      no marker, everything is reasoning. (Held text is never lost.)
const THINK_OPEN_RE = /<(?:think|thinking|thought|reasoning)>/i;
const THINK_CLOSE_RE = /<\/(?:think|thinking|thought|reasoning)>/i;
const ANSWER_MARK_RE = /(?:^|\n)[ \t]*(?:final[ \t]+)?(?:answer|response|conclusion|result)[ \t]*[:\-\u2013]\s*/i;
const OPEN_TAGS = ["<think>", "<thinking>", "<thought>", "<reasoning>"];
const CLOSE_TAGS = ["</think>", "</thinking>", "</thought>", "</reasoning>"];
const MAX_TAG_LEN = 12; // "</reasoning>" — the longest possible tag
/** Hold-back length for a buffer tail: 0 unless the tail is a PREFIX of a
 *  known tag (e.g. "<thi", "</rea") — split-tag protection without the old
 *  blanket 24-char lag that merged word-level deltas into paragraphs. */
function tagPrefixHold(buf, tags) {
  const tail = buf.slice(Math.max(0, buf.length - MAX_TAG_LEN));
  const lt = tail.lastIndexOf("<");
  if (lt === -1) return 0;
  const suf = tail.slice(lt).toLowerCase();
  for (const t of tags) {
    if (t.startsWith(suf)) return suf.length;
  }
  return 0;
}

class ThinkRouter {
  constructor() {
    this.mode = "text"; // "text" | "think"
    this.decided = false; // prefix decision made?
    this.prefix = false; // "Reasoning:" prefix style active
    this.buf = ""; // routing buffer
    this.finished = false;
  }
  /** Route an incoming text delta; onText/onThink receive emission-ready
   *  chunks (hold-back-adjusted). */
  push(s, onText, onThink) {
    if (!s || this.finished) return;
    this.buf += s;
    if (this.mode === "think") {
      const close = THINK_CLOSE_RE.exec(this.buf);
      if (close) {
        const head = this.buf.slice(0, close.index);
        if (head) onThink(head);
        this.buf = this.buf.slice(close.index + close[0].length);
        this.mode = "text";
        this._drainText(onText, onThink);
      } else {
        // stay in think mode — emit everything except a tail that could
        // still become a split close tag (exact prefix match, no blanket lag)
        const hold = tagPrefixHold(this.buf, CLOSE_TAGS);
        const safeLen = this.buf.length - hold;
        if (safeLen > 0) {
          onThink(this.buf.slice(0, safeLen));
          this.buf = this.buf.slice(safeLen);
        }
      }
      return;
    }
    // text mode — prefix decision first. Fast path: anything not starting
    // with "r/R" can NEVER be the "Reasoning:" prefix style — decide
    // immediately (zero hold). Only an "r…" start needs the 14-char window.
    if (!this.decided) {
      const trimmed = this.buf.trimStart();
      if (trimmed.length === 0) return;
      const c = trimmed[0].toLowerCase();
      if (c !== "r") {
        this.decided = true;
        this.prefix = false;
      } else if (trimmed.length < 14) {
        return; // "r…" start — hold a few more chars to decide
      } else {
        this.decided = true;
        this.prefix = /^reasoning\b\s*[:\-\u2013]/i.test(trimmed);
      }
    }
    if (this.prefix) {
      const mark = ANSWER_MARK_RE.exec(this.buf);
      if (mark) {
        const head = this.buf.slice(0, mark.index);
        if (head) onThink(head);
        this.buf = this.buf.slice(mark.index + mark[0].length);
        this.prefix = false;
        this._drainText(onText, onThink);
      }
      // no marker yet → keep holding (flushed as reasoning at finish)
      return;
    }
    this._drainText(onText, onThink);
  }
  _drainText(onText, onThink) {
    if (this.mode !== "text" || this.finished) return;
    const open = THINK_OPEN_RE.exec(this.buf);
    if (open) {
      const head = this.buf.slice(0, open.index);
      if (head) onText(head);
      this.buf = this.buf.slice(open.index + open[0].length);
      this.mode = "think";
      const close = THINK_CLOSE_RE.exec(this.buf);
      if (close) {
        const inner = this.buf.slice(0, close.index);
        if (inner) onThink(inner);
        this.buf = this.buf.slice(close.index + close[0].length);
        this.mode = "text";
        this._drainText(onText, onThink);
      }
      return;
    }
    // hold back a tail that could be a split tag opener ("<th", "<thi"…) —
    // exact prefix match, so ordinary prose with "<" still emits immediately
    const safe = this.buf.length - tagPrefixHold(this.buf, OPEN_TAGS);
    if (safe > 0) {
      onText(this.buf.slice(0, safe));
      this.buf = this.buf.slice(safe);
    }
  }
  /** End of stream: flush every hold as its current mode's kind. */
  finish(onText, onThink) {
    if (this.finished) return;
    this.finished = true;
    const rest = this.buf;
    this.buf = "";
    if (!rest) return;
    if (this.prefix) {
      onThink(rest);
    } else if (this.mode === "think") {
      onThink(rest);
    } else {
      onText(rest);
    }
  }
}

// ── Fence (\x60\x60\x60tool_call) + DSML normalizers ────────────────────
// Kept from v1: some gateways return tool calls INSIDE message.content as a
// fenced block or DSML XML tags. During streaming the fence opener is
// detected live (text after it is swallowed); at stream end the collected
// content is normalized into real tool_calls.
// NOTE: backticks are written as \x60 (char code) because this whole script
// is embedded inside a backtick-delimited template literal.
const FENCE_OPEN = /[\x60]{3}(?:tool_calls?|tool-calls?|function[_\s-]*calls?)\s*\n?/i;
const FENCE_FULL = /[\x60]{3}(?:tool_calls?|tool-calls?|function[_\s-]*calls?)\s*\n?([\s\S]*?)[\x60]{3}/gi;

function parseFenceCalls(text) {
  if (!FENCE_OPEN.test(text)) return null;
  const calls = [];
  const consume = (body) => {
    const trimmed = String(body ?? "").trim();
    if (!trimmed) return;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { return; }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    for (const it of arr) {
      if (!it || typeof it !== "object") continue;
      const name = it.name ?? (it.function && it.function.name);
      if (typeof name !== "string" || !name) continue;
      let args = it.arguments ?? (it.function && it.function.arguments) ?? {};
      if (args && typeof args === "object") args = JSON.stringify(args);
      calls.push({ id: "fence_" + calls.length + "_" + Date.now(), type: "function", function: { name, arguments: String(args ?? "") } });
    }
  };
  let clean;
  const full = [...text.matchAll(FENCE_FULL)];
  if (full.length) {
    for (const m of full) consume(m[1]);
    clean = text.replace(FENCE_FULL, "").trim();
  } else {
    const open = FENCE_OPEN.exec(text);
    if (!open) return null;
    consume(text.slice(open.index + open[0].length));
    clean = text.slice(0, open.index).trim();
  }
  if (!calls.length) return null;
  return { calls, clean };
}

function parseDSMLCalls(text) {
  if (!text.includes("DSML")) return null;
  const blockRe = /<｜｜DSML｜｜tool_calls>([\s\S]*?)(?:<\/｜｜DSML｜｜tool_calls>|$)/;
  const m = blockRe.exec(text);
  if (!m) return null;
  const calls = [];
  const invokeRe = /<｜｜DSML｜｜invoke\s+name="([^"]+)">([\s\S]*?)(?:<\/｜｜DSML｜｜invoke>|$)/g;
  let im;
  while ((im = invokeRe.exec(m[1])) !== null) {
    const args = {};
    const paramRe = /<｜｜DSML｜｜parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜｜DSML｜｜parameter>/g;
    let pm;
    while ((pm = paramRe.exec(im[2])) !== null) args[pm[1]] = pm[2].trim();
    calls.push({ id: "dsml_" + calls.length + "_" + Date.now(), type: "function", function: { name: im[1], arguments: JSON.stringify(args) } });
  }
  if (!calls.length) return null;
  return { calls, clean: (text.slice(0, m.index) + (m[0].endsWith("</｜｜DSML｜｜tool_calls>") ? text.slice(blockRe.lastIndex) : "")).trim() };
}

/** Normalize a completed message: extract text-embedded tool calls (fence /
 *  DSML) into the standard tool_calls array and strip them from content. */
function normalizeMessage(msg) {
  let toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const content = String(msg.content ?? "");
  let clean = content;
  if (toolCalls.length === 0 && content) {
    const fence = parseFenceCalls(content);
    if (fence) { toolCalls = fence.calls; clean = fence.clean; }
    else {
      const dsml = parseDSMLCalls(content);
      if (dsml) { toolCalls = dsml.calls; clean = dsml.clean; }
    }
  } else if (content) {
    const fence = parseFenceCalls(content);
    if (fence) clean = fence.clean;
    else {
      const dsml = parseDSMLCalls(content);
      if (dsml) clean = dsml.clean;
    }
  }
  return { ...msg, content: clean, tool_calls: toolCalls };
}

/** BARE-JSON TOOL CALL: some gateway/model combos (kilo-auto with a large
 *  tool set) emit the tool call as ONE bare JSON object in content —
 *   { "name": "web_search", "arguments": { ... } }
 * instead of delta.tool_calls. Detected LIVE (the text is held, never shown)
 * and resolved at stream end: converts to a real tool call when the JSON
 * parses AND the name matches a registered tool, otherwise the held text is
 * released untouched as normal text. */
function parseBareToolCall(text) {
  const t = String(text ?? "").trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return null;
  let parsed;
  try { parsed = JSON.parse(t); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const name = typeof parsed.name === "string" ? parsed.name
    : (parsed.function && typeof parsed.function.name === "string" ? parsed.function.name : null);
  // ALL_TOOLS (not the raw TOOLS table): in agent mode the coding tools are
  // filtered out, so a bare-text tool call naming them must NOT be promoted
  // out of plain text either (mode isolation defense in depth).
  if (!name || !ALL_TOOLS.some((x) => x.name === name)) return null;
  let args = parsed.arguments ?? (parsed.function && parsed.function.arguments) ?? {};
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { /* keep the string */ }
  }
  return { name, args, argsStr: typeof args === "string" ? args : JSON.stringify(args) };
}

// ── Incremental SSE frame parser ────────────────────────────────────────
/** Extract every COMPLETE SSE frame from a buffer. Returns the parsed JSON
 *  payloads + the remainder (partial frame kept for the next chunk). Handles
 *  \n\n and \r\n\r\n separators, multi-line data:, [DONE], keep-alive
 *  comments, and malformed frames (skipped, never fatal). out.sawDone is
 *  set when the provider's data: [DONE] marker was seen (premature-EOF
 *  detection — see the stream loop). */
function parseSSEFrames(buffer) {
  const events = [];
  let sawDone = false;
  let rest = buffer;
  for (;;) {
    let idx = -1;
    let len = 0;
    const nl = rest.indexOf("\n\n");
    const crlf = rest.indexOf("\r\n\r\n");
    if (crlf !== -1 && (nl === -1 || crlf < nl)) { idx = crlf; len = 4; }
    else if (nl !== -1) { idx = nl; len = 2; }
    else break;
    const frame = rest.slice(0, idx);
    rest = rest.slice(idx + len);
    const data = [];
    for (const line of frame.split("\n")) {
      const l = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (l.startsWith("data:")) data.push(l.slice(5).replace(/^ /, ""));
    }
    if (!data.length) continue; // comment/keep-alive/empty
    const payload = data.join("\n").trim();
    if (!payload) continue;
    if (payload === "[DONE]") { sawDone = true; continue; }
    try { events.push(JSON.parse(payload)); } catch { /* malformed frame */ }
  }
  return { events, rest, sawDone };
}

/** Pull content / reasoning / tool-call fragments out of one streamed chunk
 *  (mirrors the in-browser runtime's extractDelta, INCLUDING the flattened
 *  tool-call shape {index, id, name, arguments} the UI pipeline expects). */
function extractDeltas(chunk) {
  const choices = Array.isArray(chunk.choices) ? chunk.choices : null;
  if (!choices || !choices.length) {
    return { error: chunk.error ?? null };
  }
  const choice = choices[0];
  if (!choice) return { error: null };
  const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {};
  const out = { error: null };
  if (typeof delta.content === "string" && delta.content.length > 0) out.text = delta.content;
  const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
  if (typeof reasoning === "string" && reasoning.length > 0) out.reasoning = reasoning;
  const rawToolCalls = delta.tool_calls;
  if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
    out.toolCalls = rawToolCalls.map((tc) => {
      const fn = (tc && tc.function && typeof tc.function === "object") ? tc.function : {};
      return {
        index: typeof tc.index === "number" ? tc.index : 0,
        id: typeof tc.id === "string" ? tc.id : undefined,
        name: typeof fn.name === "string" ? fn.name : undefined,
        arguments: typeof fn.arguments === "string" ? fn.arguments
          : (fn.arguments && typeof fn.arguments === "object" ? JSON.stringify(fn.arguments) : undefined),
      };
    });
  }
  return out;
}

/** reader.read() with an idle timeout — the losing promise's eventual
 *  rejection is always handled (no unhandled-rejection crash). */
function readWithTimeout(reader, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("idle")), ms);
    reader.read().then(
      (r) => { clearTimeout(t); resolve(r); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** Request-message serializer (LLM HTTP 400 fix).
 *
 *  state.messages is the LOCAL conversation record — it may carry a local
 *  'reasoning' field on assistant messages (kept for DeepSeek-style
 *  providers that REQUIRE reasoning_content to be passed back on tool
 *  rounds). The WIRE format, however, must contain ONLY fields every
 *  OpenAI-compatible endpoint accepts: strict validators (Pydantic-style
 *  gateways) reject unknown fields with a generic 400 "Something was wrong
 *  with the input data".
 *
 *  Default: strip 'reasoning' (never send it). Self-healing flips
 *  state.replayReasoning = true when a provider's 400 explicitly demands it
 *  ("reasoning_content ... must be passed back") — then assistant messages
 *  regain reasoning_content for the rest of the run. */
function buildRequestMessages(state) {
  const replay = state.replayReasoning === true;
  const stripped = (Array.isArray(state.messages) ? state.messages : []).map((m) => {
    if (!m || typeof m !== "object") return m;
    if (m.role !== "assistant" || m.reasoning === undefined) return m;
    if (replay && m.reasoning) {
      return { ...m, reasoning_content: m.reasoning, reasoning: undefined };
    }
    const { reasoning, ...rest } = m;
    void reasoning;
    return rest;
  });
  return applyWireCompat(stripped, wireMode(state));
}

// ── STRICT-GATEWAY WIRE COMPAT (LLM HTTP 400 fix) ─────────────────────────
// Mirrors src/lib/agent/wire-compat.ts (this script is self-contained —
// the copy stays inlined on purpose, like the param policy above).
// VERIFIED failure modes on gen.pollinations.ai community routes
// (upstream dg-ai.daivikdagar.workers.dev, 2026-09-26): role:"tool"
// messages → 400 "Invalid role tool"; assistant.tool_calls + a system
// message → generic 400; system prompts containing agent-workload wording
// ("assistant", "directive", tool-USE instructions) → generic 400.
// VERIFIED-compatible: no/tiny-neutral system, tools param, tool calls as
// TEXT + <tool_result> user messages, stream_options with stream:true.
const COMPAT_SYSTEM_PROMPT = "You are helpful. Be concise.";

function wireMode(state) {
  if (!state.wireCompat || typeof state.wireCompat !== "object") {
    state.wireCompat = { toolText: false, system: "native", noTools: false };
  }
  return state.wireCompat;
}

function applyWireCompat(list, mode) {
  const out = [];
  let sawFirstSystem = false;
  for (const m of list) {
    if (m && m.role === "system") {
      if (!sawFirstSystem) {
        sawFirstSystem = true;
        if (mode.system === "dropped") continue;
        if (mode.system === "compact") { out.push({ ...m, content: COMPAT_SYSTEM_PROMPT }); continue; }
        out.push({ ...m });
        continue;
      }
      // Mid-conversation system notes (wrap-up round) → user messages in
      // downgraded modes — the content filter rejects them as system too.
      if (mode.system !== "native") { out.push({ ...m, role: "user" }); continue; }
      out.push({ ...m });
      continue;
    }
    out.push({ ...m });
  }
  if (!mode.toolText) return out;
  const transformed = [];
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    transformed.push({ role: "user", content: pending.join("\n") });
    pending = [];
  };
  for (const m of out) {
    if (!m) continue;
    if (m.role === "tool") {
      const header =
        m.name || m.tool_call_id
          ? "<tool_result" + (m.name ? ' name="' + m.name + '"' : "") + (m.tool_call_id ? ' tool_call_id="' + m.tool_call_id + '"' : "") + ">"
          : "<tool_result>";
      const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      pending.push(header + "\n" + body + "\n</tool_result>");
      continue;
    }
    flush();
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const callText = m.tool_calls
        .map((tc) => {
          let args = (tc.function && tc.function.arguments) || "{}";
          if (args.length > 2000) args = args.slice(0, 2000) + "…";
          return "[Calling " + ((tc.function && tc.function.name) || "tool") + " with " + args + "]";
        })
        .join("\n");
      const base = typeof m.content === "string" && m.content.trim() ? m.content.trim() + "\n" : "";
      const copy = { ...m };
      delete copy.tool_calls;
      copy.content = base + callText;
      transformed.push(copy);
      continue;
    }
    transformed.push(m);
  }
  flush();
  return transformed;
}

/** Ladder decision — learns the next downgrade into state.wireCompat and
 *  returns the reason (or null when exhausted). Mirrors
 *  nextStrictGatewayStep in wire-compat.ts. */
function nextWireCompatStep(state, opts) {
  const mode = wireMode(state);
  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  const hasToolStructures = messages.some(
    (m) => m && (m.role === "tool" || (Array.isArray(m.tool_calls) && m.tool_calls.length > 0)),
  );
  const hasSystem = messages.some((m) => m && m.role === "system");
  const invalidRoleTool = /invalid role\s*["']?tool/i.test(String(opts.errorText || ""));
  if (!mode.toolText && (hasToolStructures || invalidRoleTool)) {
    mode.toolText = true;
    return "tool-text mode (tool results as user messages)";
  }
  if (hasSystem && mode.system === "native") {
    mode.system = "compact";
    return "compact system prompt (provider filters system content)";
  }
  if (hasSystem && mode.system === "compact") {
    mode.system = "dropped";
    return "no system message (provider rejects system prompts)";
  }
  if (opts.hasToolsParam && !mode.noTools) {
    mode.noTools = true;
    return "no tools param (provider rejects tool declarations)";
  }
  return null;
}

/** Defensive JSON-Schema validation for tool parameters (LLM HTTP 400 fix).
 *  A single malformed tool definition (missing 'type', 'properties' not an
 *  object, 'required' naming unknown props, non-serializable values) makes
 *  strict endpoints reject the WHOLE request. Fix what's fixable, and fall
 *  back to a bare object schema when not. */
function sanitizeToolParameters(schema) {
  const fallback = { type: "object", properties: {} };
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return fallback;
  const out = { type: "object" };
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    const props = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        props[k] = { type: "string" };
      } else {
        props[k] = v; // keep as-is (nested schemas pass through — JSON-serializable by construction)
      }
    }
    out.properties = props;
  } else {
    out.properties = {};
  }
  if (Array.isArray(schema.required)) {
    const known = new Set(Object.keys(out.properties));
    const req = schema.required.filter((r) => typeof r === "string" && known.has(r));
    if (req.length) out.required = req;
  }
  if (typeof schema.additionalProperties === "boolean") out.additionalProperties = schema.additionalProperties;
  return out;
}

// ── No-timeout fetch for the LLM stream ───────────────────────────────
/** fetch() WITHOUT undici's default timeouts — used ONLY for the main LLM
 *  stream call. Node's global fetch (undici) silently enforces TWO
 *  dispatcher-level timeouts that fired far below the 600s floor and
 *  surfaced as yet another "Stream read failed":
 *    - headersTimeout 300s: the request is killed if response HEADERS
 *      haven't arrived within 5 minutes. Max-thinking models legitimately
 *      think for minutes BEFORE the first byte — healthy streams died.
 *    - bodyTimeout 300s: a response body that stays silent between chunks
 *      for 5 minutes is killed (long silent thinking phases mid-stream).
 *  Neither is settable through fetch() options — they live on the
 *  dispatcher — so this helper drives node:http/node:https directly:
 *  NO header/body timeouts at all, so the stream lives exactly as long
 *  as the provider keeps the connection open (IDLE_TIMEOUT_MS in the SSE
 *  loop below stays the only liveness guard). Only TCP connection
 *  ESTABLISHMENT is bounded (30s) so dead hosts fail fast; once the socket
 *  is connected nothing is ever timed out.
 *
 *  Returns a Response-like object — { status, ok, headers.get(name), body,
 *  text(), json() } — whose body is a WEB ReadableStream (Readable.toWeb),
 *  so the existing res.body.getReader() SSE loop works unchanged.
 *  Redirects are followed like fetch() would (301/302/303 → GET, 307/308
 *  keep method + body, max 5 hops). Node core modules ONLY — this script
 *  ships to the E2B sandbox as a single self-contained file. */
async function fetchNoTimeout(urlStr, opts) {
  const CONNECT_TIMEOUT_MS = 30_000;
  const MAX_REDIRECTS = 5;
  // fetch() parity: a URL without a protocol is an ERROR, not a request to
  // localhost (node's legacy url.parse would happily do the latter).
  if (!/^https?:\/\//i.test(String(urlStr))) throw new Error("Invalid URL: " + urlStr);
  let url = String(urlStr);
  let method = opts.method || "GET";
  let reqBody = opts.body;
  for (let hop = 0; ; hop++) {
    const res = await new Promise((resolve, reject) => {
      const mod = /^https:\/\//i.test(url) ? https : http;
      const headers = Object.assign({}, opts.headers);
      let reqBodyStr = null;
      if (reqBody != null) {
        reqBodyStr = typeof reqBody === "string" ? reqBody : String(reqBody);
        // Explicit Content-Length (fetch parity): some strict gateways
        // reject chunked request bodies.
        const hasLen = Object.keys(headers).some((k) => k.toLowerCase() === "content-length");
        if (!hasLen) headers["Content-Length"] = String(Buffer.byteLength(reqBodyStr));
      }
      let resEnded = false; // response fully read — skip a pointless destroy on abort
      let connectTimer = null;
      const clearConnectTimer = () => { if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; } };
      const req = mod.request(url, { method, headers }, (nodeRes) => {
        clearConnectTimer();
        nodeRes.on("end", () => { resEnded = true; });
        const webBody = Readable.toWeb(nodeRes);
        resolve({
          status: nodeRes.statusCode || 0,
          ok: nodeRes.statusCode >= 200 && nodeRes.statusCode < 300,
          headers: {
            get: (name) => {
              const v = nodeRes.headers[String(name).toLowerCase()];
              if (v === undefined) return null;
              return Array.isArray(v) ? v.join(", ") : String(v);
            },
          },
          body: webBody,
          text: () => new Response(webBody).text(),
          json: () => new Response(webBody).json(),
        });
      });
      req.on("error", (e) => { clearConnectTimer(); reject(e); });
      // Connect-phase bound ONLY: cleared the moment the TCP connection is
      // established — server processing time (silent thinking before the
      // headers arrive) is NEVER bounded by it.
      connectTimer = setTimeout(() => {
        req.destroy(new Error("connect timeout (30s) — the provider host never accepted the TCP connection"));
      }, CONNECT_TIMEOUT_MS);
      req.on("socket", (sock) => {
        if (sock.connecting) sock.once("connect", clearConnectTimer);
        else clearConnectTimer();
      });
      if (opts.signal) {
        opts.signal.addEventListener("abort", () => {
          if (!resEnded) req.destroy(new Error("aborted"));
        });
      }
      if (reqBodyStr != null) req.write(reqBodyStr);
      req.end();
    });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc || hop >= MAX_REDIRECTS) return res;
    // Release the redirect response's socket, then hop (fetch semantics:
    // 301/302/303 after POST → GET with no body; 307/308 keep everything).
    try { await res.body.cancel(); } catch {}
    url = new URL(loc, url).toString();
    if (res.status !== 307 && res.status !== 308 && method !== "GET" && method !== "HEAD") {
      method = "GET";
      reqBody = undefined;
    }
  }
}

// ── The streaming LLM call ──────────────────────────────────────────────
const MAX_ATTEMPTS = 8; // 4 + headroom for the strict-gateway self-heal ladder
// DEAD-WIRE GUARD (not a duration cap): reader.read() rejecting after this
// many milliseconds with ZERO bytes on the wire. Provider keep-alive comments
// (": ping" / empty SSE frames) arrive as bytes and reset it, so an ACTIVE
// stream — including a reasoning model that thinks for many minutes while
// dripping deltas — never trips it. Only a connection that has gone fully
// silent (dead upstream, severed socket) does, which is genuinely
// indistinguishable from a dead peer at the transport level. There is NO
// total execution timeout anywhere in this runner: a round may legitimately
// run as long as the provider keeps sending bytes (the ~567s "Stream read
// failed" failures were the old 600s hard abort killing healthy
// max-thinking streams mid-reasoning — removed 2026-10). 600s, not lower:
// NO liveness guard may fire below 600s (user requirement) — a truly dead
// connection now takes up to 10 minutes to surface, which the idle
// diagnostics message below already explains.
const IDLE_TIMEOUT_MS = 600_000;

/**
 * Streams ONE round. Emits live events (status:first_token, reasoning_delta,
 * text_delta, tool_call_delta, pre-emitted tool_call, status:llm_end) and
 * returns the normalized round result: { content, reasoning, toolCalls, error }.
 * toolCalls elements: { id, type, function: {name, arguments}, _args }.
 */
async function streamRoundEvents(state, round, finalRound) {
  const p = state.provider;
  let url = String(p.baseUrl ?? "").replace(/\/+$/, "");
  if (!p.noPrefix && !url.endsWith("/chat/completions")) url += "/chat/completions";
  const body = {
    model: p.model,
    // WIRE SAFETY: the history is sanitized — every assistant tool_calls
    // entry carries VALID JSON arguments (repaired copy / "{}"). A
    // truncated-argument replay is what made the gateway answer every
    // subsequent round with "JSON error injected into SSE stream".
    messages: sanitizeToolCallHistory(buildRequestMessages(state)),
    temperature: p.temperature ?? 0.7,
    stream: true,
  };
  // PARAMETER POLICY: some model routes reject standard params (e.g.
  // temperature) with HTTP 400 unsupported_parameter. Strip the params the
  // user disabled for this provider AND the ones auto-learned during this
  // run (state.paramBans, filled by the self-healing retry below).
  const disabledParams = Array.isArray(p.disabledParams) ? p.disabledParams : [];
  if (disabledParams.includes("temperature") || state.paramBans.includes("temperature")) delete body.temperature;
  if (disabledParams.includes("stream_options") || state.paramBans.includes("stream_options")) delete body.stream_options;
  // The final wrap-up round runs WITHOUT tools — the model must compose its
  // final answer (the cap ends the turn in done, never the old terminal
  // max-rounds error). Fence/DSML "tool_call" text on the final round is
  // parsed too — nothing executes; the text stays text.
  if (state.toolsEnabled !== false && finalRound !== true) body.tools = ALL_TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: sanitizeToolParameters(t.parameters) } }));
  if (state.paramBans.includes("tools") || disabledParams.includes("tools")) delete body.tools;

  // Pass-through emitters (1:1 with the provider's native SSE deltas).
  const emitTextDelta = (d) => { if (d) emitEvent({ t: "text_delta", round, content: d }); };
  const emitReasonDelta = (d) => { if (d) emitEvent({ t: "reasoning_delta", round, content: d }); };

  let content = "";      // visible text (post router; includes fence text)
  let reasoning = "";    // reasoning text (all sources)
  let fenceMode = false; // inside a \x60\x60\x60tool_call block — swallow
  let emittedLen = 0;    // cursor of content already emitted as text_delta
  // BARE-JSON TOOL GUARD state: null = undecided, true = holding, false = off.
  let bareMode = null;
  const toolAcc = new Map(); // index → { id, name, args }
  const preEmitted = new Set(); // indexes already pre-emitted as tool_call
  let firstToken = false;
  let router = new ThinkRouter();

  const onText = (chunkText) => {
    if (!chunkText) return;
    if (fenceMode) { content += chunkText; return; } // swallowed; parsed at end
    // LIVE BARE-JSON TOOL HOLD: while NOTHING has been emitted as text yet,
    // a stream starting with {"name":… may be a bare-JSON tool call (some
    // gateways emit those instead of delta.tool_calls). Hold it — resolved
    // at stream end (tool call, or released as text).
    if (bareMode !== false && emittedLen === 0) {
      const accHold = content + chunkText;
      const t = accHold.trimStart();
      if (bareMode === null && t.startsWith("{")) bareMode = true;
      if (bareMode === true) {
        // < 20 chars = too early to tell; otherwise require {"name": prefix.
        const looksBare = t.length < 20 || /^\{\s*"name"\s*:/.test(t);
        if (looksBare) {
          content = accHold;
          return; // held — never emitted until resolution
        }
        // Clearly not a bare tool call — release the WHOLE held text now
        // (content already includes every chunk received so far).
        bareMode = false;
        content = accHold;
        emitTextDelta(accHold);
        emittedLen = accHold.length;
        return;
      }
    }
    // LIVE FENCE DETECTION: check the accumulated visible text for an opener.
    const acc = content + chunkText;
    const open = FENCE_OPEN.exec(acc);
    if (open && open.index >= emittedLen) {
      const before = acc.slice(emittedLen, open.index);
      if (before) emitTextDelta(before);
      emittedLen = acc.length;
      content = acc;
      fenceMode = true;
      return;
    }
    content = acc;
    emitTextDelta(chunkText);
    emittedLen = content.length;
  };
  const onThink = (chunkThink) => {
    if (!chunkThink) return;
    reasoning += chunkThink;
    emitReasonDelta(chunkThink);
  };

  const markFirstToken = () => {
    if (!firstToken) {
      firstToken = true;
      emitEvent({ t: "status", kind: "first_token", round });
    }
  };

  const feedDeltas = (d) => {
    if (!d) return;
    if (d.reasoning) {
      markFirstToken();
      reasoning += d.reasoning;
      emitReasonDelta(d.reasoning);
    }
    if (d.text) {
      markFirstToken();
      router.push(d.text, onText, onThink);
    }
    if (d.toolCalls) {
      markFirstToken();
      for (const tc of d.toolCalls) {
        const idx = typeof tc.index === "number" ? tc.index : toolAcc.size;
        const existing = toolAcc.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) existing.id = tc.id;
        if (tc.name) existing.name = tc.name;
        if (tc.arguments) existing.args += tc.arguments;
        toolAcc.set(idx, existing);
      }
      // Forward the fragments so the UI shows streaming tool args live.
      emitEvent({ t: "tool_call_delta", round, tool_calls: d.toolCalls });
      // Pre-emit the card the moment we know the tool's name/id.
      for (const [idx, tc] of toolAcc) {
        if ((tc.name || tc.id) && !preEmitted.has(idx)) {
          preEmitted.add(idx);
          emitEvent({
            t: "tool_call", round,
            id: tc.id || "bg_" + round + "_" + idx,
            name: tc.name || "pending-" + idx,
            args: { _streaming: tc.args },
            _preemit: true,
          });
        }
      }
    }
  };

  const finishStream = async () => {
    router.finish(onText, onThink);
    // BARE-JSON TOOL RESOLUTION: text held as a possible bare-JSON tool call
    // converts to a real tool call (never shown as text) or releases.
    if (bareMode === true && content && emittedLen === 0) {
      const bare = parseBareToolCall(content);
      if (bare) {
        toolAcc.set(toolAcc.size, { id: "bare_" + Date.now(), name: bare.name, args: bare.argsStr });
        content = "";
      } else {
        emitTextDelta(content);
        emittedLen = content.length;
      }
      bareMode = false;
    }
    await emitChain; // wait for the last append to land
    // Finalize accumulated tool calls (parse + REPAIR args JSON). The
    // normalized 'arguments' string is ALWAYS valid JSON — repaired copy
    // when possible, "{}" when not — so the replay can never poison the
    // provider history. '_malformed' marks unrepairable calls: the tool is
    // NOT executed; it resolves to a structured MALFORMED_TOOL_ARGUMENTS
    // result instead (tool errors stay tool errors).
    const calls = [];
    for (const [idx, tc] of toolAcc) {
      const parsed = parseToolArgsSafe(tc.args);
      const wireArgs = parsed.malformed
        ? (Object.keys(parsed.args).length > 0 ? JSON.stringify(parsed.args) : "{}")
        : JSON.stringify(parsed.args);
      calls.push({
        id: tc.id || "bg_" + round + "_" + idx,
        type: "function",
        function: { name: tc.name || "unknown", arguments: wireArgs },
        _args: parsed.args,
        _malformed: parsed.malformed && Object.keys(parsed.args).length === 0,
        _rawArgs: parsed.raw,
      });
    }
    // Post-stream normalize: fence/DSML tool calls embedded in content.
    const norm = normalizeMessage({ content, tool_calls: calls });
    const normCalls = Array.isArray(norm.tool_calls) ? norm.tool_calls : [];
    const finalCalls = normCalls.map((tc) => {
      const raw = tc.function ? tc.function.arguments : "{}";
      const parsed = parseToolArgsSafe(raw);
      return {
        ...tc,
        function: { ...tc.function, arguments: wireSafeArgs(raw) },
        _args: parsed.args,
        _malformed: parsed.malformed && Object.keys(parsed.args).length === 0,
        _rawArgs: parsed.raw,
      };
    });
    return { content: norm.content, reasoning, toolCalls: finalCalls };
  };

  const resetForRetry = () => {
    // Rewinds the accumulators for a re-stream of this round. With the
    // REWIND+RETRY policy the loop can run even AFTER partial content
    // arrived: the round_retry event tells the browser to rewind its UI
    // parts first, so the re-stream can never duplicate content (PRD §17).
    content = "";
    reasoning = "";
    emittedLen = 0;
    fenceMode = false;
    bareMode = null;
    firstToken = false;
    router = new ThinkRouter();
    toolAcc.clear();
    preEmitted.clear();
  };

  // Retry loop. Two failure classes with OPPOSITE retry policies:
  //   • SHAPE/PERMANENT (HTTP 400 self-heal ladder): capped at MAX_ATTEMPTS —
  //     a permanently invalid request must not spin forever (PRD §15).
  //   • TRANSIENT/TRANSPORT (network, dead wire, premature stream cut,
  //     provider stream error — including gateways that answer with a JSON
  //     error payload injected INTO the SSE stream — and 5xx/408): retried
  //     INDEFINITELY with capped exponential backoff (2s→30s). The TASK owns
  //     its lifetime (PRD §9/§19): no wall-clock cap, no attempt cap — a
  //     transport blip never terminates the run. Only an explicit user Stop
  //     ends it. When partial content already streamed, the round is
  //     REWOUND in the UI first (round_retry event) so the re-stream can
  //     never duplicate content.
  let ladderSteps = 0;      // counted 400 self-heal continues (capped)
  let transientAttempt = 0; // transient failures since this round started
  const nextTransientDelay = () => {
    transientAttempt += 1;
    // 2s, 4s, 8s, 16s, 30s, 30s, … (PRD §15 backoff ladder)
    return Math.min(2000 * transientAttempt, 30_000);
  };
  for (let attempt = 1; ; attempt++) {
    let res = null;
    let fetchErr = null;
    // NO HARD TIMEOUT: the previous 600-second setTimeout(ac.abort) was
    // an arbitrary application-level execution cap — it killed every
    // healthy long-reasoning stream at the same wall-clock mark (visible as
    // a ~567s "Stream read failed: The operation was aborted" with
    // truncated reasoning). The only liveness guard left is IDLE_TIMEOUT_MS
    // (zero BYTES on the wire); duration itself is never failure. ac
    // exists purely to release the connection in the finally below.
    // fetchNoTimeout instead of global fetch: undici's built-in
    // headersTimeout / bodyTimeout (300s each) were the OTHER sub-600s
    // killer — see the helper above.
    const ac = new AbortController();
    const roundStart = Date.now();
    try {
      res = await fetchNoTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
          ...(p.apiKey ? { Authorization: "Bearer " + p.apiKey } : {}),
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e) {
      fetchErr = e && e.message ? e.message : String(e);
    }
    if (res && res.status === 400) {
      // PARAMETER SELF-HEALING: the body names the offending param — strip
      // it, remember the ban for the rest of this run, retry immediately
      // (this attempt doesn't count as a failure).
      const detail400 = await res.text().catch(() => "");
      const badParam = parseUnsupportedParam(detail400);
      if (badParam && body[badParam] !== undefined && !state.paramBans.includes(badParam) && ladderSteps < MAX_ATTEMPTS) {
        ladderSteps += 1;
        state.paramBans.push(badParam);
        delete body[badParam];
        if (badParam === "reasoning_effort") delete body.thinking;
        if (badParam === "thinking") delete body.reasoning_effort;
        emitEvent({ t: "status", kind: "retry", round, attempt, delayMs: 0, reason: "stripped unsupported param '" + badParam + "'" });
        continue;
      }
      // REASONING-REPLAY SELF-HEALING: DeepSeek-style thinking endpoints
      // REJECT a request whose assistant tool-call message lacks
      // reasoning_content ("The reasoning_content in the thinking mode must
      // be passed back to the API"). buildRequestMessages strips it by
      // default (strict-gateway compatibility); flip the replay flag on
      // this specific error and retry the same request WITH it restored.
      if (
        state.replayReasoning !== true &&
        ladderSteps < MAX_ATTEMPTS &&
        /reasoning_content/i.test(detail400) &&
        /must be passed|required|pass(ed)? back|include/i.test(detail400)
      ) {
        ladderSteps += 1;
        state.replayReasoning = true;
        body.messages = sanitizeToolCallHistory(buildRequestMessages(state));
        emitEvent({ t: "status", kind: "retry", round, attempt, delayMs: 0, reason: "restored reasoning_content replay (provider requires it)" });
        continue;
      }
      // STRICT-GATEWAY LADDER (LLM HTTP 400 fix): tool-text mode →
      // compact system → dropped system → no tools. Each step is learned
      // into state.wireCompat for the rest of this run; the body is
      // rebuilt (messages re-transformed, tools omitted when learned).
      const healReason = ladderSteps < MAX_ATTEMPTS
        ? nextWireCompatStep(state, {
            messages: state.messages,
            hasToolsParam: body.tools !== undefined,
            errorText: detail400,
          })
        : null;
      if (healReason) {
        ladderSteps += 1;
        body.messages = sanitizeToolCallHistory(buildRequestMessages(state));
        if (state.wireCompat.noTools) {
          delete body.tools;
          delete body.tool_choice;
        }
        emitEvent({ t: "status", kind: "retry", round, attempt, delayMs: 0, reason: "self-heal: " + healReason });
        continue;
      }
    }
    if (res && !res.ok) {
      // RATE-LIMIT POLICY (user-requested change): 429/529 is NOT retried
      // — fail fast with a clear message (auto-retrying burns the quota).
      // Transient 5xx / 408 retry INDEFINITELY with capped backoff (a
      // gateway hiccup is transport, not task failure — PRD §15/§16).
      const retryable = (res.status >= 500 || res.status === 408) && res.status !== 529;
      if (retryable) {
        const delay = nextTransientDelay();
        emitEvent({ t: "status", kind: "retry", round, attempt: transientAttempt, delayMs: delay, reason: "HTTP " + res.status });
        await sleep(delay);
        continue;
      }
      const detail = await res.text().catch(() => "");
      if (res.status === 429 || res.status === 529) {
        return { content: "", reasoning: "", toolCalls: [], error: "Rate limit reached (HTTP " + res.status + ") — the provider is throttling requests. Wait a moment and send again. " + cleanDetail(detail, res.status) };
      }
      // 4xx on stream:true → MAY be "streaming not supported" — one
      // non-streaming fallback attempt before giving up.
      if (res.status < 500 && res.status !== 408) {
        return await nonStreamFallback(state, round, feedDeltas, finishStream);
      }
      return { content: "", reasoning: "", toolCalls: [], error: "LLM HTTP " + res.status + " " + cleanDetail(detail, res.status) + requestShapeHint(state, round, body) };
    }
    if (!res || !res.body) {
      if (fetchErr) {
        // Pure network failure — TRANSIENT, retried indefinitely (PRD §15).
        const delay = nextTransientDelay();
        emitEvent({ t: "status", kind: "retry", round, attempt: transientAttempt, delayMs: delay, reason: "network: " + fetchErr });
        await sleep(delay);
        continue;
      }
      return { content: "", reasoning: "", toolCalls: [], error: "LLM network error: " + (fetchErr ?? "no response body") };
    }
    // Some gateways ignore stream:true and answer plain JSON — route that
    // through the same delta pipeline (one honest bulk delivery).
    const ct = String(res.headers.get("content-type") || "");
    if (ct.includes("application/json")) {
      try {
        const json = await res.json();
        const msg = json.choices?.[0]?.message ?? {};
        return await feedCompleteMessage(msg, round, feedDeltas, finishStream);
      } catch (e) {
        // A body that CLAIMS application/json but fails to parse (gateway
        // glitch / HTML error page) is TRANSIENT — rewind nothing (nothing
        // streamed) and retry (PRD §13: malformed payloads never kill the run).
        const delay = nextTransientDelay();
        emitEvent({ t: "status", kind: "retry", round, attempt: transientAttempt, delayMs: delay, reason: "LLM JSON parse failed: " + (e && e.message ? e.message : String(e)) });
        await sleep(delay);
        continue;
      }
    }

    // TRUE SSE — read incrementally.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuf = "";
    let streamError = null;
    let chunksReceived = 0; // wire reads with bytes — stream diagnostics
    // PREMATURE-EOF DETECTION (auto-stop fix): a stream that ends with no
    // finish_reason, no [DONE] marker and no usage chunk was severed
    // mid-generation — not completed. Without this the round ended as a
    // normal (truncated) answer with no error anywhere.
    let sawDoneMarker = false;
    let sawFinishReason = false;
    let sawUsageChunk = false;
    try {
      for (;;) {
        let readResult;
        try {
          readResult = await readWithTimeout(reader, IDLE_TIMEOUT_MS);
        } catch (e) {
          // FAILURE TAXONOMY (the old single "Stream read failed: …" string
          // collapsed unrelated causes into one vague message). Classify:
          // idle dead-wire / aborted / network / reader — each carries
          // elapsed + received-chunk diagnostics so a failure is answerable
          // (how long had it run? was data flowing before the cut?).
          const raw = e && e.message ? e.message : String(e);
          const elapsed = Math.round((Date.now() - roundStart) / 1000);
          const diag = elapsed + "s elapsed, " + chunksReceived + " chunks received";
          if (raw === "idle") {
            streamError = "Idle timeout — the provider sent no bytes at all for " + Math.round(IDLE_TIMEOUT_MS / 1000) + "s (" + diag + "). The connection is dead, not slow.";
          } else if ((e && e.name === "AbortError") || /abort/i.test(raw)) {
            streamError = "Request aborted (" + diag + ").";
          } else if ((e && e.name === "TypeError") || /fetch|network|terminated|socket|ECONN|ENET|EAI_/i.test(raw)) {
            streamError = "Network error mid-stream (" + diag + "): " + cap(raw, 200);
          } else {
            streamError = "Stream read error (" + diag + "): " + cap(raw, 200);
          }
          break;
        }
        const { value, done } = readResult;
        if (done) break;
        chunksReceived++;
        sseBuf += decoder.decode(value, { stream: true });
        const parsed = parseSSEFrames(sseBuf);
        sseBuf = parsed.rest;
        if (parsed.sawDone) sawDoneMarker = true;
        for (const ev of parsed.events) {
          if (ev && ev.usage) sawUsageChunk = true;
          const fr = ev && ev.choices && ev.choices[0] ? (ev.choices[0].finish_reason ?? ev.choices[0].stop_reason) : null;
          if (fr) sawFinishReason = true;
          const d = extractDeltas(ev);
          if (d && d.error) {
            const msg = d.error && d.error.message ? d.error.message : JSON.stringify(d.error);
            streamError = "Provider stream error: " + cap(String(msg), 500);
            break;
          }
          if (d && (d.text || d.reasoning || d.toolCalls)) feedDeltas(d);
        }
        if (streamError) break;
      }
      if (!streamError) {
        sseBuf += decoder.decode();
        const parsed = parseSSEFrames(sseBuf + "\n\n"); // flush trailing frame
        if (parsed.sawDone) sawDoneMarker = true;
        for (const ev of parsed.events) {
          if (ev && ev.usage) sawUsageChunk = true;
          const fr = ev && ev.choices && ev.choices[0] ? (ev.choices[0].finish_reason ?? ev.choices[0].stop_reason) : null;
          if (fr) sawFinishReason = true;
          const d = extractDeltas(ev);
          if (d && d.error) {
            const msg = d.error && d.error.message ? d.error.message : JSON.stringify(d.error);
            streamError = "Provider stream error: " + cap(String(msg), 500);
            break;
          }
          if (d && (d.text || d.reasoning || d.toolCalls)) feedDeltas(d);
        }
      }
    } catch (e) {
      streamError = streamError ?? (e && e.message ? e.message : String(e));
    } finally {
      try { ac.abort(); } catch {} // release the connection
    }
    // PREMATURE STREAM CUT: output arrived but the stream ended with no
    // completion signal at all. Route it through the SAME transient handling
    // as a mid-stream failure below: rewind + retry (PRD §13-§17).
    if (
      !streamError && !sawFinishReason && !sawDoneMarker && !sawUsageChunk &&
      (content || reasoning || toolAcc.size > 0)
    ) {
      streamError = "Response stream was cut off mid-generation (no finish signal)";
    }
    if (streamError) {
      // ABORT is the only non-transient stream error — the runner is being
      // torn down (user Stop / sandbox stop); retrying would ignore it.
      if (/abort/i.test(streamError)) {
        const result = await finishStream();
        emitEvent({ t: "status", kind: "llm_end", round });
        return { ...result, error: streamError };
      }
      // TRANSIENT STREAM FAILURE → REWIND + RETRY (PRD §13-§16): network
      // drops, dead wires, premature cuts and provider stream errors (the
      // "json error injected into SSE stream" gateway glitch class) are
      // TRANSPORT failures, not agent errors — they must never terminate
      // the run. Everything the failed attempt already streamed is rewound
      // in the UI FIRST (round_retry event → the browser processor drops
      // its buffered deltas and rewinds the flushed parts), then the SAME
      // round re-streams from scratch. Indefinite: backoff 2s→30s cap;
      // the explicit user Stop stays the only authority that ends the task.
      const hadPartial = Boolean(content || reasoning || toolAcc.size > 0);
      if (hadPartial) {
        emitEvent({ t: "round_retry", round });
      }
      const delay = nextTransientDelay();
      emitEvent({
        t: "status", kind: "retry", round, attempt: transientAttempt, delayMs: delay,
        reason: streamError + (hadPartial ? " — partial output rewound, retrying" : ""),
      });
      resetForRetry();
      await sleep(delay);
      continue;
    }
    const result = await finishStream();
    emitEvent({ t: "status", kind: "llm_end", round });
    return result;
  }
  const r = await finishStream();
  emitEvent({ t: "status", kind: "llm_end", round });
  return r;
}

/** Providers that reject stream:true — one non-streaming call, re-fed
 *  through the SAME delta pipeline (no fake pacing, honest bulk delivery). */
async function nonStreamFallback(state, round, feedDeltas, finishStream) {
  const p = state.provider;
  let url = String(p.baseUrl ?? "").replace(/\/+$/, "");
  if (!p.noPrefix && !url.endsWith("/chat/completions")) url += "/chat/completions";
  const nb = { model: p.model, messages: sanitizeToolCallHistory(buildRequestMessages(state)), temperature: p.temperature ?? 0.7 };
  const dp = Array.isArray(p.disabledParams) ? p.disabledParams : [];
  if (dp.includes("temperature") || state.paramBans.includes("temperature")) delete nb.temperature;
  if (state.toolsEnabled !== false) nb.tools = ALL_TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: sanitizeToolParameters(t.parameters) } }));
  if (dp.includes("tools") || state.paramBans.includes("tools") || wireMode(state).noTools) delete nb.tools;
  // HANG-GUARD, NOT A REASONING CAP: a non-streaming response has NO
  // liveness signal (no bytes arrive until the entire completion is done),
  // so some ceiling is required to ever detect a dead request. The old
  // 180s ceiling killed legitimate long-thinking models — a max-reasoning
  // non-streaming call can take many minutes — so the guard is now 30 min:
  // far past any healthy completion, short enough to surface a dead one.
  const NONSTREAM_HANG_GUARD_MS = 1_800_000;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(p.apiKey ? { Authorization: "Bearer " + p.apiKey } : {}),
      },
      body: JSON.stringify(nb),
      signal: AbortSignal.timeout(NONSTREAM_HANG_GUARD_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // Self-heal once: an unsupported-parameter 400 names the offending
      // field — strip it, remember the ban, retry this single request.
      const badParam = parseUnsupportedParam(detail);
      if (badParam && nb[badParam] !== undefined && !state.paramBans.includes(badParam)) {
        state.paramBans.push(badParam);
        delete nb[badParam];
        if (badParam === "reasoning_effort") delete nb.thinking;
        if (badParam === "thinking") delete nb.reasoning_effort;
        const retryRes = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            ...(p.apiKey ? { Authorization: "Bearer " + p.apiKey } : {}),
          },
          body: JSON.stringify(nb),
          signal: AbortSignal.timeout(NONSTREAM_HANG_GUARD_MS),
        });
        if (retryRes.ok) {
          const json2 = await retryRes.json();
          const msg2 = json2.choices?.[0]?.message ?? {};
          return await feedCompleteMessage(msg2, round, feedDeltas, finishStream);
        }
        const detail2 = await retryRes.text().catch(() => "");
        return { content: "", reasoning: "", toolCalls: [], error: "LLM HTTP " + retryRes.status + " " + cleanDetail(detail2, retryRes.status) + requestShapeHint(state, round, nb) };
      }
      return { content: "", reasoning: "", toolCalls: [], error: "LLM HTTP " + res.status + " " + cleanDetail(detail, res.status) + requestShapeHint(state, round, nb) };
    }
    const json = await res.json();
    const msg = json.choices?.[0]?.message ?? {};
    return await feedCompleteMessage(msg, round, feedDeltas, finishStream);
  } catch (e) {
    return { content: "", reasoning: "", toolCalls: [], error: "LLM non-stream fallback failed: " + (e && e.message ? e.message : String(e)) };
  }
}

/** Feed a COMPLETE message (non-stream shape) through the same delta
 *  pipeline so reasoning/text/tool events emit identically. */
async function feedCompleteMessage(msg, round, feedDeltas, finishStream) {
  const reasoningField = msg.reasoning_content ?? msg.reasoning ?? msg.thinking;
  if (typeof reasoningField === "string" && reasoningField) {
    feedDeltas({ reasoning: reasoningField });
  }
  if (typeof msg.content === "string" && msg.content) {
    feedDeltas({ text: msg.content });
  }
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    feedDeltas({
      toolCalls: msg.tool_calls.map((tc, i) => {
        const fn = (tc.function && typeof tc.function === "object") ? tc.function : {};
        return {
          index: i,
          id: typeof tc.id === "string" ? tc.id : undefined,
          name: typeof fn.name === "string" ? fn.name : undefined,
          arguments: typeof fn.arguments === "string" ? fn.arguments
            : (fn.arguments && typeof fn.arguments === "object" ? JSON.stringify(fn.arguments) : undefined),
        };
      }),
    });
  }
  const result = await finishStream();
  emitEvent({ t: "status", kind: "llm_end", round });
  return result;
}

// ── Shared todo store (cross-run persistence, PRD FR-1) ─────────────────
// One file per SANDBOX (= per conversation): /home/user/.onyx/todos.json.
// Survives every turn/run for the sandbox's lifetime, seeded from the
// client's live store on boot when the sandbox had to be recreated.
const TODOS_FILE = path.join(STATE_DIR, "todos.json");

/** Load the shared todo list (missing/corrupt file → empty list). */
async function loadSharedTodos() {
  try {
    const raw = await fs.readFile(TODOS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Atomic write of the shared todo list (tmp + rename — never a torn file). */
async function saveSharedTodos(todos) {
  const tmp = TODOS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(todos));
  await fs.rename(tmp, TODOS_FILE);
}

/** Emit a todo_event snapshot — the replay path feeds it into the WSEvent
 *  pipeline so the live TodoPreview updates IN REAL TIME in background
 *  mode (previously the UI only saw settled tool results). */
async function emitTodoEvent(todos) {
  const list = Array.isArray(todos) ? todos : [];
  await emitEvent({ t: "todo_event", todos: list });
}

// ── v3 FULL-TOOLSET helpers (native implementations below) ────────────
// These mirror the in-browser registry tools' result shapes exactly so the
// chat UI renders the same cards in background mode as in foreground mode.

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

const humanSizeBg = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return (i === 0 ? v : v.toFixed(1)) + " " + units[i];
};

const MIME_MAP = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", bmp: "image/bmp", pdf: "application/pdf", txt: "text/plain", md: "text/markdown",
  json: "application/json", csv: "text/csv", tsv: "text/tab-separated-values", js: "text/javascript",
  ts: "text/plain", tsx: "text/plain", jsx: "text/plain", py: "text/x-python", html: "text/html",
  css: "text/css", xml: "application/xml", yml: "text/yaml", yaml: "text/yaml", toml: "text/plain",
  zip: "application/zip", gz: "application/gzip", mp3: "audio/mpeg", mp4: "video/mp4",
};
const mimeForNameBg = (name) => {
  const ext = (String(name).split(".").pop() || "").toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
};

/** Ensure the parent directory of the given file exists (recursively);
 *  records the created chain (relative to HOME) into createdDirs. */
async function ensureParentDir(file, createdDirs) {
  const parent = path.dirname(file);
  if (parent === HOME || !parent) return;
  try {
    await fs.access(parent);
    return;
  } catch {}
  await fs.mkdir(parent, { recursive: true });
  let cur = parent;
  const chain = [];
  while (cur && cur.startsWith(HOME) && cur !== HOME) {
    chain.push(path.relative(HOME, cur));
    cur = path.dirname(cur);
  }
  for (const c of chain.reverse()) createdDirs.push(c);
}

/** Miklium search (images / videos) — mirrors /api/ddg-search's result
 * mapping so the UI's image/video cards render identically. */
async function mikliumSearch(args, mikliumType, uiType) {
  try {
    const query = String(args.query ?? "");
    if (!query.trim()) return { success: false, output: null, error: "query is required" };
    const limit = Math.min(Number(args.limit) || 10, 50);
    const res = await fetch("https://miklium.vercel.app/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ search: [query], type: mikliumType, maxSmallSnippets: limit, maxLargeSnippets: 0 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { success: false, output: null, error: "Search HTTP " + res.status };
    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.results)) return { success: false, output: null, error: "Search returned invalid JSON" };
    const results = [];
    if (uiType === "image") {
      const seen = new Set();
      for (const item of data.results) {
        if (results.length >= limit) break;
        const imageUrl = String((item && item.imageUrl) || "");
        if (!imageUrl || seen.has(imageUrl)) continue;
        seen.add(imageUrl);
        const size = item && item.size && typeof item.size === "object" ? item.size : {};
        const refUrl = String((item && item.referenceUrl) || imageUrl);
        results.push({
          title: String((item && item.title) || ""),
          url: refUrl,
          domain: hostOf(refUrl),
          imageUrl,
          thumbnail: imageUrl,
          width: typeof size.width === "number" ? size.width : undefined,
          height: typeof size.height === "number" ? size.height : undefined,
          source: "Miklium",
          provider: "miklium",
        });
      }
    } else {
      const seen = new Set();
      for (const item of data.results) {
        if (results.length >= limit) break;
        const videoUrl = String((item && item.videoUrl) || "");
        if (!videoUrl || seen.has(videoUrl)) continue;
        seen.add(videoUrl);
        const additional = item && item.additionalData && typeof item.additionalData === "object" ? item.additionalData : {};
        const statistics = additional.statistics && typeof additional.statistics === "object" ? additional.statistics : {};
        const thumbUrl = String((item && item.thumbUrl) || "");
        results.push({
          title: String((item && item.title) || ""),
          url: videoUrl,
          domain: hostOf(videoUrl),
          description: String((item && item.description) || ""),
          imageUrl: thumbUrl,
          thumbnail: thumbUrl,
          videoUrl,
          thumbUrl,
          duration: String((item && item.duration) || "") || undefined,
          source: additional.channelTitle || "Miklium",
          provider: "miklium",
          channelTitle: additional.channelTitle,
          viewCount: statistics.viewCount,
          likeCount: statistics.likeCount,
        });
      }
    }
    return { success: true, output: { query, type: uiType, results, count: results.length, provider: "miklium" } };
  } catch (e) {
    return { success: false, output: null, error: "Search failed: " + (e && e.message ? e.message : String(e)) };
  }
}

/** freeocr.ai OCR — URL (JSON body) or base64 data URI (multipart form).
 * Mirrors lib/tools/ocr.ts so background results render identically. */
async function ocrFetch(url, base64DataUri, filename) {
  const endpoint = "https://freeocr.ai/api/v1/ocr";
  const parse = async (res) => {
    const data = await res.json().catch(() => null);
    if (data && data.error) throw new Error("OCR API error: " + data.error);
    return String((data && data.text) || "");
  };
  if (url) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_url: url }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error("OCR API HTTP " + res.status);
    return parse(res);
  }
  const m = /^data:([^;]+);base64,(.+)$/.exec(String(base64DataUri));
  if (!m) throw new Error("Invalid base64 data URI format. Expected: data:image/png;base64,...");
  const bytes = Buffer.from(m[2], "base64");
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: m[1] }), filename || "image");
  const res = await fetch(endpoint, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error("OCR API HTTP " + res.status);
  return parse(res);
}

// ── Browser driver (shared verbatim with the browser-side use_browser) ──
// The PYTHON CloakBrowser driver source from browser-driver.ts — written to
// /home/user/.onyx/browser/driver.py and started detached (pip installs
// cloakbrowser + playwright; the browser binary downloads on first launch).
// JSON-encoded so the shebang + imports inside it stay a plain STRING here.
const BROWSER_DRIVER_PY = ${JSON.stringify(BROWSER_DRIVER_PY_SOURCE)};
const WS_DIR = path.join(HOME, ".onyx", "browser");
const WS_INSTALL_TIMEOUT_S = 280;

/** exec() as a promise (never throws — returns {err, stdout, stderr}). */
function wsExec(command, timeoutSec) {
  return new Promise((resolve) => {
    exec(command, { cwd: HOME, timeout: (timeoutSec ?? 30) * 1000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err: err ? String((err && err.message) || err) : null, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/** Serialize driver boots — concurrent use_browser calls must not
 *  double-install/double-boot. */
let wsDriverBoot = null;

/** Install (once) + boot the BROWSER driver (Python/CloakBrowser), and
 *  confirm it is ALIVE. Liveness = .ready marker AND a running driver
 *  process (a stale marker from a crashed driver used to hang every
 *  command). Restarts reuse the installed pip packages — only a FRESH
 *  sandbox pays the runtime install (the browser binary downloads inside
 *  the driver on first launch, with a standard-Chromium fallback). */
async function ensureWsDriver() {
  if (!wsDriverBoot) {
    wsDriverBoot = (async () => {
      const readyCmd = 'test -f ' + WS_DIR + '/.ready && pgrep -f "[d]river.py" >/dev/null && echo READY || echo NO';
      const alive = await wsExec(readyCmd);
      if (!alive.err && alive.stdout.trim() === "READY") return { ok: true };
      await fs.mkdir(path.join(WS_DIR, "shots"), { recursive: true });
      await fs.mkdir(path.join(WS_DIR, "profile"), { recursive: true });
      await fs.mkdir(path.join(HOME, "downloads"), { recursive: true });
      await fs.writeFile(path.join(WS_DIR, "driver.py"), BROWSER_DRIVER_PY);
      await fs.rm(path.join(WS_DIR, ".ready"), { force: true }).catch(() => {});
      const installed = await wsExec('python3 -c "import cloakbrowser" 2>/dev/null && echo YES || echo NO', 30);
      const checkPkgs = 'python3 -c "import cloakbrowser, playwright" >/dev/null 2>&1 && echo YES || echo NO';
      if (installed.stdout.trim() !== "YES") {
        // NOTE: no pipes on the pip calls — piping through tail would mask
        // pip's exit code and break the fallback logic.
        let inst = await wsExec('pip install --quiet cloakbrowser playwright', WS_INSTALL_TIMEOUT_S);
        if (inst.err || (await wsExec(checkPkgs, 30)).stdout.trim() !== "YES") {
          inst = await wsExec('pip install --quiet --break-system-packages cloakbrowser playwright', WS_INSTALL_TIMEOUT_S);
        }
        if ((await wsExec(checkPkgs, 30)).stdout.trim() !== "YES") {
          return { ok: false, error: "Failed to install the browser runtime in the sandbox: " + ((inst.stderr || inst.err || inst.stdout).slice(-300) || "pip install failed") };
        }
      }
      await wsExec('cd ' + WS_DIR + ' && nohup python3 driver.py > driver.log 2>&1 &');
      for (let i = 0; i < 40; i++) {
        const r = await wsExec(readyCmd);
        if (!r.err && r.stdout.trim() === "READY") return { ok: true };
        await sleep(400);
      }
      const log = await wsExec('tail -c 400 ' + WS_DIR + '/driver.log 2>/dev/null');
      return { ok: false, error: "The browser driver did not start in time." + (log.stdout ? " Driver log: " + log.stdout.slice(0, 200) : "") };
    })();
  }
  const result = await wsDriverBoot;
  // A FAILED boot may be transient (slow install) — drop the cache so the
  // next call retries; a successful boot stays cached while the driver
  // lives (the cheap alive-check above already ran inside it).
  if (!result.ok) wsDriverBoot = null;
  return result;
}

/** File-protocol command round-trip (local fs — the runner IS the sandbox). */
async function wsSendCommand(cmd, timeoutMs) {
  const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const resPath = path.join(WS_DIR, "res-" + id + ".json");
  await fs.rm(resPath, { force: true }).catch(() => {});
  await fs.writeFile(path.join(WS_DIR, "cmd.json"), JSON.stringify(Object.assign({ id }, cmd)));
  const deadline = Date.now() + (timeoutMs ?? 60_000);
  for (;;) {
    if (Date.now() >= deadline) return { ok: false, error: "Browser command timed out." };
    try {
      const parsed = JSON.parse(await fs.readFile(resPath, "utf8"));
      await fs.rm(resPath, { force: true }).catch(() => {});
      return parsed;
    } catch {}
    await sleep(350);
  }
}

// ── Sandbox-side tool implementations ──────────────────────────────────
const TOOLS = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace. Large files are truncated.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    run: async (args) => {
      const p = safePath(args.path);
      if (!p) return { error: "Invalid path" };
      try {
        const content = await fs.readFile(p, "utf8");
        return content.length > 128 * 1024
          ? { content: content.slice(0, 128 * 1024), truncated: true }
          : { content };
      } catch (e) { return { error: "Failed to read: " + friendlyErr(e) }; }
    },
  },
  {
    name: "write_file",
    description: "Write (create or overwrite) a text file in the workspace.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    run: async (args) => {
      const p = safePath(args.path);
      if (!p) return { error: "Invalid path" };
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, String(args.content ?? ""));
      return { success: true, path: args.path, size: String(args.content ?? "").length };
    },
  },
  {
    name: "create_file",
    description: "Create a new file. Refuses to overwrite unless overwrite=true.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, overwrite: { type: "boolean" } }, required: ["path", "content"] },
    run: async (args) => {
      const p = safePath(args.path);
      if (!p) return { error: "Invalid path" };
      try {
        await fs.access(p);
        if (!args.overwrite) return { error: "File already exists: " + args.path + ". Use write_file to overwrite." };
      } catch { /* doesn't exist — create */ }
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, String(args.content ?? ""));
      return { success: true, path: args.path, size: String(args.content ?? "").length };
    },
  },
  {
    name: "edit_file",
    description: "Replace a substring in a file. replace_all=true replaces every occurrence.",
    parameters: { type: "object", properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "find", "replace"] },
    run: async (args) => {
      const p = safePath(args.path);
      if (!p) return { error: "Invalid path" };
      try {
        const original = await fs.readFile(p, "utf8");
        const all = args.replace_all !== false;
        if (!String(args.find ?? "")) return { error: "find must be non-empty" };
        if (!original.includes(args.find)) return { path: args.path, replacements: 0, note: "substring not found" };
        const updated = all ? original.split(args.find).join(args.replace) : original.replace(args.find, args.replace);
        await fs.writeFile(p, updated);
        return { path: args.path, replacements: all ? original.split(args.find).length - 1 : 1 };
      } catch (e) { return { error: "Failed to edit: " + friendlyErr(e) }; }
    },
  },
  {
    name: "delete_file",
    description: "Delete a file (or a folder recursively).",
    parameters: { type: "object", properties: { path: { type: "string" }, recursive: { type: "boolean" } }, required: ["path"] },
    run: async (args) => {
      const p = safePath(args.path);
      if (!p) return { error: "Invalid path" };
      await fs.rm(p, { recursive: !!args.recursive, force: true });
      return { success: true, path: args.path };
    },
  },
  {
    name: "list_folder",
    description: "List a folder's entries with sizes.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    run: async (args) => {
      const p = safePath(args.path ?? ".") ?? HOME;
      try {
        const entries = await fs.readdir(p, { withFileTypes: true });
        const out = [];
        for (const e of entries.slice(0, 200)) {
          const full = path.join(p, e.name);
          let size = 0;
          try { const st = await fs.stat(full); size = st.size; } catch {}
          out.push({ name: e.name, path: path.relative(HOME, full), type: e.isDirectory() ? "directory" : "file", size });
        }
        return { entries: out, path: path.relative(HOME, p) || "." };
      } catch (e) { return { error: "Failed to list: " + friendlyErr(e) }; }
    },
  },
  {
    name: "create_folder",
    description: "Create a folder (recursively).",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    run: async (args) => {
      const p = safePath(args.path);
      if (!p) return { error: "Invalid path" };
      await fs.mkdir(p, { recursive: true });
      return { success: true, path: args.path };
    },
  },
  {
    // MERGE NOTE (tool-count cap): description widened — this tool also
    // covers renames (same directory + new filename = a rename).
    name: "move_file",
    description: "Move OR RENAME a file/folder. Same directory + new filename = rename; different directory = move.",
    parameters: { type: "object", properties: { path: { type: "string" }, new_path: { type: "string" } }, required: ["path", "new_path"] },
    run: async (args) => {
      const from = safePath(args.path), to = safePath(args.new_path);
      if (!from || !to) return { error: "Invalid path" };
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
      return { success: true, path: args.path, new_path: args.new_path };
    },
  },
  {
    name: "run_terminal",
    description: "Run a shell command in the sandbox (bash). 120s timeout, 256KB output cap.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    run: (args) =>
      new Promise((resolve) => {
        exec(String(args.command ?? ""), { cwd: HOME, timeout: 120_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          resolve({
            exit_code: err && err.code ? (typeof err.code === "number" ? err.code : 1) : 0,
            stdout: cap(String(stdout ?? ""), 256 * 1024),
            stderr: cap(String(stderr ?? err?.message ?? ""), 256 * 1024),
          });
        });
      }),
  },
  {
    name: "run_python",
    description: "Run Python 3 code (60s timeout).",
    parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    run: (args) =>
      new Promise((resolve) => {
        const file = path.join(HOME, ".onyx", "tmp_run.py");
        fs.mkdir(path.dirname(file), { recursive: true })
          .then(() => fs.writeFile(file, String(args.code ?? "")))
          .then(() => {
            exec("python3 " + file, { cwd: HOME, timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
              resolve({
                exit_code: err && err.code ? (typeof err.code === "number" ? err.code : 1) : 0,
                stdout: cap(String(stdout ?? ""), 256 * 1024),
                stderr: cap(String(stderr ?? err?.message ?? ""), 256 * 1024),
              });
              fs.rm(file, { force: true }).catch(() => {});
            });
          })
          .catch((e) => resolve({ error: "Failed to prepare python run: " + (e && e.message ? e.message : String(e)) }));
      }),
  },
  {
    name: "web_fetch",
    description: "Fetch a URL and return its readable text (title + body, 20KB cap).",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    run: async (args) => {
      try {
        const res = await fetch(String(args.url ?? ""), { redirect: "follow", signal: AbortSignal.timeout(30_000) });
        const html = cap(await res.text(), 200 * 1024);
        const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] ?? "";
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
          .replace(/\s+/g, " ")
          .trim();
        return { url: args.url, title, content: cap(text, 20 * 1024) };
      } catch (e) { return { error: "Fetch failed: " + e.message }; }
    },
  },
  {
    // Beta V1.2 — web search from inside the sandbox (Miklium direct; the
    // sandbox has outbound internet). Numbered results + citation guidance
    // so the model cites [n] markers the UI renders as superscript chips.
    name: "web_search",
    description: "Search the web (Yahoo-based index). Returns NUMBERED results: results[0].index=1, results[1].index=2, ... each {index, title, url, content}. ALWAYS call this BEFORE answering factual questions; cite sources in your answer with [n] markers matching the index numbers.",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    run: async (args) => {
      try {
        const query = String(args.query ?? "");
        const limit = Math.min(Number(args.limit) || 10, 20);
        const res = await fetch("https://miklium.vercel.app/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ search: [query], type: "default", maxSmallSnippets: limit, maxLargeSnippets: 0 }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) return { error: "Search HTTP " + res.status };
        const data = await res.json().catch(() => null);
        if (!data) return { error: "Search returned invalid JSON" };
        const raw = Array.isArray(data.results) ? data.results : [];
        const byUrl = new Map();
        for (const item of raw) {
          const url = String((item && item.url) || "");
          if (!url) continue;
          const snippet = String((item && item.snippet) || "");
          const existing = byUrl.get(url);
          if (!existing) {
            let host = url;
            try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}
            byUrl.set(url, { title: host, url, content: snippet });
          } else if (snippet.length > existing.content.length) {
            existing.content = snippet;
          }
        }
        const results = Array.from(byUrl.values()).slice(0, limit);
        if (!results.length) return { query, kind: "web_search", results: [], count: 0, note: "no results" };
        const numbered = results.map((r, i) => ({ index: i + 1, title: r.title, url: r.url, content: cap(r.content, 1200) }));
        return {
          query,
          kind: "web_search",
          results: numbered,
          count: numbered.length,
          note: "Cite these results in your answer with [n] markers matching each result index.",
        };
      } catch (e) {
        return { error: "Search failed: " + (e && e.message ? e.message : String(e)) };
      }
    },
  },
  {
    // Beta V1.3 — todo plan tools in background mode. Same wire shapes as the
    // in-browser registry (lib/tools/todos.ts) so the chat UI's TodoPreview
    // renders identically. PERSISTENCE FIX (PRD "Todo Persistence Failure"):
    // todos live in a SHARED file (.onyx/todos.json) that survives across
    // runs/turns for as long as the conversation's sandbox lives — state.json
    // is per-run and was wiped on every new turn, which is exactly why
    // created todos "disappeared" on the next tool call. The client seeds the
    // file on boot when the sandbox was recreated (seedTodos from the live
    // store), the sandbox's own file always wins once it exists, and every
    // mutation emits a todo_event snapshot so the UI updates in real time.
    name: "manage_todo",
    description: "Manage the todo list for the current task. Actions: create (requires title), update (requires todo_id; optional title/status), delete (requires todo_id), list, clear. status must be one of: not_planned, in_progress, done, not_done. ALWAYS quote the todo ID from a create result in later update/delete calls.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "update", "delete", "list", "clear"] },
        title: { type: "string" },
        content: { type: "string" },
        todo_id: { type: "string" },
        status: { type: "string", enum: ["not_planned", "in_progress", "done", "not_done"] },
      },
      required: ["action"],
    },
    run: async (args) => {
      try {
        const todos = await loadSharedTodos();
        const action = String(args.action ?? "").toLowerCase();
        const now = Date.now();
        const newId = () => "todo_" + Math.random().toString(16).slice(2, 6).padStart(4, "0");
        let next = todos;
        let out;
        if (action === "create") {
          const title = String(args.title ?? args.content ?? "").trim();
          if (!title) return { error: "title is required for create" };
          const todo = { id: newId(), title, status: "not_planned", createdAt: now, updatedAt: now };
          next = [...todos, todo];
          out = { success: true, output: { todo, total: next.length } };
        } else if (action === "update") {
          const id = String(args.todo_id ?? "");
          const idx = todos.findIndex((t) => t.id === id);
          if (idx === -1) return { error: "todo not found: " + (id || "(missing todo_id)") };
          const previous = { ...todos[idx] };
          const updated = { ...todos[idx], updatedAt: now };
          const title = String(args.title ?? args.content ?? "").trim();
          if (title) updated.title = title;
          if (args.status !== undefined) {
            const s = String(args.status);
            if (!["not_planned", "in_progress", "done", "not_done"].includes(s)) {
              return { error: 'invalid status "' + s + '" — use not_planned | in_progress | done | not_done' };
            }
            updated.status = s;
          }
          next = [...todos];
          next[idx] = updated;
          out = { success: true, output: { todo: updated, previous } };
        } else if (action === "delete") {
          const id = String(args.todo_id ?? "");
          const idx = todos.findIndex((t) => t.id === id);
          if (idx === -1) return { error: "todo not found: " + (id || "(missing todo_id)") };
          const deleted = todos.splice(idx, 1)[0];
          next = todos;
          out = { success: true, output: { deleted } };
        } else if (action === "list") {
          return { success: true, output: { todos } };
        } else if (action === "clear") {
          next = [];
          out = { success: true, output: { cleared: true } };
        } else {
          return { error: "Unknown action: " + action };
        }
        await saveSharedTodos(next);
        await emitTodoEvent(next);
        return out;
      } catch (e) {
        return { error: "Todo tool failed: " + friendlyErr(e) };
      }
    },
  },
  {
    name: "show_todo",
    description: "Display the todo list to the user as a visual to-do card in the chat. Use after creating or updating todos so the user can see the current plan and statuses (Not planned / In progress / Done / Not done). Pass todo IDs (from manage_todo results) to show specific todos, or all=true (or no IDs) to show every todo.",
    parameters: {
      type: "object",
      properties: {
        todo_ids: { type: "array", items: { type: "string" } },
        all: { type: "boolean" },
      },
    },
    run: async (args) => {
      try {
        const todos = await loadSharedTodos();
        const rawIds = Array.isArray(args.todo_ids) ? args.todo_ids.map((v) => String(v)) : [];
        const wantAll = args.all === true || rawIds.length === 0;
        if (wantAll) {
          await emitTodoEvent(todos);
          return { success: true, output: { todos } };
        }
        const found = todos.filter((t) => rawIds.includes(t.id));
        const missing = rawIds.filter((id) => !todos.some((t) => t.id === id));
        if (!found.length) return { error: "todo not found: " + (missing.join(", ") || "(none)") };
        await emitTodoEvent(todos);
        return { success: true, output: { todos: found, ...(missing.length ? { not_found: missing } : {}) } };
      } catch (e) {
        return { error: "Todo tool failed: " + friendlyErr(e) };
      }
    },
  },
  {
    // v3 FULL TOOLSET — the AI gets the SAME tool surface in background mode
    // as the in-browser runtime (Settings → Tools). Tools that can run
    // server-side in the sandbox are implemented HERE (native); everything
    // else is bridged back to the browser (see BRIDGE section below).
    name: "current_datetime",
    description: "Get the current UTC date and time in ISO 8601 format. Use this whenever the user asks about 'today', 'now', or any time-relative concept.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      const now = new Date();
      return { utc: now.toISOString(), local: now.toUTCString(), timezone: "UTC" };
    },
  },
  {
    name: "create_chart",
    description: "Create a chart (line / bar / pie / area / scatter) from structured data. The chart is rendered inline in the chat. Pass 'data' as an array of objects, 'x_key' as the field for the x-axis, and 'series' as the list of value fields to plot. Optionally pass 'style' for palette/grid/legend/labels/stacked.",
    parameters: {
      type: "object",
      properties: {
        chart_type: { type: "string", enum: ["line", "bar", "pie", "area", "scatter"] },
        title: { type: "string", description: "Chart title." },
        data: { type: "array", items: { type: "object" }, description: "Array of data records." },
        x_key: { type: "string", description: "Field name in each record to use as the x-axis." },
        series: {
          type: "array",
          items: {
            type: "object",
            properties: { key: { type: "string" }, label: { type: "string" }, color: { type: "string" } },
            required: ["key"],
          },
          description: "Value series to plot.",
        },
        style: {
          type: "object",
          properties: {
            palette: { type: "array", items: { type: "string" } },
            grid: { type: "boolean" },
            legend: { type: "boolean" },
            x_label: { type: "string" },
            y_label: { type: "string" },
            stacked: { type: "boolean" },
          },
        },
      },
      required: ["chart_type", "title", "data", "x_key", "series"],
      additionalProperties: false,
    },
    run: async (args) => {
      const types = ["line", "bar", "pie", "area", "scatter"];
      if (!types.includes(args.chart_type)) return { error: "chart_type must be one of: " + types.join(", ") };
      if (!Array.isArray(args.data) || !args.data.length) return { error: "data must be a non-empty array of records" };
      if (!String(args.x_key ?? "")) return { error: "x_key is required" };
      const series = Array.isArray(args.series) ? args.series : [];
      if (!series.length || series.some((s) => !s || !String(s.key ?? ""))) {
        return { error: "series must be a non-empty list of { key, label?, color? }" };
      }
      return {
        kind: "chart",
        chart_type: args.chart_type,
        title: String(args.title ?? ""),
        data: args.data,
        x_key: String(args.x_key),
        series,
        style: (args.style && typeof args.style === "object" ? args.style : {}),
      };
    },
  },
  {
    name: "delete_folder",
    description: "Delete a folder and its contents from the user's workspace. Refuses to delete the workspace root.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    run: async (args) => {
      const p = safePath(args.path);
      if (!p) return { error: "Invalid path" };
      if (p === HOME) return { error: "Refusing to delete the workspace root" };
      try { await fs.access(p); } catch { return { error: "Folder not found: " + args.path }; }
      await fs.rm(p, { recursive: true, force: true });
      return { deleted: true, path: args.path };
    },
  },
  // MERGE NOTE (tool-count cap): rename_file (same-directory move) was
  // removed as a separate tool — move_file covers it.
  {
    name: "send_file",
    description: "Send a file from the user's workspace to the chat as a downloadable attachment. The user sees a download card with the file's name, size, and extension. The download URL is a base64 data URL (stateless — survives page reloads and Vercel deployments). If the path is a directory, automatically sends it as a ZIP archive.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    run: async (args) => {
      const p = safePath(args.path);
      if (!p) return { error: "Invalid path" };
      let st;
      try { st = await fs.stat(p); } catch { return { error: "not found (no such file or folder): " + args.path }; }
      if (st.isDirectory()) {
        const sendFolder = TOOLS.find((t) => t.name === "send_folder");
        return sendFolder ? sendFolder.run({ path: args.path }) : { error: "send_folder unavailable" };
      }
      const MAX_BYTES = 4 * 1024 * 1024;
      if (st.size > MAX_BYTES) {
        return { error: "File is too large to send as a download (" + humanSizeBg(st.size) + " > " + humanSizeBg(MAX_BYTES) + " limit). Use read_file in chunks instead." };
      }
      const bytes = await fs.readFile(p);
      const name = path.basename(p);
      return {
        kind: "file_download",
        item_type: "file",
        name,
        path: path.relative(HOME, p) || name,
        size: st.size,
        size_human: humanSizeBg(st.size),
        extension: (name.includes(".") ? String(name.split(".").pop()).toLowerCase() : ""),
        download_url: "data:" + mimeForNameBg(name) + ";base64," + bytes.toString("base64"),
      };
    },
  },
  {
    name: "send_folder",
    description: "Send a folder from the user's workspace to the chat as a downloadable ZIP archive. The user sees a download card; clicking it downloads the folder's contents as '<name>.zip'. The ZIP is returned as a base64 data URL (stateless — survives page reloads and Vercel deployments).",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    run: (args) =>
      new Promise((resolve) => {
        const p = safePath(args.path);
        if (!p) return resolve({ error: "Invalid path" });
        const zipTmp = path.join(STATE_DIR, "tmp_send_" + Date.now() + ".zip");
        // Zip with python3 (present in every E2B sandbox) — no zip binary
        // dependency, deterministic, and skips unreadable files safely.
        const py =
          "import sys, zipfile, os\n" +
          "src, dst = sys.argv[1], sys.argv[2]\n" +
          "count = 0\n" +
          "with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as z:\n" +
          "    for root, dirs, files in os.walk(src):\n" +
          "        for f in files:\n" +
          "            fp = os.path.join(root, f)\n" +
          "            z.write(fp, os.path.relpath(fp, src))\n" +
          "            count += 1\n" +
          "print(count)\n";
        const esc = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
        exec("python3 -c " + esc(py) + " " + esc(p) + " " + esc(zipTmp), { cwd: HOME, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, async (err, stdout) => {
          try {
            if (err && err.code !== 0) return resolve({ error: "Failed to zip folder: " + (err.message || String(err)) });
            const fileCount = parseInt(String(stdout ?? "").trim(), 10) || 0;
            if (fileCount === 0) return resolve({ error: "Folder is empty: " + args.path });
            const bytes = await fs.readFile(zipTmp);
            await fs.rm(zipTmp, { force: true }).catch(() => {});
            if (bytes.length > 4 * 1024 * 1024) {
              return resolve({ error: "Folder is too large to zip-and-send (" + humanSizeBg(bytes.length) + " > 4 MB). Use list_folder + read_file on individual files instead." });
            }
            const name = path.basename(p);
            return resolve({
              kind: "file_download",
              item_type: "folder",
              name,
              path: path.relative(HOME, p) || name,
              size: bytes.length,
              size_human: humanSizeBg(bytes.length),
              file_count: fileCount,
              extension: "zip",
              download_url: "data:application/zip;base64," + bytes.toString("base64"),
            });
          } catch (e) {
            resolve({ error: "send_folder failed: " + friendlyErr(e) });
          }
        });
      }),
  },
  {
    name: "verify_path",
    description: "Verify a path exists in the user's workspace, creating directories (and optionally an empty file) as needed. Use this BEFORE create_file_chunk to ensure the parent directory exists. If the path looks like a directory (trailing slash or no file extension), it's treated as a directory; otherwise it's treated as a file (parent dir is created, file is created empty if missing). Returns the existence status, type, and a list of directories that were created.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        create_dirs: { type: "boolean", default: true },
        create_file: { type: "boolean", default: true },
      },
      required: ["path"],
    },
    run: async (args) => {
      const raw = String(args.path ?? "").trim();
      if (!raw) return { error: "path is required" };
      const p = safePath(raw);
      if (!p) return { error: "Invalid path" };
      const createDirs = args.create_dirs !== false;
      const createFile = args.create_file !== false;
      const looksDir = raw.endsWith("/") || !path.basename(p).includes(".");
      const createdDirs = [];
      try {
        const st = await fs.stat(p);
        return { exists: true, type: st.isDirectory() ? "directory" : "file", created_dirs: createdDirs, path: raw };
      } catch {}
      if (looksDir) {
        if (!createDirs) {
          return { exists: false, type: "directory", created_dirs: createdDirs, path: raw, error: "Directory does not exist and create_dirs is false: " + raw };
        }
        await ensureParentDir(p, createdDirs);
        await fs.mkdir(p, { recursive: true });
        createdDirs.push(path.relative(HOME, p) || raw);
        return { exists: true, type: "directory", created_dirs: createdDirs, path: raw };
      }
      await ensureParentDir(p, createdDirs);
      try {
        await fs.access(p);
        return { exists: true, type: "file", created_dirs: createdDirs, path: raw };
      } catch {}
      if (!createFile) {
        return { exists: false, type: "file", created_dirs: createdDirs, path: raw, error: "File does not exist and create_file is false: " + raw };
      }
      await fs.writeFile(p, "");
      return { exists: true, type: "file", created_dirs: createdDirs, path: raw };
    },
  },
  {
    name: "create_file_chunk",
    description: "Append (or create) a chunk of content to a file in the user's workspace. For files >200 lines, call verify_path first, then call this with mode='create' for the first chunk (chunk_index=0) and mode='append' for subsequent chunks. Chunk size should be 2-4 KB (50-200 lines). Splits should occur at function/class/component boundaries — never inside JSON, function bodies, classes, or JSX elements. After writing, the file is read back to verify the write succeeded. Returns the chunk index, total chunks, bytes written, file size, and verification status.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file path to write to." },
        content: { type: "string", description: "The chunk content to write/append." },
        mode: { type: "string", enum: ["create", "append"], default: "append" },
        chunk_index: { type: "number", default: 0, description: "0-based chunk index." },
        total_chunks: { type: "number", description: "Total number of chunks (if known)." },
      },
      required: ["path", "content"],
    },
    run: async (args) => {
      const raw = String(args.path ?? "").trim();
      if (!raw) return { error: "path is required" };
      const p = safePath(raw);
      if (!p) return { error: "Invalid path" };
      const content = String(args.content ?? "");
      const chunkIndex = Number(args.chunk_index ?? 0) || 0;
      const totalChunks = args.total_chunks !== undefined ? Number(args.total_chunks) : undefined;
      const mode = String(args.mode ?? "append");
      const createdDirs = [];
      const bytesWritten = Buffer.byteLength(content, "utf8");
      try {
        await ensureParentDir(p, createdDirs);
        const shouldOverwrite = mode === "create" && chunkIndex === 0;
        if (shouldOverwrite) {
          await fs.writeFile(p, content);
        } else {
          await fs.appendFile(p, content);
        }
        let verified = false;
        let fileSize = 0;
        try {
          const after = await fs.readFile(p, "utf8");
          fileSize = Buffer.byteLength(after, "utf8");
          verified = shouldOverwrite ? after === content : after.endsWith(content);
        } catch {
          verified = false;
        }
        return { path: raw, chunk_index: chunkIndex, total_chunks: totalChunks, bytes_written: bytesWritten, file_size: fileSize, created_dirs: createdDirs, verified };
      } catch (e) {
        return { error: "Failed to write chunk to " + raw + ": " + friendlyErr(e), path: raw, chunk_index: chunkIndex, total_chunks: totalChunks, bytes_written: 0, verified: false };
      }
    },
  },
  {
    name: "read_file_section",
    description: "Read a specific section of a file (by line range, 0-based). Use this to verify previously written chunks before appending the next one, or to resume an interrupted write. Returns the section content, the actual start/end line indices, the total line count, and whether more content exists after the requested section.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        start_line: { type: "number", default: 0 },
        end_line: { type: "number" },
      },
      required: ["path", "start_line"],
    },
    run: async (args) => {
      const p = safePath(args.path);
      if (!p) return { error: "Invalid path" };
      try {
        const content = await fs.readFile(p, "utf8");
        const lines = content.split("\n");
        const totalLines = lines.length;
        const MAX_LINES = 150;
        const requested = Math.max(0, Math.floor(Number(args.start_line ?? 0) || 0));
        const clampedStart = Math.min(requested, Math.max(0, totalLines - 1));
        const endRaw = args.end_line !== undefined ? Math.floor(Number(args.end_line)) : undefined;
        let clampedEnd =
          endRaw !== undefined && !Number.isNaN(endRaw)
            ? Math.max(clampedStart, Math.min(endRaw, clampedStart + MAX_LINES - 1))
            : clampedStart + MAX_LINES - 1;
        clampedEnd = Math.min(clampedEnd, totalLines - 1);
        const slice = lines.slice(clampedStart, clampedEnd + 1).join("\n");
        return { content: slice, start_line: clampedStart, end_line: clampedEnd, total_lines: totalLines, has_more: clampedEnd < totalLines - 1 };
      } catch (e) {
        return { error: "Failed to read section: " + friendlyErr(e) };
      }
    },
  },
  {
    name: "search_documents",
    description: "Search the user's workspace for documents containing the given query string. Returns matching snippets with surrounding context. Use this whenever the user asks about content of files they've uploaded or created in the workspace. Cite sources inline as [1], [2], etc.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (substring match, case-insensitive)." },
        limit: { type: "number", description: "Maximum number of snippets to return." },
      },
      required: ["query"],
    },
    run: async (args) => {
      const query = String(args.query ?? "").trim();
      if (!query) return { results: [], note: "Empty query" };
      const limit = Math.min(Number(args.limit) || 20, 50);
      const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".js", ".jsx", ".ts", ".tsx", ".py", ".html", ".htm", ".css", ".scss", ".xml", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".sh", ".bash", ".sql", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp", ".rb", ".php", ".log", ".env"]);
      const CONTEXT_CHARS = 120;
      const PER_FILE = 5;
      const MAX_FILE_BYTES = 512 * 1024;
      const allHits = [];
      const walk = async (dir) => {
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (allHits.length >= limit) return;
          if (e.name.startsWith(".")) continue; // skip .onyx + dotfiles
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            await walk(full);
            continue;
          }
          if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
          let st;
          try { st = await fs.stat(full); } catch { continue; }
          if (st.size > MAX_FILE_BYTES) continue;
          let content;
          try { content = await fs.readFile(full, "utf8"); } catch { continue; }
          const lower = content.toLowerCase();
          const qLower = query.toLowerCase();
          let idx = 0;
          let found = 0;
          while (found < PER_FILE && allHits.length < limit) {
            const pos = lower.indexOf(qLower, idx);
            if (pos === -1) break;
            const start = Math.max(0, pos - CONTEXT_CHARS);
            const end = Math.min(content.length, pos + query.length + CONTEXT_CHARS);
            const snippet =
              (start > 0 ? "… " : "") +
              content.slice(start, end).replace(/\s+/g, " ").trim() +
              (end < content.length ? " …" : "");
            allHits.push({ index: allHits.length + 1, source: path.relative(HOME, full), content: snippet, score: "1.0" });
            idx = pos + query.length;
            found += 1;
          }
        }
      };
      await walk(HOME);
      return { results: allHits };
    },
  },
  {
    name: "image_search",
    description: "Search for images using Miklium (Yahoo-based). Returns image URLs, thumbnails, dimensions, and source pages. Use when the user wants to find pictures, photos, diagrams, or visual content.",
    parameters: { type: "object", properties: { query: { type: "string", description: "Image search query" }, limit: { type: "number", description: "Max results (default 10, max 50)" } }, required: ["query"], additionalProperties: false },
    run: async (args) => mikliumSearch(args, "images", "image"),
  },
  {
    name: "video_search",
    description: "Search for videos using Miklium (Yahoo-based). Returns video titles, URLs, thumbnails, durations, and channel info. Use when the user wants to find videos, tutorials, or multimedia content.",
    parameters: { type: "object", properties: { query: { type: "string", description: "Video search query" }, limit: { type: "number", description: "Max results (default 10, max 50)" } }, required: ["query"], additionalProperties: false },
    run: async (args) => mikliumSearch(args, "videos", "video"),
  },
  {
    name: "preview_image",
    description: "Display an image inline in the chat. Use this to show the user a visual — a generated image, a screenshot, a diagram URL, a chart from an external service, etc. Accepts: - url: An HTTP/HTTPS URL to an image (e.g. \"https://example.com/chart.png\") — or a workspace path (same as path) - base64: A base64-encoded image with data URI prefix (e.g. \"data:image/png;base64,iVBOR...\") - path: A workspace/sandbox image path (e.g. \"projects/my-app/public/logo.png\", \".onyx/browser/shots/shot-2.png\", \"uploads/photo.jpg\") - alt: Optional alt text / caption shown below the image The image renders inline in the chat, just like a chart. The user sees it immediately without needing to click anything.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTP/HTTPS URL of the image to display — or a workspace/sandbox path." },
        base64: { type: "string", description: "Base64 data URI of the image (e.g. 'data:image/png;base64,iVBOR...'). Use this when you have the raw image data." },
        path: { type: "string", description: "Workspace image to display: a sandbox path (e.g. 'uploads/photo.jpg', '.onyx/browser/shots/shot-2.png')." },
        alt: { type: "string", description: "Optional caption / alt text shown below the image." },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const alt = String(args.alt || "");
      const base64 = String(args.base64 || "").trim();
      const urlArg = String(args.url || "").trim();
      const pathArg = String(args.path || "").trim();
      if (base64) {
        const url = base64.startsWith("data:")
          ? base64
          : "data:image/png;base64," + base64.replace(/\s+/g, "");
        return { kind: "image_preview", url, alt };
      }
      const httpish = (s) => /^https?:\/\//i.test(s) || s.startsWith("data:image/");
      if (urlArg && httpish(urlArg)) {
        return { kind: "image_preview", url: urlArg, alt };
      }
      // Workspace path — explicit "path", OR a "url" that isn't http(s)/data:
      // (models frequently put workspace paths in "url"; that used to
      // hard-fail with "URL must start with http://, https://, or data:image/").
      const candidate = pathArg || urlArg;
      if (!candidate) return { error: "Either 'url', 'base64', or 'path' must be provided." };
      const abs = safePath(candidate);
      if (!abs) return { error: "Invalid path: " + candidate };
      try {
        const buf = await fs.readFile(abs);
        if (buf.length > 12 * 1024 * 1024) {
          return { error: "Image too large to preview (>12 MB): " + candidate };
        }
        const mime = sniffImageMime(buf);
        if (!mime) return { error: "Not a recognized image (PNG/JPEG/GIF/WebP/BMP): " + candidate };
        return {
          kind: "image_preview",
          url: "data:" + mime + ";base64," + buf.toString("base64"),
          alt: alt || candidate,
        };
      } catch (e) {
        return { error: "Failed to read image '" + candidate + "': " + friendlyErr(e) };
      }
    },
  },
  {
    // MERGE NOTE (tool-count cap): ocr_image + ocr_pdf merged into ONE
    // ocr_document tool — the document kind is inferred from the source
    // (data-URI mime or URL suffix). Result shapes preserved.
    name: "ocr_document",
    description: "Extract text from an image OR a PDF using OCR (Optical Character Recognition). Use this when the user wants to read text from a screenshot, photo, scanned document, any image containing text, or a PDF without selectable text. Supports PNG, JPEG, GIF, WebP, BMP, and PDF. Provide the source as a URL or a base64 data URI — the document kind is detected automatically. For large PDFs, only the first few pages are processed.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL of the image or PDF to OCR" },
        base64: { type: "string", description: "Base64 data URI of the document (e.g. 'data:image/png;base64,...' or 'data:application/pdf;base64,...')" },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const url = args.url ? String(args.url) : "";
      const base64 = args.base64 ? String(args.base64) : "";
      if (!url && !base64) {
        return { success: false, output: null, error: "Either 'url' or 'base64' must be provided." };
      }
      const isPdf =
        (base64 && base64.startsWith("data:application/pdf")) ||
        (url && /\.pdf(\?|$)/i.test(url));
      try {
        const text = await ocrFetch(url, base64, isPdf ? "document.pdf" : "image");
        if (!text || !text.trim()) {
          return {
            success: true,
            output: {
              text: "",
              message: isPdf ? "No text was detected in the PDF." : "No text was detected in the image.",
            },
          };
        }
        return { success: true, output: { text, char_count: text.length } };
      } catch (e) {
        return { success: false, output: null, error: e && e.message ? e.message : String(e) };
      }
    },
  },
  {
    name: "counterfactual",
    description: "Explore a counterfactual ('what if?') scenario. Use this when the user asks 'what if X had been different?' or wants to explore alternative outcomes. Produces a structured analysis with observed facts, hypothetical change, alternative branches, and a recommendation.",
    parameters: {
      type: "object",
      properties: {
        observed: { type: "string", description: "The observed facts / what actually happened" },
        hypothetical: { type: "string", description: "The hypothetical change ('what if X')" },
        branches: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, outcome: { type: "string" }, reasoning: { type: "string" } },
            required: ["name", "outcome"],
          },
          description: "Alternative outcome branches to explore",
        },
        recommendation: { type: "string", description: "Overall synthesis / recommendation based on the analysis" },
      },
      required: ["observed", "hypothetical", "branches", "recommendation"],
    },
    run: async (args) => {
      const branches = Array.isArray(args.branches) ? args.branches : [];
      return {
        kind: "counterfactual",
        observed: args.observed,
        hypothetical: args.hypothetical,
        branches: branches.map((b, i) => ({ ...(b && typeof b === "object" ? b : {}), index: i + 1 })),
        recommendation: args.recommendation || "",
        summary: "Explored " + branches.length + " alternative outcome(s) for: " + args.hypothetical,
      };
    },
  },
  // ── Browser — NATIVE in the sandbox (use_browser) ───────────────
  // The ONE AI-facing browser tool (CloakBrowser PRD): a persistent,
  // multi-tab browser session (cookies/localStorage kept in the profile
  // under ~/.onyx/browser) driven through the file-protocol Python driver
  // (browser-driver.ts — the source is injected verbatim). Native here
  // means the sandbox owns the whole browser lifecycle, so background
  // turns keep browsing when the user's tab is closed.
  {
    name: "use_browser",
    description: "Browse and interact with websites in a real browser running INSIDE the sandbox — one persistent session (cookies/localStorage kept), multiple tabs, screenshots, page snapshots, screen recording, page inspection, forms, uploads and downloads. Pass action plus only the fields that action needs: navigate (url), click (target), type (target, text, submit?), press (key), scroll (direction?, amount?), wait (ms?/selector?/text?), read (), snapshot (filter?, limit?), screenshot (fullPage?), screen_record (operation: 'start'|'stop'|'status'), inspect (filter?, limit?), evaluate (code), select (target, value), upload (target, files), download (url?/target?), new_tab (url?), switch_tab (tab), close_tab (tab?), back / forward / reload. TARGETING: a target is a selector string ('#id', 'button.primary', 'text=Sign in', 'xpath=//a[3]', 'ref=e12') OR an object ({'role':'button','name':'Sign in'}, {'text':…}, {'label':…}, {'placeholder':…}, {'css':…}, {'xpath':…}, {'ref':'e12'}). The session persists across calls. First use in a fresh sandbox installs the browser runtime (can take a couple of minutes).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "navigate", "click", "type", "press", "scroll", "wait", "read",
            "snapshot", "screenshot", "screen_record", "inspect", "evaluate",
            "back", "forward", "reload",
            "get_page", "get_elements", "select", "upload", "download",
            "new_tab", "switch_tab", "close_tab", "go_back", "go_forward", "refresh",
          ],
          description: "The browser operation to perform.",
        },
        operation: { type: "string", enum: ["start", "stop", "status"], description: "Sub-operation for screen_record: 'start' begins recording, 'stop' finishes and returns the video file, 'status' reports the state." },
        url: { type: "string", description: "URL to open (navigate / new_tab / download)." },
        target: { description: "Element to act on: a selector string or a semantic object ({role,name} / {text} / {label} / {placeholder} / {css} / {xpath} / {ref})." },
        text: { type: "string", description: "Text to type (type action)." },
        submit: { type: "boolean", description: "Press Enter after typing (type action)." },
        clear: { type: "boolean", description: "Clear the field before typing (default true)." },
        key: { type: "string", description: "Key to press (press action), e.g. 'Enter'." },
        code: { type: "string", description: "JavaScript to evaluate in the page (evaluate action)." },
        direction: { type: "string", enum: ["down", "up", "left", "right"], description: "Scroll direction (default down)." },
        amount: { type: "number", description: "Scroll distance in px (default 600)." },
        ms: { type: "number", description: "Milliseconds to wait (wait action, default 1000)." },
        selector: { type: "string", description: "Selector to wait for (wait action)." },
        fullPage: { type: "boolean", description: "Capture the full page (screenshot action)." },
        filter: { type: "string", description: "Substring filter for snapshot / inspect / get_elements." },
        limit: { type: "number", description: "Max elements for snapshot / inspect / get_elements (default 60-80)." },
        value: { type: "string", description: "Option value to select (select action)." },
        files: { type: "array", items: { type: "string" }, description: "Workspace file paths to upload (upload action)." },
        tab: { description: "Tab index (number) or tab id like 'tab_2' (switch_tab / close_tab)." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    run: async (args) => {
      const action = String(args.action ?? "");
      const booted = await ensureWsDriver();
      if (!booted.ok) {
        return { kind: "browser", success: false, action, error: { type: "browser_startup_failed", message: booted.error, recoverable: true } };
      }
      const cmd = { action };
      for (const k of ["operation", "url", "target", "text", "submit", "clear", "key", "code", "direction", "amount", "ms", "selector", "fullPage", "filter", "limit", "value", "files", "tab"]) {
        if (args[k] !== undefined) cmd[k] = args[k];
      }
      // First browser boot (binary download) can be slow — generous ceiling.
      // Screenshots / recording assembly can take longer still.
      const timeoutMs = (action === "screen_record" || action === "screenshot" || action === "snapshot") ? 8 * 60_000 : 6 * 60_000;
      const result = await wsSendCommand(cmd, timeoutMs);
      if (result && result.ok === false && typeof result.error === "string") {
        // Old-driver shape — normalize into the structured error envelope.
        return { kind: "browser", success: false, action, error: { type: "browser_error", message: result.error, recoverable: true } };
      }
      return { kind: "browser", action, ...result };
    },
  },
];

// Tools documented in the TOOL DIGEST (generated from Onyx.md — parity
// is test-enforced against the browser registry). Used to slim the
// in-prompt tool list: digest-documented tools are listed by NAME only,
// dynamic tools (MCP / custom, bridged from the browser) keep a blurb.
const DIGEST_TOOLS = new Set(${JSON.stringify(ONYX_MD_DIGEST_TOOLS)});

// MERGE NOTE (tool-count cap): the manage_todos alias push was removed —
// the in-browser registry no longer registers manage_todos (it was an exact
// duplicate of manage_todo), so the background surface must not either.

// ── Browser-tool bridge (v3 FULL TOOLSET) ──────────────────────────────
// Tools whose implementations live in the BROWSER (Dexie/OPFS stores: chats,
// memories, skills, MCP configs, custom tools, subagents, ask_user …) are
// executed there: the runner drops a request file + emits a
// browser_tool_call event; the connected browser runs the REAL registry
// handler and writes the result back through /api/sandbox write_file. The
// runner polls the result file (350 ms) until the per-tool timeout. When no
// browser is connected the tool fails gracefully with an actionable error
// and the turn continues with the sandbox-native tools.
const BRIDGE_DIR = path.join(STATE_DIR, "bridge");
const BRIDGE_DEFAULT_TIMEOUT_MS = 240_000;
const BRIDGE_TIMEOUT_MS = { ask_user: 900_000 };
// ACK FAST-FAIL (240s timeout fix): the browser writes an .ack.json file the
// moment it PICKS UP the request (before executing the tool). If no ack
// arrives within this window, no app tab is consuming the run's events
// (closed / asleep / backgrounded) — fail NOW with the actionable message
// instead of burning the full per-tool timeout. 25s: generous enough for one
// reconnect backoff wake in a hidden tab (timers throttle to ≥1min there),
// instant compared to 240s.
const BRIDGE_ACK_WINDOW_MS = 25_000;

let ALL_TOOLS = TOOLS;

// MODE ISOLATION: sandbox-native tools that never reach the background
// agent's LLM surface — the coding write path + E2B execution. Files stay
// shared: read_file, list_folder, delete_file, create_folder, move_file,
// send_file, send_folder, search_documents all remain.
const NATIVE_CODE_ONLY_TOOLS = new Set([
  "write_file",
  "create_file",
  "edit_file",
  "verify_path",
  "create_file_chunk",
  "read_file_section",
  "run_terminal",
  "run_python",
  // NOTE: use_browser is intentionally NOT here. It is a native sandbox
  // tool (the Python driver + file protocol are entirely sandbox-side), so
  // it WORKS in background turns — filtering it out made the model truthfully
  // tell users "I don't have access to the use_browser tool this turn".
  // BG_NATIVE_TOOL_NAMES already prevents it from being bridged back to the
  // (closed) browser — the native implementation is the one that must stay.
]);

async function runBridgeTool(callId, name, args) {
  const token = String(callId || name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "call";
  const reqPath = path.join(BRIDGE_DIR, token + ".req.json");
  const resPath = path.join(BRIDGE_DIR, token + ".res.json");
  const ackPath = path.join(BRIDGE_DIR, token + ".ack.json");
  await fs.mkdir(BRIDGE_DIR, { recursive: true });
  await fs.rm(resPath, { force: true }).catch(() => {});
  await fs.rm(ackPath, { force: true }).catch(() => {});
  await fs.writeFile(reqPath, JSON.stringify({ id: callId, name, args }));
  await emitEvent({ t: "browser_tool_call", id: callId, name, args });
  const timeoutMs = BRIDGE_TIMEOUT_MS[name] ?? BRIDGE_DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const ackDeadline = Date.now() + BRIDGE_ACK_WINDOW_MS;
  let acked = false;
  for (;;) {
    // ACK PHASE — the browser picked the call up (it writes .ack.json the
    // moment it receives the event, before running the tool). Until acked,
    // we are in the fast-fail window: if it expires, no app tab is open.
    if (!acked) {
      try {
        await fs.readFile(ackPath, "utf8");
        acked = true;
      } catch {
        if (Date.now() >= ackDeadline) {
          await fs.rm(reqPath, { force: true }).catch(() => {});
          return {
            error:
              "The '" + name + "' tool runs in your BROWSER — no open app tab picked the request up within " +
              Math.round(BRIDGE_ACK_WINDOW_MS / 1000) + "s (the tab was closed, asleep or backgrounded). Browser-side tools (chats, memories, skills, MCP configs, subagents, ask_user) need this app tab open. Continue with the sandbox tools or finish without it, and tell the user to re-run with the app tab open if that tool is essential.",
          };
        }
      }
    }
    if (Date.now() >= deadline) {
      await fs.rm(reqPath, { force: true }).catch(() => {});
      return {
        error:
          "The '" + name + "' tool ran in your BROWSER but did not finish within " + Math.round(timeoutMs / 1000) +
          "s (the app tab may have closed mid-run). Continue with the sandbox tools or finish without it, and tell the user to re-run with the app tab open if that tool is essential.",
      };
    }
    try {
      const raw = await fs.readFile(resPath, "utf8");
      const parsed = JSON.parse(raw);
      await fs.rm(reqPath, { force: true }).catch(() => {});
      await fs.rm(resPath, { force: true }).catch(() => {});
      await fs.rm(ackPath, { force: true }).catch(() => {});
      if (parsed && parsed.ok === false) return { error: String(parsed.error ?? "browser tool failed") };
      if (parsed && parsed.result !== undefined) return parsed.result;
      return { error: "browser tool returned no result" };
    } catch {
      // not there yet — keep polling
    }
    await sleep(350);
  }
}

// ── The agent loop ──────────────────────────────────────────────────────
async function resolveRun() {
  const arg = process.argv[2];
  if (arg) {
    const runDir = path.join(RUNS_DIR, arg);
    await fs.mkdir(runDir, { recursive: true });
    return runDir;
  }
  try {
    const p = JSON.parse(await fs.readFile(LEGACY_POINTER, "utf8"));
    const id = p.activeRun ?? (Array.isArray(p.runs) && p.runs.length ? p.runs[p.runs.length - 1] : null);
    if (id) {
      const runDir = path.join(RUNS_DIR, String(id));
      await fs.mkdir(runDir, { recursive: true });
      return runDir;
    }
  } catch {}
  return null;
}

async function main() {
  const runDir = await resolveRun();
  if (!runDir) {
    console.error("bg-agent: no run to execute or resume");
    process.exit(1);
  }
  STATE_FILE = path.join(runDir, "state.json");
  EVENTS_FILE = path.join(runDir, "events.jsonl");

  const state = await readState();
  // A run with no provider config cannot stream anything — a readable,
  // actionable terminal (never a raw TypeError) per PRD TR-2.
  if (!state || !state.provider || !state.provider.baseUrl) {
    const msg = "Run state is missing its provider configuration (state.json was lost or never written). Restarting the turn will fix it.";
    await emitEvent({ t: "error", message: msg });
    await setTerminal("error", msg);
    return;
  }
  // seq continuity — a crash-relaunch must not reuse seq numbers.
  try {
    const raw = await fs.readFile(EVENTS_FILE, "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const ev = JSON.parse(t);
        if (typeof ev.seq === "number" && ev.seq > SEQ) SEQ = ev.seq;
      } catch {}
    }
  } catch {}

  state.status = "running";
  // TODO SEED (PRD FR-1): when the sandbox was recreated (fresh filesystem),
  // the client's seedTodos (the live store snapshot at launch) restores the
  // conversation's plan. The sandbox's OWN todos.json always wins once it
  // exists — a stale client snapshot never clobbers sandbox state.
  if (Array.isArray(state.seedTodos)) {
    let exists = true;
    try { await fs.access(TODOS_FILE); } catch { exists = false; }
    if (!exists) {
      await saveSharedTodos(state.seedTodos);
      if (state.seedTodos.length > 0) {
        await emitTodoEvent(state.seedTodos);
      }
    }
    delete state.seedTodos;
  }
  await writeState(state);
  await emitEvent({ t: "status", kind: "boot" });

  // FULL TOOLSET (v3): native sandbox tools + the browser registry snapshot
  // the client seeds into state.browserTools. Bridged tools execute in the
  // user's browser over the event channel — the AI sees the SAME tool
  // surface as the in-browser runtime (Settings → Tools).
  if (Array.isArray(state.browserTools)) {
    const nativeNames = new Set(TOOLS.map((t) => t.name));
    const bridged = [];
    for (const bt of state.browserTools) {
      if (!bt || typeof bt.name !== "string" || !bt.name || nativeNames.has(bt.name)) continue;
      if (bridged.some((t) => t.name === bt.name)) continue;
      bridged.push({
        name: bt.name,
        description: String(bt.description ?? ""),
        parameters: bt.parameters && typeof bt.parameters === "object" ? bt.parameters : { type: "object", properties: {} },
        bridge: true,
      });
    }
    if (bridged.length) ALL_TOOLS = TOOLS.concat(bridged);
  }
  // MODE ISOLATION: a background agent turn never sees the sandbox-native
  // CODING tools — file authoring (write_file, create_file, edit_file, the
  // chunked writer trio) and E2B execution (run_terminal, run_python) —
  // exactly like filterToolsForRequest in the foreground runtime. Files
  // stay shared: reading, listing, deleting, sending and searching remain
  // available. (state.browserTools is already filtered client-side by
  // collectBridgeableTools.)
  ALL_TOOLS = ALL_TOOLS.filter((t) => !NATIVE_CODE_ONLY_TOOLS.has(t.name));
  // Tool-list text (the SAME discipline the in-browser runtime uses) so the
  // model knows its exact surface — prevents hallucinated tool names.
  // When the system prompt already carries the TOOL DIGEST (injected
  // upstream: interactive turns via background-agent.ts, scheduled runs via
  // the scheduler engine), append ONLY the live names — the digest already
  // documents every built-in's capability, so duplicating descriptions here
  // would just bloat the prompt (small providers reject fat prompts).
  if (state.messages.length && state.messages[0] && state.messages[0].role === "system") {
    const sysMsg = state.messages[0];
    const content = String(sysMsg.content ?? "");
    if (!content.includes("## Available Tools (")) {
      let toolListText;
      if (content.includes("## TOOL DIGEST")) {
        const documented = ALL_TOOLS.filter((t) => DIGEST_TOOLS.has(t.name));
        const dynamic = ALL_TOOLS.filter((t) => !DIGEST_TOOLS.has(t.name));
        toolListText =
          "\n\n## Available Tools (" + ALL_TOOLS.length + " total — LIVE registry for THIS turn)\n" +
          documented.map((t) => t.name).join(", ") +
          (dynamic.length
            ? "\n\nDynamic tools (" + dynamic.length + " — active this turn, not in the digest):\n" +
              dynamic
                .map((t) => {
                  const d = String(t.description ?? "").replace(/\s+/g, " ").trim();
                  return "- **" + t.name + "** — " + (d.length > 140 ? d.slice(0, 140) + "…" : d);
                })
                .join("\n")
            : "") +
          "\n\nThis list + your tool definitions are the ONLY source of truth for what you can call this turn — not your memory, not Onyx.md alone. Every tool named here is real and callable: never claim you lack one. Tools not named here are NOT available this turn — say so honestly instead of calling them.";
      } else {
        toolListText =
          "\n\n## Available Tools (" + ALL_TOOLS.length + " total)\nYou have access to these tools. Use them by calling them through the FUNCTION-CALLING API (the tool_calls mechanism). NEVER write tool calls as plain text (e.g. \"Thought: ... Action: run_terminal Input: {...}\"). ALWAYS use the function-calling mechanism to invoke tools.\n\nUse them by name when the user's request matches:\n" +
          ALL_TOOLS.map((t) => "- **" + t.name + "** — " + t.description).join("\n") +
          "\n\nIMPORTANT: These are the ONLY tools available. Do not mention or use any tool that is not in this list.";
      }
      sysMsg.content = content + toolListText;
    }
  }
  // Fresh run → clear stale bridge requests from earlier runs.
  try {
    await fs.rm(BRIDGE_DIR, { recursive: true, force: true });
    await fs.mkdir(BRIDGE_DIR, { recursive: true });
  } catch {}

  // MAX-ROUNDS (PRD TR-3): the cap is higher (30) and, crucially, the LAST
  // round is a WRAP-UP round — a system note tells the model to answer now
  // and tools are withheld from the request, so hitting the cap ends the
  // turn with a real answer instead of the old terminal
  // "Background run hit the max-rounds cap" error.
  const maxRounds = state.maxRounds ?? 30;
  // EMPTY-RESPONSE RE-ASKS: some gateways occasionally answer a round with
  // NOTHING (no text, no reasoning, no tool calls) — a transient completion
  // glitch, not a fatal condition. Instead of failing the whole turn with
  // "The model returned an empty response.", re-ask the SAME round (a
  // system nudge + fresh request) up to twice. Only a third empty answer
  // ends the turn as an error.
  let emptyRetries = 0;
  // UNEXPECTED RUNNER EXCEPTIONS (PRD §15): a code-level crash inside a
  // round is treated as transient FIRST — rewind + retry with backoff
  // before a task is ever declared failed. The task's lifetime is owned by
  // the run, not by a single crashed attempt.
  let roundCrashRetries = 0;
  for (let round = 1; round <= maxRounds; round++) {
    const isFinalRound = round === maxRounds;
    if (isFinalRound && state.toolsEnabled !== false) {
      state.messages.push({
        role: "system",
        content: "You have used your last available tool round. Provide your final answer to the user now. Do not request any more tools.",
      });
    }
    await emitEvent({ t: "round_start", round });
    let result;
    try {
      result = await streamRoundEvents(state, round, isFinalRound);
    } catch (e) {
      if (roundCrashRetries < 5) {
        roundCrashRetries += 1;
        const msg = String(e && e.message ? e.message : e);
        await emitEvent({ t: "round_retry", round });
        await emitEvent({ t: "status", kind: "retry", round, attempt: roundCrashRetries, delayMs: Math.min(2000 * roundCrashRetries, 15_000), reason: "runner exception: " + msg });
        await sleep(Math.min(2000 * roundCrashRetries, 15_000));
        round--; // replay this round number
        continue;
      }
      const msg = String(e && e.message ? e.message : e);
      await emitEvent({ t: "error", message: msg });
      await setTerminal("error", msg);
      return;
    }
    if (result.error) {
      await emitEvent({ t: "error", message: result.error });
      await setTerminal("error", result.error);
      return;
    }
    const toolCalls = (result.toolCalls ?? []).filter((tc) => tc && tc.function && tc.function.name);
    if (!toolCalls.length || isFinalRound) {
      const content = result.content.trim() || (isFinalRound
        ? "I reached the tool-call limit after completing the work steps — here is where things stand. Ask me to continue and I'll pick up from the plan."
        : "");
      if (!content && !result.reasoning.trim()) {
        // EMPTY RESPONSE — re-ask this round before declaring failure.
        if (emptyRetries < 2) {
          emptyRetries++;
          await emitEvent({ t: "status", kind: "retry", round, attempt: emptyRetries, delayMs: 800, reason: "empty response — re-asking the model" });
          state.messages.push({
            role: "system",
            content: "Your previous response came back completely empty (no text, no tool calls). Respond now — either call one of your tools or write your answer to the user. Never return an empty message.",
          });
          round--; // replay this round number
          continue;
        }
        await emitEvent({ t: "error", message: "The model returned an empty response." });
        await setTerminal("error", "The model returned an empty response.");
        return;
      }
      await emitEvent({ t: "done", content });
      await setTerminal("done", content);
      return;
    }
    emptyRetries = 0; // a productive round resets the empty streak
    // ONE assistant message carrying content + tool_calls (protocol shape).
    // STRICT-COMPAT (LLM HTTP 400 fix): the wire format keeps ONLY fields
    // every OpenAI-compatible endpoint accepts. The local 'reasoning' field
    // rides along in state.messages but is STRIPPED by buildRequestMessages
    // unless self-healing detected a DeepSeek-style provider that demands
    // reasoning_content replay (see the 400 handler in streamRoundEvents).
    // 'content' is a STRING ("" when the model only called tools) — null
    // is spec-legal but some strict gateways type it as str.
    // 'arguments' was normalized in finishStream() — ALWAYS valid JSON
    // (repaired copy / "{}"), never the raw truncated stream text.
    state.messages.push({
      role: "assistant",
      content: result.content || "",
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.function.name, arguments: wireSafeArgs(tc.function.arguments) } })),
    });
    // IDEMPOTENT EXECUTION (PRD §5): every toolCallId runs exactly once per
    // run — retries/resumes/replays can never double-execute side effects.
    // The executed-id list lives on state (persisted per round by writeState)
    // so a crash-resume of this run can never re-execute a finished call.
    if (!Array.isArray(state._executedToolCallIds)) state._executedToolCallIds = [];
    for (const tc of toolCalls) {
      const fn = tc.function ?? {};
      const args = tc._args ?? {};
      const id = tc.id ?? "bg-" + Math.random().toString(36).slice(2, 10);
      await emitEvent({ t: "tool_call", round, id, name: fn.name ?? "unknown", args });
      // MALFORMED ARGS: never execute — resolve to a structured
      // MALFORMED_TOOL_ARGUMENTS tool result through the normal tool-result
      // protocol so the model can re-issue the call. A tool failure is NOT
      // a provider failure: it never triggers the provider retry ladder.
      if (tc._malformed) {
        const toolResult = malformedArgsResult(tc._rawArgs ?? "");
        const resultStr = cap(JSON.stringify(toolResult), 64 * 1024);
        await emitEvent({ t: "tool_result", round, id, name: fn.name ?? "unknown", result: resultStr });
        state.messages.push({ role: "tool", tool_call_id: id, content: resultStr });
        continue;
      }
      if (state._executedToolCallIds.includes(id)) continue; // duplicate — already ran
      state._executedToolCallIds.push(id);
      const tool = ALL_TOOLS.find((x) => x.name === fn.name);
      let toolResult;
      try {
        toolResult = tool
          ? tool.bridge
            ? await runBridgeTool(id, fn.name, args)
            : await tool.run(args)
          : { error: "Unknown tool in background mode: " + fn.name };
      } catch (e) { toolResult = { error: "Tool failed: " + friendlyErr(e) }; }
      // Large-payload results (base64 downloads / image previews) get a
      // bigger cap so their cards stay intact; everything else stays at
      // 64 KB like before.
      const isLarge =
        toolResult && typeof toolResult === "object" &&
        (toolResult.kind === "file_download" || toolResult.kind === "image_preview" || toolResult.download_url);
      const resultStr = cap(JSON.stringify(toolResult), isLarge ? 6 * 1024 * 1024 : 64 * 1024);
      await emitEvent({ t: "tool_result", round, id, name: fn.name ?? "unknown", result: resultStr });
      state.messages.push({ role: "tool", tool_call_id: id, content: resultStr });
    }
    await writeState(state); // persist the conversation per round
  }
  // Unreachable in the normal path (the final round always ends via done),
  // kept as a defensive terminal so the run can never hang open.
  await emitEvent({ t: "done", content: "" });
  await setTerminal("done", "");
}

main().catch(async (e) => {
  try { await emitEvent({ t: "error", message: String(e?.message ?? e) }); } catch {}
  try { await setTerminal("error", String(e?.message ?? e)); } catch {}
  process.exit(1);
});

`;

/** Where the runner script + state live inside the sandbox. */
export const BG_STATE_PATH = "/home/user/.onyx/bg-state.json";
export const BG_SCRIPT_PATH = "/home/user/.onyx/bg-agent.mjs";
/** Per-run directory prefix (state.json + events.jsonl inside). */
export const BG_RUNS_PREFIX = "/home/user/.onyx/runs/";

export { BG_NATIVE_TOOL_NAMES } from "./bg-native-tools";
