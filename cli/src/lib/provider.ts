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
 */

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  modelType: "chat" | "responses";
  toolsEnabled: boolean;
  noPrefix?: boolean;
  thinkingEnabled?: boolean;
  temperature?: number;
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
        const data = await retry2Res.json();
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

  const data = await res.json();
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

      const data = await res.json();
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
