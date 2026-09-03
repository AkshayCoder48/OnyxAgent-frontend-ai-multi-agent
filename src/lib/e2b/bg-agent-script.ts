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
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(p.apiKey ? { Authorization: "Bearer " + p.apiKey } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error("LLM HTTP " + res.status + " " + cap(detail, 500));
  }
  const json = await res.json();
  return json.choices?.[0]?.message ?? {};
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
