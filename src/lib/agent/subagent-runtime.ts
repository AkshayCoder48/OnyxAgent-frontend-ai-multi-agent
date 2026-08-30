"use client";

import { nanoid } from "nanoid";
import { useSubagentStore, type SubagentConfig, type SubagentMessage } from "@/stores/subagent-store";
import { useAuthStore } from "@/stores";
import { aiProviderService, settingsService } from "@/lib/services";
import { listTools } from "@/lib/tools/registry";
import { stripFunctionCallTags } from "@/lib/text-sanitizer";

/**
 * Subagent runtime — executes subagent tasks by calling the LLM API with
 * REAL STREAMING (SSE). Streams text back token-by-token to the subagent
 * chat sidebar.
 *
 * Uses sessions (persisted to localStorage) so chats survive page refresh.
 * Each session is a separate conversation with a subagent.
 *
 * Fixes applied:
 * - Passes reasoning_content back to the API (required by DeepSeek/moonshot)
 * - Adds Accept: text/event-stream + cache: no-store (curl -N equivalent)
 * - Streams tool call args live (shows tool card immediately, not after stream ends)
 * - No 60ms throttle (flush immediately like main chat)
 * - Tool calls execute in parallel
 * - PRD §34/§35: Shares the SAME E2B sandbox as the main agent — subagents
 *   receive the real `e2bApiKey` + `sandboxApiKey` + `envVars` so file
 *   operations performed by a subagent hit the same workspace the main
 *   agent sees. Previously `e2bApiKey: undefined` silently stripped sandbox
 *   access from every subagent tool call.
 */

interface ChatCompletionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
}

async function resolveApiConfig(subagent: SubagentConfig) {
  const userId = useAuthStore.getState().user?.id;
  if (!userId) throw new Error("No authenticated user");

  const providers = await aiProviderService.list(userId);
  if (providers.length === 0) throw new Error("No AI providers configured. Add one in Settings → Config.");

  const { selectedProviderId, selectedModel } = await import("@/stores/chat-store").then(m => {
    const store = m.useChatStore.getState();
    return { selectedProviderId: store.selectedProviderId, selectedModel: store.selectedModel };
  });

  let provider = subagent.providerId
    ? providers.find((p) => p.id === subagent.providerId)
    : selectedProviderId
      ? providers.find((p) => p.id === selectedProviderId)
      : providers.find((p) => p.is_active) || providers[0];
  if (!provider) provider = providers[0];
  if (!provider) throw new Error("No provider available");

  let apiKey = subagent.apiKey;
  if (!apiKey) {
    apiKey = await aiProviderService.getDecryptedApiKey(provider.id);
  }
  if (!apiKey) throw new Error(`No API key for provider "${provider.name}"`);

  const model = subagent.model || selectedModel || provider.models[0] || "gpt-4o-mini";
  const baseUrl = subagent.baseUrl || provider.base_url;
  const noPrefix = (provider as { no_prefix?: boolean }).no_prefix ?? false;

  return { provider, apiKey, model, baseUrl, noPrefix, toolsEnabled: provider.tools_enabled, thinkingEnabled: (provider as { thinking_enabled?: boolean }).thinking_enabled ?? false };
}

/**
 * Execute a subagent turn with REAL STREAMING.
 * Streams text chunks to the store as they arrive from the API.
 */
export async function executeSubagentTurn(
  subagentId: string,
  userMessage: string,
  _fileIds?: string[],
  sessionId?: string,
): Promise<string> {
  const store = useSubagentStore.getState();
  const subagent = store.getSubagent(subagentId);
  if (!subagent) throw new Error(`Subagent ${subagentId} not found`);

  // Get or create a session.
  let session = sessionId ? store.sessions.find((s) => s.id === sessionId) : store.getActiveSession();
  if (!session || session.subagentId !== subagentId) {
    session = store.createSession(subagentId, userMessage.slice(0, 40));
  }
  const sid = session.id;

  // Add the user message.
  const userMsg: SubagentMessage = {
    id: nanoid(),
    role: "user",
    content: userMessage,
    timestamp: new Date().toISOString(),
  };
  store.addMessage(sid, userMsg);

  // Add a placeholder assistant message to stream into.
  const assistantMsgId = nanoid();
  store.addMessage(sid, {
    id: assistantMsgId,
    role: "assistant",
    content: "",
    timestamp: new Date().toISOString(),
    isStreaming: true,
  });

  let accumulatedReasoning = "";

  // PRD §34/§35: Load the user's decrypted E2B sandbox key + env vars so
  // subagent tool calls hit the SAME workspace as the main agent. Previously
  // these were hardcoded to `undefined`, silently breaking every file tool
  // a subagent tried to call.
  let subagentSandboxKey: string | undefined;
  let subagentEnvVars: Record<string, string> = {};
  try {
    const userId = useAuthStore.getState().user?.id;
    if (userId) {
      const decryptedKey = await settingsService.getDecryptedSandboxKey(userId);
      subagentSandboxKey = decryptedKey ?? undefined;
      const decryptedEnv = await settingsService.getDecryptedEnvVars(userId);
      subagentEnvVars = decryptedEnv ?? {};
    }
  } catch (err) {
    console.warn("[subagent] failed to load sandbox key / env vars:", err);
  }

  try {
    const config = await resolveApiConfig(subagent);
    const allTools = listTools();
    const toolsSchema = allTools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    // Build message history from the session.
    const updatedSession = useSubagentStore.getState().sessions.find((s) => s.id === sid);
    const sessionMessages = (updatedSession?.messages ?? [])
      .filter((m) => m.role !== "system" && !m.isStreaming);
    const trimmedSessionMessages = sessionMessages.length > 20
      ? sessionMessages.slice(-20)
      : sessionMessages;
    const apiMessages: ChatCompletionMessage[] = [
      {
        role: "system",
        content: subagent.systemPrompt || `You are ${subagent.name}, a subagent. ${subagent.description}`,
      },
      ...trimmedSessionMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
        // Pass reasoning_content back — required by DeepSeek/moonshot/g4f
        reasoning_content: (m as { reasoning?: string }).reasoning || undefined,
      })),
    ];

    // Build the target URL — same logic as the main runtime.
    const base = config.baseUrl.replace(/\/$/, "");
    const targetUrl = config.noPrefix ? base : `${base}/chat/completions`;
    let fullResponse = "";
    let maxIterations = 10;

    while (maxIterations-- > 0) {
      const body: Record<string, unknown> = {
        model: config.model,
        messages: apiMessages,
        temperature: 0.7,
        stream: true, // ALWAYS stream
        stream_options: { include_usage: true },
      };
      if (config.toolsEnabled && toolsSchema.length > 0) {
        body.tools = toolsSchema;
        body.tool_choice = "auto";
      }
      if (config.thinkingEnabled) {
        body.chat_template_kwargs = { enable_thinking: true };
      }

      // Use ?url= query param + Accept: text/event-stream + cache: no-store
      // (curl -N equivalent — no buffering anywhere in the pipeline)
      const res = await fetch(`/api/chat-proxy?url=${encodeURIComponent(targetUrl)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-target-url": targetUrl,
          Authorization: `Bearer ${config.apiKey}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        cache: "no-store",
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`API ${res.status}: ${errText.slice(0, 500)}`);
      }

      // Check if the response is actually SSE (stream:true).
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream") && !contentType.includes("application/x-ndjson")) {
        // Non-streaming response (some providers don't support stream:true).
        const data = await res.json();
        const choice = data.choices?.[0];
        if (!choice) throw new Error("No response from API");
        const msg = choice.message;

        // Handle tool calls.
        if (msg.tool_calls && msg.tool_calls.length > 0 && config.toolsEnabled) {
          // Pass reasoning_content back
          if (msg.reasoning_content) accumulatedReasoning += msg.reasoning_content;
          apiMessages.push({
            role: "assistant",
            content: msg.content || "",
            reasoning_content: accumulatedReasoning || undefined,
            tool_calls: msg.tool_calls.map((tc: { id: string; function: { name: string; arguments: string } }) => ({
              id: tc.id,
              type: "function" as const,
              function: tc.function,
            })),
          });

          // Execute tool calls in parallel
          await executeToolCallsParallel(
            msg.tool_calls, allTools, subagentId, sid, assistantMsgId, apiMessages,
            msg.content || "",
            subagentSandboxKey,
            subagentEnvVars,
          );
          fullResponse = stripFunctionCallTags(msg.content || "");
          continue;
        }

        fullResponse = stripFunctionCallTags(msg.content || "");
        useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
          content: fullResponse,
          isStreaming: false,
        });
        break;
      }

      // Parse SSE stream — NO THROTTLE, flush immediately (like main chat)
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulatedText = "";
      accumulatedReasoning = "";
      const toolCallsBuffer: Array<{ id: string; function: { name: string; arguments: string } }> = [];

      // Track which tool calls we've already shown as "running" to avoid duplicates
      const shownToolCalls = new Set<string>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines (split on \n\n for full events)
        let eventIdx: number;
        while ((eventIdx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, eventIdx);
          buffer = buffer.slice(eventIdx + 2);

          for (const line of rawEvent.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.slice(5).trim();
            if (!dataStr || dataStr === "[DONE]") continue;

            try {
              const chunk = JSON.parse(dataStr);
              const delta = chunk.choices?.[0]?.delta;
              if (!delta) continue;

              // Text delta — flush immediately (no throttle)
              if (delta.content) {
                accumulatedText += delta.content;
                // Immediate update — no 60ms throttle
                useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
                  content: stripFunctionCallTags(accumulatedText),
                  isStreaming: true,
                });
              }

              // Reasoning delta — accumulate for passing back to API
              if (delta.reasoning_content || delta.reasoning) {
                accumulatedReasoning += (delta.reasoning_content || delta.reasoning || "");
              }

              // Tool call delta — buffer + show immediately
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallsBuffer[idx]) {
                    toolCallsBuffer[idx] = {
                      id: tc.id || nanoid(),
                      function: { name: tc.function?.name || "", arguments: tc.function?.arguments || "" },
                    };
                  } else {
                    if (tc.function?.name) toolCallsBuffer[idx]!.function.name += tc.function.name;
                    if (tc.function?.arguments) toolCallsBuffer[idx]!.function.arguments += tc.function.arguments;
                    if (tc.id) toolCallsBuffer[idx]!.id = tc.id;
                  }

                  // Show tool call card IMMEDIATELY when name is known (streaming)
                  const tcBuf = toolCallsBuffer[idx]!;
                  if (tcBuf.function.name && !shownToolCalls.has(tcBuf.id)) {
                    shownToolCalls.add(tcBuf.id);
                    const currentMsg = useSubagentStore.getState().sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantMsgId);
                    useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
                      content: stripFunctionCallTags(accumulatedText),
                      toolCalls: [
                        ...(currentMsg?.toolCalls ?? []),
                        {
                          id: tcBuf.id,
                          name: tcBuf.function.name,
                          args: { _streaming: tcBuf.function.arguments } as Record<string, unknown>,
                          status: "pending" as const,
                        },
                      ],
                    });
                  } else if (tcBuf.function.arguments && shownToolCalls.has(tcBuf.id)) {
                    // Update streaming args on existing card
                    const msg = useSubagentStore.getState().sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantMsgId);
                    if (msg?.toolCalls) {
                      useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
                        toolCalls: msg.toolCalls.map((tc2) =>
                          tc2.id === tcBuf.id
                            ? { ...tc2, args: { _streaming: tcBuf.function.arguments } as Record<string, unknown> }
                            : tc2,
                        ),
                      });
                    }
                  }
                }
              }
            } catch {
              // partial JSON — skip
            }
          }
        }
      }

      // Process any buffered tool calls.
      if (toolCallsBuffer.length > 0 && config.toolsEnabled) {
        // Parse args and update tool call cards to "running"
        const parsedToolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
        for (const tc of toolCallsBuffer) {
          let toolArgs: Record<string, unknown> = {};
          try {
            toolArgs = JSON.parse(tc.function.arguments || "{}");
          } catch {
            toolArgs = { _raw: tc.function.arguments };
          }
          parsedToolCalls.push({ id: tc.id, name: tc.function.name, args: toolArgs });

          // Update card to "running" with parsed args
          const msg = useSubagentStore.getState().sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantMsgId);
          if (msg?.toolCalls) {
            useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
              toolCalls: msg.toolCalls.map((tc2) =>
                tc2.id === tc.id ? { ...tc2, args: toolArgs, status: "running" as const } : tc2,
              ),
            });
          }
        }

        // Add assistant message with tool calls + reasoning_content to API history
        apiMessages.push({
          role: "assistant",
          content: accumulatedText || "",
          reasoning_content: accumulatedReasoning || undefined,
          tool_calls: toolCallsBuffer.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: tc.function,
          })),
        });

        // Execute all tool calls in PARALLEL (same as main runtime)
        await Promise.all(parsedToolCalls.map(async (ptc) => {
          const tool = allTools.find((t) => t.name === ptc.name);
          let toolResult: unknown;
          let toolStatus: "completed" | "error" = "completed";
          try {
            if (tool) {
              const ctx = {
                userId: useAuthStore.getState().user?.id ?? "",
                conversationId: subagentId,
                emit: () => {},
                signal: undefined,
                // PRD §34/§35: subagents share the main agent's E2B sandbox.
                e2bApiKey: subagentSandboxKey,
                sandboxApiKey: subagentSandboxKey,
                sandboxMode: "shared" as const,
                envVars: subagentEnvVars,
                onToolOutput: () => {},
              };
              toolResult = await tool.handler(ptc.args, ctx);
            } else {
              toolResult = { error: `Unknown tool: ${ptc.name}` };
              toolStatus = "error";
            }
          } catch (e) {
            toolResult = { error: e instanceof Error ? e.message : String(e) };
            toolStatus = "error";
          }

          // Update tool call card with result
          const updatedMsg = useSubagentStore.getState().sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantMsgId);
          if (updatedMsg?.toolCalls) {
            useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
              toolCalls: updatedMsg.toolCalls.map((tc2) =>
                tc2.id === ptc.id ? { ...tc2, result: toolResult, status: toolStatus } : tc2,
              ),
            });
          }

          apiMessages.push({
            role: "tool" as const,
            content: JSON.stringify(toolResult),
            tool_call_id: ptc.id,
          });
        }));

        fullResponse = stripFunctionCallTags(accumulatedText);
        continue;
      }

      // No tool calls — this is the final response.
      fullResponse = stripFunctionCallTags(accumulatedText);
      useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
        content: fullResponse,
        isStreaming: false,
      });
      break;
    }

    return fullResponse;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
      content: `Error: ${errMsg}`,
      isStreaming: false,
    });
    return errMsg;
  }
}

/** Execute tool calls in parallel for non-streaming mode. */
async function executeToolCallsParallel(
  toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>,
  allTools: ReturnType<typeof listTools>,
  _subagentId: string,
  sid: string,
  assistantMsgId: string,
  apiMessages: ChatCompletionMessage[],
  _accumulatedText: string,
  sandboxKey: string | undefined,
  envVars: Record<string, string>,
) {
  await Promise.all(toolCalls.map(async (tc) => {
    let toolArgs: Record<string, unknown> = {};
    try {
      toolArgs = JSON.parse(tc.function.arguments || "{}");
    } catch {
      toolArgs = { _raw: tc.function.arguments };
    }

    const tool = allTools.find((t) => t.name === tc.function.name);

    // Add running tool call card
    const currentMsg = useSubagentStore.getState().sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantMsgId);
    useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
      toolCalls: [
        ...(currentMsg?.toolCalls ?? []),
        { id: tc.id, name: tc.function.name, args: toolArgs, status: "running" as const },
      ],
    });

    let toolResult: unknown;
    let toolStatus: "completed" | "error" = "completed";
    try {
      if (tool) {
        const ctx = {
          userId: useAuthStore.getState().user?.id ?? "",
          conversationId: _subagentId,
          emit: () => {},
          signal: undefined,
          // PRD §34/§35: subagents share the main agent's E2B sandbox.
          e2bApiKey: sandboxKey,
          sandboxApiKey: sandboxKey,
          sandboxMode: "shared" as const,
          envVars,
          onToolOutput: () => {},
        };
        toolResult = await tool.handler(toolArgs, ctx);
      } else {
        toolResult = { error: `Unknown tool: ${tc.function.name}` };
        toolStatus = "error";
      }
    } catch (e) {
      toolResult = { error: e instanceof Error ? e.message : String(e) };
      toolStatus = "error";
    }

    // Update tool call card with result
    const updatedMsg = useSubagentStore.getState().sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantMsgId);
    if (updatedMsg?.toolCalls) {
      useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
        toolCalls: updatedMsg.toolCalls.map((tc2) =>
          tc2.id === tc.id ? { ...tc2, result: toolResult, status: toolStatus } : tc2,
        ),
      });
    }

    apiMessages.push({
      role: "tool" as const,
      content: JSON.stringify(toolResult),
      tool_call_id: tc.id,
    });
  }));
}
