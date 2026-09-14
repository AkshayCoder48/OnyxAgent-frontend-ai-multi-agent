/**
 * Provider client — OpenAI-compatible Chat Completions and Responses API.
 *
 * Supports:
 * - Streamed and non-streamed Chat Completions
 * - Multiple tool calls per response
 * - reasoning_content / thinking fields
 * - SSE parsing with tolerant buffering
 * - [DONE] termination
 * - Usage reporting
 *
 * Endpoint construction handles:
 * - OpenAI: /v1/chat/completions
 * - OpenRouter: /api/v1/chat/completions
 * - Exact custom endpoints (noPrefix mode)
 * - Local HTTP providers (Ollama, LM Studio, vLLM)
 *
 * Also gates LOCAL OnyxAI providers on the browser-runtime presence record
 * the OnyxAgent web app heartbeats to OnyxBase KV (see the OnyxAI section
 * below) — "the user has to start the models".
 */

import { getSecret } from "./vault.js";

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  modelType: "chat" | "responses";
  toolsEnabled: boolean;
  noPrefix?: boolean;
  thinkingEnabled?: boolean;
  temperature?: number;
  /** Provider display name (from the config store) — used by the OnyxAI presence gate. */
  name?: string | null;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface StreamChunk {
  textDelta?: string;
  reasoningDelta?: string;
  toolCallDelta?: {
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
  };
  finishReason?: string | null;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  done?: boolean;
}

// ---------------------------------------------------------------------------
// OnyxAI browser-runtime presence gate (OnyxBase KV)
//
// OnyxAI runs models LOCALLY in the user's browser (qvac serve --openai on
// their device). The OnyxAgent web app's "OnyxAI Browser Runtime" heartbeats
// a presence record to OnyxBase KV every 5s while it can reach the local
// server — the CLI reads that record BEFORE calling a LOCAL OnyxAI provider,
// so the user gets an actionable "start your models" error instead of a raw
// connection refusal.
// ---------------------------------------------------------------------------

/** OnyxBase REST base URL (override with the ONYXBASE_BASE_URL env var). */
const ONYXBASE_DEFAULT_BASE_URL = "https://onyxbase-phi.vercel.app";
/** KV key the Browser Runtime heartbeats (collection "onyxagent"). */
const ONYXAI_PRESENCE_KEY = "onyxai:bridge:presence";
/** Presence is fresh while younger than this (the heartbeat runs every 5s). */
const ONYXAI_PRESENCE_STALE_MS = 20_000;
/** Hard timeout for the presence fetch. */
const ONYXAI_PRESENCE_TIMEOUT_MS = 10_000;
/** Reuse one presence fetch for ~5s — a chat's rounds must not refetch every call. */
const ONYXAI_PRESENCE_CACHE_MS = 5_000;

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

/**
 * True when the URL points at the user's own machine (localhost / 127.0.0.1 /
 * 0.0.0.0 / [::1] / ::1 / *.localhost hostnames) — same logic as the app's
 * src/lib/onyxai/catalog.ts.
 */
export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    if (LOCAL_HOSTNAMES.has(u.hostname)) return true;
    // qvac serve --host also allows .localhost subdomains.
    if (u.hostname.endsWith(".localhost")) return true;
    return false;
  } catch {
    return false;
  }
}

/** Presence record published by the OnyxAI Browser Runtime. */
export interface OnyxAiPresence {
  /** Epoch ms of the last heartbeat. */
  lastSeenAt: number;
  baseUrl?: string;
  /** Models the local server actually serves. */
  models: string[];
  modelsOk: boolean;
  activeModel?: string | null;
  version: number;
}

function onyxBaseBaseUrl(): string {
  return (process.env.ONYXBASE_BASE_URL ?? ONYXBASE_DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

/**
 * Resolve the OnyxBase API key: vault secret "onyxbase_key" → ONYXBASE_KEY env.
 * An inaccessible/locked vault just means "not configured". Null when neither.
 */
function resolveOnyxBaseKey(): string | null {
  try {
    const fromVault = getSecret("onyxbase_key");
    if (fromVault) return fromVault.trim();
  } catch {
    // Vault unavailable (no master key / corrupt) — fall through to the env var.
  }
  const fromEnv = (process.env.ONYXBASE_KEY ?? "").trim();
  return fromEnv || null;
}

/**
 * Fetch the presence record from OnyxBase KV.
 * Returns null when the record is missing (404); throws on network/HTTP errors.
 */
async function fetchOnyxAiPresence(apiKey: string): Promise<OnyxAiPresence | null> {
  const res = await fetch(
    `${onyxBaseBaseUrl()}/v1/get/${encodeURIComponent(ONYXAI_PRESENCE_KEY)}?collection=onyxagent`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(ONYXAI_PRESENCE_TIMEOUT_MS),
    },
  );
  if (res.status === 404) return null; // never heartbeated, or stopped
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OnyxBase HTTP ${res.status}${errText ? `: ${errText.slice(0, 200)}` : ` (${res.statusText})`}`);
  }
  const data = (await res.json().catch(() => null)) as { value?: unknown } | null;
  if (!data || data.value === undefined || data.value === null) return null;
  // The KV API wraps the stored value as a JSON STRING — parse twice.
  let raw: unknown = data.value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null; // corrupt record — treat as missing
    }
  }
  const p = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<OnyxAiPresence>;
  if (typeof p.lastSeenAt !== "number") return null;
  return {
    lastSeenAt: p.lastSeenAt,
    baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : undefined,
    models: Array.isArray(p.models) ? p.models.filter((m): m is string => typeof m === "string") : [],
    modelsOk: p.modelsOk === true,
    activeModel: typeof p.activeModel === "string" ? p.activeModel : null,
    version: typeof p.version === "number" ? p.version : 1,
  };
}

/** Module-level presence cache (see ONYXAI_PRESENCE_CACHE_MS). */
let presenceCache: { fetchedAt: number; presence: OnyxAiPresence | null } | null = null;

/**
 * Cached presence fetch — retries once on failure, then throws a readable
 * error. Never silently proceeds when a key IS configured but the check failed.
 */
async function fetchOnyxAiPresenceCached(apiKey: string): Promise<OnyxAiPresence | null> {
  if (presenceCache && Date.now() - presenceCache.fetchedAt < ONYXAI_PRESENCE_CACHE_MS) {
    return presenceCache.presence;
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const presence = await fetchOnyxAiPresence(apiKey);
      presenceCache = { fetchedAt: Date.now(), presence };
      return presence;
    } catch (e) {
      lastError = e;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 300)); // brief backoff, one retry
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Couldn't verify the OnyxAI Browser Runtime — the OnyxBase presence check failed twice (${reason}). ` +
      `OnyxBase: ${onyxBaseBaseUrl()} (override with ONYXBASE_BASE_URL). ` +
      `Remove the onyxbase_key secret or unset ONYXBASE_KEY to skip this check.`,
  );
}

/** The actionable "start your models" error (missing OR stale presence). */
function onyxAiRuntimeOfflineError(): Error {
  return new Error(
    "OnyxAI models run locally in your browser — the OnyxAI Browser Runtime isn't running. " +
      "Open the OnyxAgent app, turn ON the OnyxAI Browser Runtime (Settings → OnyxAI), then retry. " +
      `(Presence via OnyxBase ${onyxBaseBaseUrl()} — override with ONYXBASE_BASE_URL.)`,
  );
}

/**
 * OnyxAI browser-runtime presence gate — verify the Browser Runtime is alive
 * BEFORE calling a LOCAL OnyxAI provider ("the user has to start the models").
 *
 * No-op unless the base URL is local AND the provider name matches /onyx/i.
 * Soft-skips when no OnyxBase key is configured — the direct local call then
 * surfaces its own connection error.
 */
export async function assertOnyxAiRuntimeReady(opts: {
  baseUrl: string;
  model?: string | null;
  name?: string | null;
}): Promise<void> {
  if (!isLocalBaseUrl(opts.baseUrl)) return;
  const name = (opts.name ?? "").trim();
  if (!name || !/onyx/i.test(name)) return;

  const apiKey = resolveOnyxBaseKey();
  if (!apiKey) return; // no OnyxBase key — soft skip

  const presence = await fetchOnyxAiPresenceCached(apiKey);

  if (!presence) throw onyxAiRuntimeOfflineError();
  if (Date.now() - presence.lastSeenAt >= ONYXAI_PRESENCE_STALE_MS) throw onyxAiRuntimeOfflineError();
  if (presence.modelsOk === false || presence.models.length === 0) {
    throw new Error(
      "The OnyxAI Browser Runtime is on but no local models are being served — start qvac on your device (qvac serve --openai) with at least one model.",
    );
  }
  const wanted = (opts.model ?? "").trim();
  if (wanted && !presence.models.includes(wanted)) {
    const served = presence.models.slice(0, 5).join(", ") + (presence.models.length > 5 ? "…" : "");
    throw new Error(
      `The model "${wanted}" isn't started locally (served: ${served}). Start it in your browser runtime, then retry.`,
    );
  }
}

/**
 * Non-throwing presence check for `onyx doctor` — returns a one-line status,
 * or null when the gate doesn't apply (not OnyxAI, not a local base URL).
 */
export async function checkOnyxAiRuntime(opts: {
  baseUrl: string;
  name?: string | null;
}): Promise<string | null> {
  if (!isLocalBaseUrl(opts.baseUrl)) return null;
  const name = (opts.name ?? "").trim();
  if (!name || !/onyx/i.test(name)) return null;
  const apiKey = resolveOnyxBaseKey();
  if (!apiKey) return "not checked (no onyxbase_key secret or ONYXBASE_KEY env)";

  let presence: OnyxAiPresence | null;
  try {
    presence = await fetchOnyxAiPresenceCached(apiKey);
  } catch (e) {
    return `unreachable via OnyxBase presence (${e instanceof Error ? e.message : String(e)})`;
  }
  if (!presence || Date.now() - presence.lastSeenAt >= ONYXAI_PRESENCE_STALE_MS) {
    return "stale via OnyxBase presence (Browser Runtime isn't running)";
  }
  if (presence.modelsOk === false || presence.models.length === 0) {
    return "reachable via OnyxBase presence, but no local models are served";
  }
  const age = Math.max(0, Math.round((Date.now() - presence.lastSeenAt) / 1000));
  return `reachable via OnyxBase presence (${presence.models.length} model${presence.models.length === 1 ? "" : "s"}, seen ${age}s ago)`;
}

/**
 * Construct the API endpoint URL based on provider config.
 */
export function buildEndpoint(config: ProviderConfig, stream: boolean): string {
  let base = config.baseUrl.replace(/\/+$/, "");

  // If noPrefix, use the base URL exactly as provided
  if (config.noPrefix) {
    // Only append stream query param for Responses API mode if needed
    return base;
  }

  // Chat Completions mode
  if (config.modelType === "chat") {
    // Check if base already has /v1 or /api/v1
    if (base.includes("/v1/chat/completions")) return base;
    if (base.includes("/v1")) {
      return base + "/chat/completions";
    }
    if (base.includes("/api/v1")) {
      return base + "/chat/completions";
    }
    // Default: append /v1/chat/completions
    return base + "/v1/chat/completions";
  }

  // Responses API mode
  if (base.includes("/v1/responses")) return base;
  if (base.includes("/v1")) {
    return base + "/responses";
  }
  return base + "/v1/responses";
}

/**
 * Stream a Chat Completions request via SSE.
 * Yields StreamChunk objects as they arrive.
 */
export async function* streamChatCompletion(
  config: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  // LOCAL OnyxAI → verify the browser runtime before anything else.
  await assertOnyxAiRuntimeReady({
    baseUrl: config.baseUrl,
    model: config.model,
    name: config.name,
  });

  const endpoint = buildEndpoint(config, true);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
  };
  if (config.temperature !== undefined) {
    body.temperature = config.temperature;
  }
  if (tools && tools.length > 0 && config.toolsEnabled) {
    body.tools = tools;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    // Some free providers (Pollinations) don't support system messages,
    // temperature, tools, or streaming. Try progressively stripped requests.
    if (res.status === 402 || res.status === 500) {
      // Retry 1: strip system messages + tools + temperature, keep stream
      const retry1Messages = messages.filter((m) => m.role !== "system");
      const retry1Body = {
        model: config.model,
        messages: retry1Messages,
        stream: true,
      };
      // Use a 15s timeout for the streaming retry
      const retry1Controller = new AbortController();
      const retry1Timeout = setTimeout(() => retry1Controller.abort(), 15000);
      try {
        const retry1Res = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(retry1Body),
          signal: retry1Controller.signal,
        });
        clearTimeout(retry1Timeout);
        if (retry1Res.ok && retry1Res.body) {
          yield* parseSSEStream(retry1Res.body);
          return;
        }
      } catch {
        clearTimeout(retry1Timeout);
      }

      // Retry 2: non-streaming fallback (some providers only support non-stream)
      const retry2Res = await fetch(endpoint, {
        method: "POST",
        headers: { ...headers, Accept: "application/json" },
        body: JSON.stringify({
          model: config.model,
          messages: retry1Messages,
          stream: false,
        }),
        signal,
      });
      if (retry2Res.ok) {
        const data = await retry2Res.json() as any;
        const choice = data.choices?.[0];
        const message = choice?.message ?? {};
        if (message.content) {
          yield { textDelta: message.content };
        }
        if (message.reasoning_content || message.reasoning) {
          yield { reasoningDelta: message.reasoning_content || message.reasoning };
        }
        if (message.tool_calls) {
          for (const tc of message.tool_calls) {
            yield {
              toolCallDelta: {
                index: 0,
                id: tc.id,
                name: tc.function?.name,
                arguments: tc.function?.arguments,
              },
            };
          }
        }
        if (data.usage) {
          yield {
            usage: {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
            },
          };
        }
        yield { done: true };
        return;
      }
    }
    throw new Error(`Provider HTTP ${res.status}: ${errText.slice(0, 500) || res.statusText}`);
  }

  if (!res.body) {
    throw new Error("No response body from provider");
  }

  if (!res.body) throw new Error("No response body from provider");
  yield* parseSSEStream(res.body);
}

/**
 * Parse an SSE stream body and yield StreamChunk objects.
 */
async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on double newline (SSE event boundary)
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        const lines = event.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();

          if (data === "[DONE]") {
            yield { done: true };
            return;
          }

          try {
            const chunk = JSON.parse(data);
            const choice = chunk.choices?.[0];
            const delta = choice?.delta ?? {};

            const result: StreamChunk = {};

            if (delta.content) {
              result.textDelta = delta.content;
            }
            if (delta.reasoning_content || delta.reasoning) {
              result.reasoningDelta = delta.reasoning_content || delta.reasoning;
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                result.toolCallDelta = {
                  index: tc.index ?? 0,
                  id: tc.id,
                  name: tc.function?.name,
                  arguments: tc.function?.arguments,
                };
              }
            }
            if (choice?.finish_reason) {
              result.finishReason = choice.finish_reason;
            }
            if (chunk.usage) {
              result.usage = {
                promptTokens: chunk.usage.prompt_tokens,
                completionTokens: chunk.usage.completion_tokens,
                totalTokens: chunk.usage.total_tokens,
              };
            }

            if (Object.keys(result).length > 0) {
              yield result;
            }
          } catch {
            // Malformed JSON line — skip (tolerant parsing)
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { done: true };
}

/**
 * Non-streaming Chat Completions request (fallback when streaming fails).
 */
export async function chatCompletion(
  config: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  signal?: AbortSignal,
): Promise<{
  content: string;
  reasoning?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}> {
  // LOCAL OnyxAI → verify the browser runtime before anything else.
  await assertOnyxAiRuntimeReady({
    baseUrl: config.baseUrl,
    model: config.model,
    name: config.name,
  });

  const endpoint = buildEndpoint(config, false);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: config.temperature ?? 0.7,
  };
  if (tools && tools.length > 0 && config.toolsEnabled) {
    body.tools = tools;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Provider HTTP ${res.status}: ${errText.slice(0, 500) || res.statusText}`);
  }

  const data = await res.json() as any;
  const choice = data.choices?.[0];
  const message = choice?.message ?? {};

  return {
    content: message.content ?? "",
    reasoning: message.reasoning_content,
    toolCalls: message.tool_calls?.map((tc: { id: string; function: { name: string; arguments: string } }) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    })),
    usage: data.usage
      ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        }
      : undefined,
  };
}

/**
 * Test provider connectivity by listing models.
 */
export async function testProvider(
  baseUrl: string,
  apiKey: string | null,
): Promise<{ ok: boolean; models: string[]; latency: number; error?: string }> {
  const start = Date.now();
  let base = baseUrl.replace(/\/+$/, "");

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // Try /v1/models first, then /models
  const endpoints = [
    base + "/v1/models",
    base + "/models",
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, { headers });
      const latency = Date.now() - start;

      if (!res.ok) {
        continue;
      }

      const data = await res.json() as any;
      const models: string[] = (data.data ?? []).map((m: { id: string }) => m.id);

      return { ok: true, models, latency };
    } catch {
      continue;
    }
  }

  return {
    ok: false,
    models: [],
    latency: Date.now() - start,
    error: "Failed to connect to any known models endpoint",
  };
}
