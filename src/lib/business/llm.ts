"use client";

// ============================================================================
// Business Mode — LLM transport layer (Task 3-a).
//
// Thin, provider-agnostic helpers over the same wire path the Onyx agent
// runtime uses: browser → /api/chat-proxy (stateless CORS proxy) → the user's
// OpenAI-compatible provider. No server state, no server sessions.
//
// Public API (BINDING — see worklog.md):
//   - resolveBusinessLlmConfig(override?)   provider/model/key resolution
//   - businessLlmComplete(cfg, opts)        non-streaming completion
//   - businessLlmStream(cfg, opts)          SSE streaming completion
//   - businessWebSearch(query, signal?)     real web search via /api/ddg-search
// ============================================================================

import { aiProviderService, settingsService } from "@/lib/services";
import { useAuthStore } from "@/stores";
import { useChatStore } from "@/stores/chat-store";
import { extractDelta, parseSSEStream } from "@/lib/agent/runtime";
import {
  chatCompletionsUrl,
  listUsableProviders,
  resolveProviderForModel,
} from "@/lib/agent/provider-resolution";
import {
  POLLINATIONS_TEXT_BASE_URL,
  textModelIds,
  upsertTextProvider,
} from "@/lib/pollinations/provider-sync";
import { fetchPollinationsModels } from "@/lib/pollinations/api";
import type { AIProviderRow } from "@/lib/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BusinessLlmConfig {
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** When true, use the base URL as-is (no /chat/completions suffix). */
  noPrefix: boolean;
}

export interface BusinessLlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

export interface BusinessLlmCompleteOptions {
  systemPrompt: string;
  userPrompt: string;
  /** Full multi-turn message list (the specialist tool loop) — when set it
   *  REPLACES the system/user pair verbatim. */
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
  /** Overall call timeout (default 120s). */
  timeoutMs?: number;
  /** Max attempts for transient provider failures (default 4 — 1 try +
   *  3 bounded retries; pass 1 to disable the ladder). */
  maxAttempts?: number;
}

export interface BusinessLlmStreamOptions {
  systemPrompt: string;
  userPrompt: string;
  /** Full multi-turn message list (the specialist tool loop) — when set it
   *  REPLACES the system/user pair verbatim. */
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  signal?: AbortSignal;
  /** Receives each DELTA (not the accumulated text) — accumulate yourself. */
  onDelta: (text: string) => void;
  /** Max attempts for transient provider failures (default 4 — 1 try +
   *  3 bounded retries; pass 1 to disable the ladder). */
  maxAttempts?: number;
  /** Fired when a transient provider failure (rate limit, gateway hiccup,
   *  idle timeout, empty reply…) schedules a retry. The stream RESTARTS
   *  FROM ZERO after waitMs — callers that accumulate deltas MUST reset
   *  their accumulated text (and any UI state) when this fires. */
  onRetry?: (info: LlmRetryInfo) => void;
}

/** Details of a scheduled transient-failure retry, surfaced to callers so
 *  discovery's live monitor can tell the user WHY a stream restarted. */
export interface LlmRetryInfo {
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  /** Total attempts the ladder will make before giving up. */
  maxAttempts: number;
  /** Short human-readable reason (e.g. "HTTP 429 — rate limited"). */
  error: string;
  /** How long the ladder waits before restarting the stream. */
  waitMs: number;
}

export interface BusinessWebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const CHAT_PROXY_URL = "/api/chat-proxy";
const DEFAULT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Transient-failure retry ladder
// ---------------------------------------------------------------------------

/** Bounded backoff between retry attempts (4s → 10s → 20s). Free/anonymous
 *  provider tiers rate-limit bursts (e.g. a third discovery run in a row);
 *  these windows outlive most anonymous-tier cooldowns without making the
 *  UI feel dead — and the live monitor shows exactly what is happening. */
const RETRY_DELAYS_MS = [4_000, 10_000, 20_000] as const;
export const DEFAULT_LLM_MAX_ATTEMPTS = 4;

/**
 * Classify a business-LLM failure as TRANSIENT (worth a bounded retry: rate
 * limits, gateway hiccups, inactivity 504s, idle-timeout dead streams,
 * network resets, empty replies) or PERMANENT (bad key 401/403, bad request
 * 400/404, user cancellation — retrying cannot help).
 *
 * Mirrors the chat runtime's transient classifier (runtime.ts) so Business
 * Mode calls survive the same provider flakiness normal chat already does.
 */
export function isTransientLlmError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return false; // user cancel
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const m = msg.toLowerCase();
  // Auth / request-shape problems: retrying is pointless.
  if (/http 40[0134]|http 405|http 422|check the api key|unsupported parameter/i.test(m)) {
    return false;
  }
  // Rate limits + gateway/server errors + empty replies + dead streams.
  return /http 429|http 5\d\d|rate.?limit|too many requests|inactivity timeout|idle timeout|timeout|timed out|econnreset|socket hang up|fetch failed|failed to fetch|network error|load failed|terminated|connection reset|abnormal|stream aborted|empty completion|empty response|internal server error|bad gateway|service unavailable|overloaded/i.test(m);
}

/** Human-readable one-liner for a retry (kept short — the monitor shows it). */
function shortRetryReason(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).replace(/\s+/g, " ").trim();
  return msg.length > 140 ? `${msg.slice(0, 140)}…` : msg || "the provider failed";
}

/**
 * Run one bounded retry ladder around an attempt function. The attempt fn
 * returns its result on success; on a TRANSIENT error the ladder waits the
 * backoff, notifies onRetry (so callers reset accumulated stream text), and
 * restarts. User cancellations and permanent errors rethrow immediately.
 */
async function withRetryLadder<T>(
  opts: { signal?: AbortSignal; maxAttempts?: number; onRetry?: (info: LlmRetryInfo) => void },
  attemptFn: (attempt: number) => Promise<T>,
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_LLM_MAX_ATTEMPTS);
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptFn(attempt);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      if (opts.signal?.aborted) throw err;
      if (attempt >= maxAttempts || !isTransientLlmError(err)) throw err;
      const waitMs = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)] ?? 10_000;
      opts.onRetry?.({ attempt, maxAttempts, error: shortRetryReason(err), waitMs });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, waitMs);
        opts.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new Error("The request was cancelled."));
          },
          { once: true },
        );
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the LLM configuration for a Business Mode call.
 *
 * The LEGACY-CLASSIC GUARD + MODEL-FIRST provider resolution live in the
 * SHARED layer (lib/agent/provider-resolution — listUsableProviders /
 * resolveProviderForModel), so Business Mode, the main chat and subagents
 * resolve identically: a stale text.pollinations.ai (Classic) row can never
 * be called (it self-heals here), and the selected model always travels with
 * the provider that OFFERS it (the Classic-API-404 fix).
 *
 * Provider chain (first match wins):
 *   1. override.providerId (explicit — e.g. a business's saved main
 *      provider config in Settings → Business → Main agent model)
 *   2. MODEL-FIRST — the chat-store's selectedModel resolved to the
 *      provider that OFFERS it; active providers are preferred
 *   3. the chat-store's selectedProviderId (no model picked / orphaned
 *      model id)
 *   4. first active provider
 *
 * Model chain: override.model → the chat-store selectedModel when the
 * resolved provider offers it → provider.models[0]. An orphaned selected
 * model id (its provider was deleted/re-synced away) falls back to the
 * provider's first model instead of sending a guaranteed-404 model. No
 * hardcoded fallback model, ever.
 *
 * Net effect: Business Mode calls (discovery incl. the blueprint-drafting
 * third step, chat turns, regeneration, specialists) always run on the
 * model CURRENTLY SELECTED in the chat UI together with the provider that
 * actually serves it — and always on the official gen.pollinations.ai
 * gateway when the selection is Pollinations.
 *
 * Throws a friendly Error when nothing is usable — callers surface UI
 * guidance (wizard empty state / toast), never a raw stack trace.
 */
export async function resolveBusinessLlmConfig(
  override?: { providerId?: string; model?: string },
): Promise<BusinessLlmConfig> {
  const userId = useAuthStore.getState().user?.id ?? "local-user";
  const usable = await listUsableProviders(userId);
  if (usable.length === 0) {
    throw new Error(
      "No AI provider configured — add one in Settings → Config, or connect your Pollinations account from the business wizard (the official gen.pollinations.ai API uses your own key; the old keyless text.pollinations.ai endpoint is retired) to use Business Mode.",
    );
  }

  const { selectedProviderId, selectedModel } = useChatStore.getState();

  let provider: AIProviderRow | undefined;

  if (override?.providerId) {
    provider = usable.find((p) => p.id === override.providerId);
  }
  // MODEL-FIRST (shared helper): the selected model with the provider that
  // OWNS it — also the stale-selection recovery.
  if (!provider) {
    provider = resolveProviderForModel(usable, selectedModel);
  }
  if (!provider && selectedProviderId) {
    provider = usable.find((p) => p.id === selectedProviderId);
  }
  if (!provider) {
    provider = usable.find((p) => p.is_active) ?? usable[0];
  }
  if (!provider) {
    throw new Error("No AI provider configured — add one in Settings → Config.");
  }

  const apiKey = (await aiProviderService.getDecryptedApiKey(provider.id)) ?? "";
  // An empty key is still allowed (some gateways serve anonymous tiers): the
  // Authorization header is then omitted. NOTE — the official Pollinations
  // gateway (gen.pollinations.ai) retired its keyless tier: requests without
  // a Bearer key get HTTP 401, which the retry ladder classifies as permanent
  // (the honest fix is connecting an account, not retrying).

  let model: string | undefined = override?.model;
  // Adopt the chat-store model ONLY when the resolved provider offers it
  // (guaranteed by model-first resolution; an explicit provider+model pair
  // is consistent by construction). An orphaned id falls through to the
  // provider's first model — never a guaranteed-404 model.
  if (!model && selectedModel && (provider.models ?? []).includes(selectedModel)) {
    model = selectedModel;
  }
  if (!model) model = provider.models?.[0];
  if (!model) {
    throw new Error(
      `The provider "${provider.name}" has no models configured. Add at least one model in Settings → Config.`,
    );
  }

  return {
    providerId: provider.id,
    providerName: provider.name,
    baseUrl: provider.base_url,
    apiKey,
    model,
    noPrefix: !!provider.no_prefix,
  };
}

// ---------------------------------------------------------------------------
// Shared request plumbing
// ---------------------------------------------------------------------------

function buildTargetUrl(cfg: BusinessLlmConfig): string {
  // The ONE shared construction (provider-resolution) — no workflow builds
  // its own endpoint URL.
  return chatCompletionsUrl(cfg.baseUrl, cfg.noPrefix);
}

function proxyUrl(targetUrl: string): string {
  return `${CHAT_PROXY_URL}?url=${encodeURIComponent(targetUrl)}`;
}

/** AbortController that fires on either the caller's signal or a timeout. */
function combinedController(signal: AbortSignal | undefined, timeoutMs: number): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    controller,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Human-readable message for a non-2xx upstream response. */
function describeUpstreamError(status: number, body: string, providerName: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    if (typeof parsed.error === "string") detail = parsed.error;
    else if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string") {
      detail = parsed.error.message;
    } else if (typeof parsed.message === "string") {
      detail = parsed.message;
    }
  } catch {
    // body is not JSON — fall through to the raw text
  }
  if (!detail) detail = body.replace(/\s+/g, " ").trim().slice(0, 200);
  let hint = "";
  if (status === 401 || status === 403) hint = " — check the API key for this provider (Settings → Config)";
  else if (status === 429) hint = " — rate limited by the provider, try again shortly";
  return `Provider "${providerName}" error (HTTP ${status}): ${detail || "no details provided"}${hint}`;
}

// ---------------------------------------------------------------------------
// Native tool_calls → text-protocol synthesis
// ---------------------------------------------------------------------------

/** One accumulated native tool call (OpenAI `message.tool_calls` shape or
 *  the streamed `delta.tool_calls` fragments accumulated by index). */
export interface NativeToolCallInput {
  name?: unknown;
  arguments?: unknown;
  function?: { name?: unknown; arguments?: unknown } | null;
}

/** Normalize the FIRST valid native tool call into the business text
 * protocol `{"tool": name, "args": {…}}`.
 *
 * WHY: function-calling models (gpt-oss on the free Pollinations tier,
 * OpenAI, Mistral…) read the tool protocol in the system prompt and reply
 * with NATIVE `message.tool_calls` + an EMPTY `message.content` — they never
 * write the JSON as text. Without this synthesis those replies looked like
 * empty completions and every specialist tool round died in the
 * empty-completion retry ladder. */
export function nativeToolCallsToText(calls: NativeToolCallInput[]): string {
  for (const call of calls) {
    const name = call.function?.name ?? call.name;
    if (typeof name !== "string" || !name.trim()) continue;
    let args: Record<string, unknown> = {};
    const rawArgs = call.function?.arguments ?? call.arguments;
    if (typeof rawArgs === "string" && rawArgs.trim()) {
      try {
        const parsed = JSON.parse(rawArgs) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        // Fragmented/invalid argument JSON — the loop's executor will report
        // a helpful error back to the model instead of dying silently.
        args = {};
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs as Record<string, unknown>;
    }
    return JSON.stringify({ tool: name, args });
  }
  return "";
}

/** Read a non-streaming completion body: JSON first, SSE-shaped fallback. */
function parseCompletionText(raw: string): { content: string; usage?: BusinessLlmUsage } {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as {
        choices?: Array<{
          message?: {
            content?: unknown;
            tool_calls?: Array<{
              function?: { name?: unknown; arguments?: unknown } | null;
            }>;
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const message = obj.choices?.[0]?.message;
      const content = message?.content;
      if (typeof content === "string" || content === null || content === undefined) {
        let text = content ?? "";
        // NATIVE TOOL CALLS (gpt-oss & friends): empty content + tool_calls
        // → synthesize the text protocol so the caller can execute the call.
        if (!text.trim() && Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
          text = nativeToolCallsToText(message.tool_calls);
        }
        return {
          content: text,
          usage: obj.usage
            ? { prompt_tokens: obj.usage.prompt_tokens, completion_tokens: obj.usage.completion_tokens }
            : undefined,
        };
      }
    } catch {
      // fall through to the SSE parser
    }
  }
  if (trimmed.includes("data:")) {
    // Some providers stream even when asked not to — accumulate the deltas.
    let content = "";
    let usage: BusinessLlmUsage | undefined;
    for (const block of trimmed.split("\n\n")) {
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: unknown } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === "string") content += delta;
          if (chunk.usage) {
            usage = {
              prompt_tokens: chunk.usage.prompt_tokens,
              completion_tokens: chunk.usage.completion_tokens,
            };
          }
        } catch {
          // skip malformed frame
        }
      }
    }
    if (content) return { content, usage };
  }
  return { content: trimmed };
}

// ---------------------------------------------------------------------------
// businessLlmComplete
// ---------------------------------------------------------------------------

/**
 * Non-streaming Chat Completions call through the CORS proxy.
 *
 * jsonMode adds `response_format: { type: "json_object" }`; if the upstream
 * rejects it with a 4xx mentioning response_format, the call self-heals with
 * one retry WITHOUT the flag (wire-compat precedent from runtime.ts).
 */
export async function businessLlmComplete(
  cfg: BusinessLlmConfig,
  opts: BusinessLlmCompleteOptions,
): Promise<{ text: string; usage?: BusinessLlmUsage }> {
  return withRetryLadder(opts, async () => {
    const targetUrl = buildTargetUrl(cfg);
    const { controller, cleanup } = combinedController(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const doFetch = async (withJsonMode: boolean): Promise<Response> => {
      const body: Record<string, unknown> = {
        model: cfg.model,
        messages: opts.messages ?? [
          { role: "system", content: opts.systemPrompt },
          { role: "user", content: opts.userPrompt },
        ],
        stream: false,
      };
      if (typeof opts.temperature === "number") body.temperature = opts.temperature;
      if (typeof opts.maxTokens === "number") body.max_tokens = opts.maxTokens;
      if (withJsonMode && opts.jsonMode) body.response_format = { type: "json_object" };
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-target-url": targetUrl,
        Accept: "text/event-stream",
      };
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      return fetch(proxyUrl(targetUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
    };

    try {
      let res = await doFetch(!!opts.jsonMode);
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const canSelfHeal =
          opts.jsonMode && res.status >= 400 && res.status < 500 && /response_format/i.test(errText);
        if (!canSelfHeal) {
          throw new Error(describeUpstreamError(res.status, errText, cfg.providerName));
        }
        // Wire-compat self-healing: retry once WITHOUT response_format.
        res = await doFetch(false);
        if (!res.ok) {
          const errText2 = await res.text().catch(() => "");
          throw new Error(describeUpstreamError(res.status, errText2, cfg.providerName));
        }
      }
      const raw = await res.text();
      const parsed = parseCompletionText(raw);
      if (!parsed.content.trim()) {
        throw new Error(`Provider "${cfg.providerName}" returned an empty completion.`);
      }
      return { text: parsed.content, usage: parsed.usage };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          opts.signal?.aborted
            ? "The request was cancelled."
            : `The request to "${cfg.providerName}" timed out — try again or pick a faster model.`,
        );
      }
      throw err;
    } finally {
      cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// businessLlmStream
// ---------------------------------------------------------------------------

/**
 * Streaming Chat Completions call. Deltas are surfaced through `onDelta` as
 * they arrive (the caller updates UI state per delta and persists only at the
 * end). SSE parsing + 120s idle-timeout handling come from the runtime's
 * battle-tested parseSSEStream.
 *
 * TRANSIENT-RETRY LADDER: rate limits (429), gateway 5xx/inactivity pages,
 * idle-timeout dead streams and empty completions are retried up to
 * maxAttempts (default 4) with bounded backoff. Because a retried stream
 * RESTARTS FROM ZERO, the ladder fires `onRetry` before each restart so
 * delta-accumulating callers can reset their state (otherwise the retried
 * output would be prepended with the aborted attempt's partial text).
 *
 * STREAMING-REJECTED SELF-HEAL: providers increasingly gate their streaming
 * endpoint behind auth while still serving the SAME request non-streaming
 * (Pollinations' keyless tier started doing exactly this — stream:true gets
 * HTTP 401 "A valid API key is required" while stream:false returns 200,
 * which killed every discovery draft at "0 characters streamed"). When the
 * streaming attempt is rejected with 400/401/403 — or the "streaming"
 * response arrives as plain JSON — the call self-heals with ONE
 * non-streaming request and synthesizes the delta feed, so the live monitor
 * still shows what the model wrote.
 */
export async function businessLlmStream(
  cfg: BusinessLlmConfig,
  opts: BusinessLlmStreamOptions,
): Promise<{ text: string; usage?: BusinessLlmUsage }> {
  return withRetryLadder(opts, async () => {
    const targetUrl = buildTargetUrl(cfg);
    // No overall timeout: generation length is unbounded; parseSSEStream enforces
    // the 120s idle timeout that catches dead streams.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const doFetch = async (stream: boolean): Promise<Response> => {
      const body: Record<string, unknown> = {
        model: cfg.model,
        messages: opts.messages ?? [
          { role: "system", content: opts.systemPrompt },
          { role: "user", content: opts.userPrompt },
        ],
        stream,
      };
      if (stream) body.stream_options = { include_usage: true };
      if (typeof opts.temperature === "number") body.temperature = opts.temperature;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-target-url": targetUrl,
        Accept: "text/event-stream",
      };
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      return fetch(proxyUrl(targetUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
    };

    /** Feed a fully-generated text through onDelta in small animated chunks —
     *  the self-heal path's honest equivalent of a live stream. */
    const synthesizeDeltas = async (
      text: string,
      usage?: BusinessLlmUsage,
    ): Promise<{ text: string; usage?: BusinessLlmUsage }> => {
      const CHUNK = 96;
      for (let i = 0; i < text.length; i += CHUNK) {
        if (opts.signal?.aborted) throw new Error("The stream was cancelled.");
        opts.onDelta(text.slice(i, i + CHUNK));
        if (i + CHUNK < text.length) {
          // A few ms per chunk — the whole blueprint animates in well under a
          // second; fast, but visibly "written" in the live monitor.
          await new Promise<void>((r) => setTimeout(r, 8));
        }
      }
      return { text, usage };
    };

    try {
      const res = await doFetch(true);

      // STREAMING-REJECTED SELF-HEAL (see doc comment): 400/401/403 on the
      // streaming attempt → ONE non-streaming retry of the same request.
      if (!res.ok && (res.status === 400 || res.status === 401 || res.status === 403)) {
        const streamErrText = await res.text().catch(() => "");
        const nonStream = await doFetch(false);
        if (nonStream.ok && nonStream.body) {
          const raw = await nonStream.text();
          const parsed = parseCompletionText(raw);
          if (parsed.content.trim()) {
            return await synthesizeDeltas(parsed.content, parsed.usage);
          }
          // Non-streaming replied but with no content — surface the ORIGINAL
          // streaming error (the likelier truthful reason).
          throw new Error(describeUpstreamError(res.status, streamErrText, cfg.providerName));
        }
        // Non-streaming also rejected — ITS error is the truthful one (a
        // genuinely missing/invalid key, a genuinely bad request).
        const errText2 = await nonStream.text().catch(() => "");
        throw new Error(
          describeUpstreamError(nonStream.status, errText2, cfg.providerName),
        );
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(describeUpstreamError(res.status, errText, cfg.providerName));
      }
      if (!res.body) {
        throw new Error(`Provider "${cfg.providerName}" returned an empty response body.`);
      }

      // Some relays accept stream:true but answer with a single plain-JSON
      // body (content-type application/json, no SSE events). Detect that
      // before the SSE reader and use the same self-heal path.
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const raw = await res.text();
        const parsed = parseCompletionText(raw);
        if (parsed.content.trim()) {
          return await synthesizeDeltas(parsed.content, parsed.usage);
        }
        throw new Error(`Provider "${cfg.providerName}" returned an empty completion.`);
      }

      const reader = res.body.getReader();
      let text = "";
      let usage: BusinessLlmUsage | undefined;
      // Native tool_calls arrive as indexed delta fragments (name once, then
      // argument JSON in pieces) — accumulate them by index and, when the
      // stream ends with no text, synthesize the text-protocol call.
      const toolCallAcc = new Map<number, { name: string; arguments: string }>();
      for await (const chunk of parseSSEStream(reader, controller.signal)) {
        const delta = extractDelta(chunk);
        if (delta?.text) {
          text += delta.text;
          opts.onDelta(delta.text);
        }
        if (delta?.toolCalls) {
          for (const tc of delta.toolCalls) {
            const slot = toolCallAcc.get(tc.index) ?? { name: "", arguments: "" };
            if (tc.name) slot.name += tc.name;
            if (tc.arguments) slot.arguments += tc.arguments;
            toolCallAcc.set(tc.index, slot);
          }
        }
        const u = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
        if (u && typeof u === "object") {
          usage = { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens };
        }
      }
      if (!text.trim() && toolCallAcc.size > 0) {
        // NATIVE TOOL CALL STREAM: no content deltas, but the model called a
        // tool — return the synthesized protocol text (NEVER streamed via
        // onDelta: a tool call must not appear in the chat bubble; the
        // specialist loop turns it into a real tool bar).
        const calls = [...toolCallAcc.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, v]) => ({ name: v.name, arguments: v.arguments }));
        const synthesized = nativeToolCallsToText(calls);
        if (synthesized) return { text: synthesized, usage };
      }
      if (!text.trim()) {
        // EMPTY-COMPLETED-STREAM SELF-HEAL: some reasoning models stream long
        // thinking (delta.reasoning…) that consumes the ENTIRE output budget
        // — the stream completes 200-OK with ZERO content deltas (observed
        // on Pollinations' gpt-oss keyless tier). One non-streaming request
        // usually returns the answer directly (message.content), so fall
        // back to it instead of failing the turn.
        const nonStream = await doFetch(false);
        if (nonStream.ok && nonStream.body) {
          const raw = await nonStream.text();
          const parsed = parseCompletionText(raw);
          if (parsed.content.trim()) {
            return await synthesizeDeltas(parsed.content, parsed.usage);
          }
        }
        throw new Error(`Provider "${cfg.providerName}" returned an empty completion.`);
      }
      return { text, usage };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error("The stream was cancelled.");
      }
      throw err;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
  });
}

// ---------------------------------------------------------------------------
// Pollinations provider — the OFFICIAL gen.pollinations.ai gateway (auth)
// ---------------------------------------------------------------------------

/**
 * The user's connected Pollinations (BYOP) key, read straight from the
 * encrypted settings store — the pollinations zustand store is only
 * initialized inside the settings UI, so business flows must not depend on
 * it. Null when not connected or the connection expired.
 */
async function connectedPollinationsKey(userId: string): Promise<string | null> {
  const { token, meta } = await settingsService.getPollinationsConnection(userId);
  if (!token) return null;
  const expired =
    !!meta?.expiresAt && new Date(meta.expiresAt).getTime() <= Date.now();
  return expired ? null : token;
}

/**
 * Add (or refresh) the official Pollinations text provider — the NEW
 * authenticated gateway (user directive: real API, with auth):
 *
 *   base   https://gen.pollinations.ai/v1  (the app appends /chat/completions)
 *   auth   Bearer <the user's connected Pollinations key>
 *   models the LIVE catalogue (publisher/model ids rotate — never hardcoded;
 *           the same source the Pollinations settings UI uses)
 *
 * Requires the user to be connected (Settings → Pollinations): the BYOP
 * connection key IS the API key — there is no keyless tier anymore. Throws a
 * friendly error when not connected; callers route the user to the
 * Pollinations settings page. Returns the live model count now on the row.
 */
export async function addPollinationsProvider(userId: string): Promise<number> {
  const token = await connectedPollinationsKey(userId);
  if (!token) {
    throw new Error(
      "Connect your Pollinations account first (Settings → Pollinations) — the official gen.pollinations.ai API requires your own key.",
    );
  }
  const models = await fetchPollinationsModels();
  const result = await upsertTextProvider(userId, token, models);
  return result.modelCount;
}

/**
 * One-time, self-limiting migration — now in the NEW-API direction: a
 * "Pollinations" provider still pointing at the RETIRED keyless
 * text.pollinations.ai endpoint is moved to the authenticated gateway.
 *
 *   connected → repoint to gen.pollinations.ai/v1, attach the connection
 *               key, refresh models from the live catalogue
 *   not conn. → delete the dead row (the keyless tier is gone — that base
 *               URL can never authenticate with the new API)
 *
 * No-op once no legacy row matches (cheap to call on every provider refresh).
 */
export async function migrateLegacyPollinationsGateway(userId: string): Promise<void> {
  try {
    const providers = await aiProviderService.list(userId);
    const legacy = providers.find(
      (p) => p.name === "Pollinations" && p.base_url.includes("text.pollinations.ai"),
    );
    if (!legacy) return;
    const token = await connectedPollinationsKey(userId);
    if (token) {
      const models = await fetchPollinationsModels();
      await aiProviderService.update(legacy.id, {
        base_url: POLLINATIONS_TEXT_BASE_URL,
        api_key: token,
        models: textModelIds(models),
        no_prefix: false,
        is_active: true,
      });
    } else {
      // Keyless tier is retired — a legacy row with no key to attach can
      // never work again. Remove it so the honest provider gate + connect
      // CTA take over.
      await aiProviderService.delete(legacy.id);
    }
  } catch {
    // Best-effort — provider listing errors surface through the UI paths.
  }
}

// ---------------------------------------------------------------------------
// businessWebSearch
// ---------------------------------------------------------------------------

/**
 * Real web search via the app's /api/ddg-search route (LangSearch/Miklium).
 * Never throws — failures return an empty result set so agent turns keep
 * running honestly without fabricated data.
 */
export async function businessWebSearch(
  query: string,
  signal?: AbortSignal,
): Promise<{ results: BusinessWebSearchResult[] }> {
  try {
    const q = query.trim();
    if (!q) return { results: [] };
    const res = await fetch(
      `/api/ddg-search?q=${encodeURIComponent(q)}&type=web&limit=8`,
      { signal, cache: "no-store" },
    );
    if (!res.ok) return { results: [] };
    const data = (await res.json()) as {
      results?: Array<{ title?: unknown; url?: unknown; description?: unknown }>;
    };
    const raw = Array.isArray(data.results) ? data.results : [];
    const results: BusinessWebSearchResult[] = [];
    for (const item of raw) {
      const url = typeof item.url === "string" ? item.url : "";
      if (!url) continue;
      results.push({
        title: (typeof item.title === "string" && item.title.trim()) || url,
        url,
        snippet: (typeof item.description === "string" ? item.description : "").slice(0, 400),
      });
      if (results.length >= 6) break;
    }
    return { results };
  } catch {
    return { results: [] };
  }
}
