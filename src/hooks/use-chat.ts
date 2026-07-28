"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import {
  runAgentTurn,
  respondToApproval,
  respondToAskUser,
  type AgentTurnOptions,
} from "@/lib/agent/runtime";
import { aiProviderService, settingsService } from "@/lib/services";
import { useChatStore, useAuthStore } from "@/stores";
import type {
  AskUserAnswer,
  AskUserQuestion,
  ChatMessageFile,
  Decision,
  PendingApproval,
  ResearchTodo,
  ToolCall,
  WSEvent,
} from "@/types";
import { setUrlParam } from "@/lib/utils";
import { useConversationStore, useResearchStore } from "@/stores";

/** A message the user typed while the agent was busy. Held outside the chat
 *  history until the drainer ships it. */
export interface QueuedMessage {
  id: string;
  content: string;
  fileIds?: string[];
  files?: ChatMessageFile[];
}

interface UseChatOptions {
  conversationId?: string | null;
  onConversationCreated?: (conversationId: string) => void;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant. Use the available tools when they would help answer the user's request. Be concise.";

// AI Framework presets — each changes the system prompt to match the
// framework's conventions and behavior patterns.
const FRAMEWORK_PROMPTS: Record<string, string> = {
  default: DEFAULT_SYSTEM_PROMPT,
  pydantic_ai: `You are an AI agent built with PydanticAI. You have access to tools that you can call to help the user.
Follow PydanticAI conventions:
- Call tools when they would help answer the user's request
- Structure your responses clearly with markdown
- When using tools, explain what you're doing briefly
- Handle errors gracefully and suggest alternatives
- Be precise and type-safe in your reasoning`,
  langchain: `You are an AI agent powered by LangChain. You have access to tools through LangChain's agent framework.
Follow LangChain conventions:
- Use the ReAct (Reasoning + Acting) pattern: think about what to do, call a tool, observe the result, repeat
- Chain tool calls together when needed
- Use memory of previous interactions to provide context-aware responses
- Structure outputs with clear sections (Thought, Action, Observation, Final Answer)
- Be transparent about your reasoning process`,
  crewai: `You are a CrewAI agent working as part of a crew. You have specific tools and a role to fulfill.
Follow CrewAI conventions:
- Focus on your role: research, analyze, create, or execute
- Use tools to gather information and perform actions
- Report findings clearly and concisely
- Collaborate effectively by sharing relevant context
- Deliver structured, actionable outputs`,
  openai_assistants: `You are an OpenAI Assistant with access to tools. Follow OpenAI Assistants API conventions:
- Use function calling to interact with available tools
- Provide clear, helpful responses
- When tools return results, analyze them and continue the conversation
- Be concise but thorough
- Use markdown formatting for readability`,
};

/**
 * Backendless chat hook.
 *
 * The original `useChat` opened a WebSocket to the FastAPI backend's
 * `/api/v1/ws/agent` endpoint and translated inbound `WSEvent` frames into
 * `useChatStore` mutations. Backendless mode replaces the WS transport with
 * `runAgentTurn` from `@/lib/agent/runtime`: the runtime is a client-side
 * SSE stream that emits the same `WSEvent`-shaped events via an `emit`
 * callback. The store mutation logic is unchanged.
 *
 * What's gone:
 *   - No WebSocket, no `useWebSocket` import, no reconnect/backoff logic.
 *   - No JWT access token / refresh round-trip on socket drop.
 *   - No `connect()` / `disconnect()` lifecycle (the runtime is per-turn).
 *   - No offline message queueing beyond "agent is busy" (a single in-flight
 *     turn at a time — messages typed during a turn queue and drain after).
 *
 * What's kept:
 *   - The exact `WSEvent` event handler that maps each event type to store
 *     mutations (text_delta → appendTextDelta, tool_call → addToolCallPart,
 *     etc.).
 *   - HITL approval flow (`tool_approval_required` → `respondToApproval`).
 *   - Ask-user flow (`ask_user` → `respondToAskUser`).
 *   - Todo integration (`todo_event` → `useResearchStore.applyTodoEvent`).
 *   - The `sendTodoAction` controls (dismiss / reset / snapshot) — local
 *     only; the runtime has no equivalent channel.
 *   - The exported hook interface so `chat-container.tsx` and friends don't
 *     break.
 */
export function useChat(options: UseChatOptions = {}) {
  const { conversationId, onConversationCreated } = options;
  const { setCurrentConversationId, currentConversationId: currentConversationIdFromStore } =
    useConversationStore();
  const {
    messages,
    addMessage,
    updateMessage,
    replaceMessageId,
    appendTextDelta,
    appendThinkingDelta,
    appendReasoningDelta,
    addToolCallPart,
    updateToolCallPart,
    appendToolStreamingOutput,
    clearMessages,
  } = useChatStore();
  const { setCurrentTurnId: setCurrentTodoTurnId, reset: resetTodoTurn } = useResearchStore();

  const [isProcessing, setIsProcessing] = useState(false);
  // Held in a ref instead of state because the event handler reads it
  // synchronously: events arriving in the same tick (e.g. model_request_start
  // + text_delta in one flush) need to see the just-created message id
  // without waiting for React's batched re-render. The handler never causes a
  // re-render based on this id, so state isn't needed.
  const currentMessageIdRef = useRef<string | null>(null);
  const setCurrentMessageId = useCallback((id: string | null) => {
    currentMessageIdRef.current = id;
  }, []);
  const currentGroupIdRef = useRef<string | null>(null);

  // Character-by-character drip system — buffer AI text deltas, then reveal
  // them one character at a time for a smooth typewriter effect.
  const textDeltaBuffer = useRef<string>("");
  const dripTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Batched thinking/reasoning deltas — prevents lag on fast models
  const thinkingBuffer = useRef<string>("");
  const thinkingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reasoningBuffer = useRef<string>("");
  const reasoningTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Batched tool call arg deltas — prevents lag and duplicate pending tool calls
  const toolArgBuffer = useRef<Map<number, { id: string; name: string; args: string }>>(new Map());
  const toolArgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Start the drip interval — reveals one character every 10ms for a fast
  // typewriter effect. Fixed 10ms per the user's request.
  const ensureDrip = useCallback(() => {
    if (dripTimer.current) return;
    dripTimer.current = setInterval(() => {
      if (!textDeltaBuffer.current || !currentMessageIdRef.current) return;
      // Reveal exactly 1 character per 10ms tick (≈100 chars/sec).
      const chunk = textDeltaBuffer.current.slice(0, 1);
      textDeltaBuffer.current = textDeltaBuffer.current.slice(1);
      if (chunk) {
        appendTextDelta(currentMessageIdRef.current, chunk);
      }
    }, 10); // Fixed 10ms per character
  }, [appendTextDelta]);

  // Flush remaining buffers immediately (called on final_result, error, complete)
  const flushTextDelta = useCallback(() => {
    // Drip timer is no longer used — text deltas are appended directly.
    if (dripTimer.current) { clearInterval(dripTimer.current); dripTimer.current = null; }
    textDeltaBuffer.current = "";
    if (thinkingTimer.current) { clearTimeout(thinkingTimer.current); thinkingTimer.current = null; }
    if (thinkingBuffer.current && currentMessageIdRef.current) {
      appendThinkingDelta(currentMessageIdRef.current, thinkingBuffer.current);
      thinkingBuffer.current = "";
    }
    if (reasoningTimer.current) { clearTimeout(reasoningTimer.current); reasoningTimer.current = null; }
    if (reasoningBuffer.current && currentMessageIdRef.current) {
      appendReasoningDelta(currentMessageIdRef.current, reasoningBuffer.current);
      reasoningBuffer.current = "";
    }
    if (toolArgTimer.current) { clearTimeout(toolArgTimer.current); toolArgTimer.current = null; }
    toolArgBuffer.current.clear();
  }, [appendTextDelta, appendThinkingDelta, appendReasoningDelta]);
  // Outbound queue: messages typed while a turn is in flight. Held here (not
  // in the chat history) so the UI can surface them as cancellable "pending"
  // entries above the input. The ref is the source of truth for the drainer
  // effect; the parallel state triggers re-renders for the UI.
  const messageQueueRef = useRef<QueuedMessage[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const modelRef = useRef<string | null>(null);
  const providerIdRef = useRef<string | null>(null);
  const temperatureRef = useRef<number | null>(null);
  const thinkingEffortRef = useRef<"low" | "medium" | "high" | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [pendingQuestions, setPendingQuestions] = useState<AskUserQuestion[] | null>(null);

  // The active agent turn's abort controller. Held in a ref so the various
  // `stopGeneration` / unmount handlers can abort the in-flight SSE stream.
  const abortRef = useRef<AbortController | null>(null);

  // Track the active conversation id in the research store so todo events
  // route to the right turn bucket. Reset the bucket when going to a new chat.
  useEffect(() => {
    const turnId = currentConversationIdFromStore ?? conversationId ?? null;
    setCurrentTodoTurnId(turnId);
    if (turnId === null) resetTodoTurn();
  }, [currentConversationIdFromStore, conversationId, setCurrentTodoTurnId, resetTodoTurn]);

  // Single event handler for every WSEvent the runtime emits. Maps each event
  // type to the appropriate chat-store mutation. This is the same handler the
  // WebSocket version had — only the transport changed.
  const handleAgentEvent = useCallback(
    (wsEvent: WSEvent) => {
      const createNewMessage = (content: string): string => {
        if (currentMessageIdRef.current) {
          updateMessage(currentMessageIdRef.current, (msg) => ({
            ...msg,
            isStreaming: false,
          }));
        }

        const newMsgId = nanoid();
        // Use current conversationId from store to avoid closure issues.
        const effectiveConversationId =
          currentConversationIdFromStore || conversationId || undefined;
        addMessage({
          id: newMsgId,
          role: "assistant",
          content,
          timestamp: new Date(),
          isStreaming: true,
          toolCalls: [],
          parts: content === "" ? [] : undefined,
          groupId: currentGroupIdRef.current || undefined,
          conversationId: effectiveConversationId,
          isTemporaryId: true,
        });
        setCurrentMessageId(newMsgId);
        return newMsgId;
      };

      switch (wsEvent.type) {
        case "conversation_created": {
          // Handle new conversation created by the runtime.
          const { conversation_id } = wsEvent.data as { conversation_id: string };
          setCurrentConversationId(conversation_id);
          // Reflect the new ID in the URL so the page is refreshable + shareable.
          setUrlParam("id", conversation_id);
          // CRITICAL: associate the persisted (sessionStorage) messages with
          // the new conversation ID. Without this, a page refresh would call
          // reconcilePersisted(newId) → getPersistedConversationId() returns
          // null → null !== newId → wipe all messages!
          if (typeof window !== "undefined") {
            window.sessionStorage.setItem("chat-store:conversationId", conversation_id);
          }
          // Update all messages that don't have a conversationId yet
          const { updateMessagesWhere } = useChatStore.getState();
          updateMessagesWhere(
            (msg) => !msg.conversationId,
            (msg) => ({ ...msg, conversationId: conversation_id }),
          );
          onConversationCreated?.(conversation_id);
          break;
        }

        case "message_saved": {
          // Assistant message was saved to IndexedDB; swap the temporary
          // nanoid for the real database ID. We use replaceMessageId (not
          // updateMessage) because updateMessage matches by ID — you can't
          // change the ID inside it.
          const { message_id } = wsEvent.data as { message_id: string };
          const oldId = currentMessageIdRef.current;
          if (oldId && oldId !== message_id) {
            replaceMessageId(oldId, message_id);
            currentMessageIdRef.current = message_id;
          } else if (!oldId) {
            // Fallback: find the last assistant message with a temp id.
            const messages = useChatStore.getState().messages;
            const lastTemp = [...messages]
              .reverse()
              .find((msg) => msg.role === "assistant" && !!msg.isTemporaryId);
            if (lastTemp && lastTemp.id !== message_id) {
              replaceMessageId(lastTemp.id, message_id);
            }
          }
          break;
        }

        case "model_request_start": {
          // Each agent round (text → tool → text → tool → text) creates a
          // NEW assistant message bubble. This is the expected behavior —
          // each round of the agent's response is a distinct message, so
          // the user can see the agent's thought process: first message
          // has the initial text + tool call, second message has the
          // follow-up text after the tool result, etc.
          createNewMessage("");
          break;
        }

        case "text_delta": {
          // Append the delta directly to the current message. No drip timer
          // — text appears at the same speed the AI outputs it (real-time).
          // The CSS fade-in animation on each character is handled by the
          // `stream-char` class in the TextBubble component.
          if (currentMessageIdRef.current) {
            const content = (wsEvent.data as { index: number; content: string }).content;
            if (content) {
              appendTextDelta(currentMessageIdRef.current, content);
            }
          }
          break;
        }

        case "thinking_delta": {
          // Reasoning trace — batch like text deltas to prevent lag
          if (!currentMessageIdRef.current) {
            createNewMessage("");
          }
          if (currentMessageIdRef.current) {
            const content = (wsEvent.data as { index: number; content: string }).content;
            thinkingBuffer.current += content;
            if (!thinkingTimer.current) {
              thinkingTimer.current = setTimeout(() => {
                if (thinkingBuffer.current && currentMessageIdRef.current) {
                  appendThinkingDelta(currentMessageIdRef.current, thinkingBuffer.current);
                  thinkingBuffer.current = "";
                }
                thinkingTimer.current = null;
              }, 100); // 100ms batch for thinking
            }
          }
          break;
        }

        case "reasoning_delta": {
          // DeepSeek/Moonshot/g4f-style reasoning — batch to prevent lag
          if (!currentMessageIdRef.current) {
            createNewMessage("");
          }
          if (currentMessageIdRef.current) {
            const content = (wsEvent.data as { index: number; content: string }).content;
            reasoningBuffer.current += content;
            if (!reasoningTimer.current) {
              reasoningTimer.current = setTimeout(() => {
                if (reasoningBuffer.current && currentMessageIdRef.current) {
                  appendReasoningDelta(currentMessageIdRef.current, reasoningBuffer.current);
                  reasoningBuffer.current = "";
                }
                reasoningTimer.current = null;
              }, 100);
            }
          }
          break;
        }

        case "llm_started":
        case "llm_completed": {
          // LLM lifecycle events — optionally show status. No-op for now.
          break;
        }

        case "tool_call_delta": {
          // Tool call args streaming — buffer and flush every 50ms to prevent
          // lag and duplicate pending tool calls.
          if (currentMessageIdRef.current) {
            const data = wsEvent.data as {
              tool_calls?: Array<{
                index: number;
                id?: string;
                name?: string;
                arguments?: string;
              }>;
            };
            const toolCalls = data.tool_calls ?? [];
            for (const tc of toolCalls) {
              const existing = toolArgBuffer.current.get(tc.index);
              if (tc.name) {
                // New tool call — REPLACE the buffer entry (don't append to
                // old args from a previous round that used the same index).
                // The tool_call event (which fires when the tool is finalized)
                // clears the buffer entry, but as a safety measure we also
                // reset here when a new tool name arrives.
                toolArgBuffer.current.set(tc.index, {
                  id: tc.id || `pending-${tc.index}`,
                  name: tc.name,
                  args: tc.arguments || "",
                });
              } else if (tc.id && tc.id !== existing?.id) {
                // Different tool_call_id at the same index — new tool call
                // without a name. Reset the buffer entry.
                toolArgBuffer.current.set(tc.index, {
                  id: tc.id,
                  name: existing?.name || `pending-${tc.index}`,
                  args: tc.arguments || "",
                });
              } else if (tc.arguments && existing) {
                // Append args to existing buffer entry (same tool call)
                existing.args += tc.arguments;
              }
            }
            // Flush every 30ms — creates/updates the pending tool call
            // so the user sees streaming args in realtime.
            if (!toolArgTimer.current) {
              toolArgTimer.current = setTimeout(() => {
                toolArgTimer.current = null;
                if (!currentMessageIdRef.current) return;
                const msgs = useChatStore.getState().messages;
                const msg = msgs.find((m) => m.id === currentMessageIdRef.current);
                if (!msg?.toolCalls) return;

                for (const [index, buffered] of toolArgBuffer.current) {
                  const existing = msg.toolCalls.find(
                    (t) => t.id === buffered.id || t.id === `pending-${index}`,
                  );
                  if (existing) {
                    // Update existing pending tool call's streaming args
                    updateToolCallPart(currentMessageIdRef.current, existing.id, {
                      args: { _streaming: buffered.args },
                    });
                  } else {
                    // Create new pending tool call
                    addToolCallPart(currentMessageIdRef.current, {
                      id: buffered.id,
                      name: buffered.name,
                      args: { _streaming: buffered.args },
                      status: "pending",
                    });
                  }
                }
              }, 50);
            }
          }
          break;
        }

        case "tool_call": {
          // Tool call is ready to execute — replace the pending/streaming
          // tool call with the final one (with parsed args + running status).
          // ALSO clear the toolArgBuffer so the next round's tool calls
          // (which may reuse the same index) don't inherit stale args.
          if (currentMessageIdRef.current) {
            const { tool_name, args, tool_call_id } = wsEvent.data as {
              tool_name: string;
              args: Record<string, unknown>;
              tool_call_id: string;
            };
            const toolCall: ToolCall = {
              id: tool_call_id,
              name: tool_name,
              args,
              status: "running",
            };

            // Clear the toolArgBuffer entry for this tool call. Find by
            // matching name or id, since the index may not be available.
            for (const [idx, buffered] of toolArgBuffer.current) {
              if (
                buffered.name === tool_name ||
                buffered.id === tool_call_id ||
                buffered.id === `pending-${idx}`
              ) {
                toolArgBuffer.current.delete(idx);
                break;
              }
            }

            // Check if there's a pending tool call to replace
            const msgs = useChatStore.getState().messages;
            const msg = msgs.find((m) => m.id === currentMessageIdRef.current);
            const pendingTc = msg?.toolCalls?.find(
              (t) => t.status === "pending" && t.name === tool_name,
            );

            if (pendingTc) {
              // Replace the pending tool call
              updateToolCallPart(currentMessageIdRef.current, pendingTc.id, {
                id: tool_call_id,
                args,
                status: "running",
              });
            } else {
              // No pending — add new
              addToolCallPart(currentMessageIdRef.current, toolCall);
            }
          }
          break;
        }

        case "tool_result": {
          // Update tool call with result
          if (currentMessageIdRef.current) {
            const { tool_call_id, content } = wsEvent.data as {
              tool_call_id: string;
              content: string;
            };
            updateToolCallPart(currentMessageIdRef.current, tool_call_id, {
              result: content,
              status: "completed",
            });
          }
          // Broadcast a window event so other components (e.g. FileSidebar)
          // can auto-refresh when the agent mutates the workspace.
          try {
            const data = wsEvent.data as { tool_call_id?: string };
            // Look up the tool name from the chat store.
            const msgs = useChatStore.getState().messages;
            outer: for (let i = msgs.length - 1; i >= 0; i--) {
              const msg = msgs[i];
              if (!msg?.parts) continue;
              for (const p of msg.parts) {
                if (
                  p.type === "tool" &&
                  p.toolCall?.id === data.tool_call_id &&
                  p.toolCall
                ) {
                  window.dispatchEvent(
                    new CustomEvent("tool_result", {
                      detail: { tool_name: p.toolCall.name },
                    }),
                  );
                  break outer;
                }
              }
            }
          } catch {
            // ignore — best-effort event
          }
          break;
        }

        case "tool_output": {
          // Real-time streaming output from a tool (run_python, run_terminal).
          // Append the chunk to the tool call's streamingOutput / streamingError
          // field so the RunningToolPanel renders it live. The final
          // `tool_result` event later replaces these with the structured result.
          if (currentMessageIdRef.current) {
            const { tool_call_id, content, type } = wsEvent.data as {
              tool_call_id: string;
              content: string;
              type: "stdout" | "stderr";
            };
            appendToolStreamingOutput(
              currentMessageIdRef.current,
              tool_call_id,
              content,
              type,
            );
          }
          break;
        }

        case "final_result": {
          flushTextDelta();
          // Finalize message
          if (currentMessageIdRef.current) {
            const { output } = wsEvent.data as { output: string };
            // If the model returned text only via final_result (no streamed
            // text_delta), append it as the trailing text part.
            const fr = useChatStore
              .getState()
              .messages.find((m) => m.id === currentMessageIdRef.current);
            if (output && fr && !fr.content) {
              appendTextDelta(currentMessageIdRef.current, output);
            }
            updateMessage(currentMessageIdRef.current, (msg) => ({
              ...msg,
              isStreaming: false,
            }));
          }
          setIsProcessing(false);
          // Don't clear currentMessageId yet — we need it for message_saved.
          currentGroupIdRef.current = null;
          break;
        }

        case "error": {
          flushTextDelta();
          // Handle error
          if (currentMessageIdRef.current) {
            const id = currentMessageIdRef.current;
            const { message } = wsEvent.data as { message: string };
            const errText = `\n\n❌ Error: ${message || "Unknown error"}`;
            const cur = useChatStore.getState().messages.find((m) => m.id === id);
            if (cur?.parts) {
              appendTextDelta(id, errText);
            } else {
              updateMessage(id, (msg) => ({ ...msg, content: msg.content + errText }));
            }
            updateMessage(id, (msg) => ({ ...msg, isStreaming: false }));
          }
          setIsProcessing(false);
          break;
        }

        case "tool_approval_required": {
          // Human-in-the-Loop: AI wants to execute tools that need approval.
          const { action_requests, review_configs } = wsEvent.data as {
            action_requests: Array<{
              id: string;
              tool_name: string;
              args: Record<string, unknown>;
            }>;
            review_configs: Array<{
              tool_name: string;
              allow_edit?: boolean;
              timeout?: number;
            }>;
          };
          setPendingApproval({
            actionRequests: action_requests,
            reviewConfigs: review_configs,
          });
          // Show pending tools in the current message
          if (currentMessageIdRef.current) {
            const id = currentMessageIdRef.current;
            const toolNames = action_requests.map((ar) => ar.tool_name).join(", ");
            const waitText = `\n\n⏸️ Waiting for approval: ${toolNames}`;
            const cur = useChatStore.getState().messages.find((m) => m.id === id);
            if (cur?.parts) {
              appendTextDelta(id, waitText);
            } else {
              updateMessage(id, (msg) => ({ ...msg, content: msg.content + waitText }));
            }
          }
          break;
        }

        case "ask_user": {
          const { questions } = wsEvent.data as {
            questions: { question: string; options: string[]; allow_custom: boolean }[];
          };
          setPendingQuestions(
            (questions ?? []).map((q) => ({
              question: q.question,
              options: q.options ?? [],
              allowCustom: q.allow_custom,
            })),
          );
          break;
        }

        case "todo_event": {
          const { event_type, todo, all_todos } = wsEvent.data as {
            event_type: string;
            todo: ResearchTodo | null;
            all_todos?: ResearchTodo[] | null;
          };
          useResearchStore.getState().applyTodoEvent(event_type, todo, all_todos);
          break;
        }

        case "complete": {
          flushTextDelta();
          setIsProcessing(false);
          // Clear currentMessageId after complete (message_saved should have
          // handled ID mapping).
          setCurrentMessageId(null);
          // Drop the abort controller — the turn is done.
          abortRef.current = null;
          break;
        }
      }
    },
    [
      // currentMessageId is read via currentMessageIdRef inside the handler,
      // so we deliberately omit it here — that's the whole point of the ref.
      addMessage,
      updateMessage,
      appendTextDelta,
      appendThinkingDelta,
      appendReasoningDelta,
      addToolCallPart,
      updateToolCallPart,
      appendToolStreamingOutput,
      setCurrentConversationId,
      setCurrentMessageId,
      onConversationCreated,
      currentConversationIdFromStore,
      conversationId,
    ],
  );

  // In backendless mode there's no socket — the agent runtime is local and
  // always "available" (it'll error at turn time if no AI provider is
  // configured). We expose `isConnected: true` for backward compatibility
  // with components that gate the input on it.
  const isConnected = true;

  /**
   * Load the provider config + system prompt for the current user. Cached
   * per-turn (called fresh from `doSend` so model/provider overrides picked
   * up via the setters are honored).
   */
  const buildTurnOptions = useCallback(
    async (
      userId: string,
      message: string,
      fileIds?: string[],
    ): Promise<AgentTurnOptions | null> => {
      // Provider: explicit override (providerIdRef) → first active provider.
      let providers = await aiProviderService.list(userId, true);
      // If no providers found for this user ID (non-auth migration), load ALL
      if (providers.length === 0) {
        const { db } = await import("@/lib/db");
        providers = await db.ai_providers.toArray();
      }
      if (providers.length === 0) {
        handleAgentEvent({
          type: "error",
          data: {
            message:
              "No AI provider configured. Add one in Settings → Agent Settings → AI Providers.",
          },
        });
        return null;
      }
      const selectedProvider =
        providerIdRef.current != null
          ? (providers.find((p) => p.id === providerIdRef.current) ?? providers[0])
          : providers[0];
      if (!selectedProvider) {
        handleAgentEvent({
          type: "error",
          data: { message: "Selected AI provider not found." },
        });
        return null;
      }
      const apiKey = await aiProviderService.getDecryptedApiKey(selectedProvider.id);
      const model = modelRef.current ?? selectedProvider.models[0] ?? "";

      // Load user settings (system prompt, framework, auto-approve, etc.)
      const settings = await settingsService.get(userId);

      // System prompt: user override (if enabled) → framework preset → default
      const framework = settings.ai_framework ?? "default";
      const frameworkPrompt = FRAMEWORK_PROMPTS[framework] ?? FRAMEWORK_PROMPTS.default;
      const systemPrompt =
        settings.system_prompt_enabled && settings.system_prompt
          ? settings.system_prompt
          : frameworkPrompt;

      // Tool approval: if the user opted into auto-approval (Settings →
      // Config → "Auto-approve tool calls"), pass it through so the runtime
      // skips the HITL gate for `requires_approval` tools (run_terminal,
      // run_python, etc.). Defaults to false — secure-by-default.
      const autoApproveTools = !!settings.auto_approve_tools;

      // Abort controller for stop / unmount.
      const controller = new AbortController();
      abortRef.current = controller;

      return {
        userId,
        conversationId: conversationId ?? null,
        userMessage: message,
        fileIds,
        provider: {
          baseUrl: selectedProvider.base_url,
          apiKey,
          model,
          modelType: selectedProvider.model_type,
          toolsEnabled: selectedProvider.tools_enabled,
          noPrefix: (selectedProvider as { no_prefix?: boolean }).no_prefix ?? false,
          thinkingEnabled: (selectedProvider as { thinking_enabled?: boolean }).thinking_enabled ?? false,
        },
        systemPrompt,
        temperature: temperatureRef.current,
        thinkingEffort: thinkingEffortRef.current,
        emit: handleAgentEvent,
        signal: controller.signal,
        autoApproveTools,
      };
    },
    [conversationId, handleAgentEvent],
  );

  const doSend = useCallback(
    async (content: string, fileIds?: string[], files?: ChatMessageFile[]) => {
      const userId = useAuthStore.getState().user?.id;
      if (!userId) {
        // No-op — components should gate on `isAuthenticated` before
        // allowing send. Surface a console warning for diagnostics.
        console.warn("[useChat] sendMessage called without an authenticated user.");
        return;
      }

      const userMessageId = nanoid();
      addMessage({
        id: userMessageId,
        role: "user",
        content,
        timestamp: new Date(),
        conversationId: conversationId || undefined,
        fileIds,
        files,
      });
      setIsProcessing(true);

      // Upload attached files to the E2B sandbox if cloud mode is active.
      // The files are ALREADY in OPFS (uploadFile wrote them there when the
      // user attached them). This step mirrors them into the sandbox so the
      // agent's run_python / run_terminal / read_file tools can access them.
      // In local mode (file_system_mode === "local"), this is skipped — the
      // agent's file tools fall back to OPFS directly.
      if (fileIds && fileIds.length > 0) {
        try {
          const [fsMode, sandboxKey] = await Promise.all([
            settingsService.getFileSystemMode(userId),
            settingsService.getDecryptedSandboxKey(userId),
          ]);
          // Sandbox mode is always "shared" — all conversations share one sandbox.
          const sandboxMode = "shared" as const;
          if ((fsMode === "auto" || fsMode === "hopx") && sandboxKey) {
            const { uploadFileToSandbox, readFileBytes } = await import("@/lib/file-api");
            // Fire-and-forget — don't block the chat turn on sandbox upload.
            // The agent may not need the files immediately, and if the upload
            // fails we still have the OPFS copy.
            void (async () => {
              for (const fid of fileIds) {
                try {
                  const blob = await readFileBytes(fid);
                  if (blob) {
                    const file = new File([blob], files?.find((f) => f.id === fid)?.filename ?? fid, {
                      type: files?.find((f) => f.id === fid)?.mime_type,
                    });
                    await uploadFileToSandbox(file, sandboxKey, conversationId, sandboxMode);
                  }
                } catch (err) {
                  console.warn("[useChat] sandbox upload failed for", fid, err);
                }
              }
            })();
          }
        } catch (err) {
          console.warn("[useChat] failed to check file system mode for sandbox upload:", err);
        }
      }

      // Build the runtime options (loads provider + system prompt). If the
      // build fails (e.g. no provider configured), `handleAgentEvent` will
      // already have emitted an error and we abort the turn.
      //
      // INVISIBLE FILE TAG: when files are attached, append a hidden tag to
      // the message sent to the AI so it knows what files were uploaded and
      // can check the workspace. This tag is NOT shown in the UI — only the
      // clean `content` above is stored + displayed.
      let aiContent = content;
      if (files && files.length > 0) {
        const fileTags = files
          .map((f) => `<@${f.filename} is uploaded check the workspace>`)
          .join(" ");
        aiContent = `${content}\n\n${fileTags}`;
      }
      const opts = await buildTurnOptions(userId, aiContent, fileIds);
      if (!opts) {
        setIsProcessing(false);
        return;
      }

      // Fire-and-forget the turn. Errors inside the runtime are caught and
      // emitted as `error` events via the `emit` callback; we don't need to
      // await here. Awaiting would block the UI until the full turn completes
      // (tens of seconds for long thinking + tool chains), preventing the
      // queued-message drainer from running.
      runAgentTurn(opts).catch((err) => {
        const message = err instanceof Error ? err.message : "Agent turn failed";
        handleAgentEvent({ type: "error", data: { message } });
        setIsProcessing(false);
        abortRef.current = null;
      });
    },
    [addMessage, conversationId, buildTurnOptions, handleAgentEvent],
  );

  const sendChatMessage = useCallback(
    (content: string, fileIds?: string[], files?: ChatMessageFile[]) => {
      // Queue when the agent is busy. The queue is surfaced above the input
      // as pending entries the user can cancel; the drainer effect below
      // pops the head as soon as the agent is idle.
      if (isProcessing) {
        const id = nanoid();
        messageQueueRef.current.push({ id, content, fileIds, files });
        setQueuedMessages([...messageQueueRef.current]);
        return;
      }
      void doSend(content, fileIds, files);
    },
    [isProcessing, doSend],
  );

  const cancelQueued = useCallback((id: string) => {
    messageQueueRef.current = messageQueueRef.current.filter((q) => q.id !== id);
    setQueuedMessages([...messageQueueRef.current]);
  }, []);

  const clearQueued = useCallback(() => {
    messageQueueRef.current = [];
    setQueuedMessages([]);
  }, []);

  const sendResumeDecisions = useCallback(
    (decisions: Decision[]) => {
      setPendingApproval(null);

      // Update message to show decisions were made
      if (currentMessageIdRef.current) {
        const approvedCount = decisions.filter((d) => d.type === "approve").length;
        const editedCount = decisions.filter((d) => d.type === "edit").length;
        const rejectedCount = decisions.filter((d) => d.type === "reject").length;

        const summaryParts: string[] = [];
        if (approvedCount > 0) summaryParts.push(`${approvedCount} approved`);
        if (editedCount > 0) summaryParts.push(`${editedCount} edited`);
        if (rejectedCount > 0) summaryParts.push(`${rejectedCount} rejected`);

        updateMessage(currentMessageIdRef.current, (msg) => ({
          ...msg,
          content: msg.content.replace(
            /\n\n⏸️ Waiting for approval:.*$/,
            `\n\n✅ Decisions: ${summaryParts.join(", ")}`,
          ),
        }));
      }

      // Forward each decision to the runtime via window events. The runtime
      // matches by `toolCallId` — emit one event per decision so each tool
      // call gets its own response.
      for (const d of decisions) {
        const toolCallId =
          d.type === "edit" && d.editedAction
            ? d.editedAction.id
            : (d as { id?: string }).id ?? "";
        if (!toolCallId) continue;
        respondToApproval(toolCallId, {
          type: d.type,
          editedArgs: d.editedAction?.args,
        });
      }
    },
    [updateMessage],
  );

  const sendAskUserResponses = useCallback((answers: AskUserAnswer[]) => {
    setPendingQuestions(null);
    respondToAskUser(answers);
  }, []);

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (currentMessageIdRef.current) {
      updateMessage(currentMessageIdRef.current, (msg) => ({ ...msg, isStreaming: false }));
    }
    setCurrentMessageId(null);
    currentGroupIdRef.current = null;
    setIsProcessing(false);
    setPendingApproval(null);
    setPendingQuestions(null);
  }, [updateMessage, setCurrentMessageId]);

  /**
   * Local-only todo action controls. The runtime has no equivalent channel —
   * `dismiss` hides the panel for the current turn, `reset` clears the
   * current turn's todos, `snapshot` is a no-op (the runtime emits todo
   * events as they happen; there's nothing to re-snapshot).
   */
  const sendTodoAction = useCallback(
    (action: "dismiss" | "reset" | "snapshot") => {
      if (action === "dismiss") useResearchStore.getState().dismiss();
      if (action === "reset") {
        const turnId = useResearchStore.getState().currentTurnId ?? "default";
        useResearchStore.getState().reset(turnId);
      }
      // snapshot: no-op.
    },
    [],
  );

  // Stable setters for model / provider / temperature / thinking effort.
  // These only mutate refs (no React state), so they can be useCallback with
  // empty deps — keeping their references stable across renders.
  // WITHOUT useCallback, every render produces new function references, which
  // invalidates any useEffect that lists them as deps (e.g. the conversation-
  // switch effect in chat-container.tsx), causing an infinite update loop:
  // effect fires → clearMessages() → chat-store set() → useChatStore
  // subscribers re-render → new setter refs → effect fires again → React #185.
  const setModel = useCallback((model: string | null) => {
    modelRef.current = model;
    useChatStore.getState().setSelectedModel(model);
  }, []);
  const setProviderId = useCallback((providerId: string | null) => {
    providerIdRef.current = providerId;
    useChatStore.getState().setSelectedProviderId(providerId);
  }, []);
  const setTemperature = useCallback((temperature: number | null) => {
    temperatureRef.current = temperature;
  }, []);
  const setThinkingEffort = useCallback(
    (effort: "low" | "medium" | "high" | null) => {
      thinkingEffortRef.current = effort;
    },
    [],
  );

  // Drain message queue when processing finishes. Re-runs on the isProcessing
  // flip so a busy turn ending → drains the next one.
  useEffect(() => {
    if (!isProcessing && messageQueueRef.current.length > 0) {
      const next = messageQueueRef.current.shift();
      setQueuedMessages([...messageQueueRef.current]);
      if (next) {
        // Small debounce so the UI shows the queue clearing visibly before
        // the next user bubble lands; also avoids racing the isProcessing flip.
        setTimeout(() => void doSend(next.content, next.fileIds, next.files), 100);
      }
    }
  }, [isProcessing, doSend]);

  // Abort the in-flight turn on unmount so an aborted SSE connection doesn't
  // keep mutating the chat store after the user has navigated away.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  // No-op connect/disconnect kept for backward compatibility with components
  // that may have called them. They do nothing in backendless mode.
  const connect = useCallback(() => {}, []);
  const disconnect = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  return {
    messages,
    isConnected,
    isProcessing,
    connect,
    disconnect,
    sendMessage: sendChatMessage,
    stopGeneration,
    clearMessages,
    queuedMessages,
    cancelQueued,
    clearQueued,
    setModel,
    setProviderId,
    setTemperature,
    setThinkingEffort,
    // Human-in-the-Loop support
    pendingApproval,
    sendResumeDecisions,
    pendingQuestions,
    sendAskUserResponses,
    // Todo tool: live plan panel control (local-only)
    sendTodoAction,
  };
}
