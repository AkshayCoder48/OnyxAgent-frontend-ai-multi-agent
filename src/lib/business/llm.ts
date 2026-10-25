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

import { aiProviderService } from "@/lib/services";
import { useAuthStore } from "@/stores";
import { useChatStore } from "@/stores/chat-store";
import { extractDelta, parseSSEStream } from "@/lib/agent/runtime";
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
}

export interface BusinessWebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const CHAT_PROXY_URL = "/api/chat-proxy";
const DEFAULT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the LLM configuration for a Business Mode call.
 *
 * Provider chain: override.providerId → chat-store selectedProviderId →
 * the provider that offers the chat-store selectedModel (stale-provider
 * recovery) → first active provider. Model chain: override.model →
 * chat-store selectedModel (when the selected provider resolved, or the
 * resolved provider offers that model) → provider.models[0].
 *
 * Net effect: Business Mode calls (discovery, chat turns, regeneration)
 * always run on the model CURRENTLY SELECTED in the chat UI whenever it
 * can be resolved to a configured provider.
 *
 * Throws a friendly Error when nothing is usable — callers surface UI
 * guidance (wizard empty state / toast), never a raw stack trace.
 */
export async function resolveBusinessLlmConfig(
  override?: { providerId?: string; model?: string },
): Promise<BusinessLlmConfig> {
  const userId = useAuthStore.getState().user?.id ?? "local-user";
  const providers = await aiProviderService.list(userId);
  if (providers.length === 0) {
    throw new Error(
      "No AI provider configured — add one in Settings → Config (or use the free Pollinations provider from the business wizard) to use Business Mode.",
    );
  }

  const { selectedProviderId, selectedModel } = useChatStore.getState();

  let provider: AIProviderRow | undefined;
  let fromChatStore = false;

  if (override?.providerId) {
    provider = providers.find((p) => p.id === override.providerId);
  }
  if (!provider && selectedProviderId) {
    provider = providers.find((p) => p.id === selectedProviderId);
    fromChatStore = !!provider;
  }
  // Stale selectedProviderId (provider deleted / imported id drifted) but a
  // live selectedModel: resolve the provider that actually offers that model
  // so the user's current chat selection still wins.
  if (!provider && selectedModel) {
    provider =
      providers.find((p) => p.is_active && (p.models ?? []).includes(selectedModel)) ??
      providers.find((p) => (p.models ?? []).includes(selectedModel));
    fromChatStore = !!provider;
  }
  if (!provider) {
    provider = providers.find((p) => p.is_active) ?? providers[0];
    fromChatStore = false;
  }
  if (!provider) {
    throw new Error("No AI provider configured — add one in Settings → Config.");
  }

  const apiKey = (await aiProviderService.getDecryptedApiKey(provider.id)) ?? "";
  // Keyless providers (e.g. the free Pollinations tier) are allowed: an empty
  // key simply means the Authorization header is omitted — the provider then
  // serves its anonymous tier instead of rejecting an invalid bearer token.

  let model: string | undefined = override?.model;
  if (!model && selectedModel && fromChatStore) model = selectedModel;
  // The selected provider may not list the selected model explicitly (some
  // providers accept arbitrary model ids) — still honor the selection when
  // it is at least offered by the resolved provider.
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
  const base = cfg.baseUrl.replace(/\/$/, "");
  return cfg.noPrefix ? base : `${base}/chat/completions`;
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

/** Read a non-streaming completion body: JSON first, SSE-shaped fallback. */
function parseCompletionText(raw: string): { content: string; usage?: BusinessLlmUsage } {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = obj.choices?.[0]?.message?.content;
      if (typeof content === "string" || content === null || content === undefined) {
        return {
          content: content ?? "",
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
}

// ---------------------------------------------------------------------------
// businessLlmStream
// ---------------------------------------------------------------------------

/**
 * Streaming Chat Completions call. Deltas are surfaced through `onDelta` as
 * they arrive (the caller updates UI state per delta and persists only at the
 * end). SSE parsing + 120s idle-timeout handling come from the runtime's
 * battle-tested parseSSEStream.
 */
export async function businessLlmStream(
  cfg: BusinessLlmConfig,
  opts: BusinessLlmStreamOptions,
): Promise<{ text: string; usage?: BusinessLlmUsage }> {
  const targetUrl = buildTargetUrl(cfg);
  // No overall timeout: generation length is unbounded; parseSSEStream enforces
  // the 120s idle timeout that catches dead streams.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: opts.messages ?? [
        { role: "system", content: opts.systemPrompt },
        { role: "user", content: opts.userPrompt },
      ],
      stream: true,
      stream_options: { include_usage: true },
    };
    if (typeof opts.temperature === "number") body.temperature = opts.temperature;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-target-url": targetUrl,
      Accept: "text/event-stream",
    };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    const res = await fetch(proxyUrl(targetUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(describeUpstreamError(res.status, errText, cfg.providerName));
    }
    if (!res.body) {
      throw new Error(`Provider "${cfg.providerName}" returned an empty response body.`);
    }

    const reader = res.body.getReader();
    let text = "";
    let usage: BusinessLlmUsage | undefined;
    for await (const chunk of parseSSEStream(reader, controller.signal)) {
      const delta = extractDelta(chunk);
      if (delta?.text) {
        text += delta.text;
        opts.onDelta(delta.text);
      }
      const u = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      if (u && typeof u === "object") {
        usage = { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens };
      }
    }
    if (!text.trim()) {
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
