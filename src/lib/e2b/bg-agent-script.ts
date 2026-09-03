/**
 * The background agent runner — a self-contained Node ESM script that runs
 * INSIDE the E2B sandbox as a background command
 * (`commands.run("node …", { background: true, timeoutMs: 0 })`).
 *
 * Why inside the sandbox? E2B sandboxes are server-side VMs: they keep
 * running after the browser disconnects (per the E2B docs — "a sandbox is
 * not session-scoped", and a background command "keeps running inside the
 * sandbox even after the SDK disconnects"). The agent loop therefore
 * CONTINUES while the browser is closed, minimized, or cut off; when the
 * user comes back, the app reconnects (Sandbox.connect) and reads the
 * progress this script wrote to /home/user/.onyx/bg-state.json.
 *
 * The script implements the sandbox-side tool subset (files, terminal,
 * python, web fetch) and calls the user's OpenAI-compatible provider
 * directly (the sandbox has outbound internet). Every step appends an
 * event to the state file so the browser can replay the turn incrementally.
 */

export const BG_AGENT_SCRIPT = String.raw`
// OnyxAgent background runner — executes INSIDE the E2B sandbox.
import fs from "node:fs/promises";
import { exec } from "node:child_process";
import path from "node:path";

const HOME = "/home/user";
const STATE_DIR = path.join(HOME, ".onyx");
const STATE_FILE = path.join(STATE_DIR, "bg-state.json");

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
  await fs.mkdir(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state));
  await fs.rename(tmp, STATE_FILE);
}

async function appendEvent(ev) {
  const state = await readState();
  state.events.push(ev);
  if (ev.t === "done" || ev.t === "error") {
    state.status = ev.t === "done" ? "done" : "error";
    if (ev.t === "done") state.content = ev.content ?? "";
    if (ev.t === "error") state.error = ev.message ?? "Unknown error";
  }
  await writeState(state);
}

const cap = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "\n... (truncated)" : s);

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
        const tmp = path.join(HOME, ".onyx", "py-" + Date.now() + ".py");
        fs.mkdir(STATE_DIR, { recursive: true })
          .then(() => fs.writeFile(tmp, String(args.code ?? "")))
          .then(() => {
            exec("python3 " + JSON.stringify(tmp), { cwd: HOME, timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
              fs.rm(tmp, { force: true }).catch(() => {});
              resolve({
                exit_code: err && err.code ? (typeof err.code === "number" ? err.code : 1) : 0,
                stdout: cap(String(stdout ?? ""), 256 * 1024),
                stderr: cap(String(stderr ?? err?.message ?? ""), 256 * 1024),
              });
            });
          })
          .catch((e) => resolve({ error: String(e) }));
      }),
  },
  {
    name: "web_fetch",
    description: "Fetch a web page and return its readable text (tags stripped, 20KB cap).",
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
];

// ── The agent loop ──────────────────────────────────────────────────────
// Text-embedded tool-call normalizers. Some gateway upstreams (freeaixyz4all's
// toolbaz/ua providers) return tool calls INSIDE message.content as a fenced
// code block:
//   ~~~tool_call
//   [{"name":"get_weather","arguments":{"city":"Tokyo"}}]
//   ~~~
// (where ~~~ stands for three backticks). Others use DeepSeek-style DSML XML
// tags. Both are converted here into the standard message.tool_calls shape so
// the loop below is format-agnostic.
// NOTE: backticks are written as \x60 (their char code) in the regexes
// below because this whole script is embedded inside a backtick-delimited
// template literal — a literal backtick would terminate it.
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

/** Normalize a provider message: extract text-embedded tool calls (fence /
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
    // Standard tool_calls present — still strip any leaked embedded blocks.
    const fence = parseFenceCalls(content);
    if (fence) clean = fence.clean;
    else {
      const dsml = parseDSMLCalls(content);
      if (dsml) clean = dsml.clean;
    }
  }
  return { ...msg, content: clean, tool_calls: toolCalls };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Call the LLM with retries — gateway upstreams flap (502 "edge runtime
 *  crypto" errors, 503 UPSTREAM_UNAVAILABLE, network blips) and a single
 *  transient failure must NOT kill the whole background run. 5xx/429/network
 *  errors retry up to 4 times with exponential backoff; 4xx fails fast. */
async function callLLM(state) {
  const p = state.provider;
  let url = String(p.baseUrl ?? "").replace(/\/+$/, "");
  if (!p.noPrefix && !url.endsWith("/chat/completions")) url += "/chat/completions";
  const body = {
    model: p.model,
    messages: state.messages,
    temperature: p.temperature ?? 0.7,
  };
  if (state.toolsEnabled !== false) body.tools = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

  const MAX_ATTEMPTS = 4;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          ...(p.apiKey ? { Authorization: "Bearer " + p.apiKey } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      lastErr = new Error("LLM network error: " + String(e?.message ?? e));
      if (attempt < MAX_ATTEMPTS) { await sleep(2000 * attempt); continue; }
      throw lastErr;
    }
    if (res.ok) {
      const json = await res.json();
      return normalizeMessage(json.choices?.[0]?.message ?? {});
    }
    const detail = await res.text().catch(() => "");
    lastErr = new Error("LLM HTTP " + res.status + " " + cap(detail, 500));
    const retryable = res.status >= 500 || res.status === 429;
    if (retryable && attempt < MAX_ATTEMPTS) { await sleep(2000 * attempt); continue; }
    throw lastErr;
  }
  throw lastErr ?? new Error("LLM call failed after retries");
}

async function main() {
  const state = await readState();
  state.status = "running";
  state.events = state.events ?? [];
  await writeState(state);

  const maxRounds = state.maxRounds ?? 12;
  for (let round = 1; round <= maxRounds; round++) {
    await appendEvent({ t: "round_start", round });
    let message;
    try {
      message = await callLLM(state);
    } catch (e) {
      await appendEvent({ t: "error", message: String(e.message ?? e) });
      return;
    }
    // Reasoning tokens (some providers return reasoning_content alongside
    // the message content + tool calls — capture as an event, never as the
    // conversation content).
    if (message.reasoning_content) {
      await appendEvent({ t: "reasoning", round, content: cap(String(message.reasoning_content), 32 * 1024) });
    }
    const content = String(message.content ?? "");
    if (content.trim()) {
      await appendEvent({ t: "text", round, content });
    }
    const toolCalls = message.tool_calls ?? [];
    if (!toolCalls.length) {
      if (!content.trim() && !message.reasoning_content) {
        await appendEvent({ t: "error", message: "The model returned an empty response." });
        return;
      }
      await appendEvent({ t: "done", content });
      return;
    }
    // ONE assistant message carrying content + tool_calls (protocol shape).
    state.messages.push({ role: "assistant", content: content || null, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const fn = tc.function ?? {};
      let args = {};
      try { args = fn.arguments ? JSON.parse(fn.arguments) : {}; } catch { args = { _raw: fn.arguments }; }
      await appendEvent({ t: "tool_call", round, id: tc.id ?? "bg-" + Math.random().toString(36).slice(2, 10), name: fn.name ?? "unknown", args });
      const tool = TOOLS.find((x) => x.name === fn.name);
      let result;
      try {
        result = tool ? await tool.run(args) : { error: "Unknown tool in background mode: " + fn.name };
      } catch (e) { result = { error: String(e.message ?? e) }; }
      const resultStr = cap(JSON.stringify(result), 64 * 1024);
      await appendEvent({ t: "tool_result", round, id: tc.id ?? "unknown", name: fn.name ?? "unknown", result: resultStr });
      state.messages.push({ role: "tool", tool_call_id: tc.id, content: resultStr });
    }
  }
  await appendEvent({ t: "error", message: "Background run hit the max-rounds cap (" + maxRounds + ")" });
}

main().catch(async (e) => {
  try { await appendEvent({ t: "error", message: String(e?.message ?? e) }); } catch {}
  process.exit(1);
});
`;

/** Where the runner script + state live inside the sandbox. */
export const BG_STATE_PATH = "/home/user/.onyx/bg-state.json";
export const BG_SCRIPT_PATH = "/home/user/.onyx/bg-agent.mjs";
