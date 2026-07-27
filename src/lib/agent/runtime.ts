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
  ChatMessage,
  MessagePart,
  ToolCall,
  AskUserQuestion,
} from "@/types";
import { listTools, getTool, type ToolContext } from "@/lib/tools/registry";
import "@/lib/tools"; // Side-effect: registers all built-in tools (datetime, chart, ask_user, e2b_*, etc.)
import { conversationService, settingsService } from "@/lib/services";

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export interface AgentTurnOptions {
  /** User id (used to scope Dexie queries, OPFS paths, E2B sandbox). */
  userId: string;
  /** Existing conversation id, or null to create one on first turn. */
  conversationId: string | null;
  /** The user's prompt for this turn. */
  userMessage: string;
  /** File IDs already uploaded to OPFS — included as `file_ids`. */
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
  /**
   * Deprecated — kept for back-compat. Tool approval has been removed entirely
   * (tools execute immediately when the model invokes them). When `false`,
   * the value is ignored — approval is always skipped. The setting still
   * appears in Settings → Config so users don't lose their stored preference,
   * but it has no effect.
   */
  autoApproveTools?: boolean;
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

async function* parseSSEStream(
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

function extractDelta(chunk: Record<string, unknown>): DeltaAccumulator | null {
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
function extractFinishReason(chunk: Record<string, unknown>): string | null {
  const choices = chunk.choices as
    | Array<{ finish_reason?: string | null; stop_reason?: string | null }>
    | undefined;
  if (!choices || choices.length === 0) return null;
  const choice = choices[0];
  if (!choice) return null;
  return choice.finish_reason ?? choice.stop_reason ?? null;
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

  // Pass the target URL via ?url= query param — Vercel can't strip query params.
  const response = await fetch(`${CHAT_PROXY_URL}?url=${encodeURIComponent(targetUrl)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-target-url": targetUrl,
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

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

  emit({ type: "model_request_start", timestamp: nowISO() });

  // Accumulators — built up as deltas arrive.
  let content = "";
  let thinking = "";
  let reasoning = "";
  const toolCallAccumulator = new Map<
    number,
    { id: string; name: string; args: string }
  >();
  let finishReason: string | null = null;
  let usage: RoundResult["usage"];
  let aborted = false;
  let roundIndex = 0; // monotonically increasing part index for the UI.

  const reader = response.body.getReader();
  try {
    for await (const chunk of parseSSEStream(reader, signal)) {
      const delta = extractDelta(chunk);
      if (delta) {
        if (delta.text) {
          content += delta.text;
          emit({
            type: "text_delta",
            data: { index: roundIndex, content: delta.text },
            timestamp: nowISO(),
          });
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
          emit({
            type: "tool_call_delta",
            data: { tool_calls: delta.toolCalls },
            timestamp: nowISO(),
          });
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

  return {
    content,
    thinking,
    reasoning,
    toolCalls,
    finishReason,
    usage,
    aborted,
  };
}

// ---------------------------------------------------------------------------
// Tool approval has been removed — tools now execute immediately when the
// model invokes them. The window-event plumbing below remains for back-compat
// with components that may still dispatch approval responses (e.g. older
// versions of the ToolApprovalDialog). The `autoApproveTools` option is kept
// for back-compat too but is treated as always-true.
// ---------------------------------------------------------------------------

const APPROVAL_EVENT_NAME = "agent:approval-response";
const APPROVAL_REQUEST_EVENT_NAME = "agent:approval-request";

interface ApprovalDecision {
  type: "approve" | "edit" | "reject";
  editedArgs?: Record<string, unknown>;
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
): import("@/types/chat").MessagePart[] {
  const parts: import("@/types/chat").MessagePart[] = [];
  if (thinking && thinking.trim()) {
    parts.push({ id: `p-think-${Date.now()}`, type: "thinking", content: thinking });
  }
  if (reasoning && reasoning.trim()) {
    parts.push({ id: `p-reason-${Date.now()}`, type: "reasoning", content: reasoning });
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
  if (content && content.trim()) {
    parts.push({ id: `p-text-${Date.now()}`, type: "text", content });
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Main entry — `runAgentTurn`.
// ---------------------------------------------------------------------------

export async function runAgentTurn(opts: AgentTurnOptions): Promise<AgentTurnResult> {
  const { emit, signal } = opts;

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
  // so file tools use OPFS fallback even if a sandbox key is configured.
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
    ? `\n\n## Available Tools (${registeredTools.length} total)\nYou have access to these tools. Use them by name when the user's request matches:\n${registeredTools.map((t) => `- **${t.name}** — ${t.description}`).join("\n")}\n\nIMPORTANT: These are the ONLY tools available. Do not mention or use any tool that is not in this list.`
    : "";

  const toolKnowledgeBase = `
## Tool Usage Guide — When to Use What

### Code Execution
- **run_python**: Use for data analysis, calculations, file processing, ML models, web scraping with Python. ALWAYS try this first for any computation task. Requires an E2B sandbox key (configured in Settings).
- **run_terminal**: Use for shell commands — file operations, git, npm/pip installs, system queries. Supports pipes (|), redirects (>), and chains (&&).

### Web & Search
- **ddg_search**: Use for web searches via DuckDuckGo. Returns titles + URLs + snippets. Best for finding current information, documentation, or answers to factual questions.
- **web_fetch**: Use to read the full content of a specific URL. Use AFTER ddg_search to deep-read a promising result page.

### File Management (OPFS — local browser storage)
- **create_file / write_file**: Create or overwrite files in the user's workspace. Files persist across sessions.
- **read_file**: Read the content of a file in the workspace.
- **delete_file**: Remove a file from the workspace.
- **list_files**: List all files in a directory. Use this to discover what files exist before reading them.
- **search_files**: Grep/search for text across files. Use when the user asks "find X in my files".
- **create_folder**: Create a new directory in the workspace.

### Memory & Knowledge
- **memory**: Store and retrieve persistent facts about the user. Use when the user says "remember that..." or when you learn something important about their preferences.
- **e2b_rag / hopx_rag**: Search through uploaded documents using semantic search. Use when the user asks about content in their knowledge base or uploaded files.

### Subagent Orchestration (you are an orchestrator)
- **spawn_subagent**: Create a new subagent for a specific task. Use when a task is complex enough to delegate (e.g. "research X while I work on Y").
- **query_subagent**: Send a message to a subagent and get its reply. The subagent processes your message using its own API config and has access to all the same tools you do. Use this to delegate work and get results. If the subagent's task isn't done, query again with more specific instructions.
- **list_subagents**: Check which subagents are currently active. Use before spawning to avoid duplicates.
- **steer_subagent**: Send guidance to a running subagent (e.g. "focus only on Python files").
- **complete_subagent**: Mark a subagent's task as completed with a final result.
- **cancel_subagent**: Cancel a subagent that's going in the wrong direction.
- **create_custom_tool**: Create a specialized tool for a subagent (e.g. a meme generator, a sentiment analyzer). Use when a subagent needs a capability that doesn't exist in the built-in tools.
- **create_subagent_chat**: Start a new chat session with a subagent.
- **delete_subagent_chat / edit_subagent_chat_title / pin_subagent_chat**: Manage subagent chat sessions.

### Datetime & Utilities
- **datetime**: Get the current date/time. Use when the user asks "what time is it" or when timestamps are needed.
- **chart**: Create data visualizations (bar, line, pie, scatter, etc). Use when the user wants to "visualize" or "plot" data.
- **preview_image**: Display an image inline in the chat from a URL or base64. Use when you want to show the user a visual — a generated image, a screenshot, a diagram URL, etc.
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
2. **Analyse** complexity and dependencies
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

Each subagent shares the same sandbox + file system as you, so they can read/write the same files.`;

  const enhancedSystemPrompt = `${opts.systemPrompt}${toolListText}${toolKnowledgeBase}`;

  const priorMessages: ChatCompletionMessage[] = [
    { role: "system", content: enhancedSystemPrompt },
    ...history.map((m): ChatCompletionMessage => {
      if (m.role === "user") return { role: "user", content: m.content };
      if (m.role === "system") return { role: "system", content: m.content };
      // assistant — include tool_calls if any.
      const toolCalls = (m.tool_calls ?? []).map((tc) => ({
        id: tc.tool_call_id,
        type: "function" as const,
        function: { name: tc.tool_name, arguments: JSON.stringify(tc.args ?? {}) },
      }));
      return {
        role: "assistant",
        // Strip any "_(stopped)_" markers from aborted turns.
        // Use empty string (not null) for content — some providers reject
        // null content with "invalid message content type: <nil>".
        content: m.content
          ? m.content.replace(/\n\n_\(stopped\)_/g, "").trim()
          : "",
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    }),
  ];

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
  let lastAssistantThinking = "";
  let lastAssistantReasoning = "";
  let lastUsage: AgentTurnResult["usage"];
  let allToolCalls: ToolCall[] = [];
  // Accumulated ordered parts (thinking/reasoning/text/tool) across all
  // rounds — persisted on the assistant message so a page refresh restores
  // the exact same card ordering the user saw live.
  const assistantParts: MessagePart[] = [];
  const messages = [...priorMessages];

  // The "current" assistant message id we'll mutate as deltas arrive. The
  // outer caller / use-chat.ts creates the message on `model_request_start`
  // — we don't need to manage it here, but we do need a stable id to send
  // back in `message_saved`.
  const assistantMessageId = nanoid();

  while (round < MAX_ROUNDS) {
    round += 1;
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
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({
        type: "error",
        data: { message },
        timestamp: nowISO(),
      });
      // Persist what we have so far before exiting.
      await conversationService.addMessage(conversationId, opts.userId, {
        role: "assistant",
        content: lastAssistantContent || `(error: ${message})`,
        thinking: lastAssistantThinking || undefined,
        reasoning: lastAssistantReasoning || undefined,
        parts: buildAssistantParts(
          lastAssistantThinking || undefined,
          lastAssistantReasoning || undefined,
          allToolCalls,
          lastAssistantContent || `(error: ${message})`,
        ),
        toolCalls: allToolCalls,
        modelName: opts.provider.model,
      });
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

    if (roundResult.usage) lastUsage = roundResult.usage;
    lastAssistantContent = roundResult.content;
    lastAssistantThinking = roundResult.thinking;
    lastAssistantReasoning = roundResult.reasoning;

    // No tool calls → final result.
    if (roundResult.toolCalls.length === 0 || roundResult.aborted) {
      // If the content is empty (e.g. aborted before any text arrived),
      // use a minimal placeholder so the DB row isn't empty.
      const finalContent = roundResult.content || (roundResult.aborted ? "" : "");
      // Persist the final assistant message.
      const savedMessage = await conversationService.addMessage(
        conversationId,
        opts.userId,
        {
          role: "assistant",
          content: finalContent,
          thinking: roundResult.thinking || undefined,
          reasoning: roundResult.reasoning || undefined,
          parts: buildAssistantParts(
            roundResult.thinking || undefined,
            roundResult.reasoning || undefined,
            allToolCalls,
            finalContent,
          ),
          toolCalls: allToolCalls,
          modelName: opts.provider.model,
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
    messages.push({
      role: "assistant",
      content: roundResult.content || null,
      tool_calls: roundResult.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    });

    // Execute each tool.
    emit({ type: "call_tools_start", timestamp: nowISO() });
    for (const tc of roundResult.toolCalls) {
      const toolDef = getTool(tc.name);
      if (!toolDef) {
        const errMsg = `Tool '${tc.name}' is not registered`;
        emit({
          type: "tool_call",
          data: { tool_name: tc.name, args: tc.args, tool_call_id: tc.id },
          timestamp: nowISO(),
        });
        emit({
          type: "tool_result",
          data: { tool_call_id: tc.id, content: JSON.stringify({ error: errMsg }) },
          timestamp: nowISO(),
        });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.name,
          content: JSON.stringify({ error: errMsg }),
        });
        allToolCalls.push({
          id: tc.id,
          name: tc.name,
          args: tc.args,
          result: { error: errMsg },
          status: "error",
        });
        continue;
      }

      // Tool approval was removed — every tool executes immediately. The
      // `requires_approval` flag on the tool definition is now metadata-only
      // (still surfaced in the Settings → Tools catalog for transparency).
      const effectiveArgs = tc.args;

      emit({
        type: "tool_call",
        data: { tool_name: tc.name, args: effectiveArgs, tool_call_id: tc.id },
        timestamp: nowISO(),
      });

      // Build the per-call tool context. We inject an `onToolOutput` callback
      // that streams stdout/stderr chunks back to the UI in real time as
      // `tool_output` WSEvents. Tools that don't stream simply never call it.
      const streamingToolCtx: ToolContext = {
        ...toolCtxForList,
        onToolOutput: (toolCallId: string, output: string, type: "stdout" | "stderr") => {
          // The e2b_exec tools pass an empty toolCallId (they don't know it
          // at construction time) — substitute the real one from this turn.
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

      // ask_user short-circuit — the tool emitted an ask_user event and
      // returned a sentinel; the answers were already folded into `result`
      // by the tool handler (see tools/ask_user.ts).
      const resultStr =
        typeof result === "string" ? result : JSON.stringify(result);
      emit({
        type: "tool_result",
        data: { tool_call_id: tc.id, content: resultStr },
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
    }

    // Loop back for the next round.
  }

  // Hit max rounds — persist whatever content was generated (don't error).
  // The agent may have produced useful intermediate text or tool results;
  // surfacing those is better than dropping them on the floor with an error.
  const savedMessage = await conversationService.addMessage(
    conversationId,
    opts.userId,
    {
      role: "assistant",
      content:
        lastAssistantContent ||
        `(reached max rounds (${MAX_ROUNDS}); last content shown above)`,
      thinking: lastAssistantThinking || undefined,
      reasoning: lastAssistantReasoning || undefined,
      parts: buildAssistantParts(
        lastAssistantThinking || undefined,
        lastAssistantReasoning || undefined,
        allToolCalls,
        lastAssistantContent ||
          `(reached max rounds (${MAX_ROUNDS}); last content shown above)`,
      ),
      toolCalls: allToolCalls,
      modelName: opts.provider.model,
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
// Public helpers — exposed so the UI can dispatch approval / ask_user
// responses back into the runtime via window events.
// ---------------------------------------------------------------------------

export function respondToApproval(
  toolCallId: string,
  decision: ApprovalDecision,
): void {
  window.dispatchEvent(
    new CustomEvent(APPROVAL_EVENT_NAME, {
      detail: { ...decision, toolCallId },
    }),
  );
}

export function respondToAskUser(
  answers: Array<{ answer: string; skipped: boolean }>,
): void {
  window.dispatchEvent(
    new CustomEvent(ASK_USER_RESPONSE_EVENT, { detail: { answers } }),
  );
}

export { APPROVAL_REQUEST_EVENT_NAME, ASK_USER_RESPONSE_EVENT };
