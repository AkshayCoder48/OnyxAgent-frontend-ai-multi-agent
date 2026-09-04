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

export const BG_AGENT_SCRIPT = String.raw`
// OnyxAgent background runner v2 — STREAMING. Executes INSIDE the E2B sandbox.
// Started as: node bg-agent.mjs <runId>
import fs from "node:fs/promises";
import { exec } from "node:child_process";
import path from "node:path";

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
 *  markup. Also adds the base-URL hint for 404s (root-vs-API confusion). */
const cleanDetail = (s, status) => {
  let t = String(s ?? "");
  if (/^\s*(<!DOCTYPE|<html)/i.test(t)) t = "(HTML error page)";
  t = t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  t = cap(t, 300);
  if (status === 404 && !t) {
    t = "endpoint not found — check the provider Base URL (the app calls {base}/chat/completions)";
  }
  return t;
};

const safePath = (p) => {
  if (typeof p !== "string" || !p.trim()) return null;
  const cleaned = p.trim().replace(/^\/+/, "");
  const abs = path.resolve(HOME, cleaned);
  if (!abs.startsWith(HOME)) return null;
  return abs;
};

async function readState() {
  const raw = await fs.readFile(STATE_FILE, "utf8");
  return JSON.parse(raw);
}

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
  if (!name || !TOOLS.some((x) => x.name === name)) return null;
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
 *  comments, and malformed frames (skipped, never fatal). */
function parseSSEFrames(buffer) {
  const events = [];
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
    if (!payload || payload === "[DONE]") continue;
    try { events.push(JSON.parse(payload)); } catch { /* malformed frame */ }
  }
  return { events, rest };
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

// ── The streaming LLM call ──────────────────────────────────────────────
const MAX_ATTEMPTS = 4;
const IDLE_TIMEOUT_MS = 240_000;

/**
 * Streams ONE round. Emits live events (status:first_token, reasoning_delta,
 * text_delta, tool_call_delta, pre-emitted tool_call, status:llm_end) and
 * returns the normalized round result: { content, reasoning, toolCalls, error }.
 * toolCalls elements: { id, type, function: {name, arguments}, _args }.
 */
async function streamRoundEvents(state, round) {
  const p = state.provider;
  let url = String(p.baseUrl ?? "").replace(/\/+$/, "");
  if (!p.noPrefix && !url.endsWith("/chat/completions")) url += "/chat/completions";
  const body = {
    model: p.model,
    messages: state.messages,
    temperature: p.temperature ?? 0.7,
    stream: true,
  };
  if (state.toolsEnabled !== false) body.tools = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

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
    // Finalize accumulated tool calls (parse args JSON).
    const calls = [];
    for (const [idx, tc] of toolAcc) {
      let args = {};
      try { args = JSON.parse(tc.args || "{}"); } catch { args = { _raw: tc.args }; }
      calls.push({ id: tc.id || "bg_" + round + "_" + idx, type: "function", function: { name: tc.name || "unknown", arguments: tc.args || "{}" }, _args: args });
    }
    // Post-stream normalize: fence/DSML tool calls embedded in content.
    const norm = normalizeMessage({ content, tool_calls: calls });
    const normCalls = Array.isArray(norm.tool_calls) ? norm.tool_calls : [];
    const finalCalls = normCalls.map((tc) => {
      let args = {};
      const raw = tc.function ? tc.function.arguments : "{}";
      try { args = JSON.parse(raw || "{}"); } catch { args = { _raw: raw }; }
      return { ...tc, _args: args };
    });
    return { content: norm.content, reasoning, toolCalls: finalCalls };
  };

  const resetForRetry = () => {
    // Pass-through emitters hold nothing — retries never duplicate deltas
    // (retry loop only runs BEFORE any content arrived).
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

  // Retry loop — only BEFORE any content arrived (no duplicate deltas).
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res = null;
    let fetchErr = null;
    const ac = new AbortController();
    const hardTimer = setTimeout(() => { try { ac.abort(); } catch {} }, 600_000);
    try {
      res = await fetch(url, {
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
    if (res && !res.ok) {
      const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
      if (retryable && attempt < MAX_ATTEMPTS) {
        const delay = Math.min(2000 * attempt, 15_000);
        emitEvent({ t: "status", kind: "retry", round, attempt, delayMs: delay, reason: "HTTP " + res.status });
        await sleep(delay);
        clearTimeout(hardTimer);
        continue;
      }
      const detail = await res.text().catch(() => "");
      clearTimeout(hardTimer);
      // 4xx on stream:true → MAY be "streaming not supported" — one
      // non-streaming fallback attempt before giving up.
      if (res.status < 500 && res.status !== 429 && res.status !== 408) {
        return await nonStreamFallback(state, round, feedDeltas, finishStream);
      }
      return { content: "", reasoning: "", toolCalls: [], error: "LLM HTTP " + res.status + " " + cleanDetail(detail, res.status) };
    }
    if (!res || !res.body) {
      if (fetchErr && attempt < MAX_ATTEMPTS) {
        const delay = Math.min(2000 * attempt, 15_000);
        emitEvent({ t: "status", kind: "retry", round, attempt, delayMs: delay, reason: "network: " + fetchErr });
        await sleep(delay);
        clearTimeout(hardTimer);
        continue;
      }
      clearTimeout(hardTimer);
      return { content: "", reasoning: "", toolCalls: [], error: "LLM network error: " + (fetchErr ?? "no response body") };
    }
    // Some gateways ignore stream:true and answer plain JSON — route that
    // through the same delta pipeline (one honest bulk delivery).
    const ct = String(res.headers.get("content-type") || "");
    if (ct.includes("application/json")) {
      clearTimeout(hardTimer);
      try {
        const json = await res.json();
        const msg = json.choices?.[0]?.message ?? {};
        return await feedCompleteMessage(msg, round, feedDeltas, finishStream);
      } catch (e) {
        return { content: "", reasoning: "", toolCalls: [], error: "LLM JSON parse failed: " + (e && e.message ? e.message : String(e)) };
      }
    }

    // TRUE SSE — read incrementally.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuf = "";
    let streamError = null;
    try {
      for (;;) {
        let readResult;
        try {
          readResult = await readWithTimeout(reader, IDLE_TIMEOUT_MS);
        } catch (e) {
          streamError = e && e.message === "idle"
            ? "Idle timeout (" + Math.round(IDLE_TIMEOUT_MS / 1000) + "s without a chunk)"
            : "Stream read failed: " + (e && e.message ? e.message : String(e));
          break;
        }
        const { value, done } = readResult;
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        const parsed = parseSSEFrames(sseBuf);
        sseBuf = parsed.rest;
        for (const ev of parsed.events) {
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
        for (const ev of parsed.events) {
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
      clearTimeout(hardTimer);
      try { ac.abort(); } catch {} // release the connection
    }
    if (streamError && !content && !reasoning && toolAcc.size === 0) {
      // Nothing streamed yet — a retry is duplicate-free.
      if (attempt < MAX_ATTEMPTS) {
        const delay = Math.min(2000 * attempt, 15_000);
        emitEvent({ t: "status", kind: "retry", round, attempt, delayMs: delay, reason: streamError });
        resetForRetry();
        await sleep(delay);
        continue;
      }
      return { content: "", reasoning: "", toolCalls: [], error: streamError };
    }
    // Mid-stream failure: the partial text is ALREADY streamed + preserved
    // in the UI — end the round in an ERROR state so the user knows the
    // answer is truncated (PRD §26: partial response → error state, never
    // a silent "done", never a blank replacement).
    const result = await finishStream();
    emitEvent({ t: "status", kind: "llm_end", round });
    if (streamError) {
      return { ...result, error: streamError };
    }
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
  const nb = { model: p.model, messages: state.messages, temperature: p.temperature ?? 0.7 };
  if (state.toolsEnabled !== false) nb.tools = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(p.apiKey ? { Authorization: "Bearer " + p.apiKey } : {}),
      },
      body: JSON.stringify(nb),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { content: "", reasoning: "", toolCalls: [], error: "LLM HTTP " + res.status + " " + cleanDetail(detail, res.status) };
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
      } catch (e) { return { error: "Failed to read: " + e.code }; }
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
      } catch (e) { return { error: "Failed to edit: " + e.code }; }
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
      } catch (e) { return { error: "Failed to list: " + e.code }; }
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
    name: "move_file",
    description: "Move or rename a file/folder.",
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
    // Beta V1.2 — todo plan tools in background mode. Same wire shapes as the
    // in-browser registry (lib/tools/todos.ts) so the chat UI's TodoPreview
    // renders identically. Todos persist in the run's state.json
    // (crash-safe) and execution is sequential, so the load→mutate→save
    // cycle cannot race.
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
        const state = await readState();
        const todos = Array.isArray(state.todos) ? state.todos : [];
        const action = String(args.action ?? "").toLowerCase();
        const now = Date.now();
        const newId = () => "todo_" + Math.random().toString(16).slice(2, 6).padStart(4, "0");
        if (action === "create") {
          const title = String(args.title ?? args.content ?? "").trim();
          if (!title) return { error: "title is required for create" };
          const todo = { id: newId(), title, status: "not_planned", createdAt: now, updatedAt: now };
          todos.push(todo);
          state.todos = todos;
          await writeState(state);
          return { success: true, output: { todo, total: todos.length } };
        }
        if (action === "update") {
          const id = String(args.todo_id ?? "");
          const idx = todos.findIndex((t) => t.id === id);
          if (idx === -1) return { error: "todo not found: " + (id || "(missing todo_id)") };
          const previous = { ...todos[idx] };
          const next = { ...todos[idx], updatedAt: now };
          const title = String(args.title ?? args.content ?? "").trim();
          if (title) next.title = title;
          if (args.status !== undefined) {
            const s = String(args.status);
            if (!["not_planned", "in_progress", "done", "not_done"].includes(s)) {
              return { error: 'invalid status "' + s + '" — use not_planned | in_progress | done | not_done' };
            }
            next.status = s;
          }
          todos[idx] = next;
          state.todos = todos;
          await writeState(state);
          return { success: true, output: { todo: next, previous } };
        }
        if (action === "delete") {
          const id = String(args.todo_id ?? "");
          const idx = todos.findIndex((t) => t.id === id);
          if (idx === -1) return { error: "todo not found: " + (id || "(missing todo_id)") };
          const deleted = todos.splice(idx, 1)[0];
          state.todos = todos;
          await writeState(state);
          return { success: true, output: { deleted } };
        }
        if (action === "list") return { success: true, output: { todos } };
        if (action === "clear") {
          state.todos = [];
          await writeState(state);
          return { success: true, output: { cleared: true } };
        }
        return { error: "Unknown action: " + action };
      } catch (e) {
        return { error: "Todo tool failed: " + (e && e.message ? e.message : String(e)) };
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
        const state = await readState();
        const todos = Array.isArray(state.todos) ? state.todos : [];
        const rawIds = Array.isArray(args.todo_ids) ? args.todo_ids.map((v) => String(v)) : [];
        const wantAll = args.all === true || rawIds.length === 0;
        if (wantAll) return { success: true, output: { todos } };
        const found = todos.filter((t) => rawIds.includes(t.id));
        const missing = rawIds.filter((id) => !todos.some((t) => t.id === id));
        if (!found.length) return { error: "todo not found: " + (missing.join(", ") || "(none)") };
        return { success: true, output: { todos: found, ...(missing.length ? { not_found: missing } : {}) } };
      } catch (e) {
        return { error: "Todo tool failed: " + (e && e.message ? e.message : String(e)) };
      }
    },
  },
];

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
  await writeState(state);
  await emitEvent({ t: "status", kind: "boot" });

  const maxRounds = state.maxRounds ?? 12;
  for (let round = 1; round <= maxRounds; round++) {
    await emitEvent({ t: "round_start", round });
    let result;
    try {
      result = await streamRoundEvents(state, round);
    } catch (e) {
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
    if (!toolCalls.length) {
      if (!result.content.trim() && !result.reasoning.trim()) {
        await emitEvent({ t: "error", message: "The model returned an empty response." });
        await setTerminal("error", "The model returned an empty response.");
        return;
      }
      await emitEvent({ t: "done", content: result.content });
      await setTerminal("done", result.content);
      return;
    }
    // ONE assistant message carrying content + tool_calls (protocol shape).
    state.messages.push({
      role: "assistant",
      content: result.content || null,
      ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
      tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } })),
    });
    for (const tc of toolCalls) {
      const fn = tc.function ?? {};
      const args = tc._args ?? {};
      const id = tc.id ?? "bg-" + Math.random().toString(36).slice(2, 10);
      await emitEvent({ t: "tool_call", round, id, name: fn.name ?? "unknown", args });
      const tool = TOOLS.find((x) => x.name === fn.name);
      let toolResult;
      try {
        toolResult = tool ? await tool.run(args) : { error: "Unknown tool in background mode: " + fn.name };
      } catch (e) { toolResult = { error: String(e && e.message ? e.message : e) }; }
      const resultStr = cap(JSON.stringify(toolResult), 64 * 1024);
      await emitEvent({ t: "tool_result", round, id, name: fn.name ?? "unknown", result: resultStr });
      state.messages.push({ role: "tool", tool_call_id: id, content: resultStr });
    }
    await writeState(state); // persist the conversation per round
  }
  await emitEvent({ t: "error", message: "Background run hit the max-rounds cap (" + maxRounds + ")" });
  await setTerminal("error", "Background run hit the max-rounds cap (" + maxRounds + ")");
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
