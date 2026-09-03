"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import {
  runAgentTurn,
  respondToAskUser,
  type AgentTurnOptions,
} from "@/lib/agent/runtime";
import { aiProviderService, settingsService } from "@/lib/services";
import { getEffectiveE2BKey } from "@/lib/e2b/env-key";
import { useChatStore, useAuthStore } from "@/stores";
import type {
  AskUserAnswer,
  AskUserQuestion,
  ChatMessageFile,
  ResearchTodo,
  Todo,
  ToolCall,
  WSEvent,
} from "@/types";
import { getGenerationId } from "@/types";
import { setUrlParam } from "@/lib/utils";
import { restoreTodos } from "@/lib/tools/todos";
import { useConversationStore, useResearchStore } from "@/stores";
import { useSubagentStore } from "@/stores/subagent-store";
import { useBackgroundRunStore } from "@/stores/background-run-store";
import { startBackgroundTurn, resumeBackgroundTurn, type BackgroundTurnHandle } from "@/lib/agent/background-turn";
import { beginResponseOrb } from "@/components/assistant-ui/elements/response-orb";

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
  "You are a helpful AI assistant. You have access to tools — call them using the FUNCTION-CALLING API (the tool_calls mechanism) when they would help answer the user's request. NEVER write tool calls as plain text (e.g. 'Thought: ... Action: run_terminal Input: {...}'). ALWAYS use the tool-calling mechanism. Be concise.";

// AI Framework presets — each changes the system prompt to match the
// framework's conventions and behavior patterns.
//
// CRITICAL: ALL framework presets MUST instruct the AI to use the
// FUNCTION-CALLING API (not text) to invoke tools. Previously the LangChain
// preset told the AI to "Use the ReAct pattern: Structure outputs with clear
// sections (Thought, Action, Observation, Final Answer)" — which caused the
// AI to write tool calls as PLAIN TEXT ("Thought: ... Action: run_terminal
// Input: {...}") instead of emitting proper function-call tool_calls. This
// made it look like the AI wasn't calling tools at all. All presets now
// explicitly say: "NEVER write tool calls as text. ALWAYS use the function-
// calling API."
const FRAMEWORK_PROMPTS: Record<string, string> = {
  default: DEFAULT_SYSTEM_PROMPT,
  pydantic_ai: `You are an AI agent built with PydanticAI. You have access to tools that you can call to help the user.
Follow PydanticAI conventions:
- Call tools using the FUNCTION-CALLING API when they would help answer the user's request. NEVER write tool calls as text (e.g. "Action: run_terminal Input: {...}"). ALWAYS use the tool-calling mechanism.
- Structure your responses clearly with markdown
- When using tools, explain what you're doing briefly
- Handle errors gracefully and suggest alternatives
- Be precise and type-safe in your reasoning`,
  langchain: `You are an AI agent powered by LangChain. You have access to tools through LangChain's agent framework.
Follow LangChain conventions:
- Use the ReAct (Reasoning + Acting) pattern: think about what to do, call a tool, observe the result, repeat
- CRITICAL: Call tools using the FUNCTION-CALLING API. NEVER write "Thought:", "Action:", "Input:", "Observation:", or "Final Answer:" as text. The ReAct pattern is a reasoning framework — reason internally, then invoke tools via the tool-calling mechanism, NOT by writing text.
- Chain tool calls together when needed
- Use memory of previous interactions to provide context-aware responses
- Be transparent about your reasoning process in your text responses, but tool invocations MUST go through the function-calling API`,
  crewai: `You are a CrewAI agent working as part of a crew. You have specific tools and a role to fulfill.
Follow CrewAI conventions:
- Focus on your role: research, analyze, create, or execute
- Use tools by calling them through the FUNCTION-CALLING API. NEVER write tool calls as text.
- Report findings clearly and concisely
- Collaborate effectively by sharing relevant context
- Deliver structured, actionable outputs`,
  openai_assistants: `You are an OpenAI Assistant with access to tools. Follow OpenAI Assistants API conventions:
- Use FUNCTION CALLING to interact with available tools. NEVER write tool calls as text.
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
 *   - Ask-user flow (`ask_user` → `respondToAskUser`).
 *   - Todo integration (`todo_event` → `useResearchStore.applyTodoEvent`).
 *   - The `sendTodoAction` controls (dismiss / reset / snapshot) — local
 *     only; the runtime has no equivalent channel.
 *   - The exported hook interface so `chat-container.tsx` and friends don't
 *     break.
 */
export function useChat(options: UseChatOptions = {}) {
  const { conversationId, onConversationCreated } = options;
  const { attachConversation, currentConversationId: currentConversationIdFromStore } =
    useConversationStore();
  const {
    messages,
    addMessage,
    removeMessage,
    updateMessage,
    replaceMessageId,
    appendTextDelta,
    appendThinkingDelta,
    appendReasoningDelta,
    addToolCallPart,
    updateToolCallPart,
    appendToolStreamingOutput,
    endRound: endRoundPart,
    endReasoning: endReasoningPart,
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
  /** Temp id of the user message the CURRENT turn is processing. The
   *  `user_prompt` event swaps it for the real Dexie row id (same pattern as
   *  `message_saved` for assistant messages) so regenerate can delete the
   *  exact DB row, and ratings/exports key on the persisted id. */
  const currentUserMessageIdRef = useRef<string | null>(null);
  const setCurrentMessageId = useCallback((id: string | null) => {
    currentMessageIdRef.current = id;
  }, []);
  const currentGroupIdRef = useRef<string | null>(null);

  // ── GENERATION IDENTITY ─────────────────────────────────────────────────
  // PRD §19: "Use a generation/request identity. Every event carries/retains
  // the generation identity. If event.generationId !== activeGenerationId,
  // ignore the event."
  //
  // The runtime mints a fresh `generationId` (a nanoid) at the start of every
  // `runAgentTurn` call and injects it into `data.generation_id` on EVERY
  // emitted WSEvent. We track the active generation here and discard events
  // whose generation_id doesn't match — this is the critical fix for the
  // "stale message_saved corrupts new generation" race:
  //
  //   1. User clicks Stop → stopGeneration() clears activeGenerationId.
  //   2. User immediately sends a new message → new runAgentTurn starts,
  //      sets activeGenerationId = "gen-B".
  //   3. The OLD runtime (still finishing up after the abort) emits its
  //      final `message_saved` for "gen-A".
  //   4. WITHOUT generation_id check, the handler would replace the new
  //      turn's temp message ID with the old turn's DB ID — hijacking all
  //      subsequent text deltas onto the wrong message.
  //   5. WITH generation_id check, the stale event is silently dropped.
  //
  // `null` means "no active generation" — events with no generation_id
  // (legacy/external emitters) are still accepted when null, for back-compat.
  const activeGenerationIdRef = useRef<string | null>(null);
  // The generation that OWNS the current streaming assistant message. Rounds
  // 2+ of the same generation reuse the message; a NEW generation always
  // starts a new message — even if the previous generation's `complete`
  // never arrived (runtime crash, aborted turn unwinding late). Without
  // this, generation B's deltas would append to generation A's message
  // whenever A's lifecycle events were lost (cross-generation contamination).
  const currentMessageGenerationRef = useRef<string | null>(null);

  // ── ROUND TRACKING (PRD §9–16) ─────────────────────────────────────────
  // Every `model_request_start` of the SAME generation is a new agent round
  // (1-based). Parts created during a round are stamped with it so the UI
  // renders one reasoning panel + one tool stack PER ROUND — never merged.
  // `endRound` stamps roundEndedAt when a round finishes; its timing stays
  // frozen forever after.
  const activeRoundRef = useRef(1);

  /** Freeze the given round's timing on the streaming message (no-op when
   *  the message or round doesn't exist). */
  const endActiveRound = useCallback(
    (round: number) => {
      const messageId = currentMessageIdRef.current;
      if (messageId) endRoundPart(messageId, round);
    },
    [endRoundPart],
  );

  /** Settle the round's reasoning the moment its stream stops — the panel
   *  flips to "Thought for Ns" + auto-collapses immediately (PRD: reasoning
   *  is "-ing" only while reasoning_content is actually arriving, never
   *  until the round ends). */
  const endActiveReasoning = useCallback(
    (round: number) => {
      const messageId = currentMessageIdRef.current;
      if (messageId) endReasoningPart(messageId, round);
    },
    [endReasoningPart],
  );

  // ── STREAMING BUFFERS ──────────────────────────────────────────────
  // Every delta type is buffered + flushed on a timer so React doesn't
  // re-render the whole message tree on every single token. Previously
  // text_delta had NO batching (0ms) which caused "4 lines at once",
  // stuttering, and full app freezes on long responses. Now every delta
  // type goes through the same buffer+flush pattern.
  //
  //   text_delta      → 30ms  (real-time feel, ~33 updates/sec)
  //   thinking_delta  → 100ms (less critical, heavier markdown)
  //   reasoning_delta → 100ms
  //   tool_call_delta → 30ms  (args streaming)
  //
  // 30ms is the sweet spot: feels instant to humans (film is 24fps / 41ms)
  // but lets React batch 3-5 SSE tokens into a single render pass.
  const textDeltaBuffer = useRef<string>("");
  const textDeltaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const thinkingBuffer = useRef<string>("");
  const thinkingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reasoningBuffer = useRef<string>("");
  const reasoningTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toolArgBuffer = useRef<Map<number, { id: string; name: string; args: string }>>(new Map());
  const toolArgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Batched tool_output deltas — prevents store update spam when the sandbox
  // emits stdout/stderr chunks rapidly (e.g. `pip install` with 100s of lines).
  // Without batching, each chunk triggers a full React re-render. 50ms keeps
  // output feeling live (~20fps) while batching 5-10 chunks per render.
  const toolOutputBuffer = useRef<Map<string, { stdout: string; stderr: string }>>(new Map());
  const toolOutputTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Flush remaining text buffer immediately (called on final_result, error, complete)
  const flushTextDelta = useCallback(() => {
    if (textDeltaTimer.current) { clearTimeout(textDeltaTimer.current); textDeltaTimer.current = null; }
    if (textDeltaBuffer.current && currentMessageIdRef.current) {
      // Round-stamp new text parts (activeRoundRef) so text + thinking of
      // the same round land in one round segment — prevents the mid-stream
      // single→multi-round layout flip that remounted the TextBubble.
      appendTextDelta(currentMessageIdRef.current, textDeltaBuffer.current, activeRoundRef.current);
      textDeltaBuffer.current = "";
    }
    if (thinkingTimer.current) { clearTimeout(thinkingTimer.current); thinkingTimer.current = null; }
    if (thinkingBuffer.current && currentMessageIdRef.current) {
      appendThinkingDelta(currentMessageIdRef.current, thinkingBuffer.current, activeRoundRef.current);
      thinkingBuffer.current = "";
    }
    if (reasoningTimer.current) { clearTimeout(reasoningTimer.current); reasoningTimer.current = null; }
    if (reasoningBuffer.current && currentMessageIdRef.current) {
      appendReasoningDelta(currentMessageIdRef.current, reasoningBuffer.current, activeRoundRef.current);
      reasoningBuffer.current = "";
    }
    if (toolArgTimer.current) { clearTimeout(toolArgTimer.current); toolArgTimer.current = null; }
    toolArgBuffer.current.clear();
    // Flush tool_output buffer immediately so the final chunks show before result.
    if (toolOutputTimer.current) { clearTimeout(toolOutputTimer.current); toolOutputTimer.current = null; }
    if (currentMessageIdRef.current && toolOutputBuffer.current.size > 0) {
      for (const [tcId, chunks] of toolOutputBuffer.current) {
        if (chunks.stdout) appendToolStreamingOutput(currentMessageIdRef.current, tcId, chunks.stdout, "stdout");
        if (chunks.stderr) appendToolStreamingOutput(currentMessageIdRef.current, tcId, chunks.stderr, "stderr");
      }
      toolOutputBuffer.current.clear();
    }
  }, [appendTextDelta, appendThinkingDelta, appendReasoningDelta, appendToolStreamingOutput]);
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
  const [pendingQuestions, setPendingQuestions] = useState<AskUserQuestion[] | null>(null);
  /** Human-readable rate-limit status while the runtime backs off and
   *  retries (PRD §7) — e.g. "Rate limit reached — retrying in 4s…". */
  const [rateLimitStatus, setRateLimitStatus] = useState<string | null>(null);

  // The active agent turn's abort controller. Held in a ref so the various
  // `stopGeneration` / unmount handlers can abort the in-flight SSE stream.
  const abortRef = useRef<AbortController | null>(null);

  // The active BACKGROUND agent turn (E2B sandbox job), when the turn runs
  // in background mode. Stopping the generation kills the sandbox job too.
  const backgroundHandleRef = useRef<BackgroundTurnHandle | null>(null);

  // Track the active conversation id in the research store so todo events
  // route to the right turn bucket. Reset the bucket when going to a new chat.
  // ALSO rehydrate persisted agent todos (Dexie) so the TodoPreview tables
  // survive page refreshes and conversation switches (PRD §24).
  useEffect(() => {
    const turnId = currentConversationIdFromStore ?? conversationId ?? null;
    setCurrentTodoTurnId(turnId);
    if (turnId === null) resetTodoTurn();
    if (turnId) {
      let cancelled = false;
      restoreTodos(turnId).then((todos) => {
        if (!cancelled && todos.length > 0) {
          useResearchStore.getState().setAgentTodos(turnId, todos);
        }
      }).catch(() => {
        // IndexedDB unavailable — live events will populate the store.
      });
      return () => {
        cancelled = true;
      };
    }
  }, [currentConversationIdFromStore, conversationId, setCurrentTodoTurnId, resetTodoTurn]);

  // Single event handler for every WSEvent the runtime emits. Maps each event
  // type to the appropriate chat-store mutation. This is the same handler the
  // WebSocket version had — only the transport changed.
  //
  // GENERATION AWARENESS (PRD §19): Every event from `runAgentTurn` carries
  // `data.generation_id`. We compare it to `activeGenerationIdRef.current`:
  //   - If they match → process the event normally.
  //   - If they differ → SILENTLY DROP (it's from a stale generation).
  //   - If the event has no generation_id → accept (legacy/external emitter).
  //
  // The only events exempt from the generation check are `conversation_created`,
  // `model_request_start` (which SETS the active generation), and `error` /
  // `complete` (which CLEAR it). All delta/tool/result events are checked.
  const handleAgentEvent = useCallback(
    (wsEvent: WSEvent) => {
      const eventGenId = getGenerationId(wsEvent);
      const activeGenId = activeGenerationIdRef.current;

      // Helper: returns true if this event should be processed based on
      // generation_id matching. null eventGenId means "always accept" (legacy
      // emitter or pre-runtime event).
      const isFromActiveGeneration = (): boolean => {
        if (!eventGenId) return true; // legacy / external event
        if (!activeGenId) return true; // no active generation — accept
        return eventGenId === activeGenId;
      };

      const createNewMessage = (content: string): string => {
        // Flush any pending delta buffers into the PREVIOUS message before
        // switching, so the tail of generation N-1's stream never lands in
        // generation N's message (cross-generation contamination).
        flushTextDelta();
        if (currentMessageIdRef.current) {
          // Finalize the previous generation's message — it will no longer
          // receive updates.
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

      /** Ensure an assistant message exists and belongs to the ACTIVE
       *  generation. Creates a new message (finalizing the previous one and
       *  flushing its pending buffers) when the message is owned by a
       *  different generation; no-ops when the active generation already owns
       *  the streaming message (rounds 2+ of the same turn). */
      const ensureMessageForActiveGeneration = (): void => {
        if (
          currentMessageIdRef.current !== null &&
          currentMessageGenerationRef.current === activeGenerationIdRef.current
        ) {
          return; // same generation still streaming — reuse the message
        }
        createNewMessage("");
        currentMessageGenerationRef.current = activeGenerationIdRef.current;
      };

      switch (wsEvent.type) {
        case "conversation_created": {
          // Handle new conversation created by the runtime.
          const { conversation_id } = wsEvent.data as { conversation_id: string };
          // `attachConversation` switches the id WITHOUT clearing anything and
          // marks the conversation hydrated — the live streaming messages in
          // the chat store are authoritative, so no DB reload may fire for
          // this id (PRD §23–24: never wipe a live generation).
          attachConversation(conversation_id);
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

        case "user_prompt": {
          // The runtime persisted the user's message — swap the optimistic
          // temp nanoid in the chat store for the real Dexie row id. Same
          // pattern as `message_saved` below (generation-guarded so a stale
          // turn's event can't hijack the current one). Without this swap the
          // store's user message id never matched its DB row, which broke the
          // regenerate path (it deletes rows by id).
          if (!isFromActiveGeneration()) {
            break;
          }
          const { message_id } = wsEvent.data as { message_id: string };
          const tempUserId = currentUserMessageIdRef.current;
          if (tempUserId && tempUserId !== message_id) {
            replaceMessageId(tempUserId, message_id);
            currentUserMessageIdRef.current = message_id;
          }
          break;
        }

        case "message_saved": {
          // Assistant message was saved to IndexedDB; swap the temporary
          // nanoid for the real database ID. We use replaceMessageId (not
          // updateMessage) because updateMessage matches by ID — you can't
          // change the ID inside it.
          //
          // GENERATION GUARD: Only replace the ID if this message_saved
          // belongs to the ACTIVE generation. A stale message_saved from a
          // previous (aborted) generation must NOT replace the current
          // generation's temp ID — that was the root cause of the
          // "stale message_saved corrupts new generation" bug.
          if (!isFromActiveGeneration()) {
            break;
          }
          const { message_id } = wsEvent.data as { message_id: string };
          const oldId = currentMessageIdRef.current;
          if (oldId && oldId !== message_id) {
            replaceMessageId(oldId, message_id);
            currentMessageIdRef.current = message_id;
          } else if (!oldId) {
            // Fallback: find the last assistant message with a temp id.
            // This is safe now because we've already verified the generation
            // matches — so the temp message we find IS this generation's.
            const messages = useChatStore.getState().messages;
            const lastTemp = [...messages]
              .reverse()
              .find((msg) => msg.role === "assistant" && !!msg.isTemporaryId);
            if (lastTemp && lastTemp.id !== message_id) {
              replaceMessageId(lastTemp.id, message_id);
              currentMessageIdRef.current = message_id;
            }
          }
          break;
        }

        case "model_request_start": {
          // One assistant turn = ONE message bubble, even if the agent
          // runs multiple rounds (text → tool → text → tool → text).
          //
          // GENERATION LIFECYCLE:
          //   - First `model_request_start` of a turn: adopt the event's
          //     generation_id as the active generation. Create the assistant
          //     message ONCE. Round counter resets to 1.
          //   - Subsequent `model_request_start` events (rounds 2+ of the
          //     same turn): the event's generation_id matches the active
          //     generation → reuse the existing streaming message. Freeze
          //     the previous round's timing, then advance the round counter
          //     so new thinking/reasoning/tool parts stamp the NEW round.
          //   - Stale `model_request_start` from a previous generation:
          //     event's generation_id differs → SILENTLY DROP.
          if (eventGenId && activeGenId && eventGenId !== activeGenId) {
            // Stale event from a previous generation — ignore.
            break;
          }
          const isFirstRequestOfGeneration = !activeGenId || activeGenId !== eventGenId;
          if (eventGenId && !activeGenId) {
            // First event of a new generation — adopt it.
            activeGenerationIdRef.current = eventGenId;
          }
          const eventRoundRaw = (wsEvent.data as { round?: unknown }).round;
          const eventRound =
            typeof eventRoundRaw === "number" && eventRoundRaw >= 1 ? Math.floor(eventRoundRaw) : null;
          if (isFirstRequestOfGeneration && currentMessageGenerationRef.current !== activeGenerationIdRef.current) {
            // Fresh turn — round numbering restarts.
            activeRoundRef.current = eventRound ?? 1;
          } else if (!isFirstRequestOfGeneration) {
            // Rounds 2+ of the SAME turn: flush pending buffers (they belong
            // to the OLD round), freeze the old round's elapsed time, then
            // advance — starting Round 2 never resets Round 1's duration.
            // A retry re-emits the SAME round number — only advance when the
            // round actually changed.
            const roundChanged = eventRound !== null ? eventRound !== activeRoundRef.current : true;
            if (roundChanged) {
              flushTextDelta();
              endActiveRound(activeRoundRef.current);
              activeRoundRef.current = eventRound ?? activeRoundRef.current + 1;
            }
          }
          // MESSAGE OWNERSHIP: reuse the streaming message only while the
          // ACTIVE generation owns it. If the previous generation's
          // `complete` was lost (runtime crash / late abort unwind), the
          // message still belongs to that generation — start a fresh bubble
          // instead of appending the new turn's text to the old message
          // (finalizing the old one and flushing its pending buffers).
          ensureMessageForActiveGeneration();
          break;
        }

        case "text_delta": {
          // GENERATION GUARD: drop deltas from stale generations.
          // Previously, this handler had a fallback `createNewMessage("")`
          // when `currentMessageIdRef.current` was null. That fallback was
          // a source of "broken half word" bugs — if the ref was somehow
          // null mid-stream (e.g. after a stale complete event), each delta
          // would create a NEW assistant message, splitting words like
          // "Hel" + "lo" across two bubbles. Now we DROP the delta instead
          // (the buffer is preserved across drops so nothing is lost if the
          // ref comes back, but a stale delta never creates a phantom bubble).
          if (!isFromActiveGeneration()) break;
          if (currentMessageIdRef.current) {
            const content = (wsEvent.data as { index: number; content: string }).content;
            if (content) {
              textDeltaBuffer.current += content;
              if (!textDeltaTimer.current) {
                textDeltaTimer.current = setTimeout(() => {
                  if (textDeltaBuffer.current && currentMessageIdRef.current) {
                    appendTextDelta(currentMessageIdRef.current, textDeltaBuffer.current, activeRoundRef.current);
                    textDeltaBuffer.current = "";
                  }
                  textDeltaTimer.current = null;
                }, 1); // 1ms — flush immediately (next tick), no batching delay
              }
            }
          }
          break;
        }

        case "thinking_delta": {
          // Reasoning trace — batch like text deltas to prevent lag.
          // GENERATION GUARD: same as text_delta — drop stale, NO fallback
          // createNewMessage (prevents phantom thinking bars).
          if (!isFromActiveGeneration()) break;
          if (currentMessageIdRef.current) {
            const content = (wsEvent.data as { index: number; content: string }).content;
            thinkingBuffer.current += content;
            if (!thinkingTimer.current) {
              thinkingTimer.current = setTimeout(() => {
                if (thinkingBuffer.current && currentMessageIdRef.current) {
                  appendThinkingDelta(currentMessageIdRef.current, thinkingBuffer.current, activeRoundRef.current);
                  thinkingBuffer.current = "";
                }
                thinkingTimer.current = null;
              }, 100); // 100ms batch for thinking
            }
          }
          break;
        }

        case "reasoning_delta": {
          // DeepSeek/Moonshot/g4f-style reasoning — batch to prevent lag.
          // GENERATION GUARD: same as text_delta — drop stale, NO fallback.
          if (!isFromActiveGeneration()) break;
          if (currentMessageIdRef.current) {
            const content = (wsEvent.data as { index: number; content: string }).content;
            reasoningBuffer.current += content;
            if (!reasoningTimer.current) {
              reasoningTimer.current = setTimeout(() => {
                if (reasoningBuffer.current && currentMessageIdRef.current) {
                  appendReasoningDelta(currentMessageIdRef.current, reasoningBuffer.current, activeRoundRef.current);
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
          // LLM lifecycle events — optionally show status. A new provider
          // request also clears any stale rate-limit note.
          //
          // REASONING SETTLEMENT (instant "-ed"): the LLM stream for this
          // round just ended — any thinking/reasoning that was streaming is
          // done NOW. Stamp it so the panel collapses immediately instead
          // of shimmering "Thinking…" until the whole turn finishes.
          if (wsEvent.type === "llm_completed" && currentMessageIdRef.current) {
            flushTextDelta();
            endActiveReasoning(activeRoundRef.current);
          }
          setRateLimitStatus(null);
          break;
        }

        case "rate_limited": {
          // The runtime hit a 429/529 and is backing off before retrying.
          // Surface it instead of letting the turn silently look dead —
          // the agent state (accumulated content, tool calls) is preserved
          // and no duplicate work is issued (PRD §7).
          const d = wsEvent.data as { retryAfterMs?: number; attempt?: number; maxAttempts?: number };
          const secs = Math.max(1, Math.round((d.retryAfterMs ?? 1000) / 1000));
          const attempt = d.attempt ?? 1;
          const max = d.maxAttempts ?? 3;
          setRateLimitStatus(
            `Rate limit reached — retrying automatically in ${secs}s… (attempt ${attempt}/${max})`,
          );
          break;
        }

        case "tool_call_delta": {
          // Tool call args streaming — buffer and flush every 16ms to prevent
          // lag and duplicate pending tool calls.
          // GENERATION GUARD: drop stale.
          if (!isFromActiveGeneration()) break;
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
                // New tool call with a name — REPLACE the buffer entry.
                // Use the real ID if provided, otherwise keep the existing ID
                // (don't generate pending-N — causes matching issues).
                toolArgBuffer.current.set(tc.index, {
                  id: tc.id || existing?.id || `pending-${tc.index}`,
                  name: tc.name,
                  args: tc.arguments || "",
                });
              } else if (tc.id && tc.id !== existing?.id && !existing) {
                // First delta has ID but no name — create buffer entry.
                // Don't use pending-N as the name — use empty string.
                toolArgBuffer.current.set(tc.index, {
                  id: tc.id,
                  name: "",
                  args: tc.arguments || "",
                });
              } else if (tc.id && tc.id !== existing?.id && existing) {
                // Different tool_call_id at the same index — update ID but
                // keep the name (provider may send ID first, then name).
                existing.id = tc.id;
                if (tc.arguments) existing.args += tc.arguments;
              } else if (tc.arguments && existing) {
                // Append args to existing buffer entry (same tool call)
                existing.args += tc.arguments;
              }
            }
            // Flush every 16ms — creates/updates the pending tool call
            // so the user sees streaming args in realtime. 16ms ≈ 60fps.
            if (!toolArgTimer.current) {
              toolArgTimer.current = setTimeout(() => {
                toolArgTimer.current = null;
                if (!currentMessageIdRef.current) return;
                const msgs = useChatStore.getState().messages;
                const msg = msgs.find((m) => m.id === currentMessageIdRef.current);
                if (!msg?.toolCalls) return;

                for (const [index, buffered] of toolArgBuffer.current) {
                  // Match by ID first. Then try matching by index-based pending ID.
                  // Then try matching by name (for pre-emitted cards with different IDs).
                  // Finally, try matching ANY pending card that doesn't have a real name yet.
                  let existing = msg.toolCalls.find(
                    (t) => t.id === buffered.id,
                  );
                  if (!existing) {
                    existing = msg.toolCalls.find(
                      (t) => t.id === `pending-${index}`,
                    );
                  }
                  const realName = buffered.name && !buffered.name.startsWith("pending-")
                    ? buffered.name
                    : "";
                  if (!existing && realName) {
                    // Match by name — finds pre-emitted cards
                    existing = msg.toolCalls.find(
                      (t) => t.name === realName && (t.status === "pending" || (t.args as { _streaming?: string })?._streaming !== undefined),
                    );
                  }
                  if (!existing) {
                    // Last resort: match ANY pending/streaming card (the first one)
                    existing = msg.toolCalls.find(
                      (t) => (t.status === "pending" || (t.args as { _streaming?: string })?._streaming !== undefined) && (!t.name || t.name.startsWith("pending-") || t.name === ""),
                    );
                  }
                  if (existing) {
                    // Update existing card's streaming args + name
                    updateToolCallPart(currentMessageIdRef.current, existing.id, {
                      args: { _streaming: buffered.args },
                      name: realName || existing.name,
                      // Also update the ID if we now have a real one
                      ...(buffered.id && !buffered.id.startsWith("pending-") && existing.id.startsWith("pending-")
                        ? { id: buffered.id }
                        : {}),
                    });
                  }
                  // DO NOT create a new card here — only the tool_call event
                  // (pre-emit or final) creates cards. The delta handler only
                  // UPDATES existing cards. This prevents duplicate cards and
                  // ensures the card appears via the pre-emit, not via the
                  // delta flush — which fixes the "stuck then appears" issue.
                }
              }, 16);
            }
          }
          break;
        }

        case "tool_call": {
          // Tool call is ready to execute — replace the pending/streaming
          // tool call with the final one (with parsed args + running status).
          // ALSO clear the toolArgBuffer so the next round's tool calls
          // (which may reuse the same index) don't inherit stale args.
          // GENERATION GUARD: drop stale.
          if (!isFromActiveGeneration()) break;

          // SUB-AGENT SIDEBAR AUTO-OPEN (PRD §15): the moment a sub-agent
          // tool call is detected, open the Sub-Agent sidebar so its
          // progress streams visibly. If the user closed it manually, a NEW
          // invocation re-opens it (setSidebarOpen is idempotent). Applies
          // to pre-emits too (cards appear during streaming).
          {
            const tn = (wsEvent.data as { tool_name?: string }).tool_name;
            if (
              tn === "spawn_subagent" ||
              tn === "query_subagent" ||
              tn === "create_subagent_chat" ||
              tn === "steer_subagent" ||
              tn === "complete_subagent" ||
              tn === "cancel_subagent"
            ) {
              useSubagentStore.getState().setSidebarOpen(true);
            }
          }

          if (currentMessageIdRef.current) {
            const data = wsEvent.data as {
              tool_name: string;
              args: Record<string, unknown>;
              tool_call_id: string;
              _preemit?: boolean;
            };
            const { tool_name, args, tool_call_id } = data;
            // Pre-emit tool calls (sent during streaming before args are
            // fully parsed) get status "pending" so the user sees the card
            // immediately. The final tool_call event (after stream ends)
            // will update it to "running" with parsed args.
            const toolCall: ToolCall = {
              id: tool_call_id,
              name: tool_name,
              args,
              status: data._preemit ? "pending" : "running",
            };

            // Clear the toolArgBuffer entry for this tool call — BUT ONLY
            // for non-pre-emit events. Pre-emit events fire DURING streaming
            // (before all args have arrived), so clearing the buffer would
            // cause subsequent deltas to be lost. Only clear when the FINAL
            // tool_call event arrives (after stream ends, _preemit is false).
            if (!data._preemit) {
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
            }

            // Check if there's a pre-emitted or pending tool call to replace.
            // The runtime pre-emits tool_call events during streaming (as soon
            // as the tool name is known) so the card appears immediately. We
            // need to find and UPDATE that card instead of creating a duplicate.
            //
            // MATCHING RULES (timeline PRD §7/§8 — a tool call is anchored to
            // its own card; tool results update THAT card in place):
            //   1. EXACT tool_call_id match — always safe. Pre-emit + final
            //      events for the same call share the id (standard providers
            //      AND nanoid fallbacks — both come from the same accumulator
            //      entry).
            //   2. Placeholder-id fallback — ONLY for pending cards whose id
            //      is a placeholder (`dsml_*` real-time parse ids, `pending-*`
            //      composing ids). DSML ids are time-based, so the final event
            //      can never match them by id; the rebind gives the card its
            //      real id.
            // A card with a REAL provider id — pending, running, OR completed —
            // must NEVER be name-matched to a different tool_call_id. The old
            // name+pending matcher (which also treated a lingering
            // `args._streaming` as "pending") rebound every later same-name
            // tool call onto the FIRST card: parallel same-name tools
            // collapsed into one card, and a completed card's id was
            // overwritten so later tool_results never landed on any card.
            const msgs = useChatStore.getState().messages;
            const msg = msgs.find((m) => m.id === currentMessageIdRef.current);
            // Match by tool_call_id first (most reliable).
            let existingTc = msg?.toolCalls?.find(
              (t) => t.id === tool_call_id,
            );
            if (!existingTc) {
              // Placeholder-id pending card awaiting its real id (DSML
              // real-time pre-emits / "Composing…" cards).
              existingTc = msg?.toolCalls?.find(
                (t) =>
                  t.status === "pending" &&
                  t.name === tool_name &&
                  (t.id.startsWith("dsml_") || t.id.startsWith("pending-")),
              );
            }
            if (!existingTc) {
              // Composing cards (name "tool") from the FENCE (```tool_call) and
              // DSML open-tag detectors: the real name only exists AFTER the
              // post-stream parse, so these placeholder-prefix cards are
              // rebound by prefix + pending status, not by name. Only the
              // composing_* prefixes match — real fence_ ids belong to their
              // own cards and must never be name/prefix-hijacked.
              existingTc = msg?.toolCalls?.find(
                (t) =>
                  t.status === "pending" &&
                  (t.id.startsWith("fence_composing_") ||
                    t.id.startsWith("dsml_composing_")),
              );
            }
            if (!existingTc && (!tool_name || tool_name === "tool" || tool_name.startsWith("pending-"))) {
              // The incoming event is itself a placeholder pre-emit — it may
              // adopt any still-pending placeholder card.
              existingTc = msg?.toolCalls?.find(
                (t) =>
                  t.status === "pending" &&
                  (!t.name || t.name === "tool" || t.name.startsWith("pending-")),
              );
            }

            if (existingTc) {
              // Replace the pre-emitted/pending tool call — NO duplicate.
              // The FINAL tool_call event's parsed args are authoritative —
              // use them even when they're an EMPTY object ({}), so the
              // `_streaming` placeholder from the pre-emit is cleared once
              // the call is real. A lingering `_streaming` args marker made
              // completed cards keep matching "pending-ish" matchers forever
              // (the card-hijack root cause). Pre-emit events keep the
              // streaming args visible until the final event lands.
              const existingArgs = existingTc.args as { _streaming?: string };
              const hasStreamingArgs = existingArgs?._streaming !== undefined;
              const isPreemit = !!data._preemit;
              updateToolCallPart(currentMessageIdRef.current, existingTc.id, {
                id: tool_call_id,
                args: !isPreemit
                  ? args
                  : (hasStreamingArgs ? existingTc.args : args),
                status: isPreemit ? "pending" : "running",
              });
            } else if (data._preemit) {
              // Pre-emit with no existing card — add as pending.
              addToolCallPart(currentMessageIdRef.current, toolCall, activeRoundRef.current);
            } else {
              // Normal (non-preemit) tool_call with no existing — add new.
              addToolCallPart(currentMessageIdRef.current, toolCall, activeRoundRef.current);
            }
          }
          break;
        }

        case "tool_result": {
          // Update tool call with result.
          // GENERATION GUARD: drop stale. (A stale tool_result from a
          // previous generation could otherwise write a result onto the
          // current generation's tool card if IDs happened to collide.)
          if (!isFromActiveGeneration()) break;
          if (currentMessageIdRef.current) {
            const { tool_call_id, content } = wsEvent.data as {
              tool_call_id: string;
              content: string;
            };
            // Flush any buffered tool_output for THIS tool_call_id before
            // marking it completed — otherwise the last 50ms of live output
            // (buffered by the tool_output batcher) is lost when the panel
            // switches from RunningToolPanel to the completed result view.
            if (toolOutputBuffer.current.has(tool_call_id)) {
              const chunks = toolOutputBuffer.current.get(tool_call_id)!;
              if (chunks.stdout) appendToolStreamingOutput(currentMessageIdRef.current, tool_call_id, chunks.stdout, "stdout");
              if (chunks.stderr) appendToolStreamingOutput(currentMessageIdRef.current, tool_call_id, chunks.stderr, "stderr");
              toolOutputBuffer.current.delete(tool_call_id);
              // If this was the last buffered tool, clear the timer too.
              if (toolOutputBuffer.current.size === 0 && toolOutputTimer.current) {
                clearTimeout(toolOutputTimer.current);
                toolOutputTimer.current = null;
              }
            }
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
          // Buffer + flush every 50ms to prevent store update spam when the
          // sandbox emits chunks rapidly (e.g. `pip install` = 100s of lines).
          // Without batching, each chunk triggers a full React re-render.
          // GENERATION GUARD: drop stale.
          if (!isFromActiveGeneration()) break;
          if (currentMessageIdRef.current) {
            const { tool_call_id, content, type } = wsEvent.data as {
              tool_call_id: string;
              content: string;
              type: "stdout" | "stderr";
            };
            const existing = toolOutputBuffer.current.get(tool_call_id) ?? { stdout: "", stderr: "" };
            if (type === "stdout") existing.stdout += content;
            else existing.stderr += content;
            toolOutputBuffer.current.set(tool_call_id, existing);
            if (!toolOutputTimer.current) {
              toolOutputTimer.current = setTimeout(() => {
                toolOutputTimer.current = null;
                if (!currentMessageIdRef.current) return;
                for (const [tcId, chunks] of toolOutputBuffer.current) {
                  if (chunks.stdout) appendToolStreamingOutput(currentMessageIdRef.current, tcId, chunks.stdout, "stdout");
                  if (chunks.stderr) appendToolStreamingOutput(currentMessageIdRef.current, tcId, chunks.stderr, "stderr");
                }
                toolOutputBuffer.current.clear();
              }, 50);
            }
          }
          break;
        }

        case "final_result": {
          // GENERATION GUARD: a stale final_result from a previous (aborted)
          // generation must NOT finalize the current generation's message.
          // Without this check, stopping and immediately starting a new turn
          // could cause the new turn's message to be marked isStreaming=false
          // prematurely by the old turn's final_result.
          if (!isFromActiveGeneration()) break;
          flushTextDelta();
          // Freeze the final round's timing (PRD §15 — settled state).
          endActiveRound(activeRoundRef.current);
          // Finalize message
          if (currentMessageIdRef.current) {
            const { output } = wsEvent.data as { output: string };
            // If the model returned text only via final_result (no streamed
            // text_delta), append it as the trailing text part.
            const fr = useChatStore
              .getState()
              .messages.find((m) => m.id === currentMessageIdRef.current);
            if (output && fr && !fr.content) {
              appendTextDelta(currentMessageIdRef.current, output, activeRoundRef.current);
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
          // GENERATION GUARD: a stale error from a previous generation must
          // NOT mark the current generation's message as errored. If the
          // event's generation_id doesn't match, drop it silently.
          if (!isFromActiveGeneration()) break;
          // The turn ended (non-retryable) — clear any rate-limit note.
          setRateLimitStatus(null);
          flushTextDelta();
          // Freeze the round's timing before tearing down (failed round still
          // shows its elapsed time — PRD §25).
          endActiveRound(activeRoundRef.current);
          // Handle error
          if (currentMessageIdRef.current) {
            const id = currentMessageIdRef.current;
            const { message } = wsEvent.data as { message: string };
            const errText = `\n\n❌ Error: ${message || "Unknown error"}`;
            const cur = useChatStore.getState().messages.find((m) => m.id === id);
            if (cur?.parts) {
              appendTextDelta(id, errText, activeRoundRef.current);
            } else {
              updateMessage(id, (msg) => ({ ...msg, content: msg.content + errText }));
            }
            updateMessage(id, (msg) => ({ ...msg, isStreaming: false }));
          } else {
            // NO streaming message exists — the turn failed before the first
            // model_request_start (e.g. the very first LLM request 4xx'd:
            // "You have reached the maximum prompt length limit", 404 from a
            // wrong base URL, 401 bad key…). Create the assistant message NOW
            // so the error is VISIBLE in the chat instead of silently
            // vanishing ("the app did nothing" — the invisible-error bug).
            const { message } = wsEvent.data as { message: string };
            const errText = `❌ Error: ${message || "Unknown error"}`;
            const id = createNewMessage(errText);
            updateMessage(id, (msg) => ({ ...msg, isStreaming: false }));
          }
          setIsProcessing(false);
          // PRD §18: error preserves already-streamed content + marks the
          // active assistant turn as error. Clear the active generation so
          // any subsequent stale events from this generation are dropped.
          activeGenerationIdRef.current = null;
          setCurrentMessageId(null);
          abortRef.current = null;
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
          // Agent Todo system: new-shape todos (manage_todo / show_todo)
          // carry `title` + 4-status values — route them to the agentTodos
          // bucket that the TodoPreview table reads. Legacy ResearchTodo
          // shapes keep the old panel path.
          if (Array.isArray(all_todos)) {
            const isNewShape = (all_todos as unknown[]).some(
              (t) => t && typeof t === "object" && "title" in (t as Record<string, unknown>),
            );
            if (isNewShape) {
              const turnId = currentConversationIdFromStore || conversationId || "default";
              useResearchStore.getState().setAgentTodos(turnId, all_todos as unknown as Todo[]);
              break;
            }
          }
          useResearchStore.getState().applyTodoEvent(event_type, todo, all_todos);
          break;
        }

        case "complete": {
          // Turn finished — clear any rate-limit note.
          setRateLimitStatus(null);
          // GENERATION GUARD: only clear if this complete belongs to the
          // active generation. A stale complete from a previous (aborted)
          // generation must NOT clear the current generation's state.
          if (!isFromActiveGeneration()) break;
          flushTextDelta();
          // Freeze the final round's timing — its elapsed display settles.
          endActiveRound(activeRoundRef.current);
          setIsProcessing(false);
          // Clear currentMessageId after complete (message_saved should have
          // handled ID mapping).
          setCurrentMessageId(null);
          // Clear the active generation — the next turn mints a new one.
          activeGenerationIdRef.current = null;
          // Reset message ownership — the next generation starts a fresh
          // assistant message even if this complete arrives out of order.
          currentMessageGenerationRef.current = null;
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
      replaceMessageId,
      flushTextDelta,
      appendTextDelta,
      appendThinkingDelta,
      appendReasoningDelta,
      addToolCallPart,
      updateToolCallPart,
      appendToolStreamingOutput,
      endActiveRound,
      endActiveReasoning,
      attachConversation,
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
      // SINGLE SOURCE OF TRUTH (model-desync PRD): the chat store's
      // `selectedModel` / `selectedProviderId` are authoritative. The refs are
      // a fast mirror kept in sync by setModel/setProviderId — read both with
      // the store winning so a selection made through ANY writer (popover,
      // restore, subagent) is what this request actually uses.
      const storeSelection = useChatStore.getState();
      const modelOverride = storeSelection.selectedModel ?? modelRef.current;
      const providerOverrideId = storeSelection.selectedProviderId ?? providerIdRef.current;
      const selectedProvider =
        providerOverrideId != null
          ? (providers.find((p) => p.id === providerOverrideId) ?? providers[0])
          : providers[0];
      if (!selectedProvider) {
        handleAgentEvent({
          type: "error",
          data: { message: "Selected AI provider not found." },
        });
        return null;
      }
      const apiKey = await aiProviderService.getDecryptedApiKey(selectedProvider.id);
      const model = modelOverride ?? selectedProvider.models[0] ?? "";

      // Dev instrumentation (PRD §15): verify UI model == runtime model ==
      // request model. Visible in the console during development only.
      if (process.env.NODE_ENV !== "production") {
        console.debug(
          `[useChat] turn provider=${selectedProvider.name} model=${model || "(provider default)"}`,
        );
      }

      // Load user settings (system prompt, framework, auto-approve, etc.)
      const settings = await settingsService.get(userId);

      // System prompt: user override (if enabled) → framework preset → default
      const framework = settings.ai_framework ?? "default";
      const frameworkPrompt = FRAMEWORK_PROMPTS[framework] ?? FRAMEWORK_PROMPTS.default;
      const systemPrompt =
        (settings.system_prompt_enabled && settings.system_prompt
          ? settings.system_prompt
          : frameworkPrompt) ?? "";

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
      // Track for the `user_prompt` id swap (see its handler above).
      currentUserMessageIdRef.current = userMessageId;
      // A new AI response is starting with this user message — pick this
      // response's random orb ONCE (25 variants, no immediate repeat). The
      // selection stays stable for the whole response (never per chunk) and
      // lives in a module singleton, so it never triggers app-wide renders
      // (PRD §25–§29).
      beginResponseOrb();
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

      // ── BACKGROUND RUN (E2B) ──────────────────────────────────────────
      // When enabled (Settings → "Continue in background") AND an E2B key
      // is configured, the turn executes INSIDE the sandbox as a background
      // command — it keeps working after the browser closes, stops, or
      // minimizes; on return we reconnect and replay the progress. Falls
      // back to the in-browser runtime when the launch fails or no key.
      if (useBackgroundRunStore.getState().enabled) {
        let e2bKey: string | null = null;
        try {
          e2bKey = await getEffectiveE2BKey(userId);
        } catch {
          e2bKey = null;
        }
        if (e2bKey) {
          const handle = await startBackgroundTurn({
            turn: opts,
            e2bApiKey: e2bKey,
            userId,
            conversationId: opts.conversationId,
            emit: handleAgentEvent,
            onFinished: () => {
              setIsProcessing(false);
              abortRef.current = null;
              backgroundHandleRef.current = null;
            },
          });
          if (handle) {
            backgroundHandleRef.current = handle;
            return; // the background job owns this turn now
          }
          // Launch failed — fall through to the in-browser runtime.
        }
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

  /**
   * REGENERATE (PRD §6) — re-run the turn that produced an assistant message.
   *
   * The old implementation just re-sent the user's text via `sendMessage`,
   * which APPENDED a duplicate user bubble + a second response and left the
   * original pair in the thread (and double-persisted the user message in
   * Dexie). This implementation:
   *   1. Guards against a busy agent (no duplicate/queued regenerations).
   *   2. Finds the user prompt that produced the target response.
   *   3. Removes BOTH the assistant response and its user prompt from the
   *      chat store AND from Dexie (ids are the persisted DB ids — the
   *      `user_prompt` / `message_saved` handlers swapped the temp nanoids).
   *   4. Re-runs the turn via doSend with the original content + files, using
   *      the CURRENTLY selected model/provider (buildTurnOptions reads the
   *      authoritative chat-store selection).
   * The streaming UI takes over from there — the thread shows the user
   * message once, followed by the fresh response.
   */
  const regenerate = useCallback(
    (assistantMessageId: string) => {
      if (isProcessing) return; // already generating — ignore (button is also disabled)

      const msgs = useChatStore.getState().messages;
      const idx = msgs.findIndex((m) => m.id === assistantMessageId);
      if (idx < 0) return;

      // Find the user prompt immediately before this assistant response.
      let userIdx = -1;
      for (let i = idx - 1; i >= 0; i--) {
        if (msgs[i]?.role === "user") {
          userIdx = i;
          break;
        }
      }
      if (userIdx < 0) return; // no prompt to re-run — nothing to regenerate from
      const userMsg = msgs[userIdx]!;
      const targetMsg = msgs[idx]!;

      const convId = targetMsg.conversationId ?? conversationId ?? null;
      if (!convId) return; // unsaved chat — nothing persisted to regenerate

      // 1. Drop both messages from the live store (instant visual removal).
      removeMessage(targetMsg.id);
      removeMessage(userMsg.id);

      // 2. Delete both rows (tool calls + ratings cascade) from Dexie so a
      //    reload doesn't resurrect the old pair. Ids are the DB ids; a temp
      //    id (shouldn't happen for completed turns) is skipped — best effort.
      void (async () => {
        try {
          const { conversationService } = await import("@/lib/services");
          if (!targetMsg.isTemporaryId) {
            await conversationService.deleteMessage(convId, targetMsg.id);
          }
          if (!userMsg.isTemporaryId) {
            await conversationService.deleteMessage(convId, userMsg.id);
          }
        } catch (err) {
          // Non-fatal: the store already dropped the pair; the DB copy (if
          // the delete failed) is cleaned up on the next full reload path.
          console.warn("[useChat] regenerate: failed to delete old rows from Dexie", err);
        }
      })();

      // 3. Re-run the turn with the original prompt. doSend re-adds the user
      //    message and the runtime re-persists it — the thread ends up with
      //    exactly ONE user prompt + ONE fresh response.
      void doSend(userMsg.content, userMsg.fileIds, userMsg.files);
    },
    [isProcessing, conversationId, removeMessage, doSend],
  );

  const sendAskUserResponses = useCallback((answers: AskUserAnswer[]) => {
    setPendingQuestions(null);
    respondToAskUser(answers);
  }, []);

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    // BACKGROUND RUN: killing the generation kills the sandbox job (and its
    // poller). Just closing the tab does NOT — the job keeps running on E2B
    // until it finishes or its timeout expires.
    if (backgroundHandleRef.current) {
      const handle = backgroundHandleRef.current;
      backgroundHandleRef.current = null;
      void handle.stop();
    }
    if (currentMessageIdRef.current) {
      const msgId = currentMessageIdRef.current;
      // Mark the message as not streaming + mark ALL tool calls as "stopped"
      // (instead of "running"/"pending") so they don't show spinners forever.
      const msgs = useChatStore.getState().messages;
      const msg = msgs.find((m) => m.id === msgId);
      if (msg?.toolCalls) {
        for (const tc of msg.toolCalls) {
          if (tc.status === "running" || tc.status === "pending") {
            updateToolCallPart(msgId, tc.id, {
              status: "completed" as const,
              result: { stopped: true, message: "Stopped by user" },
            });
          }
        }
      }
      // Also update tool calls inside parts.
      if (msg?.parts) {
        for (const p of msg.parts) {
          if (p.type === "tool" && p.toolCall && (p.toolCall.status === "running" || p.toolCall.status === "pending")) {
            updateToolCallPart(msgId, p.toolCall.id, {
              status: "completed" as const,
              result: { stopped: true, message: "Stopped by user" },
            });
          }
        }
      }
      updateMessage(msgId, (m) => ({ ...m, isStreaming: false }));
    }
    // Flush any pending streaming buffers.
    flushTextDelta();
    setCurrentMessageId(null);
    currentGroupIdRef.current = null;
    // CRITICAL: clear the active generation so any subsequent (stale) events
    // emitted by the old runtime as it unwinds (final_result, message_saved,
    // complete) are dropped instead of corrupting the next turn's message.
    // PRD §19: "A stopped generation cannot modify a subsequent generation."
    activeGenerationIdRef.current = null;
    // Reset message ownership — the next generation must start a new message,
    // never append to the stopped one.
    currentMessageGenerationRef.current = null;
    setIsProcessing(false);
    setPendingQuestions(null);
  }, [updateMessage, setCurrentMessageId, updateToolCallPart, flushTextDelta]);

  // BACKGROUND RUN RESUME: if the active conversation has an unfinished E2B
  // background job (the user closed/stopped/minimized the browser while the
  // agent was working), reconnect and replay what ran while they were away —
  // then keep streaming until the turn finishes. The job itself never paused:
  // it kept executing inside the sandbox the whole time.
  useEffect(() => {
    const turnId = currentConversationIdFromStore ?? conversationId ?? null;
    if (!turnId) return;
    if (!useBackgroundRunStore.getState().enabled) return;
    if (backgroundHandleRef.current) return;
    let cancelled = false;
    void (async () => {
      const userId = useAuthStore.getState().user?.id;
      if (!userId || cancelled) return;
      let e2bKey: string | null = null;
      try {
        e2bKey = await getEffectiveE2BKey(userId);
      } catch {
        return;
      }
      if (!e2bKey || cancelled) return;
      const handle = await resumeBackgroundTurn({
        e2bApiKey: e2bKey,
        userId,
        conversationId: turnId,
        emit: handleAgentEvent,
        onFinished: () => {
          setIsProcessing(false);
          backgroundHandleRef.current = null;
        },
      }).catch(() => null);
      if (cancelled) {
        if (handle) void handle.stop();
        return;
      }
      if (handle) {
        backgroundHandleRef.current = handle;
        setIsProcessing(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentConversationIdFromStore, conversationId, handleAgentEvent]);

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
    regenerate,
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
    pendingQuestions,
    sendAskUserResponses,
    /** Rate-limit backoff status (PRD §7) — non-null while retrying. */
    rateLimitStatus,
    // Todo tool: live plan panel control (local-only)
    sendTodoAction,
  };
}
