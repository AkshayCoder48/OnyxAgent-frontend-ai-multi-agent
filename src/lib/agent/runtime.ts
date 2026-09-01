"use client";

/**
 * Agent runtime — the backendless replacement for the original PydanticAI
 * agent + WebSocket backend.
 *
 * The runtime drives a custom agent loop:
 *   1. Build an OpenAI-compatible Chat Completions request (system prompt +
 *      conversation history + tools array from the registry).
 *   2. POST through `/api/chat-proxy` with the `x-target-url` header set to
 *      the user's AI provider endpoint. The proxy adds CORS headers and
 *      streams the SSE response back unchanged.
 *   3. Parse the SSE stream chunk-by-chunk, dispatching `text_delta`,
 *      `thinking_delta`, `reasoning_delta`, and `tool_call_delta` events as
 *      they arrive.
 *   4. After the stream ends, collect any `tool_calls` the model requested.
 *      For each, request HITL approval if the tool is flagged
 *      `requires_approval`. Execute the tool, emit `tool_result`, and loop.
 *   5. Continue until the model returns a final response with no tool calls
 *      (max 10 rounds).
 *   6. Emit `final_result` → `message_saved` → `complete`.
 *
 * Emits WSEvent-shaped objects via the supplied `emit` callback so the
 * cloned app's `use-chat.ts` hook (which was written to consume the original
 * WebSocket frames) keeps working unchanged.
 *
 * Provider quirks handled:
 *   - `reasoning_content` (DeepSeek / Moonshot / g4f.space) → `reasoning_delta`
 *   - `reasoning` (vLLM relays) → `reasoning_delta`
 *   - `thinking` (Anthropic / Claude via some relays) → `thinking_delta`
 *   - `stream_options: { include_usage: true }` → usage chunk parsed
 *   - `stop_reason` (vLLM) handled alongside OpenAI's `finish_reason`
 *   - Partial content saved on stream interruption (abort/network error)
 */

import { nanoid } from "nanoid";
import type {
  WSEvent,
  MessagePart,
  ToolCall,
  AskUserQuestion,
} from "@/types";
import { listTools, getTool, type ToolContext } from "@/lib/tools/registry";
import "@/lib/tools"; // Side-effect: registers all built-in tools (datetime, chart, ask_user, e2b_*, etc.)
import { conversationService, settingsService } from "@/lib/services";
import { readChatTheme, genuiThemePromptBlock } from "@/lib/genui/theme";

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export interface AgentTurnOptions {
  /** User id (used to scope Dexie queries + E2B sandbox). */
  userId: string;
  /** Existing conversation id, or null to create one on first turn. */
  conversationId: string | null;
  /** The user's prompt for this turn. */
  userMessage: string;
  /** File IDs already uploaded to the workspace — included as `file_ids`. */
  fileIds?: string[];
  /** AI provider config: base URL, decrypted API key, model name, tools flag. */
  provider: {
    baseUrl: string;
    apiKey: string;
    model: string;
    /** Some providers (Responses API) need a slightly different shape. */
    modelType?: "chat" | "responses";
    toolsEnabled?: boolean;
    /** When true, use the base URL as-is (no /chat/completions suffix). */
    noPrefix?: boolean;
    /** When true, sends `chat_template_kwargs: {"enable_thinking": true}` in
     *  the request body (for providers like Poolside). */
    thinkingEnabled?: boolean;
  };
  /** System prompt (already includes skills/MCP/custom-tools/env sections). */
  systemPrompt: string;
  /** Optional sampling temperature override. */
  temperature?: number | null;
  /** Optional extended-thinking effort (some providers). */
  thinkingEffort?: "low" | "medium" | "high" | null;
  /** Emit a WSEvent to the consumer (replaces WebSocket send). */
  emit: (event: WSEvent) => void;
  /** Caller-supplied abort signal (e.g. user clicked Stop). */
  signal?: AbortSignal;
  /** Optional context the tools can read (vault key, E2B sandbox key, env vars…). */
  toolContext?: ToolContext;
}

export interface AgentTurnResult {
  conversationId: string;
  assistantMessageId: string;
  /** Flat text content (no reasoning / tool calls). */
  content: string;
  /** Reasoning trace if any. */
  reasoning?: string;
  thinking?: string;
  /** Tool calls executed this turn. */
  toolCalls: ToolCall[];
  /** Token usage if the provider reported it. */
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  /** Why the loop ended. */
  stopReason:
    | "complete"
    | "max_rounds"
    | "aborted"
    | "error"
    | "no_provider";
}

const MAX_ROUNDS = 50;
const CHAT_PROXY_URL = "/api/chat-proxy";

// ---------------------------------------------------------------------------
// Token-saving truncation functions.
// When the AI writes a large file via create_file/write_file, the full file
// content is in the tool call arguments. If we send this back in the message
// history on the next round, the API charges for ALL those tokens again.
// These functions truncate large args/results before they go into `messages`.
// The FULL values are preserved in `allToolCalls` for the UI.
// ---------------------------------------------------------------------------

/** Tools where the args contain large content (files, code, etc). */
const LARGE_ARG_TOOLS = new Set([
  "create_file", "write_file", "edit_file", "create_custom_tool",
  "preview_image", "workflow", "create_file_chunk",
  "ocr_image", "ocr_pdf",
]);

/** Max length of any single string value in tool args sent to the API. */
const MAX_ARG_LEN = 500;

/** NO truncation — the user requested all results be sent in full to the AI.
 *  Tool results are in the AI's workspace, not the context window, so there's
 *  no risk of maxing context. The previous per-tool budgets caused the AI to
 *  see truncated file content and get confused. */

function truncateToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!LARGE_ARG_TOOLS.has(toolName)) return args;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > MAX_ARG_LEN) {
      // Truncate but ensure the string is properly terminated (no unterminated strings)
      out[key] = value.slice(0, MAX_ARG_LEN) + `... [truncated, ${value.length} chars total]`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Safely stringify tool call arguments as JSON. If the args contain
 * non-serializable values (undefined, functions, circular refs), or if
 * the JSON string would be malformed (unterminated strings from streaming
 * truncation), fall back to a safe representation.
 *
 * This fixes the "Unterminated string starting at: line 1 column 42" error
 * that occurs when streaming tool call args are truncated mid-string and
 * passed back to the API as malformed JSON.
 */
function safeStringifyArgs(args: Record<string, unknown>): string {
  try {
    // First, clean any _streaming sentinel values (they're not valid for the API)
    const cleanArgs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (key === "_streaming") continue;
      if (key === "_raw") {
        cleanArgs["raw"] = value;
        continue;
      }
      // If value is a string that looks truncated (ends mid-escape), fix it
      if (typeof value === "string") {
        // Remove any trailing incomplete escape sequences
        const cleaned = value.replace(/\\+$/, (match) => {
          // If odd number of backslashes, the last one is an incomplete escape
          return match.length % 2 === 1 ? match.slice(0, -1) : match;
        });
        cleanArgs[key] = cleaned;
      } else {
        cleanArgs[key] = value;
      }
    }
    const result = JSON.stringify(cleanArgs);
    // Verify the JSON is valid by parsing it back
    JSON.parse(result);
    return result;
  } catch {
    // If JSON.stringify fails, return a minimal valid JSON
    return JSON.stringify({ error: "args could not be serialized" });
  }
}

function truncateResult(_toolName: string, result: string): string {
  // NO truncation — return the full result. The user requested all tool
  // results be sent in full to the AI without any length limits.
  return result;
}

// ---------------------------------------------------------------------------
// Chat Completions message shape (what we send to the provider).
// ---------------------------------------------------------------------------

interface ChatCompletionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** For assistant messages that requested tools. */
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  /** For tool-result messages. */
  tool_call_id?: string;
  name?: string;
  /** DeepSeek/moonshot/g4f reasoning_content — MUST be passed back to the
   *  API in thinking mode, otherwise the provider rejects the request with
   *  "The reasoning_content in the thinking mode must be passed back to the API." */
  reasoning_content?: string;
}

interface ChatCompletionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// SSE parser — turns a ReadableStream<Uint8Array> into a stream of parsed
// JSON chunks. Tolerant of partial-event buffering and `data: [DONE]`.
// ---------------------------------------------------------------------------

export async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by `\n\n`.
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of rawEvent.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            yield JSON.parse(payload) as Record<string, unknown>;
          } catch {
            // ignore malformed line — keep streaming.
          }
        }
      }
    }
    // flush trailing partial event
    if (buffer.trim()) {
      for (const line of buffer.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          yield JSON.parse(payload) as Record<string, unknown>;
        } catch {
          // ignore
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function nowISO(): string {
  return new Date().toISOString();
}

/** Pull `content` / `reasoning_content` / `reasoning` / `thinking` deltas
 *  out of a streamed chunk. Returns null if the chunk is a no-op. */
interface DeltaAccumulator {
  text?: string;
  thinking?: string;
  reasoning?: string;
  toolCalls?: Array<{
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
  }>;
}

export function extractDelta(chunk: Record<string, unknown>): DeltaAccumulator | null {
  const choices = chunk.choices as
    | Array<{ delta?: Record<string, unknown>; finish_reason?: string | null; stop_reason?: string | null }>
    | undefined;
  if (!choices || choices.length === 0) {
    // Could still carry a `usage` chunk — caller handles that separately.
    if (chunk.usage) return {};
    return null;
  }
  const choice = choices[0];
  if (!choice) return null;
  const delta = (choice.delta ?? {}) as Record<string, unknown>;
  const out: DeltaAccumulator = {};
  if (typeof delta.content === "string" && delta.content.length > 0) {
    out.text = delta.content;
  }
  // Reasoning (DeepSeek/Moonshot/g4f) — `reasoning_content` is the canonical
  // field, some relays also expose `reasoning`.
  const reasoning =
    (delta.reasoning_content as string | undefined) ??
    (delta.reasoning as string | undefined);
  if (typeof reasoning === "string" && reasoning.length > 0) {
    out.reasoning = reasoning;
  }
  // Thinking (Anthropic-style native reasoning, relayed by some proxies).
  const thinking = delta.thinking as string | undefined;
  if (typeof thinking === "string" && thinking.length > 0) {
    out.thinking = thinking;
  }
  // Tool calls.
  const toolCalls = delta.tool_calls as
    | Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>
    | undefined;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    out.toolCalls = toolCalls.map((tc) => ({
      index: tc.index,
      id: tc.id,
      name: tc.function?.name,
      arguments: tc.function?.arguments,
    }));
  }
  return out;
}

/** Pull the finish reason out of a chunk — handles both `finish_reason`
 *  (OpenAI standard) and `stop_reason` (vLLM). */
export function extractFinishReason(chunk: Record<string, unknown>): string | null {
  const choices = chunk.choices as
    | Array<{ finish_reason?: string | null; stop_reason?: string | null }>
    | undefined;
  if (!choices || choices.length === 0) return null;
  const choice = choices[0];
  if (!choice) return null;
  return choice.finish_reason ?? choice.stop_reason ?? null;
}

/**
 * Parse DSML (DeepSeek-style Markup Language) tool calls from text content.
 * Some providers (e.g. FreeGPT/freeaixyz4all) don't support the standard
 * OpenAI tool_calls API — instead, the model writes tool calls as XML-like
 * tags in the text:
 *
 *   <｜｜DSML｜｜tool_calls>
 *   <｜｜DSML｜｜invoke name="list_chats">
 *   </｜｜DSML｜｜invoke>
 *   <｜｜DSML｜｜invoke name="run_terminal">
 *   <｜｜DSML｜｜parameter name="command" string="true">ls -la</｜｜DSML｜｜parameter>
 *   </｜｜DSML｜｜invoke>
 *   </｜｜DSML｜｜tool_calls>
 *
 * This parser detects the pattern, extracts tool name + args, and returns
 * them as a tool_calls array (same format as the standard API). The caller
 * then strips the DSML tags from the visible text.
 *
 * Returns { toolCalls: [...], cleanText: "..." } or null if no DSML found.
 */
function parseDSMLToolCalls(text: string): {
  toolCalls: Array<{ index: number; id: string; name: string; arguments: string }>;
  cleanText: string;
} | null {
  // Quick check — if the DSML marker isn't in the text, skip.
  if (!text.includes("DSML")) return null;

  let cleanText = text;
  const toolCalls: Array<{ index: number; id: string; name: string; arguments: string }> = [];
  let index = 0;

  // Remove the entire <｜｜DSML｜｜tool_calls>...</｜｜DSML｜｜tool_calls> block.
  // The special character ｜ (U+FF5C) is used by DeepSeek.
  const dsmlBlockRe = /<｜｜DSML｜｜tool_calls>([\s\S]*?)<\/｜｜DSML｜｜tool_calls>/g;
  const dsmlBlockMatch = dsmlBlockRe.exec(text);

  if (!dsmlBlockMatch) {
    // Also try without closing tag (streaming — may be incomplete).
    const openTag = "<｜｜DSML｜｜tool_calls>";
    const openIdx = text.indexOf(openTag);
    if (openIdx === -1) return null;
    // Has open tag but no close — extract from open tag to end.
    const block = text.slice(openIdx + openTag.length);
    cleanText = text.slice(0, openIdx).trim();

    // Parse invoke tags from the block.
    const invokeRe = /<｜｜DSML｜｜invoke\s+name="([^"]+)">([\s\S]*?)(?:<\/｜｜DSML｜｜invoke>|$)/g;
    let invokeMatch;
    while ((invokeMatch = invokeRe.exec(block)) !== null) {
      const name = invokeMatch[1]!;
      const body = invokeMatch[2] ?? "";
      const args: Record<string, unknown> = {};

      // Parse <｜｜DSML｜｜parameter name="X" string="true">VALUE</｜｜DSML｜｜parameter>
      const paramRe = /<｜｜DSML｜｜parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜｜DSML｜｜parameter>/g;
      let paramMatch;
      while ((paramMatch = paramRe.exec(body)) !== null) {
        const paramName = paramMatch[1]!;
        const paramValue = paramMatch[2]!.trim();
        args[paramName] = paramValue;
      }

      toolCalls.push({
        index: index++,
        id: `dsml_${Date.now()}_${index}`,
        name,
        arguments: JSON.stringify(args),
      });
    }
  } else {
    // Has both open and close tags.
    cleanText = (text.slice(0, dsmlBlockMatch.index) + text.slice(dsmlBlockRe.lastIndex)).trim();
    const block = dsmlBlockMatch[1] ?? "";

    const invokeRe = /<｜｜DSML｜｜invoke\s+name="([^"]+)">([\s\S]*?)<\/｜｜DSML｜｜invoke>/g;
    let invokeMatch;
    while ((invokeMatch = invokeRe.exec(block)) !== null) {
      const name = invokeMatch[1]!;
      const body = invokeMatch[2] ?? "";
      const args: Record<string, unknown> = {};

      const paramRe = /<｜｜DSML｜｜parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜｜DSML｜｜parameter>/g;
      let paramMatch;
      while ((paramMatch = paramRe.exec(body)) !== null) {
        const paramName = paramMatch[1]!;
        const paramValue = paramMatch[2]!.trim();
        args[paramName] = paramValue;
      }

      toolCalls.push({
        index: index++,
        id: `dsml_${Date.now()}_${index}`,
        name,
        arguments: JSON.stringify(args),
      });
    }
  }

  if (toolCalls.length === 0 && !dsmlBlockMatch) return null;

  return { toolCalls, cleanText };
}

function extractUsage(chunk: Record<string, unknown>): {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
} | null {
  const usage = chunk.usage as
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      }
    | undefined;
  if (!usage) return null;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

// ---------------------------------------------------------------------------
// Stream a single round of Chat Completions.
// ---------------------------------------------------------------------------

interface RoundResult {
  content: string;
  /** Text that was generated BEFORE the first tool call in this round.
   *  Used by buildAssistantParts to place pre-tool text above the tool card. */
  textBeforeTools?: string;
  thinking: string;
  reasoning: string;
  toolCalls: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
  finishReason: string | null;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  aborted: boolean;
}

async function streamRound(
  opts: {
    messages: ChatCompletionMessage[];
    tools: ChatCompletionTool[];
    provider: AgentTurnOptions["provider"];
    temperature?: number | null;
    thinkingEffort?: "low" | "medium" | "high" | null;
    emit: (e: WSEvent) => void;
    signal?: AbortSignal;
    /** 1-based agent round number — stamped into the model_request_start
     *  event so the UI can create a separate reasoning panel per round. */
    roundNumber?: number;
  },
): Promise<RoundResult> {
  const {
    messages,
    tools,
    provider,
    temperature,
    thinkingEffort,
    emit,
    signal,
    roundNumber,
  } = opts;

  // Target URL — strip trailing slash. If the provider has `no_prefix` set,
  // use the base URL as-is (no /chat/completions suffix). Otherwise append
  // /chat/completions (standard OpenAI-compatible endpoint).
  const base = provider.baseUrl.replace(/\/$/, "");
  const targetUrl = provider.noPrefix
    ? base
    : `${base}/chat/completions`;

  const body: Record<string, unknown> = {
    model: provider.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools.length > 0 && provider.toolsEnabled !== false) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  if (typeof temperature === "number") body.temperature = temperature;
  // Provider-specific thinking toggle (e.g. Poolside's chat_template_kwargs).
  if (provider.thinkingEnabled) {
    body.chat_template_kwargs = { enable_thinking: true };
  }
  if (thinkingEffort) {
    // OpenAI reasoning effort hint + DeepSeek-style `thinking` flag — the
    // proxy passes both through; the provider ignores whichever it doesn't
    // recognise.
    body.reasoning_effort = thinkingEffort;
    body.thinking = { type: "enabled", effort: thinkingEffort };
  }

  emit({ type: "llm_started", timestamp: nowISO() });

  // RATE-LIMIT RESILIENCE (PRD §7): retry 429/529 + provider rate-limit
  // errors with exponential backoff + jitter, honoring Retry-After /
  // x-ratelimit-reset-headers when present. Mirrors the proven pattern
  // from src/lib/e2b/client.ts. Each wait emits a `rate_limited` event so
  // the UI can show "Rate limit reached — retrying automatically in Ns…"
  // instead of silently dying. Retries are inherently single-flight (this
  // loop is sequential within the turn) and the abort signal is honored
  // during the wait.
  const MAX_RATE_LIMIT_RETRIES = 3;
  const parseRetryAfterMs = (resp: Response): number | null => {
    const ra = resp.headers.get("retry-after");
    if (ra) {
      const asSeconds = Number(ra);
      if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
      const asDate = Date.parse(ra);
      if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
    }
    // OpenAI-style reset hints (seconds until the window resets).
    const reset =
      resp.headers.get("x-ratelimit-reset-requests") ??
      resp.headers.get("x-ratelimit-reset-tokens");
    if (reset) {
      const m = reset.match(/[\d.]+/);
      if (m) {
        const secs = parseFloat(m[0]);
        if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
      }
    }
    return null;
  };

  let response: Response;
  let rateLimitAttempts = 0;
  for (;;) {
    // Pass the target URL via ?url= query param — Vercel can't strip query
    // params. Use Accept: text/event-stream to signal streaming intent to
    // all proxies.
    response = await fetch(`${CHAT_PROXY_URL}?url=${encodeURIComponent(targetUrl)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-target-url": targetUrl,
        Authorization: `Bearer ${provider.apiKey}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
      // Prevent browser/proxy from buffering the response.
      cache: "no-store",
    });

    const status = response.status;
    let isRateLimited = status === 429 || status === 529;
    if (!isRateLimited && status >= 400) {
      // Some providers/proxies normalize 429 to an error-body with another
      // status — sniff the body BEFORE deciding.
      const text = await response.clone().text().catch(() => "");
      isRateLimited = /rate.?limit|too many requests|quota exceeded|resource_exhausted/i.test(text);
    }

    if (isRateLimited && rateLimitAttempts < MAX_RATE_LIMIT_RETRIES) {
      rateLimitAttempts += 1;
      const headerMs = parseRetryAfterMs(response);
      const backoffMs = Math.min(1000 * 2 ** (rateLimitAttempts - 1), 8000);
      const jitter = backoffMs * (0.7 + Math.random() * 0.6); // ±30%
      const delayMs = Math.min(Math.max(headerMs ?? jitter, 500), 30_000);
      emit({
        type: "rate_limited",
        data: {
          retryAfterMs: Math.round(delayMs),
          attempt: rateLimitAttempts,
          maxAttempts: MAX_RATE_LIMIT_RETRIES,
          status,
        },
        timestamp: nowISO(),
      });
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
      if (signal?.aborted) break;
      continue;
    }
    break;
  }

  if (!response.ok || !response.body) {
    let detail = `Provider returned ${response.status}`;
    try {
      const text = await response.text();
      if (text) {
        try {
          const obj = JSON.parse(text);
          const err = obj.error ?? obj.detail ?? obj.message;
          if (typeof err === "string") detail = err;
          else if (err && typeof err === "object") {
            detail = (err as { message?: string }).message ?? JSON.stringify(err);
          } else {
            detail = text.slice(0, 500);
          }
        } catch {
          detail = text.slice(0, 500);
        }
      }
    } catch {
      // ignore
    }
    throw new Error(detail);
  }

  emit({
    type: "model_request_start",
    data: { round: roundNumber ?? 1 },
    timestamp: nowISO(),
  });

  // Accumulators — built up as deltas arrive.
  let content = "";
  let thinking = "";
  let reasoning = "";
  // Track text that came BEFORE the first tool call. When the AI generates
  // text → tool call → more text in the same round, we need to know which
  // text was "pre-tool" so buildAssistantParts can put it BEFORE the tool
  // card (not after). Without this, ALL text gets concatenated and placed
  // after the tool calls, making the response look cut/split.
  let textBeforeTools = "";
  const toolCallAccumulator = new Map<
    number,
    { id: string; name: string; args: string }
  >();
  // Track which tool call indices we've already pre-emitted (so we don't
  // emit duplicate tool_call events during streaming).
  const preEmittedToolCalls = new Set<number>();
  // Track whether we've already pre-emitted DSML tool calls (from FreeGPT
  // providers that send tool calls as XML text instead of delta.tool_calls).
  let dsmlPreEmitted = false;
  let finishReason: string | null = null;
  let usage: RoundResult["usage"];
  let aborted = false;
  const roundIndex = 0; // monotonically increasing part index for the UI.

  const reader = response.body.getReader();
  try {
    for await (const chunk of parseSSEStream(reader, signal)) {
      const delta = extractDelta(chunk);
      if (delta) {
        if (delta.text) {
          content += delta.text;
          // Strip DSML tags from streaming text so the user never sees the
          // raw <｜｜DSML｜｜...> XML. The tags are parsed into tool_calls
          // after the stream ends (in the post-stream DSML parser above).
          const cleanText = delta.text.replace(/<｜｜DSML｜｜[^>]*>/g, "").replace(/<\/｜｜DSML｜｜[^>]*>/g, "");
          if (cleanText) {
            emit({
              type: "text_delta",
              data: { index: roundIndex, content: cleanText },
              timestamp: nowISO(),
            });
          }
          // REAL-TIME DSML DETECTION: When we detect the DSML tool_calls
          // open tag in the accumulated content, try to parse any complete
          // invoke tags and pre-emit tool_call events so the UI shows the
          // tool card DURING streaming (not after). This is critical for
          // FreeGPT providers that send tool calls as DSML text — without
          // this, the tool card only appears after the stream ends.
          // We retry on every text delta because the DSML tags might be
          // incomplete on the first check (streaming — tags arrive in pieces).
          if (content.includes("DSML") && !dsmlPreEmitted) {
            const dsmlResult = parseDSMLToolCalls(content);
            if (dsmlResult && dsmlResult.toolCalls.length > 0) {
              for (const tc of dsmlResult.toolCalls) {
                emit({
                  type: "tool_call",
                  data: {
                    tool_name: tc.name,
                    args: { _streaming: tc.arguments } as Record<string, unknown>,
                    tool_call_id: tc.id,
                    _preemit: true,
                  },
                  timestamp: nowISO(),
                });
              }
              dsmlPreEmitted = true;
            }
            // If DSML tag detected but no complete invoke tags yet, emit a
            // "composing" tool_call so the user sees a card immediately.
            // The card will be updated when the invoke tags complete.
            if (!dsmlPreEmitted && content.includes("tool_calls")) {
              dsmlPreEmitted = true;
              emit({
                type: "tool_call",
                data: {
                  tool_name: "tool",
                  args: { _streaming: "Composing tool call…" } as Record<string, unknown>,
                  tool_call_id: `dsml_composing_${Date.now()}`,
                  _preemit: true,
                },
                timestamp: nowISO(),
              });
            }
          }
        }
        if (delta.thinking) {
          thinking += delta.thinking;
          emit({
            type: "thinking_delta",
            data: { index: roundIndex, content: delta.thinking },
            timestamp: nowISO(),
          });
        }
        if (delta.reasoning) {
          reasoning += delta.reasoning;
          emit({
            type: "reasoning_delta",
            data: { index: roundIndex, content: delta.reasoning },
            timestamp: nowISO(),
          });
        }
        if (delta.toolCalls) {
          // Capture text that came before the first tool call. This lets
          // buildAssistantParts place pre-tool text ABOVE the tool card.
          if (toolCallAccumulator.size === 0 && content) {
            textBeforeTools = content;
          }
          for (const tc of delta.toolCalls) {
            const existing = toolCallAccumulator.get(tc.index) ?? {
              id: tc.id ?? nanoid(),
              name: tc.name ?? "",
              args: "",
            };
            if (tc.id) existing.id = tc.id;
            if (tc.name) existing.name = tc.name;
            if (tc.arguments) existing.args += tc.arguments;
            toolCallAccumulator.set(tc.index, existing);
          }
          // Emit tool_call_delta so the UI can show streaming tool call
          // arguments in realtime (the user sees the AI "writing" the file
          // content as it streams, instead of waiting for the full call to
          // complete before anything appears).
          emit({
            type: "tool_call_delta",
            data: { tool_calls: delta.toolCalls },
            timestamp: nowISO(),
          });
          // ALSO: Pre-emit a tool_call event as soon as we know the tool
          // name — even before the stream ends. Many LLM providers (g4f,
          // some OpenAI-compatible) send the entire tool call in one chunk
          // at the END of the stream, so tool_call_delta never fires during
          // streaming. By pre-emitting tool_call here (with status "pending"),
          // the UI shows the tool call card DURING streaming, not after.
          // The final tool_call event (after stream ends) will update it.
          for (const [index, tc] of toolCallAccumulator) {
            // Pre-emit as soon as we have EITHER a name OR an id. Even if
            // the name hasn't arrived yet, the card will show "Composing…"
            // and update when the name arrives.
            if ((tc.name || tc.id) && !preEmittedToolCalls.has(index)) {
              preEmittedToolCalls.add(index);
              emit({
                type: "tool_call",
                data: {
                  tool_name: tc.name || `pending-${index}`,
                  args: { _streaming: tc.args } as Record<string, unknown>,
                  tool_call_id: tc.id,
                  _preemit: true,
                },
                timestamp: nowISO(),
              });
            }
          }
        }
      }
      const fr = extractFinishReason(chunk);
      if (fr) finishReason = fr;
      const u = extractUsage(chunk);
      if (u) usage = u;
    }
  } catch (err) {
    if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      aborted = true;
      // Partial content is preserved — the caller will save it.
    } else {
      // Network blip mid-stream — keep what we have and re-throw so the
      // outer loop can emit an error event.
      throw err;
    }
  }

  emit({ type: "llm_completed", timestamp: nowISO() });

  // Parse tool-call args from accumulated JSON strings.
  const toolCalls = Array.from(toolCallAccumulator.values()).map((tc) => {
    let args: Record<string, unknown> = {};
    if (tc.args) {
      try {
        args = JSON.parse(tc.args) as Record<string, unknown>;
      } catch {
        args = { _raw: tc.args };
      }
    }
    return { id: tc.id, name: tc.name, args };
  });

  // DSML PARSER: Some providers (FreeGPT/freeaixyz4all) don't support the
  // standard OpenAI tool_calls API — the model writes tool calls as XML-like
  // tags (<｜｜DSML｜｜tool_calls>...) in the TEXT content. Parse these and
  // convert to proper tool calls. Strip the DSML tags from the content so
  // the user never sees the raw XML.
  if (toolCalls.length === 0) {
    const dsmlResult = parseDSMLToolCalls(content);
    if (dsmlResult && dsmlResult.toolCalls.length > 0) {
      content = dsmlResult.cleanText;
      for (const tc of dsmlResult.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments) as Record<string, unknown>;
        } catch {
          args = { _raw: tc.arguments };
        }
        toolCalls.push({ id: tc.id, name: tc.name, args });
      }
    }
  } else {
    // Even with standard tool_calls, strip any DSML tags that leaked into
    // the text content (some providers mix both formats).
    const dsmlResult = parseDSMLToolCalls(content);
    if (dsmlResult) {
      content = dsmlResult.cleanText;
    }
  }

  return {
    content,
    textBeforeTools: textBeforeTools || undefined,
    thinking,
    reasoning,
    toolCalls,
    finishReason,
    usage,
    aborted,
  };
}

// ---------------------------------------------------------------------------
// ask_user — emit `ask_user` and wait for `agent:ask-user-response`.
// ---------------------------------------------------------------------------

const ASK_USER_RESPONSE_EVENT = "agent:ask-user-response";

function waitForAskUser(
  questions: AskUserQuestion[],
  emit: (e: WSEvent) => void,
  signal?: AbortSignal,
): Promise<Array<{ answer: string; skipped: boolean }>> {
  return new Promise((resolve) => {
    const cleanup = () => {
      window.removeEventListener(ASK_USER_RESPONSE_EVENT, handler);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
    };
    const handler = (event: Event) => {
      const ce = event as CustomEvent<{
        answers: Array<{ answer: string; skipped: boolean }>;
      }>;
      if (!ce.detail?.answers) return;
      cleanup();
      resolve(ce.detail.answers);
    };
    let abortListener: (() => void) | null = null;
    if (signal) {
      abortListener = () => {
        cleanup();
        resolve(questions.map(() => ({ answer: "", skipped: true })));
      };
      signal.addEventListener("abort", abortListener);
    }
    window.addEventListener(ASK_USER_RESPONSE_EVENT, handler);

    emit({
      type: "ask_user",
      data: {
        questions: questions.map((q) => ({
          question: q.question,
          options: q.options,
          allow_custom: q.allowCustom,
        })),
      },
      timestamp: nowISO(),
    });
  });
}

// ---------------------------------------------------------------------------
// Build a `parts` timeline from the accumulated turn state, so it can be
// persisted alongside the flat `content` / `thinking` / `reasoning` fields.
// The order matches what the user saw live: reasoning/thinking → tools → text.
// ---------------------------------------------------------------------------
function buildAssistantParts(
  thinking: string | undefined,
  reasoning: string | undefined,
  toolCalls: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
    status?: string;
  }>,
  content: string,
  textBeforeTools?: string,
): import("@/types/chat").MessagePart[] {
  const parts: import("@/types/chat").MessagePart[] = [];
  if (thinking && thinking.trim()) {
    parts.push({ id: `p-think-${Date.now()}`, type: "thinking", content: thinking });
  }
  if (reasoning && reasoning.trim()) {
    parts.push({ id: `p-reason-${Date.now()}`, type: "reasoning", content: reasoning });
  }
  // Text that came BEFORE the first tool call goes ABOVE the tool cards.
  // This prevents the response from looking "cut" — half text above, half
  // below the tool card. Without this, ALL text gets pushed after the tools.
  if (textBeforeTools && textBeforeTools.trim()) {
    parts.push({ id: `p-text-pre-${Date.now()}`, type: "text", content: textBeforeTools });
  }
  for (const tc of toolCalls) {
    parts.push({
      id: `p-tool-${tc.id}`,
      type: "tool",
      toolCall: {
        id: tc.id,
        name: tc.name,
        args: tc.args,
        result: tc.result,
        status: (tc.status === "failed" ? "error" : tc.status ?? "completed") as
          | "pending"
          | "running"
          | "completed"
          | "error",
      },
    });
  }
  // Text AFTER tools: push only the text that came AFTER the tool calls.
  // If textBeforeTools was set, content includes both pre+post text — we
  // need to extract just the post-text (everything after textBeforeTools).
  if (content && content.trim()) {
    let postText = content;
    if (textBeforeTools && content.startsWith(textBeforeTools)) {
      postText = content.slice(textBeforeTools.length);
    }
    if (postText.trim()) {
      parts.push({ id: `p-text-${Date.now()}`, type: "text", content: postText });
    }
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Main entry — `runAgentTurn`.
// ---------------------------------------------------------------------------

/**
 * Wrap the caller-supplied `emit` so that EVERY event emitted by the runtime
 * carries the turn's `generationId` in `data.generation_id`. This is the
 * stable identity consumers use to discard stale events from a previous
 * generation (PRD §19). Events whose `data` is not an object (rare — only
 * legacy callers) pass through unchanged.
 */
function wrapEmitWithGenerationId(
  emit: (event: WSEvent) => void,
  generationId: string,
): (event: WSEvent) => void {
  return (event: WSEvent) => {
    if (event.data && typeof event.data === "object") {
      // Inject generation_id without clobbering any existing field.
      const patched = { ...(event.data as Record<string, unknown>), generation_id: generationId };
      emit({ ...event, data: patched });
    } else if (event.data === undefined) {
      emit({ ...event, data: { generation_id: generationId } });
    } else {
      // data is a primitive (string/number) — leave it alone, can't add a field.
      emit(event);
    }
  };
}

export async function runAgentTurn(opts: AgentTurnOptions): Promise<AgentTurnResult> {
  const { signal } = opts;

  // ── GENERATION IDENTITY ────────────────────────────────────────────────
  // A single `generationId` is minted at the start of every turn and threaded
  // through EVERY emitted WSEvent's `data.generation_id`. Consumers (use-chat.ts)
  // track `activeGenerationIdRef` and discard events whose generation_id doesn't
  // match. This is the critical fix for the "stale message_saved corrupts new
  // generation" bug: when the user stops generation and immediately starts a
  // new one, the old runtime's final `message_saved` event arrives AFTER the
  // new turn has begun. Without generation_id, the handler would replace the
  // new turn's temp message ID with the old turn's DB ID — hijacking all
  // subsequent text deltas onto the wrong message. With generation_id, the
  // stale event is silently dropped.
  const generationId = nanoid();
  const emit = wrapEmitWithGenerationId(opts.emit, generationId);

  // Lazily load the user's decrypted E2B sandbox API key + env-var dict
  // from the settings service. The runtime is the single source of truth
  // for these — callers (use-chat.ts) don't need to know about them. Tools
  // like `run_python` / `run_terminal` read `ctx.e2bApiKey` (legacy field
  // name — kept for back-compat with the tool implementations) and
  // `ctx.envVars` to spin up the sandbox and inject environment variables.
  //
  // If a caller already supplied a `toolContext` (e.g. tests overriding
  // `e2bApiKey`), we respect their values — only fall back to the
  // settings service for fields the caller didn't populate.
  let sandboxApiKey: string | undefined = opts.toolContext?.e2bApiKey;
  let envVars: Record<string, string> | undefined = opts.toolContext?.envVars;

  // Check file system mode — if "local", force sandboxApiKey to undefined
  // so file tools use the E2B sandbox's local-mode fallback (the E2B sandbox
  // is still authoritative even in local mode — it just runs locally).
  let forceLocal = false;
  // Sandbox mode is always "shared" — all conversations share one sandbox.
  // (The separate-sandboxes option was removed per user request.)
  const sandboxMode: "shared" | "separate" = "shared";
  try {
    const fsMode = await settingsService.getFileSystemMode(opts.userId);
    if (fsMode === "local") {
      forceLocal = true;
      sandboxApiKey = undefined;
    }
  } catch {
    // Non-fatal — default to auto mode
  }

  if (!sandboxApiKey || envVars === undefined) {
    try {
      // Only fetch the sandbox key if we don't already have one AND we're not
      // in local-only mode. The previous condition `sandboxApiKey || forceLocal`
      // was inverted — it skipped fetching when the key was already set (correct)
      // but also when forceLocal was true (also correct), however the ternary
      // returned null in both cases which masked fetch errors.
      const decryptedKey = (!sandboxApiKey && !forceLocal)
        ? await settingsService.getDecryptedSandboxKey(opts.userId)
        : null;
      const decryptedEnv = envVars === undefined
        ? await settingsService.getDecryptedEnvVars(opts.userId)
        : ({} as Record<string, string>);
      if (!sandboxApiKey && !forceLocal && decryptedKey) {
        sandboxApiKey = decryptedKey;
      }
      if (envVars === undefined) envVars = decryptedEnv ?? {};
    } catch (err) {
      console.warn("[agent] failed to load sandbox key / env vars:", err);
    }
  }

  const toolCtx: ToolContext = opts.toolContext ?? {
    userId: opts.userId,
    emit,
    signal,
    waitForAskUser: (questions: AskUserQuestion[]) =>
      waitForAskUser(questions, emit, signal),
    // `e2bApiKey` is the legacy field name — the tools read this. We
    // populate it with the E2B sandbox key for back-compat. `sandboxApiKey`
    // is the new alias.
    e2bApiKey: sandboxApiKey,
    sandboxApiKey,
    sandboxMode,
    envVars: envVars ?? {},
  };

  // 1. Persist the user's message + create conversation if needed.
  let conversationId = opts.conversationId;
  if (!conversationId) {
    const title =
      opts.userMessage.slice(0, 60) + (opts.userMessage.length > 60 ? "…" : "");
    const conv = await conversationService.create(opts.userId, title);
    conversationId = conv.id;
    emit({
      type: "conversation_created",
      data: { conversation_id: conv.id },
      timestamp: nowISO(),
    });
  }
  const userMessageRow = await conversationService.addMessage(
    conversationId,
    opts.userId,
    {
      role: "user",
      content: opts.userMessage,
      fileIds: opts.fileIds,
    },
  );
  emit({
    type: "user_prompt",
    data: { message: opts.userMessage, message_id: userMessageRow.id },
    timestamp: nowISO(),
  });
  emit({
    type: "user_prompt_processed",
    data: { message_id: userMessageRow.id },
    timestamp: nowISO(),
  });

  // 2. Load history from Dexie → ChatCompletionMessage[].
  const history = await conversationService.getMessages(conversationId);

  // 3. Build the tools list + system prompt. We inject the real tool list
  // into the system prompt so the model knows exactly which tools it has —
  // prevents hallucinating fake tool names like "get_lec_infos" or
  // "write_code" that don't exist.
  const toolCtxForList = { ...toolCtx, conversationId };
  const registeredTools = listTools(toolCtxForList);
  const tools: ChatCompletionTool[] = registeredTools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
    },
  }));

  // Debug: log the tool count so we can verify all built-in tools are registered
  console.log(`[agent] Tools registered: ${registeredTools.length}`, registeredTools.map(t => t.name));

  // Build the enhanced system prompt with the tool list + usage knowledge.
  const toolListText = registeredTools.length > 0
    ? `\n\n## Available Tools (${registeredTools.length} total)\nYou have access to these tools. Use them by calling them through the FUNCTION-CALLING API (the tool_calls mechanism). NEVER write tool calls as plain text (e.g. "Thought: ... Action: run_terminal Input: {...}"). ALWAYS use the function-calling mechanism to invoke tools.\n\nUse them by name when the user's request matches:\n${registeredTools.map((t) => `- **${t.name}** — ${t.description}`).join("\n")}\n\nIMPORTANT: These are the ONLY tools available. Do not mention or use any tool that is not in this list. NEVER write "Thought:", "Action:", "Input:", "Observation:", or "Final Answer:" as text — these are ReAct patterns that DON'T work here. Use the tool_calls mechanism instead.`
    : "";

  const toolKnowledgeBase = `
## CRITICAL: Pre-Execution Workspace Analysis
Before starting ANY task, you MUST first call \`analyze_workspace\` to understand:
- Project architecture and file structure
- Technologies used
- Existing coding style and patterns
- Available tools, skills, MCP servers
- Environment variables and API keys
- Existing subagents and memories

NEVER blindly modify files without first understanding the workspace. The only exception is for trivial conversational answers (e.g. "what time is it") where no file or code changes will be made.

## Automatic Task Complexity Detection
After workspace analysis, estimate task complexity:
- **Tiny**: Single answer, no file changes → no sub-agents
- **Small**: One file, simple change → usually no sub-agents
- **Medium**: 2-4 files, moderate complexity → optional sub-agents
- **Large**: 5-10+ files, multiple technologies → spawn specialists
- **Massive**: Repository-wide, multi-system → multi-agent workflow

## Dynamic Sub-Agent Decision
- **Never spawn agents unnecessarily** — Tiny/Small tasks should be handled directly.
- For **Large/Massive** tasks, spawn specialized agents with roles:
  Planner, Frontend Engineer, Backend Engineer, Database Engineer,
  Testing Engineer, Documentation Writer, API Specialist,
  Performance Optimizer, Security Reviewer, Refactoring Specialist,
  Deployment Engineer
- Use \`disposable: true\` for one-off tasks (auto-cleans after completion — agent is removed from the sidebar)
- Use \`disposable: false\` for persistent agents needed for ongoing work

## Execution Pipeline
1. Receive user request
2. Call \`analyze_workspace\` to build full workspace context
3. Build project understanding (technologies, patterns, existing subagents)
4. Estimate task complexity (Tiny / Small / Medium / Large / Massive)
5. Decide if sub-agents are needed
6. Determine optimal number of agents (respect the 5-8 concurrency limit)
7. Assign specialized roles (Frontend Engineer, Backend Engineer, …)
8. Spawn agents with appropriate \`disposable\` setting + \`role\`
9. Execute work in parallel where beneficial (use \`query_subagent\`)
10. Aggregate and validate outputs (use \`list_subagents\` + \`query_subagent\`)
11. Dispose of temporary agents automatically via \`complete_subagent\`
12. Deliver final unified result to the user

## Agent Lifecycle Status (real-time tracking)
Each subagent has a lifecycle status surfaced in the UI:
\`idle → planning → working → waiting → reviewing → completed → (disposed)\`
- **idle**: just spawned, not yet working
- **planning**: building its own plan before executing
- **working**: actively executing a task
- **waiting**: paused, waiting for input/steering
- **reviewing**: validating its own output
- **completed**: task finished (still available if non-disposable)
- **disposed**: auto-removed (disposable agents only)

## Tool Usage Guide — When to Use What

### Workspace Analysis (run FIRST)
- **analyze_workspace**: Scan the entire workspace before starting any task. Returns files, key project files (README, package.json, configs, .env), skills, MCP servers, available tools, env vars, existing subagents, and memories. Call this BEFORE any file modification or sub-agent spawning. Re-run when context may have changed (e.g. after a sub-agent has made significant changes).

### Code Execution
- **run_python**: Use for data analysis, calculations, file processing, ML models, web scraping with Python. ALWAYS try this first for any computation task. Requires an E2B sandbox key (configured in Settings).
- **run_terminal**: Use for shell commands — file operations, git, npm/pip installs, system queries. Supports pipes (|), redirects (>), and chains (&&).

### Web & Search
- **web_search**: Search the web for text results. Uses LangSearch (if API key configured in Settings) for richer summaries, else falls back to Miklium (Yahoo-based). Returns titles, URLs, snippets. Best for finding current information, documentation, or answers to factual questions.
- **image_search**: Search for images via Miklium. Returns image URLs, thumbnails, dimensions, and source pages. Use when the user wants pictures, photos, or diagrams.
- **video_search**: Search for videos via Miklium. Returns video titles, URLs, thumbnails, durations, and channel info. Use when the user wants tutorials or multimedia content.
- **web_fetch**: Use to read the full content of a specific URL. Use AFTER web_search to deep-read a promising result page.

### File Management (E2B sandbox — authoritative workspace)
- **create_file / write_file**: Create or overwrite files in the user's workspace. Files persist across sessions. For files >200 lines, use verify_path + create_file_chunk instead for incremental writing.
- **read_file**: Read the content of a file in the workspace.
- **edit_file**: Edit a file by finding and replacing text. For large edits, use create_file_chunk with mode='append'.
- **delete_file**: Remove a file from the workspace.
- **move_file**: Move or rename a file (source → destination).
- **rename_file**: Rename a file (just the filename, keeps the same directory).
- **list_files**: List all files in a directory. Use this to discover what files exist before reading them.
- **search_files**: Grep/search for text across files. Use when the user asks "find X in my files".
- **create_folder**: Create a new directory in the workspace.
- **delete_folder**: Delete a folder and all its contents.
- **verify_path**: Verify a path exists, create directories (and empty file) if missing. Call BEFORE create_file_chunk to ensure parent dirs exist.
- **create_file_chunk**: Write/append content in 2-4 KB (50-200 line) chunks with progress tracking. Use mode="create" for the first chunk, mode="append" for subsequent chunks.
- **read_file_section**: Read a specific section of a file (by 0-based line range). Use to verify previously written chunks before appending the next one, or to resume an interrupted write.

### CRITICAL: Incremental File Writing Policy
NEVER generate an entire large file in one operation. Large files MUST be written incrementally:

1. Call verify_path to create directories + verify the file path
2. Call create_file_chunk with mode="create" for the first chunk (50-200 lines)
3. Call create_file_chunk with mode="append" for each subsequent chunk
4. Split on: functions, classes, interfaces, components, modules, logical sections
5. NEVER split in the middle of: JSON objects, function bodies, classes, JSX elements, multiline strings
6. Chunk size: 2-4 KB (50-200 lines) per chunk

If a write fails:
- Detect the reason (directory missing → mkdir -p, permission → use ./useless/ fallback)
- Retry ONLY the failed chunk, never regenerate previous chunks
- If all writes fail, save to ./useless/ directory as fallback — never discard generated content

Available tools for incremental writing:
- verify_path: Create/verify directories + files before writing
- create_file_chunk: Write/append content in chunks with progress tracking
- read_file_section: Read specific sections for verification and resume

### Memory & Knowledge
- **memory**: Store and retrieve persistent facts about the user. Use when the user says "remember that..." or when you learn something important about their preferences.
- **e2b_rag / hopx_rag**: Search through uploaded documents using semantic search. Use when the user asks about content in their knowledge base or uploaded files.

### Subagent Orchestration (you are an orchestrator)
- **analyze_workspace**: Scan the workspace BEFORE spawning subagents — lets you pick the right roles, detect existing agents, and avoid duplicates.
- **spawn_subagent**: Create a new subagent for a specific task. Pass \`disposable: true\` for one-off tasks (auto-disposes), \`role\` for specialization (e.g. "Frontend Engineer"). Use when a task is complex enough to delegate (e.g. "research X while I work on Y").
- **query_subagent**: Send a message to a subagent and get its reply. The subagent processes your message using its own API config and has access to all the same tools you do. Use this to delegate work and get results. If the subagent's task isn't done, query again with more specific instructions.
- **list_subagents**: Check which subagents are currently active (returns disposable + role + lifecycle status). Use before spawning to avoid duplicates.
- **steer_subagent**: Send guidance to a running subagent (e.g. "focus only on Python files").
- **complete_subagent**: Mark a subagent's task as completed. For disposable agents, this AUTOMATICALLY disposes them (status="disposed", removed from sidebar, enabled=false).
- **cancel_subagent**: Cancel a subagent that's going in the wrong direction.
- **create_custom_tool**: Create a specialized tool for a subagent (e.g. a meme generator, a sentiment analyzer). Use when a subagent needs a capability that doesn't exist in the built-in tools.
- **create_subagent_chat**: Start a new chat session with a subagent.
- **delete_subagent_chat / edit_subagent_chat_title / pin_subagent_chat**: Manage subagent chat sessions.

### Datetime & Utilities
- **datetime**: Get the current date/time. Use when the user asks "what time is it" or when timestamps are needed.
- **chart**: Create data visualizations (bar, line, pie, scatter, etc). Use when the user wants to "visualize" or "plot" data.
- **preview_image**: Display an image inline in the chat from a URL or base64. Use when you want to show the user a visual — a generated image, a screenshot, a diagram URL, etc.
- **ocr_image**: Extract text from an image using OCR. Use when the user wants to read text from a screenshot, photo, scanned document, or any image containing text. Accepts image_url or image_base64.
- **ocr_pdf**: Extract text from a PDF document using OCR. Use when the user wants to read text from a scanned PDF or a PDF without selectable text. Accepts pdf_url or pdf_base64.
- **memory**: Store and retrieve persistent facts about the user. Use when the user says "remember that..." or when you learn something important about their preferences.
- **todos**: Create and manage a live task checklist. Use for multi-step tasks to show progress.
- **workflow**: Create, run, and manage multi-step workflow pipelines. Use when the user wants to automate a sequence of AI/tool steps.
- **counterfactual**: Explore "what if" scenarios. Use when the user asks hypothetical questions.
- **security_audit**: Audit code or config for security issues. Use when the user asks to "check for vulnerabilities" or "is this secure".

### Skills & MCP
- **skill_tools**: Use installed skills (from Settings → Skills). Skills are contextual capabilities that activate when your task matches.
- **mcp_tools / mcp_management**: Connect to and call tools from MCP (Model Context Protocol) servers.
- **dynamic_tools**: Call user-defined custom HTTP/Python tools.
- **local_chats**: Search through past conversations. Use when the user asks "what did we talk about before" or "find a conversation about X".

### When to THINK (reasoning) vs ACT (tools)
- **Think first** when: the task is ambiguous, requires planning, involves multiple steps, or the user's intent isn't clear. Break down the problem before acting.
- **Act immediately** when: the user gives a clear, direct command (e.g. "run this code", "search for X", "create a file named Y").
- **Use tools in parallel** when: multiple independent sub-tasks can run at the same time (e.g. search the web AND read a local file simultaneously).
- **Chain tools** when: one tool's output feeds into the next (e.g. search → fetch URL → extract data → write to file).

### AUTONOMOUS TASK DECOMPOSITION & MULTI-AGENT DELEGATION ENGINE
You are an **Executive Orchestrator**, not a worker. Your primary role is to understand, plan, divide, delegate, monitor, validate, and merge — NOT to implement everything yourself.

**Automatic Complexity Detection (before responding):**
Before doing any work, silently evaluate the request's complexity:
- Level 0: Tiny (single answer, no delegation)
- Level 1: Simple (one agent, do it yourself)
- Level 2: Medium (2-4 subagents, delegate parallel parts)
- Level 3: Large feature (5-10 subagents, full decomposition)
- Level 4: Large application (10+ subagents, recursive delegation)

**Automatic Delegation Rules — NEVER ask the user:**
Automatically delegate when ANY of these are true:
- Multiple files/folders affected
- Multiple technologies involved (frontend + backend, API + UI, etc.)
- Research required before implementation
- Large code generation (>100 lines)
- Testing + implementation + documentation needed
- More than one programming language
- Database changes + API changes + UI changes
- Repository-wide modifications
- Complex architecture design

**NEVER ask:** "Should I use subagents?" / "Should I split this?" / "Should I delegate?" — these decisions are AUTOMATIC.

**Execution Strategy:**
1. **Understand** the request fully
2. **Analyse** complexity and dependencies (call \`analyze_workspace\` first)
3. **Plan** the execution graph (which tasks can run in parallel, which are sequential)
4. **Decompose** into independent work packages
5. **Delegate** to specialist subagents via spawn_subagent + query_subagent
6. **Monitor** progress via list_subagents + query_subagent
7. **Validate** outputs (check for errors, conflicts, missing pieces)
8. **Merge** all results into a coherent final response
9. **Respond** with a single unified answer

**Concurrency Limit:** Maximum 5-8 concurrent subagents. Queue additional work. As one finishes, start the next queued task.

**Recursive Delegation:** Subagents may decompose their own tasks further and spawn additional subagents (up to the global concurrency limit).

**Automatic Failure Recovery:** If a subagent fails: retry once → spawn a Debug Agent → if still failing, split the task further → continue automatically.

**Automatic Specialist Selection:** Infer the right specialist from the task:
- Frontend Agent, Backend Agent, Database Agent, Testing Agent, Documentation Agent
- Research Agent, Code Reviewer, Security Agent, Deployment Agent
- React Agent, Python Agent, TypeScript Agent, API Agent, UI Designer Agent

**Parallel Execution:** Independent tasks MUST execute simultaneously. Example: for "build a web app", spawn Frontend + Backend + Database agents in parallel, then Testing after they complete.

**Planning is Mandatory:** Skipping planning for large requests is an error. Always plan before executing.

### File Uploads
When the user uploads a file, you'll see a tag like \`<@filename is uploaded check the workspace>\` in their message. The file is in your workspace — use \`list_files\` or \`read_file\` to access it. A manifest file \`.onyxagent_files.json\` lists all uploaded files with their metadata.

### Subagent Auto-Spawning
When you detect a large or complex task, automatically spawn subagents to handle different parts in parallel. For example:
- "Build a web app" → spawn a Coder subagent for frontend, a Coder subagent for backend, a Researcher for API docs
- "Research and summarize" → spawn a Researcher to search, an Analyst to summarize
- "Create content" → spawn a Writer subagent, and use create_custom_tool if it needs special capabilities

Each subagent shares the same sandbox + file system as you, so they can read/write the same files.

## CRITICAL: Read agent.md for tool usage guide
A file called \`agent.md\` has been written to the sandbox at \`/home/user/agent.md\`. It contains:
- Complete use cases for every tool (when to use run_python vs run_terminal, create_file vs create_file_chunk, etc.)
- Incremental file writing policy (for files >200 lines)
- Task complexity detection guide
- Subagent orchestration patterns
- Error recovery procedures
- Tool calling rules

Read it FIRST with \`read_file\` (path: \`agent.md\`) before using any tools. If it doesn't exist, use \`run_terminal\` with command \`sed -n '1,200p' /home/user/agent.md\` as fallback.

## Generative UI (GenUI)
GenUI lets you render rich interactive UI components — cards, tables, charts, games, calculators, educational widgets — directly in the chat by emitting a \`<<<genui>>>...<<</genui>>>\` block with a JSON spec. **No tool calls needed** — just emit the spec as text and it renders live.

**FULL documentation** (all 33 node types, props, use cases, examples, custom HTML components) is in \`agent.md\` under the "Generative UI (GenUI)" section. Read it with \`read_file\` (path: \`agent.md\`) before emitting GenUI blocks.

Quick reference — available types: header, text_block, card, card_grid, stat, stats_row, badge, progress, sparkline, key_value, quote, code_block, comparison_table, image, image_grid, list, checklist, timeline, stepper, divider, columns, tabs, accordion, callout, terminal_card, agent_card, weather_card, stock_ticker, suggestion_chips, sources_panel, **custom_html**, **custom_card**.

The two custom types let you write arbitrary HTML/CSS/JS (mini-games, calculators, educational demos, interactive visualizations) that renders in a sandboxed iframe. See agent.md for details and examples.

${genuiThemePromptBlock(readChatTheme())}`;

  const enhancedSystemPrompt = `${opts.systemPrompt}${toolListText}${toolKnowledgeBase}`;

  // CONTEXT WINDOW MANAGEMENT: Always strip tool_calls from history to
  // prevent DEGRADED errors. The AI doesn't need old tool calls to continue.
  // Handoff letter is triggered DYNAMICALLY when a context error is detected
  // (not at a fixed message count) — see the error handler in the agent loop.
  const MAX_HISTORY_MESSAGES = 20;
  let trimmedHistory = history.length > MAX_HISTORY_MESSAGES
    ? history.slice(-MAX_HISTORY_MESSAGES)
    : history;

  let handoffContext = "";

  // Function to build handoff letter + save full chat to the E2B sandbox.
  // Called when a context error is detected (DEGRADED, context length, etc.)
  // PRD §25/§26: handoff letters used to be written to OPFS; now they go to
  // the E2B sandbox (the authoritative workspace) so the AI's `read_file`
  // tool can access them. OPFS is no longer touched for workspace files.
  async function generateHandoff(): Promise<string> {
    try {
      const chatFileName = `chat_${conversationId?.slice(0, 8) ?? "unknown"}_${Date.now()}.md`;
      const fullChatText = history.map((m) => {
        const role = m.role.toUpperCase();
        const content = m.content || "(no text — tool calls only)";
        const toolSummary = m.tool_calls?.length
          ? `\n\n[Tool calls: ${m.tool_calls.map((tc) => tc.tool_name).join(", ")}]`
          : "";
        return `## ${role}\n\n${content}${toolSummary}`;
      }).join("\n\n---\n\n");

      // The AI reads workspace files from the E2B SANDBOX (read_file has no
      // OPFS path), so the transcript MUST be written there. Writing it to
      // OPFS (the historical behavior) produced a handoff letter pointing at
      // a file the agent could never open — the read_file call always failed
      // with "not found". No sandbox key (local mode / no sandbox configured)
      // → skip the file entirely and rely on the inline summary below.
      let fileSaved = false;
      if (sandboxApiKey && typeof window !== "undefined") {
        try {
          const { getE2BClient } = await import("@/lib/e2b/client");
          const client = getE2BClient(sandboxApiKey, conversationId, sandboxMode);
          // Ensure the chats/ directory exists, then write the file.
          await client.createFolder("/home/user/chats").catch(() => {});
          await client.writeFile(`/home/user/chats/${chatFileName}`, fullChatText);
          fileSaved = true;
        } catch (err) {
          console.warn("[agent] failed to write handoff to E2B sandbox:", err);
        }
      }

      const userMessages = history.filter((m) => m.role === "user");
      const allToolNames = new Set<string>();
      history.forEach((m) => m.tool_calls?.forEach((tc) => allToolNames.add(tc.tool_name)));

      const fileSection = fileSaved
        ? `**File path:** \`chats/${chatFileName}\` (in the workspace)
**How to read it:** Use the \`read_file\` tool with path \`chats/${chatFileName}\`

`
        : "";

      return `\n\n## CONVERSATION HANDOFF LETTER
This is a continuation of a long conversation. ${fileSaved ? `The full chat history (${history.length} messages) has been saved to a file.` : "The full history was too large to save; a summary follows."}

${fileSection}### Summary
- **Total messages:** ${history.length} (showing last ${MAX_HISTORY_MESSAGES})
- **User messages:** ${userMessages.length}
- **Tools used:** ${Array.from(allToolNames).join(", ") || "none"}

### First user message (original request):
${userMessages[0]?.content?.slice(0, 500) ?? "(empty)"}

### Key topics discussed:
${userMessages.slice(0, 5).map((m, i) => `${i + 1}. ${m.content?.slice(0, 200) ?? ""}`).join("\n")}

### Most recent exchanges:
${trimmedHistory.slice(-6).map((m) => `[${m.role}] ${m.content?.slice(0, 300) ?? "(tool calls)"}`).join("\n")}
${fileSaved ? `\nIf you need more context, read the full chat file at \`chats/${chatFileName}\`.` : ""}
`;
    } catch {
      return "";
    }
  }

  function buildPriorMessages(): ChatCompletionMessage[] {
    return [
      { role: "system", content: enhancedSystemPrompt + handoffContext },
      ...trimmedHistory
        .filter((m) => (m.role as string) !== "tool")
        .map((m): ChatCompletionMessage => {
          if (m.role === "user") return { role: "user", content: m.content };
          if (m.role === "system") return { role: "system", content: m.content };
          return {
            role: "assistant",
            content: m.content
              ? m.content.replace(/\n\n_\(stopped\)_/g, "").trim()
              : "",
            // Pass reasoning_content back to the API — required by DeepSeek/
            // moonshot/g4f providers in thinking mode. Without it, the API
            // rejects with "The reasoning_content in the thinking mode must
            // be passed back to the API."
            reasoning_content: m.reasoning || undefined,
          };
        }),
    ];
  }

  let priorMessages = buildPriorMessages();

  // 3. Build the tools array from the registry.
  // First, hot-load any user-defined custom tools from IndexedDB so they're
  // available to the agent this turn.
  try {
    const { loadDynamicTools } = await import("@/lib/tools/dynamic_tools");
    await loadDynamicTools(opts.userId);
  } catch {
    // Non-fatal — built-in tools still work
  }
  // Then, hot-load MCP tools (one client per active server). Each MCP tool
  // is registered with a `mcp_<server>__<tool>` name so the agent can call
  // it like any built-in tool. Per-server failures are swallowed — a bad
  // MCP server doesn't block the turn.
  try {
    const { loadMCPTools, mcpToolCount } = await import("@/lib/tools/mcp_tools");
    const discovery = await loadMCPTools(opts.userId);
    const failed = discovery.filter((d) => d.error);
    if (failed.length > 0) {
      console.warn(
        `[agent] MCP discovery: ${mcpToolCount()} tools across ${
          discovery.length - failed.length
        } server(s); ${failed.length} server(s) failed:`,
        failed.map((f) => `${f.server.name}: ${f.error}`),
      );
    } else if (discovery.length > 0) {
      console.log(
        `[agent] MCP discovery: ${mcpToolCount()} tools across ${discovery.length} server(s)`,
      );
    }
  } catch (err) {
    // Non-fatal — built-in tools still work.
    console.warn("[agent] MCP tool loading failed:", err);
  }


  // 4. Agent loop — max MAX_ROUNDS.
  let round = 0;
  let lastAssistantContent = "";
  let lastAssistantTextBeforeTools: string | undefined;
  let lastAssistantThinking = "";
  let lastAssistantReasoning = "";
  let lastUsage: AgentTurnResult["usage"];
  const allToolCalls: ToolCall[] = [];
  let retryCountThisTurn = 0;
  // Accumulated ordered parts (thinking/reasoning/text/tool) across all
  // rounds — persisted on the assistant message so a page refresh restores
  // the exact same card ordering the user saw live.
  const assistantParts: MessagePart[] = [];
  // Per-round start timestamps (indexed by 1-based round number) — stamped
  // onto persisted parts so each round's panel shows its own timing after a
  // refresh (PRD §12: round N's timer belongs to round N only).
  const roundStartTimes: number[] = [];
  const messages = [...priorMessages];

  // The "current" assistant message id we'll mutate as deltas arrive. The
  // outer caller / use-chat.ts creates the message on `model_request_start`
  // — we don't need to manage it here, but we do need a stable id to send
  // back in `message_saved`.
  const assistantMessageId = nanoid();

  const effectiveMaxRounds = MAX_ROUNDS;

  while (round < effectiveMaxRounds) {
    round += 1;
    roundStartTimes[round] = Date.now();

    if (signal?.aborted) {
      return {
        conversationId,
        assistantMessageId,
        content: lastAssistantContent,
        thinking: lastAssistantThinking,
        reasoning: lastAssistantReasoning,
        toolCalls: allToolCalls,
        usage: lastUsage,
        stopReason: "aborted",
      };
    }

    let roundResult: RoundResult;
    try {
      roundResult = await streamRound({
        messages,
        tools,
        provider: opts.provider,
        temperature: opts.temperature,
        thinkingEffort: opts.thinkingEffort,
        emit,
        signal,
        roundNumber: round,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // AUTO CONTEXT ERROR DETECTION: If the error is related to context
      // window overflow or DEGRADED functions, automatically generate a
      // handoff letter, reduce history, and retry ONCE.
      // AUTO RETRY: If the error is a timeout (524), rate limit, or network
      // blip, retry the round up to 2 times before giving up. These are
      // transient errors that happen between rounds when the connection
      // drops momentarily. Rate-limit messages are the second line of
      // defense — streamRound already retries 429/529 with backoff before
      // the error ever reaches this handler (PRD §7).
      const isTimeout =
        /524|timeout|ECONNRESET|socket hang up|fetch failed|network/i.test(message) ||
        /429|rate.?limit|too many requests|quota exceeded|resource_exhausted/i.test(message);
      if (isTimeout && retryCountThisTurn < 3 && round < effectiveMaxRounds) {
        retryCountThisTurn += 1;
        console.warn(`[agent] Timeout/network error on round ${round} (retry ${retryCountThisTurn}/3), retrying...`, message.slice(0, 100));
        // Wait 1 second before retrying to let the connection recover
        await new Promise((r) => setTimeout(r, 1000));
        round -= 1; // don't consume a round on retry
        continue; // retry the same round
      }

      const isContextError = /degraded|context.*length|too many tokens|maximum context|context window|too long/i.test(message);
      if (isContextError && !handoffContext) {
        console.warn("[agent] Context error detected, generating handoff + retrying...", message.slice(0, 100));
        // Generate handoff letter (saves full chat to file + builds summary)
        handoffContext = await generateHandoff();
        // Reduce history to last 10 messages (even more aggressive)
        trimmedHistory = history.length > 10 ? history.slice(-10) : history;
        // Rebuild messages with handoff
        priorMessages = buildPriorMessages();
        // Reset messages array for the retry
        messages.length = 0;
        messages.push(...priorMessages);
        // Retry the round
        try {
          roundResult = await streamRound({
            messages,
            tools,
            provider: opts.provider,
            temperature: opts.temperature,
            thinkingEffort: opts.thinkingEffort,
            emit,
            signal,
            roundNumber: round,
          });
        } catch (retryErr) {
          // Retry also failed — give up and report the original error
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          emit({
            type: "error",
            data: { message: `Context error (retry also failed): ${retryMsg}` },
            timestamp: nowISO(),
          });
          await conversationService.saveAgentCheckpoint(
            conversationId,
            opts.userId,
            assistantMessageId,
            {
              role: "assistant",
              content: `(error: context limit reached. Full chat saved to /chats folder. ${retryMsg})`,
              toolCalls: allToolCalls,
              modelName: opts.provider.model,
              isStreaming: false,
            },
          );
          emit({ type: "complete", timestamp: nowISO() });
          return {
            conversationId,
            assistantMessageId,
            content: "",
            toolCalls: allToolCalls,
            usage: lastUsage,
            stopReason: "error",
          };
        }
      } else {
        // Non-context error, or already retried — report it
        emit({
          type: "error",
          data: { message },
          timestamp: nowISO(),
        });
        // Persist what we have so far before exiting (checkpoint upsert so
        // an error path never duplicates the turn's row).
        await conversationService.saveAgentCheckpoint(
          conversationId,
          opts.userId,
          assistantMessageId,
          {
            role: "assistant",
            content: lastAssistantContent || `(error: ${message})`,
            thinking: lastAssistantThinking || undefined,
            reasoning: lastAssistantReasoning || undefined,
            parts: buildAssistantParts(
              lastAssistantThinking || undefined,
              lastAssistantReasoning || undefined,
              allToolCalls,
              lastAssistantContent || `(error: ${message})`,
              lastAssistantTextBeforeTools,
            ),
            toolCalls: allToolCalls,
            modelName: opts.provider.model,
            isStreaming: false,
          },
        );
        emit({ type: "complete", timestamp: nowISO() });
        return {
          conversationId,
          assistantMessageId,
          content: lastAssistantContent,
          thinking: lastAssistantThinking,
          reasoning: lastAssistantReasoning,
          toolCalls: allToolCalls,
          usage: lastUsage,
          stopReason: "error",
        };
      }
    }

    if (roundResult.usage) lastUsage = roundResult.usage;
    lastAssistantContent = roundResult.content;
    lastAssistantTextBeforeTools = roundResult.textBeforeTools;
    lastAssistantThinking = roundResult.thinking;
    lastAssistantReasoning = roundResult.reasoning;

    // Accumulate parts for this round into assistantParts so the final
    // message has the correct chronological order (text → tool → text →
    // tool → text) across ALL rounds. Without this, buildAssistantParts
    // rebuilds from scratch and loses the multi-round ordering, causing
    // content to appear "cut" into multiple parts.
    //
    // ROUND STAMPING (PRD §9–16): every part of round R carries `round: R`
    // and the round's start timestamp — reasoning from different rounds is
    // NEVER merged into one panel; each renders its own panel with its own
    // timing. Within one round, consecutive same-type parts still merge.
    const roundStart = roundStartTimes[round] ?? Date.now();
    if (roundResult.thinking && roundResult.thinking.trim()) {
      const lastPart = assistantParts[assistantParts.length - 1];
      if (lastPart && lastPart.type === "thinking" && lastPart.content && lastPart.round === round) {
        lastPart.content += "\n" + roundResult.thinking;
      } else {
        assistantParts.push({ id: `p-think-${Date.now()}-${round}`, type: "thinking", content: roundResult.thinking, round, roundStartedAt: roundStart });
      }
    }
    if (roundResult.reasoning && roundResult.reasoning.trim()) {
      const lastPart = assistantParts[assistantParts.length - 1];
      if (lastPart && lastPart.type === "reasoning" && lastPart.content && lastPart.round === round) {
        lastPart.content += "\n" + roundResult.reasoning;
      } else {
        assistantParts.push({ id: `p-reason-${Date.now()}-${round}`, type: "reasoning", content: roundResult.reasoning, round, roundStartedAt: roundStart });
      }
    }
    if (roundResult.textBeforeTools && roundResult.textBeforeTools.trim()) {
      assistantParts.push({ id: `p-text-pre-${Date.now()}-${round}`, type: "text", content: roundResult.textBeforeTools, round, roundStartedAt: roundStart });
    }
    for (const tc of roundResult.toolCalls) {
      assistantParts.push({
        id: `p-tool-${tc.id}`,
        type: "tool",
        toolCall: {
          id: tc.id,
          name: tc.name,
          args: tc.args,
          status: "completed" as const,
        },
        round,
        roundStartedAt: roundStart,
      });
    }
    // Post-tool text (content minus textBeforeTools).
    // Only split if textBeforeTools is a clean prefix of content. If the
    // content was modified (DSML stripping, etc.), don't split — put all
    // remaining text as one part. This prevents single words/periods from
    // ending up as separate parts below the tool call.
    if (roundResult.content && roundResult.content.trim()) {
      if (roundResult.textBeforeTools && roundResult.content.startsWith(roundResult.textBeforeTools)) {
        const postText = roundResult.content.slice(roundResult.textBeforeTools.length);
        if (postText.trim()) {
          assistantParts.push({ id: `p-text-${Date.now()}-${round}`, type: "text", content: postText, round, roundStartedAt: roundStart });
        }
      } else if (!roundResult.textBeforeTools) {
        // No text-before-tools → all content is post-tool text
        assistantParts.push({ id: `p-text-${Date.now()}-${round}`, type: "text", content: roundResult.content, round, roundStartedAt: roundStart });
      }
      // If textBeforeTools exists but doesn't match content prefix (DSML
      // stripping changed it), the text was already pushed as textBeforeTools
      // — don't push a duplicate.
    }

    // No tool calls → final result.
    if (roundResult.toolCalls.length === 0 || roundResult.aborted) {
      // If the content is empty (e.g. aborted before any text arrived),
      // use a minimal placeholder so the DB row isn't empty.
      const finalContent = roundResult.content || (roundResult.aborted ? "" : "");
      // Use accumulated assistantParts (correct multi-round ordering) if
      // available, otherwise fall back to buildAssistantParts.
      const finalParts = assistantParts.length > 0
        ? assistantParts
        : buildAssistantParts(
            roundResult.thinking || undefined,
            roundResult.reasoning || undefined,
            allToolCalls,
            finalContent,
            roundResult.textBeforeTools,
          );
      // BACKFILL ROUND END TIMES (PRD §12/§15): round N ended when round N+1
      // started; the LAST round ends now. Each round's elapsed = its own
      // end − its own start, so completed panels show frozen, independent
      // durations after a refresh.
      const turnEndTime = Date.now();
      for (const p of finalParts) {
        if (p.round !== undefined && p.roundEndedAt === undefined) {
          const nextRoundStart = roundStartTimes[p.round + 1];
          p.roundEndedAt = nextRoundStart ?? turnEndTime;
        }
      }
      // Persist the final assistant message. CHECKPOINT UPSERT (PRD
      // §6/§32): write the SAME stable id the per-round checkpoints used,
      // so a turn interrupted mid-stream (tab closed / refreshed) never
      // produces a second assistant row for the same execution — the final
      // save simply settles the existing checkpoint.
      const savedMessage = await conversationService.saveAgentCheckpoint(
        conversationId,
        opts.userId,
        assistantMessageId,
        {
          role: "assistant",
          content: finalContent,
          thinking: roundResult.thinking || undefined,
          reasoning: roundResult.reasoning || undefined,
          parts: finalParts,
          toolCalls: allToolCalls,
          modelName: opts.provider.model,
          isStreaming: false,
        },
      );
      emit({
        type: "final_result",
        data: { output: finalContent, tool_events: allToolCalls },
        timestamp: nowISO(),
      });
      emit({
        type: "message_saved",
        data: { message_id: savedMessage.id },
        timestamp: nowISO(),
      });
      emit({ type: "complete", timestamp: nowISO() });
      return {
        conversationId,
        assistantMessageId: savedMessage.id,
        content: roundResult.content,
        thinking: roundResult.thinking,
        reasoning: roundResult.reasoning,
        toolCalls: allToolCalls,
        usage: lastUsage,
        stopReason: roundResult.aborted ? "aborted" : "complete",
      };
    }

    // Tool calls requested — append the assistant turn to the message list.
    // CRITICAL: Pass reasoning_content back to the API — DeepSeek/moonshot/g4f
    // providers in thinking mode REQUIRE this. Without it, the API rejects
    // with "The reasoning_content in the thinking mode must be passed back
    // to the API."
    // Also truncate large tool call arguments before sending them back.
    messages.push({
      role: "assistant",
      content: roundResult.content || "",
      // Pass reasoning_content back so the provider can maintain context.
      reasoning_content: roundResult.reasoning || undefined,
      tool_calls: roundResult.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: safeStringifyArgs(truncateToolArgs(tc.name, tc.args)),
        },
      })),
    });

    // Execute ALL tools in parallel — every `tool_call` event is emitted
    // instantly (so the UI renders all cards simultaneously), then every
    // handler runs concurrently. CRITICAL: each tool's `tool_result` is
    // emitted AS IT FINISHES (via per-promise .then()), NOT after all tools
    // complete. Previously `await Promise.all(...)` blocked until ALL tools
    // finished before emitting ANY result — making tools feel queued even
    // though they ran concurrently internally. Now a fast tool completes and
    // shows its result immediately while a slow tool is still running.
    emit({ type: "call_tools_start", timestamp: nowISO() });

    // 1) Emit every `tool_call` event up front so cards render together.
    for (const tc of roundResult.toolCalls) {
      const toolDef = getTool(tc.name);
      emit({
        type: "tool_call",
        data: {
          tool_name: tc.name,
          args: tc.args,
          tool_call_id: tc.id,
          // Surface unknown-tool errors immediately so the card shows the
          // failure state without waiting for the parallel batch.
          ...(toolDef ? {} : { __error: `Tool '${tc.name}' is not registered` }),
        },
        timestamp: nowISO(),
      });
    }

    // 2) Kick off every handler in parallel. Each promise resolves to a
    //    normalized result record. We attach a `.then()` to each promise that
    //    emits the `tool_result` + pushes to messages/allToolCalls AS SOON AS
    //    that tool finishes — no waiting for siblings. Then we `await
    //    Promise.all` only to know when ALL are done before looping back for
    //    the next LLM round (the API needs all tool results before the next
    //    message). This way: tools run concurrently, results appear as each
    //    finishes, and the next LLM round starts as soon as the slowest tool
    //    completes.
    const resultPromises = roundResult.toolCalls.map(
      async (tc): Promise<void> => {
        const toolDef = getTool(tc.name);
        if (!toolDef) {
          const errMsg = `Tool '${tc.name}' is not registered`;
          const fullResultStr = JSON.stringify({ error: errMsg });
          // Backfill the error onto the persisted part (see the persistence
          // fix in the success path below for rationale).
          for (const part of assistantParts) {
            if (part.type === "tool" && part.toolCall && part.toolCall.id === tc.id) {
              part.toolCall.result = { error: errMsg };
              part.toolCall.status = "error";
            }
          }
          emit({
            type: "tool_result",
            data: { tool_call_id: tc.id, content: fullResultStr },
            timestamp: nowISO(),
          });
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.name,
            content: fullResultStr,
          });
          allToolCalls.push({
            id: tc.id,
            name: tc.name,
            args: tc.args,
            result: { error: errMsg },
            status: "error",
          });
          return;
        }

        const effectiveArgs = tc.args;

        // Build the per-call tool context. We inject an `onToolOutput`
        // callback that streams stdout/stderr chunks back to the UI in real
        // time as `tool_output` WSEvents. Tools that don't stream simply
        // never call it.
        const streamingToolCtx: ToolContext = {
          ...toolCtxForList,
          onToolOutput: (toolCallId: string, output: string, type: "stdout" | "stderr" | "prompt") => {
            // The e2b_exec tools pass an empty toolCallId (they don't know
            // it at construction time) — substitute the real one from this
            // turn.
            const id = toolCallId || tc.id;
            emit({
              type: "tool_output",
              data: {
                tool_call_id: id,
                content: output,
                type,
              },
              timestamp: nowISO(),
            });
          },
        };

        // Execute.
        let result: unknown;
        let status: ToolCall["status"] = "completed";
        try {
          result = await toolDef.handler(effectiveArgs, streamingToolCtx);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
          status = "error";
        }

        // PERSISTENCE FIX (PRD §3/§26 — "Web Search UI persistence" /
        // "UI Rendering Architecture"): the tool PART pushed into
        // `assistantParts` was created WITHOUT a result (it is emitted before
        // execution so the card renders immediately). The live UI receives
        // the result through the `tool_result` EVENT — but the event only
        // updates the in-memory chat store. Unless the result is ALSO
        // backfilled onto the part here, the persisted `parts` array carries
        // `toolCall.result === undefined`, and after a refresh every tool
        // card (web search included) renders as an empty rectangle.
        for (const part of assistantParts) {
          if (part.type === "tool" && part.toolCall && part.toolCall.id === tc.id) {
            part.toolCall.result = result;
            part.toolCall.status = status;
          }
        }

        // Emit result IMMEDIATELY — no waiting for sibling tools.
        const fullResultStr =
          typeof result === "string" ? result : JSON.stringify(result);
        const resultStr = truncateResult(tc.name, fullResultStr);
        emit({
          type: "tool_result",
          data: { tool_call_id: tc.id, content: fullResultStr },
          timestamp: nowISO(),
        });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.name,
          content: resultStr,
        });
        allToolCalls.push({
          id: tc.id,
          name: tc.name,
          args: effectiveArgs,
          result,
          status,
        });
      },
    );

    // Wait for ALL tools to finish before looping back for the next LLM round.
    // The API requires all tool results in the message history before the
    // next message. But each tool's result was already emitted above as it
    // completed — so the UI shows results progressively.
    await Promise.all(resultPromises);

    // ROUND-BOUNDARY CHECKPOINT (PRD §6/§32 — background execution
    // resilience): persist everything accumulated so far under the turn's
    // STABLE message id. If the tab is closed / refreshed mid-turn, the
    // reload shows every completed round (reasoning, tool calls, results)
    // instead of losing the whole turn; the final save settles the same
    // row. Cheap upsert: only runs once per ROUND, not per delta.
    try {
      await conversationService.saveAgentCheckpoint(
        conversationId,
        opts.userId,
        assistantMessageId,
        {
          content: lastAssistantContent || roundResult.textBeforeTools || "",
          thinking: lastAssistantThinking || undefined,
          reasoning: lastAssistantReasoning || undefined,
          parts: assistantParts,
          toolCalls: allToolCalls,
          modelName: opts.provider.model,
          isStreaming: true,
        },
      );
    } catch {
      // Non-fatal — the next checkpoint or the final save retries.
    }

    // Loop back for the next round.
  }

  // Hit max rounds — persist whatever content was generated (don't error).
  // The agent may have produced useful intermediate text or tool results;
  // surfacing those is better than dropping them on the floor with an error.
  const savedMessage = await conversationService.saveAgentCheckpoint(
    conversationId,
    opts.userId,
    assistantMessageId,
    {
      role: "assistant",
      content:
        lastAssistantContent ||
        `(reached max rounds (${effectiveMaxRounds}); last content shown above)`,
      thinking: lastAssistantThinking || undefined,
      reasoning: lastAssistantReasoning || undefined,
      parts: buildAssistantParts(
        lastAssistantThinking || undefined,
        lastAssistantReasoning || undefined,
        allToolCalls,
        lastAssistantContent ||
          `(reached max rounds (${effectiveMaxRounds}); last content shown above)`,
        lastAssistantTextBeforeTools,
      ),
      toolCalls: allToolCalls,
      modelName: opts.provider.model,
      isStreaming: false,
    },
  );
  emit({
    type: "final_result",
    data: { output: lastAssistantContent, tool_events: allToolCalls },
    timestamp: nowISO(),
  });
  emit({
    type: "message_saved",
    data: { message_id: savedMessage.id },
    timestamp: nowISO(),
  });
  emit({ type: "complete", timestamp: nowISO() });
  return {
    conversationId,
    assistantMessageId: savedMessage.id,
    content: lastAssistantContent,
    thinking: lastAssistantThinking,
    reasoning: lastAssistantReasoning,
    toolCalls: allToolCalls,
    usage: lastUsage,
    stopReason: "max_rounds",
  };
}

// ---------------------------------------------------------------------------
// Public helpers — exposed so the UI can dispatch ask_user responses back
// into the runtime via window events.
// ---------------------------------------------------------------------------

export function respondToAskUser(
  answers: Array<{ answer: string; skipped: boolean }>,
): void {
  window.dispatchEvent(
    new CustomEvent(ASK_USER_RESPONSE_EVENT, { detail: { answers } }),
  );
}

export { ASK_USER_RESPONSE_EVENT };
