"use client";

// ============================================================================
// SPECIALIST TOOL RUNTIME — real tools for Business Mode specialist agents.
//
// USER DIRECTIVES this module implements:
//   "fix agents other than main agent does not able to use tools to create
//    files and etc everything answering raw" — specialists get a REAL
//    text-protocol tool loop over the app's actual tool registry (the same
//    handlers the main agent uses): web search/fetch, sandbox files, code
//    execution. No more raw `{"url": …}` pseudo tool-call JSON in outputs.
//
//   "make the all the business have a special directory in them, in e2b
//    files" — every file operation a specialist performs is scoped to the
//    business's OWN sandbox directory `businesses/<businessId>/` (relative
//    to the E2B workspace root /home/user), which the Files tab browses.
//
// The loop is model-agnostic (works with ANY OpenAI-compatible provider,
// including keyless text-only tiers): the model requests a tool by replying
// with ONLY a JSON object `{"tool": "...", "args": {...}}`; the runtime
// executes it through the registry and feeds the result back as the next
// user message. Any non-tool reply is the final answer (streamed via
// onDelta while it generates — the caller renders it live).
// ============================================================================

import { getTool, type ToolContext } from "@/lib/tools/registry";
import { stripFunctionCallTags } from "@/lib/text-sanitizer";
import { businessLlmStream, type BusinessLlmConfig, type BusinessLlmUsage } from "./llm";

// ---------------------------------------------------------------------------
// The business directory convention (shared with the Files tab).
// ---------------------------------------------------------------------------

/** The per-business sandbox directory (relative to the E2B workspace root
 *  /home/user): `businesses/<businessId>`. */
export function businessDirPath(businessId: string): string {
  return `businesses/${businessId}`;
}

// ---------------------------------------------------------------------------
// The tool protocol (appended to the specialist system prompt).
// ---------------------------------------------------------------------------

export const SPECIALIST_TOOL_PROTOCOL = `# Tools — REAL execution
You can ACTUALLY use tools while you work (search the live web, read pages, create and edit files, run code). To call a tool, reply with ONLY this JSON object and NOTHING else:

{"tool": "<tool name>", "args": {…}}

Available tools:
- "web" — args: {"action": "web_search" | "web_fetch", "query" | "url", …}
    web_search finds current information (titles, URLs, snippets); web_fetch reads a page's full text. ALWAYS verify claims with web_search before asserting facts, and READ important sources with web_fetch instead of guessing from snippets.
- "files" — args: {"action": "list_folder" | "read_file" | "create_file" | "write_file" | "edit_file" | "create_folder" | "delete_file" | "move_file", "path", "content", …}
    Your business's own file workspace. Paths are RELATIVE to your business directory (e.g. "report.md", "research/competitors.md"). Create deliverables, drafts, code, data files — they appear in the business's Files tab.
- "code_exec" — args: {"action": "run_python" | "run_terminal", "code" | "command"}
    Run code or shell commands in the sandbox (files in your business directory are accessible).

Rules:
- One tool call per reply, as the ONLY content of the reply (no prose around the JSON).
- After each call you receive the tool's result and may call another tool or write your final answer.
- When you have everything you need, write your COMPLETE final deliverable as your reply (no JSON) — it is streamed to the user live and becomes the document/deliverable.
- NEVER write fake tool syntax like <function_call> or {"url": …} in your final answer — either call the tool for real or write prose.`;

// ---------------------------------------------------------------------------
// Tool-call parsing.
// ---------------------------------------------------------------------------

export interface SpecialistToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/** Whitelisted specialist tools (umbrella names — dispatch stays normal). */
const SPECIALIST_TOOL_WHITELIST: ReadonlySet<string> = new Set(["web", "files", "code_exec"]);

/** Parse a tool call from a model reply. A valid call must be the ONLY
 *  content (optionally fenced) — prose + JSON together is a final answer. */
export function parseSpecialistToolCall(text: string): SpecialistToolCall | null {
  const raw = (text ?? "").trim();
  if (!raw || raw.length > 4000) return null;
  let candidate = raw;
  // Unwrap a single markdown code fence.
  const fence = candidate.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  if (fence?.[1]) candidate = fence[1].trim();
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const tool = typeof obj.tool === "string" ? obj.tool : typeof obj.name === "string" ? obj.name : "";
  if (!tool || !SPECIALIST_TOOL_WHITELIST.has(tool)) return null;
  let args: Record<string, unknown>;
  if (obj.args && typeof obj.args === "object" && !Array.isArray(obj.args)) {
    args = obj.args as Record<string, unknown>;
  } else if (obj.arguments && typeof obj.arguments === "object" && !Array.isArray(obj.arguments)) {
    args = obj.arguments as Record<string, unknown>;
  } else {
    // Flat form: {"tool": "web", "action": "web_search", "query": "…"}
    const { tool: _t, name: _n, ...rest } = obj;
    void _t;
    void _n;
    args = rest;
  }
  return { tool, args };
}

// ---------------------------------------------------------------------------
// Business-scoped argument rewriting (the per-business E2B directory).
// ---------------------------------------------------------------------------

/** Path-ish argument keys the `files` umbrella understands. */
const PATH_KEYS: ReadonlySet<string> = new Set(["path", "source", "destination"]);

/** Rewrite a single path argument into the business's directory unless it
 *  is already scoped there (or is an uploads file_id — those aren't paths). */
function scopePath(value: string, dir: string): string {
  const v = value.trim();
  if (!v) return v;
  // Already inside this business's directory (any spelling).
  if (v === dir || v.startsWith(`${dir}/`)) return v;
  if (v.startsWith(`/home/user/${dir}`) || v === `/home/user/${dir}`) return v;
  // Absolute sandbox path OUTSIDE the business dir → nest it under the
  // business dir (keep the trailing segments).
  if (v.startsWith("/home/user/")) return `${dir}/${v.slice("/home/user/".length)}`;
  if (v.startsWith("/")) return `${dir}/${v.replace(/^\/+/, "")}`;
  return `${dir}/${v}`;
}

function scopeFileArgs(args: Record<string, unknown>, dir: string): Record<string, unknown> {
  const scoped: Record<string, unknown> = { ...args };
  for (const key of Object.keys(scoped)) {
    if (!PATH_KEYS.has(key)) continue;
    const value = scoped[key];
    if (typeof value !== "string" || !value.trim()) continue;
    scoped[key] = scopePath(value, dir);
  }
  return scoped;
}

// ---------------------------------------------------------------------------
// Sanitization — the raw tool-call JSON safety net.
// ---------------------------------------------------------------------------

/** Residual pseudo tool-call patterns the sanitizer doesn't know (models
 *  emit creative spellings: <dots_function_call>, <tool_call>, <use_tool>…). */
const RESIDUAL_TOOL_TAG_RE =
  /<\/?[a-z0-9_.:-]*(?:function_call|tool_call|use_tool|tool_use|invoke|tool)[a-z0-9_.:-]*\/?>/gi;

/** Final-answer sanitizer: strip known function-call XML tags, residual
 *  pseudo tool-call tags and bare `{"url": …}` JSON runs, then tidy up. */
export function sanitizeSpecialistOutput(text: string): string {
  let out = stripFunctionCallTags(text ?? "");
  out = out.replace(RESIDUAL_TOOL_TAG_RE, "");
  // Bare JSON tool-call objects left over on their own lines:
  // {"url": "https://…", "max_chars": 5000} — drop whole lines that are JUST
  // such an object (keys typical of tool args).
  out = out
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t.startsWith("{") || !t.endsWith("}")) return true;
      try {
        const o = JSON.parse(t) as Record<string, unknown>;
        const keys = Object.keys(o);
        if (keys.length === 0) return true;
        const toolish = keys.every((k) =>
          /^(url|query|max_chars|max_length|action|path|content|command|code|file_id|name|tool)$/i.test(k),
        );
        return !toolish;
      } catch {
        return true;
      }
    })
    .join("\n");
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

// ---------------------------------------------------------------------------
// The tool loop.
// ---------------------------------------------------------------------------

export interface SpecialistToolLoopOptions {
  cfg: BusinessLlmConfig;
  systemPrompt: string;
  userPrompt: string;
  businessId: string;
  userId: string;
  agentName: string;
  signal?: AbortSignal;
  temperature?: number | null;
  /** Tool-call budget per task (default 10). */
  maxToolRounds?: number;
  /** Live FINAL-ANSWER deltas (tentative — reset when a round turns out to
   *  be a tool call instead). Receives the ACCUMULATED partial answer. */
  onDelta?: (partial: string) => void;
  /** Called when a tentative stream turns out to be a tool call (the caller
   *  clears whatever it was rendering from onDelta). */
  onDeltaReset?: () => void;
  /** Visibility hook — one call per executed tool (after execution, with a
   *  short result summary so the Browser tab keeps its result counts). */
  onToolCall?: (info: SpecialistToolCallInfo) => void;
}

export interface SpecialistToolLoopResult {
  output: string;
  sources: { title: string; url: string }[];
  usage?: BusinessLlmUsage;
  toolRounds: number;
}

/** What the visibility hook (onToolCall) receives per executed tool. */
export interface SpecialistToolCallInfo {
  tool: string;
  action?: string;
  detail: string;
  /** web_search: how many results came back. */
  resultCount?: number;
  /** web_search: the first result URLs (Browser tab parity). */
  topUrls?: string[];
  ok: boolean;
}

/** Max characters of a tool result fed back to the model. */
const TOOL_RESULT_MAX_CHARS = 24_000;

export async function runSpecialistToolLoop(
  opts: SpecialistToolLoopOptions,
): Promise<SpecialistToolLoopResult> {
  // Ensure the whole tool registry is registered (side-effect import) and
  // resolve the sandbox key the tools will use.
  const [{ settingsService }] = await Promise.all([import("@/lib/services")]);
  await import("@/lib/tools");
  let e2bApiKey: string | undefined;
  try {
    e2bApiKey = (await settingsService.getDecryptedSandboxKey(opts.userId)) ?? undefined;
  } catch {
    // no key — the file/code tools report honest errors, web still works
  }

  const dir = businessDirPath(opts.businessId);
  const sources: { title: string; url: string }[] = [];
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.userPrompt },
  ];

  const makeCtx = (signal?: AbortSignal): ToolContext => ({
    userId: opts.userId,
    conversationId: `business-${opts.businessId}`,
    emit: () => {
      /* business specialists don't ride the chat WSEvent pipeline —
         visibility comes from onToolCall → business activity events */
    },
    signal,
    e2bApiKey,
    sandboxApiKey: e2bApiKey,
    sandboxMode: "shared",
  });

  const executeTool = async (
    call: SpecialistToolCall,
  ): Promise<{ result: Record<string, unknown>; resultCount?: number; topUrls?: string[] }> => {
    const def = getTool(call.tool);
    if (!def) return { result: { error: `Unknown tool "${call.tool}". Use "web", "files" or "code_exec".` } };
    const action = typeof call.args.action === "string" ? call.args.action : undefined;
    const args =
      call.tool === "files" ? scopeFileArgs(call.args, dir) : { ...call.args };
    try {
      const result = (await def.handler(args, makeCtx(opts.signal))) as unknown;
      // Collect sources from web tools for the chat chips.
      let resultCount: number | undefined;
      let topUrls: string[] | undefined;
      if (call.tool === "web") {
        if (action === "web_search" || (!action && typeof args.query === "string")) {
          const rows =
            result && typeof result === "object" && "results" in result
              ? ((result as { results?: unknown }).results as unknown[])
              : [];
          if (Array.isArray(rows)) {
            resultCount = rows.length;
            const urls: string[] = [];
            for (const row of rows) {
              const r = row as { title?: unknown; url?: unknown };
              if (typeof r?.url === "string" && /^https?:\/\//.test(r.url)) {
                sources.push({ title: String(r.title ?? r.url), url: r.url });
                if (urls.length < 3) urls.push(r.url);
              }
            }
            topUrls = urls;
          }
        }
        if (action === "web_fetch" || (!action && typeof args.url === "string")) {
          const url = String(args.url);
          if (/^https?:\/\//.test(url) && !sources.some((s) => s.url === url)) {
            sources.push({ title: url, url });
          }
        }
      }
      const normalized =
        result && typeof result === "object" ? (result as Record<string, unknown>) : { result: String(result) };
      return { result: normalized, resultCount, topUrls };
    } catch (err) {
      return { result: { error: err instanceof Error ? err.message : String(err) } };
    }
  };

  const describeCall = (call: SpecialistToolCall): string => {
    const args = call.args ?? {};
    const action = typeof args.action === "string" ? args.action : "";
    const detail =
      typeof args.query === "string"
        ? args.query
        : typeof args.url === "string"
          ? args.url
          : typeof args.path === "string"
            ? args.path
            : typeof args.command === "string"
              ? args.command
              : action || call.tool;
    return detail;
  };

  const maxRounds = opts.maxToolRounds ?? 10;
  let rounds = 0;
  let usage: BusinessLlmUsage | undefined;

  while (rounds < maxRounds) {
    if (opts.signal?.aborted) throw new Error("cancelled");

    // Tentative streaming: if this round IS the final answer, the caller's
    // onDelta renders it live; if it turns out to be a tool call, reset.
    let partial = "";
    const res = await businessLlmStream(opts.cfg, {
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt, // unused when messages is set
      messages,
      temperature: opts.temperature ?? undefined,
      signal: opts.signal,
      onDelta: (delta) => {
        partial += delta;
        opts.onDelta?.(partial);
      },
    });
    usage = res.usage ?? usage;
    const call = parseSpecialistToolCall(res.text);

    if (!call) {
      // Final answer — sanitize residual pseudo tool-call syntax.
      const clean = sanitizeSpecialistOutput(res.text);
      if (clean) return { output: clean, sources, usage, toolRounds: rounds };
      // Sanitized to nothing (raw JSON junk) — ask once more, honestly.
      messages.push({ role: "assistant", content: res.text });
      messages.push({
        role: "user",
        content:
          "That reply contained only raw tool-call syntax and was not shown to the user. Either call a tool with the JSON format, or write your actual final deliverable in plain prose/markdown.",
      });
      rounds++;
      continue;
    }

    // A tool round — clear the tentative stream and execute for real.
    partial = "";
    opts.onDeltaReset?.();
    const { result, resultCount, topUrls } = await executeTool(call);
    rounds++;
    opts.onToolCall?.({
      tool: call.tool,
      action: typeof call.args?.action === "string" ? call.args.action : undefined,
      detail: describeCall(call),
      resultCount,
      topUrls,
      ok: !(result && typeof result === "object" && "error" in result),
    });

    let resultText: string;
    try {
      resultText = JSON.stringify(result, null, 2);
    } catch {
      resultText = String(result);
    }
    if (resultText.length > TOOL_RESULT_MAX_CHARS) {
      resultText = `${resultText.slice(0, TOOL_RESULT_MAX_CHARS)}\n…[truncated]`;
    }

    messages.push({ role: "assistant", content: res.text });
    messages.push({
      role: "user",
      content: `TOOL RESULT (${call.tool}${call.args?.action ? ` · ${String(call.args.action)}` : ""}):\n${resultText}\n\nContinue: call another tool with the JSON format, or write your COMPLETE final deliverable as your reply.`,
    });
  }

  // Tool budget exhausted — force the final answer out.
  messages.push({
    role: "user",
    content:
      "You have used the maximum tool budget for this task. Write your COMPLETE final deliverable NOW as your reply (no more tool calls).",
  });
  let partial = "";
  const res = await businessLlmStream(opts.cfg, {
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    messages,
    temperature: opts.temperature ?? undefined,
    signal: opts.signal,
    onDelta: (delta) => {
      partial += delta;
      opts.onDelta?.(partial);
    },
  });
  const clean = sanitizeSpecialistOutput(res.text) || partial;
  return { output: clean, sources, usage: res.usage ?? usage, toolRounds: rounds };
}
