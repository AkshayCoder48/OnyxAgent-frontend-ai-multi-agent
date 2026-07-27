"use client";

import { nanoid } from "nanoid";
import { useSubagentStore, type SubagentConfig, type SubagentMessage } from "@/stores/subagent-store";
import { useAuthStore } from "@/stores";
import { aiProviderService } from "@/lib/services";
import { listTools } from "@/lib/tools/registry";
import { stripFunctionCallTags } from "@/lib/text-sanitizer";

/**
 * Subagent runtime — executes subagent tasks by calling the LLM API with
 * REAL STREAMING (SSE). Streams text back token-by-token to the subagent
 * chat sidebar.
 *
 * Uses sessions (persisted to localStorage) so chats survive page refresh.
 * Each session is a separate conversation with a subagent.
 */

interface ChatCompletionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

async function resolveApiConfig(subagent: SubagentConfig) {
  const userId = useAuthStore.getState().user?.id;
  if (!userId) throw new Error("No authenticated user");

  const providers = await aiProviderService.list(userId);
  if (providers.length === 0) throw new Error("No AI providers configured. Add one in Settings → Config.");

  // Read the main chat's selected provider + model from the chat store.
  // This is set by the ChatControls component when the user picks a model.
  const { selectedProviderId, selectedModel } = await import("@/stores/chat-store").then(m => {
    const store = m.useChatStore.getState();
    return { selectedProviderId: store.selectedProviderId, selectedModel: store.selectedModel };
  });

  // Provider resolution: subagent override → main chat's selected provider →
  // first active provider → first provider.
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

  // Model resolution: subagent override → main chat's selected model →
  // provider's first model.
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
  fileIds?: string[],
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
    fileIds,
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

  try {
    const config = await resolveApiConfig(subagent);
    const allTools = listTools();
    const toolsSchema = allTools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    // Build message history from the session.
    const updatedSession = useSubagentStore.getState().sessions.find((s) => s.id === sid);
    const apiMessages: ChatCompletionMessage[] = [
      {
        role: "system",
        content: subagent.systemPrompt || `You are ${subagent.name}, a subagent. ${subagent.description}`,
      },
      ...((updatedSession?.messages ?? [])
        .filter((m) => m.role !== "system" && !m.isStreaming)
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }))),
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
      };
      if (config.toolsEnabled && toolsSchema.length > 0) {
        body.tools = toolsSchema;
        body.tool_choice = "auto";
      }
      // Provider-specific thinking toggle (e.g. Poolside's chat_template_kwargs).
      if (config.thinkingEnabled) {
        body.chat_template_kwargs = { enable_thinking: true };
      }

      // Use the SAME /api/chat-proxy as the main chat to avoid CORS errors.
      // Pass _targetUrl in the body as a fallback (some Vercel deployments
      // strip custom headers).
      body._targetUrl = targetUrl;

      const res = await fetch("/api/chat-proxy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-target-url": targetUrl,
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`API ${res.status}: ${errText.slice(0, 200)}`);
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
          await handleToolCalls(
            msg, apiMessages, allTools, subagentId, sid, assistantMsgId, config,
          );
          continue;
        }

        fullResponse = stripFunctionCallTags(msg.content || "");
        useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
          content: fullResponse,
          isStreaming: false,
        });
        break;
      }

      // Parse SSE stream.
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulatedText = "";
      let toolCallsBuffer: Array<{ id: string; function: { name: string; arguments: string } }> = [];

      // THROTTLE: only update the store every 60ms to prevent lag from
      // too many re-renders when the API sends many small chunks rapidly.
      let lastUpdateTime = 0;
      const UPDATE_INTERVAL_MS = 60;
      let pendingUpdate = false;
      const flushUpdate = () => {
        if (pendingUpdate) {
          useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
            content: stripFunctionCallTags(accumulatedText),
            isStreaming: true,
          });
          pendingUpdate = false;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines.
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // keep the last partial line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const dataStr = trimmed.slice(6);
          if (dataStr === "[DONE]") continue;

          try {
            const chunk = JSON.parse(dataStr);
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            // Text delta — accumulate + throttled stream to UI.
            if (delta.content) {
              accumulatedText += delta.content;
              const now = Date.now();
              if (now - lastUpdateTime >= UPDATE_INTERVAL_MS) {
                lastUpdateTime = now;
                useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
                  content: stripFunctionCallTags(accumulatedText),
                  isStreaming: true,
                });
                pendingUpdate = false;
              } else {
                pendingUpdate = true;
              }
            }

            // Tool call delta — buffer the arguments (they arrive in chunks).
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
              }
            }
          } catch {
            // partial JSON — skip, will complete on next chunk
          }
        }
      }
      // Flush any pending update after the stream ends.
      flushUpdate();

      // Process any buffered tool calls.
      if (toolCallsBuffer.length > 0 && config.toolsEnabled) {
        // Add the assistant message with tool calls to the API history.
        apiMessages.push({
          role: "assistant",
          content: accumulatedText || "",
          tool_calls: toolCallsBuffer.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: tc.function,
          })),
        });

        // Execute each tool call.
        for (const tc of toolCallsBuffer) {
          const toolArgs = JSON.parse(tc.function.arguments || "{}");
          const tool = allTools.find((t) => t.name === tc.function.name);

          // Add a running tool call card to the message.
          const currentMsg = useSubagentStore.getState().sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantMsgId);
          useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
            content: stripFunctionCallTags(accumulatedText),
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
                conversationId: subagentId,
                emit: () => {},
                signal: undefined,
                e2bApiKey: undefined,
                sandboxApiKey: undefined,
                sandboxMode: "shared" as const,
                envVars: {},
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

          // Update the tool call card status.
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
            content: JSON.stringify(toolResult).slice(0, 10000),
            tool_call_id: tc.id,
          });
        }
        // Reset for the next iteration — the API will process the tool results.
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

/** Helper to handle tool calls in non-streaming mode. */
async function handleToolCalls(
  msg: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> },
  apiMessages: ChatCompletionMessage[],
  allTools: ReturnType<typeof listTools>,
  subagentId: string,
  sid: string,
  assistantMsgId: string,
  _config: unknown,
) {
  apiMessages.push({
    role: "assistant",
    content: msg.content || "",
    tool_calls: (msg.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: tc.function,
    })),
  });

  for (const tc of msg.tool_calls ?? []) {
    const toolArgs = JSON.parse(tc.function.arguments || "{}");
    const tool = allTools.find((t) => t.name === tc.function.name);

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
          conversationId: subagentId,
          emit: () => {},
          signal: undefined,
          e2bApiKey: undefined,
          sandboxApiKey: undefined,
          sandboxMode: "shared" as const,
          envVars: {},
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
      content: JSON.stringify(toolResult).slice(0, 10000),
      tool_call_id: tc.id,
    });
  }
}
