import ZAI from "z-ai-web-dev-sdk";
import {
  REASONING_OPEN,
  routeRequest,
  splitThinking,
  type ModelPreference,
  type RouteDecision,
  type RouterMessage,
} from "./router";
import {
  codeToolDocs,
  executeCodeTool,
  workspaceContextText,
  type ToolExecutionResult,
} from "./code-tools";

/**
 * Background turn jobs.
 *
 * A model turn used to live inside the /api/chat request handler: when the
 * browser backgrounded/froze the tab (or any proxy dropped the leg),
 * `request.signal` fired and aborted the whole turn mid-reasoning — the
 * "Stream read failed: This operation was aborted" class of failure.
 *
 * Now a turn runs as an in-process JOB that is completely detached from any
 * HTTP connection. The SSE response is just a *viewer* that replays the job's
 * event log and follows it live; disconnecting the viewer never touches the
 * job. When the tab comes back it re-attaches with a `since` cursor and
 * receives exactly the events it missed — so background work always
 * completes and retrieval is near-instant.
 */

export type TurnEvent =
  | {
      type: "route";
      route: "fast" | "balanced" | "deep";
      label: string;
      model: string;
      reason: string;
      thinking: boolean;
      resume: boolean;
    }
  | { type: "reasoning"; text: string }
  | { type: "delta"; text: string }
  | { type: "replace"; reasoning: string; answer: string }
  | { type: "status"; text: string }
  | { type: "warning"; text: string }
  | {
      /** A code-mode tool started executing (server-side, in this job). */
      type: "tool_call";
      toolId: string;
      name: string;
      subtitle: string;
      args: string;
    }
  | {
      /** Skip-wait: the tool keeps running detached while the agent continues. */
      type: "tool_status";
      toolId: string;
      backgrounded: boolean;
      subtitle: string;
    }
  | {
      /** A tool finished — updates the card and feeds the next model round. */
      type: "tool_result";
      toolId: string;
      ok: boolean;
      result: string;
      subtitle: string;
      resultData?: { kind: string; payload: Record<string, unknown> };
    }
  | { type: "done"; elapsedMs?: number; partial?: boolean }
  | { type: "error"; message: string }
  | { type: "cancelled" };

/** Options that shape how a turn runs. */
export interface TurnJobOptions {
  mode?: "agent" | "code";
  workspaceId?: string;
}

export interface IndexedTurnEvent {
  index: number;
  event: TurnEvent;
}

type Subscriber = (indexed: IndexedTurnEvent) => void;

/** How long a finished job stays retrievable. */
const FINISHED_TTL_MS = 10 * 60_000;
/** Hard wall-clock cap on a single turn. */
const RUNNING_TTL_MS = 12 * 60_000;
/** Finished jobs kept in memory (LRU by finish time). */
const MAX_FINISHED_JOBS = 20;

/** How long an upstream silence may last before we cancel the stalled reader. */
const UPSTREAM_IDLE_MS = 90_000;
/** Fresh retries when the upstream dies before any content was produced. */
const MAX_FRESH_RETRIES = 2;
/** Headers timeout for the upstream create call. */
const UPSTREAM_HEADERS_MS = 60_000;

export class TurnJob {
  readonly id: string;
  readonly createdAt = Date.now();
  readonly events: IndexedTurnEvent[] = [];
  done = false;
  finishedAt: number | null = null;
  cancelReason: "user" | "ttl" | null = null;

  private readonly subscribers = new Set<Subscriber>();
  private readonly abortController = new AbortController();
  /** Skip-wait resolvers for tools this job is currently blocked on. */
  private readonly skipResolvers = new Map<string, () => void>();
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(id: string) {
    this.id = id;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get aborted(): boolean {
    return this.abortController.signal.aborted;
  }

  append(event: TurnEvent): void {
    if (this.done) return;
    const indexed: IndexedTurnEvent = { index: this.events.length, event };
    this.events.push(indexed);
    for (const subscriber of this.subscribers) {
      try {
        subscriber(indexed);
      } catch {
        // A broken viewer never breaks the job.
        this.subscribers.delete(subscriber);
      }
    }
    if (event.type === "done" || event.type === "error" || event.type === "cancelled") {
      this.done = true;
      this.finishedAt = Date.now();
      this.subscribers.clear();
      if (this.ttlTimer) {
        clearTimeout(this.ttlTimer);
        this.ttlTimer = null;
      }
    }
  }

  subscribe(subscriber: Subscriber): () => void {
    if (this.done) return () => undefined;
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /** Detached viewers disconnect freely — the job keeps running. */
  cancel(reason: "user" | "ttl" = "user"): void {
    if (this.done) return;
    this.cancelReason = reason;
    this.skipResolvers.clear();
    this.abortController.abort();
  }

  /** Register the resolver that unblocks a waiting tool (skip-wait). */
  registerSkip(toolId: string, resolve: () => void): void {
    if (!this.done) this.skipResolvers.set(toolId, resolve);
  }

  clearSkip(toolId: string): void {
    this.skipResolvers.delete(toolId);
  }

  /** The user chose to continue while a tool runs — unblock the pipeline. */
  requestToolSkip(toolId: string): boolean {
    const resolve = this.skipResolvers.get(toolId);
    if (!resolve) return false;
    this.skipResolvers.delete(toolId);
    resolve();
    return true;
  }

  armTtl(): void {
    if (this.ttlTimer) return;
    this.ttlTimer = setTimeout(() => {
      this.ttlTimer = null;
      this.cancel("ttl");
    }, RUNNING_TTL_MS);
  }
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

const jobs = new Map<string, TurnJob>();

function gcJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.done && job.finishedAt !== null && now - job.finishedAt > FINISHED_TTL_MS) {
      jobs.delete(id);
    } else if (!job.done && now - job.createdAt > RUNNING_TTL_MS + 30_000) {
      // Safety net if the pipeline failed to observe the TTL abort.
      job.cancel("ttl");
      jobs.delete(id);
    }
  }
  // Cap finished jobs (newest first).
  const finished = [...jobs.values()]
    .filter((j) => j.done)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  for (const job of finished.slice(MAX_FINISHED_JOBS)) {
    jobs.delete(job.id);
  }
}

if (typeof setInterval === "function") {
  const timer = setInterval(gcJobs, 60_000);
  // Never hold the process open just for GC.
  (timer as { unref?: () => void }).unref?.();
}

export function getTurnJob(id: string): TurnJob | undefined {
  return jobs.get(id);
}

export function cancelTurnJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancel("user");
  return true;
}

/** Skip-wait action: unblock a running tool so the agent keeps planning. */
export function skipToolWait(turnId: string, toolId: string): boolean {
  const job = jobs.get(turnId);
  if (!job || job.done) return false;
  return job.requestToolSkip(toolId);
}

/* ------------------------------------------------------------------ */
/* Upstream reader (idle-only watchdog, never kills an active stream)  */
/* ------------------------------------------------------------------ */

let cachedZai: Awaited<ReturnType<typeof ZAI.create>> | null = null;
async function getZai() {
  if (!cachedZai) cachedZai = await ZAI.create();
  return cachedZai;
}

interface UpstreamChunk {
  content: string;
  finish: string | null;
}

function isAbortLike(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "AbortError" || name === "TimeoutError" || /aborted|abort/i.test(message);
}

function isRetryableUpstream(error: unknown): boolean {
  if (isAbortLike(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket|premature|stalled|idle watchdog|ended before any data|never responded|did not return a stream|stream read failed/i.test(
      message,
    ) || /\bHTTP (5|408|429)\d\b/.test(message)
  );
}

async function readUpstream(
  upstreamMessages: { role: "system" | "user" | "assistant"; content: string }[],
  thinking: boolean,
  temperature: number,
  onChunk: (chunk: UpstreamChunk) => void,
  externalAbort?: AbortSignal,
): Promise<{ finished: boolean }> {
  const zai = await getZai();

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelledByWatchdog = false;

  // The SDK does not forward fetch signals, so cancellation works by
  // cancelling the body reader — that tears the upstream socket down.
  const cancelUpstream = () => {
    cancelledByWatchdog = true;
    try {
      void reader?.cancel();
    } catch {
      // already cancelled
    }
  };
  const armIdleWatchdog = () => {
    if (idleTimer) clearTimeout(idleTimer);
    // Never abort an ACTIVE stream — only one that has been silent for
    // UPSTREAM_IDLE_MS, which no healthy reasoning phase should exceed.
    idleTimer = setTimeout(cancelUpstream, UPSTREAM_IDLE_MS);
  };
  const onExternalAbort = () => cancelUpstream();
  externalAbort?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    // Race the SDK call: if the gateway never even sends headers, fail fast
    // into the retry logic instead of hanging the turn forever. If the race
    // is lost on time but the create later resolves, release its body so the
    // socket never leaks.
    let createSettled = false;
    const createPromise = zai.chat.completions.create({
      messages: upstreamMessages,
      stream: true,
      thinking: { type: thinking ? "enabled" : "disabled" },
      temperature,
    }).then(
      (value) => {
        createSettled = true;
        return value;
      },
      (error) => {
        createSettled = true;
        throw error;
      },
    );
    const headersTimeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        if (createSettled) return;
        reject(new Error("Upstream never responded within 60s."));
        void createPromise.then(
          (late) => {
            if (late instanceof ReadableStream) void late.cancel().catch(() => undefined);
          },
          () => undefined,
        );
      }, UPSTREAM_HEADERS_MS);
    });
    const body: unknown = await Promise.race([createPromise, headersTimeout]);

    // The SDK resolves with the raw ReadableStream body when streaming.
    if (!(body instanceof ReadableStream)) {
      throw new Error("Upstream did not return a stream — retrying.");
    }

    reader = (body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;
    let sawAnyChunk = false;

    armIdleWatchdog();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdleWatchdog();
      sawAnyChunk = true;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, boundary).replace(/\r$/, "");
        buffer = buffer.slice(boundary + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") {
          finished = true;
          continue;
        }
        try {
          const json = JSON.parse(payload) as {
            choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[];
          };
          const choice = json.choices?.[0];
          const content = choice?.delta?.content;
          if (typeof content === "string" && content.length > 0) {
            onChunk({ content, finish: null });
          }
          if (typeof choice?.finish_reason === "string" && choice.finish_reason !== "null") {
            onChunk({ content: "", finish: choice.finish_reason });
            finished = true;
          }
        } catch {
          // Ignore malformed SSE fragments — the next chunk usually repairs.
        }
      }
    }
    if (cancelledByWatchdog && !finished) {
      throw new Error("Upstream stalled mid-stream (idle watchdog) — retryable.");
    }
    if (!sawAnyChunk && !finished) {
      throw new Error("Upstream stream ended before any data arrived.");
    }
    if (!finished) {
      // Content streamed but the provider never sent [DONE] or a finish
      // reason — a cut stream, NOT a completed reply. Treat as retryable
      // so the mid-stream recovery can continue exactly where it stopped
      // (otherwise a truncated tool block or sentence would look final).
      throw new Error("Upstream stream ended prematurely (no completion signal).");
    }
    return { finished };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (!cancelledByWatchdog) {
      try {
        void reader?.cancel();
      } catch {
        // already cancelled
      }
    }
    externalAbort?.removeEventListener("abort", onExternalAbort);
  }
}

/* ------------------------------------------------------------------ */
/* Turn pipeline — the whole model turn, detached from any request     */
/* ------------------------------------------------------------------ */

function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const message = error.message ?? "";
  const httpMatch = /HTTP (\d{3})/.exec(message);
  if (httpMatch) {
    const status = httpMatch[1];
    if (status === "401" || status === "403") {
      return "The AI provider rejected the credentials. Please try again later.";
    }
    if (status === "429") {
      return "The AI provider is rate-limiting us for a moment. Try again shortly.";
    }
    if (status.startsWith("5")) {
      return "The AI provider is having a rough minute. Try again shortly.";
    }
  }
  if (/json|parse/i.test(message)) {
    return "The AI provider sent an unreadable reply. Please try again.";
  }
  return "";
}

export function startTurnJob(
  id: string,
  messages: RouterMessage[],
  preference: ModelPreference,
  resumeFrom: string | null,
  options?: TurnJobOptions,
): TurnJob {
  const existing = jobs.get(id);
  if (existing && !existing.done) return existing;

  gcJobs();
  const job = new TurnJob(id);
  jobs.set(id, job);
  job.armTtl();

  // Fire and forget: the job runs to completion no matter what any
  // HTTP connection does. All outcomes terminate the job.
  void runTurnPipeline(job, messages, preference, resumeFrom, options).catch((error) => {
    if (!job.done) {
      job.append({
        type: "error",
        message: `The reply could not be completed. ${
          errorDetail(error) || "Please try again."
        }`,
      });
    }
  });

  return job;
}

/* ------------------------------------------------------------------ */
/* Code mode — multi-round tool loop                                   */
/*                                                                     */
/* The model emits tool calls as a fenced ```onyxtool JSON block at the */
/* end of its reply (works with ANY chat model — no native function     */
/* calling required). The pipeline executes the tool server-side, feeds */
/* the result back as a TOOL RESULT message, and loops until the model  */
/* answers without a tool block. Skip-wait detaches long tools so the  */
/* agent keeps planning while they run.                                */
/* ------------------------------------------------------------------ */

const MAX_TOOL_ROUNDS = 5;
/** How long a finished reply stays open waiting for backgrounded tools. */
const BG_TOOL_CAP_MS = 90_000;

const TOOL_FENCE_RE = /```[ \t]*onyxtool[^\n]*\n?/i;

/**
 * The portion of a round's raw text that is safe to show: everything before
 * a tool fence. A partial fence at the very tail ("``", "```ony"…) is held
 * back so marker fragments never flash as answer text.
 */
function visiblePortion(raw: string): string {
  const match = TOOL_FENCE_RE.exec(raw);
  if (match) return raw.slice(0, match.index);
  const tail =
    /(?:`|``|```|```o|```on|```ony|```onyx|```onyxt|```onyxto|```onyxtoo|```onyxtool)[ \t]*$/i.exec(
      raw,
    );
  if (tail) return raw.slice(0, raw.length - tail[0].length);
  return raw;
}

interface ToolBlock {
  complete: boolean;
  /** Raw text before the first fence (the model's visible message). */
  before: string;
  /** JSON texts of every complete fenced block, in order. */
  jsonTexts: string[];
}

/**
 * Extract EVERY onyxtool fence in the reply. A single reply may batch calls
 * either as one JSON array inside one fence or as several fences — both are
 * collected here so nothing is silently dropped. `complete` is false when a
 * fence is left unterminated.
 */
function extractToolBlocks(raw: string): ToolBlock | null {
  const fences: { start: number; jsonStart: number }[] = []
  const re = /```[ \t]*onyxtool[^\n]*\n?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    fences.push({ start: match.index, jsonStart: match.index + match[0].length });
  }
  if (fences.length === 0) return null;
  const before = raw.slice(0, fences[0].start);
  const jsonTexts: string[] = [];
  for (let i = 0; i < fences.length; i++) {
    const close = raw.indexOf("```", fences[i].jsonStart);
    if (close === -1) return { complete: false, before, jsonTexts };
    jsonTexts.push(raw.slice(fences[i].jsonStart, close));
  }
  return { complete: true, before, jsonTexts };
}

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

function toToolCall(value: unknown): ToolCall | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as { tool?: unknown; args?: unknown };
  if (typeof obj.tool !== "string" || obj.tool.trim().length === 0) return null;
  const args =
    obj.args && typeof obj.args === "object" && !Array.isArray(obj.args)
      ? (obj.args as Record<string, unknown>)
      : {};
  return { tool: obj.tool.trim(), args };
}

/**
 * Parse one fence's JSON into a list of calls. Accepts a single call object,
 * a bare array of call objects, or {"calls": [...]} — so the model can batch
 * "write the page AND start the preview" in one block instead of fabricating
 * the first action in prose.
 */
function parseToolCalls(jsonText: string): ToolCall[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.trim());
  } catch {
    return null;
  }
  const fromList = (list: unknown): ToolCall[] | null => {
    if (!Array.isArray(list)) return null;
    const calls = list
      .map(toToolCall)
      .filter((c): c is ToolCall => c !== null);
    return calls.length > 0 ? calls : null;
  };
  if (Array.isArray(parsed)) return fromList(parsed);
  if (parsed && typeof parsed === "object") {
    const callsField = (parsed as { calls?: unknown }).calls;
    if (Array.isArray(callsField)) return fromList(callsField);
    const single = toToolCall(parsed);
    return single ? [single] : null;
  }
  return null;
}

function describeToolCall(call: { tool: string; args: Record<string, unknown> }): string {
  const a = call.args ?? {};
  const s = (key: string): string => (typeof a[key] === "string" ? (a[key] as string) : "");
  switch (call.tool) {
    case "create_app":
      return `Scaffold ${s("framework") || "app"} · ${s("name") || "project"}`;
    case "manage_files":
      return `${s("action") || "list"} ${s("path")}`.trim();
    case "start_preview":
      return `Start live preview${s("name") ? ` · ${s("name")}` : ""}`;
    case "manage_preview":
      return `${s("action") || "list"} preview${s("sessionId") ? ` · ${s("sessionId")}` : ""}`;
    case "start_web_session":
      return `Open web session${a.screenshot === true ? " + screenshot" : ""}`;
    case "manage_database":
      return `${s("action") || "list"} ${s("key") || "records"}`.trim();
    default:
      return call.tool;
  }
}

/**
 * Deterministic self-healing for the classic failure mode: the model ANNOUNCES
 * a tool action in prose but never emits the block. When a reply without a
 * block clearly promises one of the known actions, a corrective round asks
 * for the block explicitly (bounded — at most two corrections per turn).
 */
function detectAnnouncedTool(text: string): { action: string; example: string } | null {
  const intent = /\b(i'?ll|i will|i am going to|i'?m going to|let me|now i|we'?ll)\b/i.test(text);
  if (!intent) return null;
  // Explanations — questions answered, code shown — are not announcements.
  if (text.includes("?") || text.includes("```")) return null;
  const lower = text.toLowerCase();
  if (/(preview|go live)/.test(lower) && /(start|launch|run|open|spin|bring|serve)/.test(lower)) {
    return {
      action: "start the live preview",
      example: '{"tool": "start_preview", "args": {"name": "<the app name>"}}',
    };
  }
  if (/(web session|browser session|screenshot|headless)/.test(lower) && /(open|run|start|launch|take|capture)/.test(lower)) {
    return {
      action: "open the web session",
      example: '{"tool": "start_web_session", "args": {"screenshot": true}}',
    };
  }
  if (/(database|record)/.test(lower) && /(save|store|write|persist)/.test(lower)) {
    return {
      action: "save to the workspace database",
      example: '{"tool": "manage_database", "args": {"action": "set", "key": "<key>", "data": {}}}',
    };
  }
  // File edits — the most common code-mode action. Broad on purpose: in
  // code mode an announced edit ALWAYS needs the manage_files block.
  if (
    /(file|page|site|section|footer|header|hero|menu|\.html|index|app|css|style|code)/.test(lower) &&
    /(add|write|update|change|edit|modify|put|insert|remove|delete|fix|append|move|replace)/.test(lower)
  ) {
    return {
      action: "write the file changes",
      example:
        '{"tool": "manage_files", "args": {"action": "write", "path": "index.html", "content": "<the full updated file content>"}}',
    };
  }
  return null;
}

/**
 * The nastier cousin of the announcement: the model FABRICATES a completed
 * manage_files action in prose — quoting tool-result wording like
 * "[used tool manage_files…" or "Wrote 2370 bytes to index.html" — while the
 * real block it emitted was for a different tool. Nothing was written.
 * Detected deterministically from the tool-result phrasing itself.
 */
function detectFabricatedFileWrite(text: string): boolean {
  if (/\[\s*used tool\s+manage_files/i.test(text)) return true;
  if (/\bwrote\s+\d+\s+bytes?\s+to\b/i.test(text)) return true;
  if (
    /\b(?:i'?ve|i have|has been|is now|now)\s+(?:been\s+)?(?:written|saved|updated|added|changed)\b/i.test(text) &&
    /\b(?:file|files|page|index\.html|preview\/index\.html|site|html)\b/i.test(text)
  ) {
    return true;
  }
  return false;
}

/** Stream one model round, emitting reasoning/delta/replace for the visible
 *  portion only (tool fences held back). Returns the round's full raw text. */
async function readCodeRound(
  job: TurnJob,
  upstream: { role: "system" | "user" | "assistant"; content: string }[],
  thinking: boolean,
  temperature: number,
  resumeFrom: string | null,
): Promise<string> {
  const state = { raw: resumeFrom ?? "", lastReasoning: "", lastAnswer: resumeFrom ?? "" };
  let produced = state.raw.length > 0;
  let success = false;
  let lastError: unknown = null;

  const openMarkerPending = (raw: string): boolean => {
    if (resumeFrom) return false;
    const stripped = raw.replace(/^[*_#>\s]*/, "");
    const head = stripped.slice(0, REASONING_OPEN.length).toUpperCase();
    if (head.length === 0) return raw.length < 8;
    return REASONING_OPEN.startsWith(head) && head.length < REASONING_OPEN.length;
  };

  const emit = (nextRaw: string) => {
    state.raw = nextRaw;
    if (openMarkerPending(nextRaw)) return;
    const visible = visiblePortion(nextRaw);
    const { reasoning, answer } = splitThinking(visible);
    if (reasoning.startsWith(state.lastReasoning) && reasoning.length > state.lastReasoning.length) {
      job.append({ type: "reasoning", text: reasoning.slice(state.lastReasoning.length) });
      state.lastReasoning = reasoning;
    } else if (!reasoning.startsWith(state.lastReasoning)) {
      job.append({ type: "replace", reasoning, answer });
      state.lastReasoning = reasoning;
      state.lastAnswer = answer;
      return;
    }
    if (answer.startsWith(state.lastAnswer) && answer.length > state.lastAnswer.length) {
      job.append({ type: "delta", text: answer.slice(state.lastAnswer.length) });
      state.lastAnswer = answer;
    } else if (!answer.startsWith(state.lastAnswer)) {
      job.append({ type: "replace", reasoning, answer });
      state.lastAnswer = answer;
      state.lastReasoning = reasoning;
    }
  };

  const feed = (chunk: UpstreamChunk) => {
    if (chunk.content) {
      produced = true;
      emit(state.raw + chunk.content);
    }
  };

  for (let attempt = 0; attempt <= MAX_FRESH_RETRIES && !produced; attempt++) {
    if (job.aborted) break;
    try {
      if (attempt > 0) {
        job.append({
          type: "status",
          text: `Connection hiccup — retrying (${attempt}/${MAX_FRESH_RETRIES})…`,
        });
      }
      await readUpstream(upstream, thinking, temperature, feed, job.signal);
      success = true;
      break;
    } catch (error) {
      lastError = error;
      if (!isRetryableUpstream(error) || job.aborted) break;
    }
  }

  if (!success && !job.aborted && produced) {
    // Recover from anywhere — including mid-way inside a tool fence (the
    // continuation finishes the block; the parser then sees it complete).
    if (state.raw.trim().length > 0) {
      try {
        job.append({ type: "status", text: "Stream dropped — recovering your reply…" });
        await readUpstream(
          [
            ...upstream,
            { role: "assistant" as const, content: state.raw },
            {
              role: "user" as const,
              content:
                "Your reply above was cut off by a connection drop. Continue EXACTLY where it stopped, mid-sentence if needed. Output ONLY the continuation — never repeat earlier text.",
            },
          ],
          thinking,
          temperature,
          feed,
          job.signal,
        );
        success = true;
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (!success) throw lastError ?? new Error("The model round produced no content.");
  return state.raw;
}

interface BackgroundTool {
  toolId: string;
  name: string;
  settled: boolean;
  result: ToolExecutionResult | null;
  promise: Promise<void>;
}

async function runCodeTurn(
  job: TurnJob,
  history: RouterMessage[],
  decision: RouteDecision,
  resumeFrom: string | null,
  workspaceId: string,
  startedAt: number,
): Promise<void> {
  const send = (event: TurnEvent) => job.append(event);

  let workspaceText: string;
  try {
    workspaceText = await workspaceContextText(workspaceId);
  } catch {
    workspaceText = "(workspace unavailable)";
  }
  const systemPrompt = `${decision.systemPrompt}

${codeToolDocs()}

CURRENT WORKSPACE STATE:
${workspaceText}`;

  const roundHistory: { role: "user" | "assistant"; content: string }[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const temperature = decision.route === "fast" ? 0.4 : decision.route === "deep" ? 0.6 : 0.7;

  const backgroundTools: BackgroundTool[] = [];

  const runRound = (roundResume: string | null): Promise<string> =>
    readCodeRound(
      job,
      [{ role: "system" as const, content: systemPrompt }, ...roundHistory],
      decision.thinking,
      temperature,
      roundResume,
    );

  /** Execute a tool; returns "skipped" when the user chose to continue. */
  const executeWithSkip = async (
    call: { tool: string; args: Record<string, unknown> },
    toolId: string,
    skipAllowed: boolean,
  ): Promise<{ kind: "result"; result: ToolExecutionResult } | { kind: "skipped"; promise: Promise<ToolExecutionResult> }> => {
    const lastUserMessage =
      [...roundHistory].reverse().find((m) => m.role === "user" && !m.content.startsWith("[TOOL "))?.content ?? null;
    const execPromise = executeCodeTool(call.tool, call.args, {
      workspaceId,
      signal: job.signal,
      ...(lastUserMessage ? { lastUserMessage } : {}),
    });
    if (!skipAllowed) {
      const result = await execPromise;
      return { kind: "result", result };
    }
    const skipPromise = new Promise<void>((resolve) => {
      job.registerSkip(toolId, resolve);
    });
    const outcome = (await Promise.race([
      execPromise.then(
        (result) => ({ kind: "result" as const, result }),
        (error: unknown) =>
          ({
            kind: "result" as const,
            result: {
              ok: false,
              subtitle: `${call.tool} failed`,
              text: `Tool ${call.tool} failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          }) satisfies { kind: "result"; result: ToolExecutionResult },
      ),
      skipPromise.then(() => ({ kind: "skipped" as const })),
    ])) as { kind: "result"; result: ToolExecutionResult } | { kind: "skipped" };
    job.clearSkip(toolId);
    if (outcome.kind === "skipped") {
      return { kind: "skipped", promise: execPromise };
    }
    return outcome;
  };

  const emitToolResult = (toolId: string, result: ToolExecutionResult): void => {
    send({
      type: "tool_result",
      toolId,
      ok: result.ok,
      result: result.text,
      subtitle: result.subtitle,
      ...(result.resultData ? { resultData: result.resultData } : {}),
    });
  };

  let producedContent = Boolean(resumeFrom);
  let toolCalls = 0;
  let corrections = 0;
  let modelFinished = false;
  /** Tools actually executed this turn — powers the fabrication guard. */
  const calledTools = new Set<string>();

  /* ---------------- main loop: model round → tool → model round ------ */
  while (!job.aborted) {
    let raw: string;
    try {
      raw = await runRound(toolCalls === 0 && !producedContent ? resumeFrom : null);
    } catch (error) {
      if (job.aborted) break;
      if (producedContent) {
        send({
          type: "warning",
          text: "The connection wobbled and recovery failed — this reply may be incomplete.",
        });
        send({ type: "done", elapsedMs: Date.now() - startedAt, partial: true });
      } else {
        const message = isAbortLike(error)
          ? "The model stream kept stalling. Nothing was lost — please try again."
          : `OnyxCode could not complete the reply. ${errorDetail(error) || "Please try again."}`;
        send({ type: "error", message });
      }
      return;
    }
    if (job.aborted) break;
    producedContent = producedContent || raw.trim().length > 0;

    const block = extractToolBlocks(raw);
    if (!block) {
      // No tool block — is the model merely ANNOUNCING an action it never
      // ran? One bounded corrective round demands the real block.
      const visibleAnswer = splitThinking(visiblePortion(raw)).answer.trim();
      const announced = detectAnnouncedTool(visibleAnswer);
      if (announced && corrections < 2 && !job.aborted) {
        corrections += 1;
        roundHistory.push({ role: "assistant", content: visibleAnswer });
        roundHistory.push({
          role: "user",
          content: `You wrote that you would ${announced.action}, but you did NOT emit the onyxtool block — the action has not happened. Emit the tool block NOW as the ONLY content of your reply, in exactly this shape:

\`\`\`onyxtool
${announced.example}
\`\`\`

Replace the placeholders with real values from the conversation. No prose, just the block.`,
        });
        continue;
      }
      modelFinished = true;
      break;
    }
    if (!block.complete) {
      // Unterminated fence — release it as literal text, nothing is lost.
      const fenceIdx = raw.search(/```[ \t]*onyxtool/i);
      const remainder = raw.slice(fenceIdx);
      send({ type: "warning", text: "A tool block was left unfinished — kept as text." });
      if (remainder.trim().length > 0) send({ type: "delta", text: `\n\n${remainder}` });
      modelFinished = true;
      break;
    }

    // One reply may batch several calls (single object, array, or several
    // fences) — they all run in order in this round.
    const calls = block.jsonTexts
      .map((json) => parseToolCalls(json))
      .filter((list): list is ToolCall[] => list !== null)
      .flat();
    if (calls.length === 0) {
      send({ type: "warning", text: "A malformed tool block was ignored." });
      modelFinished = true;
      break;
    }

    const visibleText = splitThinking(visiblePortion(raw)).answer.trim();

    // Fabrication guard: the reply CLAIMS a completed file write (quoting
    // tool-result phrasing) but no manage_files call was emitted this round
    // or any earlier one — the claimed change does not exist. Demand the
    // real block before anything else runs.
    const roundTools = new Set(calls.map((c) => c.tool));
    if (
      !calledTools.has("manage_files") &&
      !roundTools.has("manage_files") &&
      detectFabricatedFileWrite(visibleText) &&
      corrections < 2 &&
      !job.aborted
    ) {
      corrections += 1;
      roundHistory.push({ role: "assistant", content: visibleText });
      roundHistory.push({
        role: "user",
        content: `Your reply described file changes as already written ("used tool manage_files", "wrote bytes to…"), but you did NOT emit a manage_files block — NOTHING was written to the workspace. That text was a fabrication; results only ever arrive as [TOOL RESULT] messages after you emit a block.

Emit the tool call(s) NOW as the ONLY content of your reply. A single call:

\`\`\`onyxtool
{"tool": "manage_files", "args": {"action": "write", "path": "index.html", "content": "<the full updated file content>"}}
\`\`\`

…or batch several calls as a JSON array in ONE block (e.g. the write, then start_preview). No prose.`,
      });
      continue;
    }

    if (toolCalls + calls.length > MAX_TOOL_ROUNDS) {
      send({ type: "warning", text: "Tool budget for this reply reached — finishing up." });
      modelFinished = true;
      break;
    }

    roundHistory.push({
      role: "assistant",
      content: visibleText || `(calling ${calls.map((c) => c.tool).join(", ")})`,
    });
    const resultLines: string[] = [];

    for (const call of calls) {
      toolCalls += 1;
      producedContent = true;
      calledTools.add(call.tool);

      const toolId = `t${toolCalls}-${Math.random().toString(36).slice(2, 8)}`;
      send({
        type: "tool_call",
        toolId,
        name: call.tool,
        subtitle: describeToolCall(call),
        args: JSON.stringify(call.args, null, 2),
      });

      const outcome = await executeWithSkip(call, toolId, true);

      if (outcome.kind === "result") {
        emitToolResult(toolId, outcome.result);
        resultLines.push(
          `[TOOL RESULT] ${call.tool} — ${outcome.result.ok ? "success" : "failure"}\n${outcome.result.text.slice(0, 4000)}`,
        );
      } else {
        // Skip-wait: the tool keeps running detached; the agent continues now.
        send({ type: "tool_status", toolId, backgrounded: true, subtitle: "Running in background" });
        const background: BackgroundTool = {
          toolId,
          name: call.tool,
          settled: false,
          result: null,
          promise: Promise.resolve(),
        };
        background.promise = outcome.promise.then(
          (result) => {
            background.result = result;
            background.settled = true;
          },
          (error: unknown) => {
            background.result = {
              ok: false,
              subtitle: `${call.tool} failed`,
              text: `Tool ${call.tool} failed: ${error instanceof Error ? error.message : String(error)}`,
            };
            background.settled = true;
          },
        );
        backgroundTools.push(background);
        resultLines.push(
          `[TOOL STATUS] ${call.tool} is still running in the background — the user chose to continue without waiting.`,
        );
      }
    }

    roundHistory.push({
      role: "user",
      content: `${resultLines.join("\n\n")}

Continue now. The user's request may need several steps (scaffold THEN preview, save THEN verify…). If any tool work is still needed, end THIS reply with a tool block — a single call, or a JSON array of calls executed in order:

\`\`\`onyxtool
[{"tool": "<tool-name>", "args": {}}, {"tool": "<tool-name>", "args": {}}]
\`\`\`

Use the real tool names and args for whatever you actually intend. If everything is done, write your final answer with NO tool block — never promise future tool actions.`,
    });
  }

  if (job.aborted) {
    if (job.cancelReason === "ttl") {
      send({
        type: "error",
        message: "This reply ran too long and was stopped. Please try a shorter request.",
      });
      return;
    }
    send({ type: "cancelled" });
    return;
  }

  /* ---------------- backgrounded tools: hold the turn open ----------- */
  if (backgroundTools.length > 0) {
    send({
      type: "status",
      text: `Waiting for ${backgroundTools.length} background tool${backgroundTools.length === 1 ? "" : "s"}…`,
    });
    await Promise.race([
      Promise.all(backgroundTools.map((t) => t.promise)),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, BG_TOOL_CAP_MS);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);

    let late = 0;
    for (const tool of backgroundTools) {
      if (tool.settled && tool.result) {
        emitToolResult(tool.toolId, tool.result);
        late += 1;
      } else {
        send({
          type: "tool_result",
          toolId: tool.toolId,
          ok: false,
          result: "The background tool did not finish within the wait window.",
          subtitle: "Timed out",
        });
        void tool.promise; // keep the chain observed
      }
    }

    // The model already wrapped up — give it the late results so it can react.
    if (late > 0 && modelFinished && !job.aborted) {
      const resultLines = backgroundTools
        .filter((t) => t.settled && t.result)
        .map((t) => `[TOOL RESULT] ${t.name}\n${(t.result?.text ?? "").slice(0, 2000)}`)
        .join("\n\n");
      roundHistory.push({
        role: "user",
        content: `${resultLines}\n\nThe background tools finished. Briefly acknowledge the results and wrap up — no new tool calls.`,
      });
      try {
        const bonusRaw = await runRound(null);
        // A stray tool block in the bonus round is executed synchronously,
        // then one final round closes the turn — never an endless chain.
        const bonusBlock = extractToolBlocks(bonusRaw);
        if (bonusBlock?.complete) {
          const bonusCalls = bonusBlock.jsonTexts
            .map((json) => parseToolCalls(json))
            .filter((list): list is ToolCall[] => list !== null)
            .flat();
          const bonusCall = bonusCalls[0];
          if (bonusCall) {
            const bonusId = `t${toolCalls + 1}-bonus`;
            send({
              type: "tool_call",
              toolId: bonusId,
              name: bonusCall.tool,
              subtitle: describeToolCall(bonusCall),
              args: JSON.stringify(bonusCall.args, null, 2),
            });
            const outcome = await executeWithSkip(bonusCall, bonusId, false);
            if (outcome.kind === "result") emitToolResult(bonusId, outcome.result);
            roundHistory.push({
              role: "user",
              content: `[TOOL RESULT] ${bonusCall.tool}\n${outcome.kind === "result" ? outcome.result.text.slice(0, 2000) : "(still running)"}\n\nWrite your final answer now — no more tool calls.`,
            });
            await runRound(null);
          }
        }
      } catch {
        // Keep whatever streamed before the failure.
        if (!job.aborted) {
          send({
            type: "warning",
            text: "The wrap-up round was interrupted — the results above are still valid.",
          });
        }
      }
    }
  }

  if (job.aborted) {
    send({ type: "cancelled" });
    return;
  }

  send({ type: "done", elapsedMs: Date.now() - startedAt });
}

async function runTurnPipeline(
  job: TurnJob,
  messages: RouterMessage[],
  preference: ModelPreference,
  resumeFrom: string | null,
  options?: TurnJobOptions,
): Promise<void> {
  const startedAt = Date.now();
  const mode = options?.mode ?? "agent";
  const decision = routeRequest(messages, preference, mode);
  const history = messages.slice(-decision.historyWindow);

  const temperature = decision.route === "fast" ? 0.4 : decision.route === "deep" ? 0.6 : 0.7;

  const send = (event: TurnEvent) => job.append(event);

  send({
    type: "route",
    route: decision.route,
    label: decision.label,
    model: decision.model,
    reason: decision.reason,
    thinking: decision.thinking,
    resume: Boolean(resumeFrom),
  });

  // Seed the replayable log with the recovered base so any viewer that
  // re-attaches from index 0 reconstructs the full reply.
  if (resumeFrom) {
    send({ type: "replace", reasoning: "", answer: resumeFrom });
  }

  // Code mode: multi-round tool loop (create_app, previews, database, …).
  if (mode === "code" && options?.workspaceId) {
    await runCodeTurn(job, history, decision, resumeFrom, options.workspaceId, startedAt);
    return;
  }

  const upstreamMessages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: decision.systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content }) as const),
  ];

  let rawSoFar = resumeFrom ?? "";
  let lastReasoning = "";
  let lastAnswer = resumeFrom ?? "";
  let producedContent = rawSoFar.length > 0;
  let recoveredOnce = false;

  // While the opening "THINKING:" marker is still arriving one delta at
  // a time ("TH", "THIN", …) hold emission — otherwise those fragments
  // would flash as answer text before the marker completes.
  const openMarkerPending = (raw: string): boolean => {
    if (resumeFrom) return false;
    const stripped = raw.replace(/^[*_#>\s]*/, "");
    const head = stripped.slice(0, REASONING_OPEN.length).toUpperCase();
    if (head.length === 0) return raw.length < 8;
    return REASONING_OPEN.startsWith(head) && head.length < REASONING_OPEN.length;
  };

  const emitSplit = (nextRaw: string) => {
    rawSoFar = nextRaw;
    if (openMarkerPending(rawSoFar)) return;
    const { reasoning, answer } = splitThinking(nextRaw);
    if (reasoning.startsWith(lastReasoning) && reasoning.length > lastReasoning.length) {
      send({ type: "reasoning", text: reasoning.slice(lastReasoning.length) });
      lastReasoning = reasoning;
    } else if (!reasoning.startsWith(lastReasoning)) {
      send({ type: "replace", reasoning, answer });
      lastReasoning = reasoning;
      lastAnswer = answer;
      return;
    }
    if (answer.startsWith(lastAnswer) && answer.length > lastAnswer.length) {
      send({ type: "delta", text: answer.slice(lastAnswer.length) });
      lastAnswer = answer;
    } else if (!answer.startsWith(lastAnswer)) {
      send({ type: "replace", reasoning, answer });
      lastAnswer = answer;
      lastReasoning = reasoning;
    }
  };

  const attemptOnce = async (continueFrom: string | null): Promise<boolean> => {
    const upstream = continueFrom
      ? [
          { role: "system" as const, content: decision.systemPrompt },
          ...history.map((m) => ({ role: m.role, content: m.content }) as const),
          { role: "assistant" as const, content: continueFrom },
          {
            role: "user" as const,
            content:
              "Your reply above was cut off by a connection drop. Continue EXACTLY where it stopped, mid-sentence if needed. Output ONLY the continuation — never repeat earlier text.",
          },
        ]
      : upstreamMessages;

    await readUpstream(
      upstream,
      decision.thinking,
      temperature,
      (chunk) => {
        if (chunk.content) {
          producedContent = true;
          emitSplit(rawSoFar + chunk.content);
        }
      },
      job.signal,
    );
    return true;
  };

  let success = false;
  let lastError: unknown = null;

  // Fresh attempts while nothing has been produced yet.
  for (let attempt = 0; attempt <= MAX_FRESH_RETRIES && !producedContent; attempt++) {
    if (job.aborted) break;
    try {
      if (attempt > 0) {
        send({
          type: "status",
          text: `Connection hiccup — retrying (${attempt}/${MAX_FRESH_RETRIES})…`,
        });
      }
      await attemptOnce(null);
      success = true;
      break;
    } catch (error) {
      lastError = error;
      if (!isRetryableUpstream(error) || job.aborted) break;
    }
  }

  // Mid-stream recovery: content already streamed, continue the reply.
  if (!success && !job.aborted && producedContent) {
    const answerSoFar = splitThinking(rawSoFar).answer;
    if (answerSoFar.length > 0 && !recoveredOnce) {
      recoveredOnce = true;
      try {
        send({ type: "status", text: "Stream dropped — recovering your reply…" });
        await attemptOnce(answerSoFar);
        success = true;
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (job.aborted) {
    if (job.cancelReason === "ttl") {
      send({
        type: "error",
        message: "This reply ran too long and was stopped. Please try a shorter question.",
      });
      return;
    }
    // User cancel: keep whatever streamed; viewers finalize the partial.
    send({ type: "cancelled" });
    return;
  }

  if (success) {
    send({ type: "done", elapsedMs: Date.now() - startedAt });
  } else if (producedContent) {
    // Never destroy a reply we already streamed — finish with a note.
    send({
      type: "warning",
      text: "The connection wobbled and recovery failed — this reply may be incomplete.",
    });
    send({ type: "done", elapsedMs: Date.now() - startedAt, partial: true });
  } else {
    const message = isAbortLike(lastError)
      ? "The model stream kept stalling. Nothing was lost — please try again."
      : `Terra could not complete the reply. ${errorDetail(lastError) || "Please try again."}`;
    send({ type: "error", message });
  }
}
