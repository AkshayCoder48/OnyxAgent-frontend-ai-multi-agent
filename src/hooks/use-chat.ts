"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import type { AgentTurnOptions } from "@/lib/agent/runtime";
import { respondToAskUser } from "@/lib/agent/runtime";
import { aiProviderService, settingsService } from "@/lib/services";
import { getEffectiveE2BKey } from "@/lib/e2b/env-key";
import { useChatStore, useAuthStore } from "@/stores";
import type {
  AskUserAnswer,
  AskUserQuestion,
  ChatMessageFile,
} from "@/types";
import { restoreTodos } from "@/lib/tools/todos";
import { useConversationStore, useResearchStore } from "@/stores";
import { useBackgroundRunStore } from "@/stores/background-run-store";
import { startBackgroundTurn } from "@/lib/agent/background-turn";
import {
  executionHub,
  useExecutionById,
  useExecutionFor,
  useExecutionMessages,
  useExecutionChatValue,
  type ExecutionRecord,
} from "@/lib/agent/execution-hub";
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
// FUNCTION-CALLING API (not text) to invoke tools (see the original long
// comment in git history).
// Beta V1.2 — mandatory web research + inline citations. Appended to every
// turn's system prompt so the agent ALWAYS grounds factual answers in a live
// web search and cites sources with [n] markers.
const WEB_RESEARCH_DIRECTIVE = `## Web Research & Citations (MANDATORY)
- For EVERY user message that involves facts, current events, technology, documentation, versions, prices, names, or anything verifiable, you MUST call the web_search tool BEFORE answering. NEVER answer such questions purely from memory — search first, then answer from the results.
- The web_search results are NUMBERED (1, 2, 3 …). Cite them inline in your answer with bracket markers like [1] or [2], placed immediately after the claim they support. Example: "Transformers scale well with data and compute[1], though attention is quadratic[2]."
- Every non-trivial factual claim in your answer should carry at least one [n] citation marker. Never invent citation numbers — only cite numbers that exist in the search results you received.
- Use web_fetch to deep-read a promising result when a short snippet is not enough.
- Purely creative tasks (write a story, refactor this file) do not need citations — but anything you state as fact does.`;

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
- Collaborate effectively by sharing context
- Deliver structured, actionable outputs`,
  openai_assistants: `You are an OpenAI Assistant with access to tools. Follow OpenAI Assistants API conventions:
- Use FUNCTION CALLING to interact with available tools. NEVER write tool calls as text.
- Provide clear, helpful responses
- When tools return results, analyze them and continue the conversation
- Be concise but thorough
- Use markdown formatting for readability`,
};

/**
 * Backendless chat hook — now a thin adapter over the ExecutionHub.
 *
 * ARCHITECTURE (the "navigation never aborts" contract):
 *   - The HUB (module singleton) owns every agent execution: its headless
 *     message store, its event processor, its E2B background consumer / fg
 *     fetch. Executions survive component unmounts, chat switches, route
 *     changes and settings navigation — only the explicit Stop button
 *     cancels one.
 *   - This hook SUBSCRIBES to the execution for the conversation the user
 *     is viewing (creating executions on send, resuming persisted E2B jobs
 *     on mount). Unmounting merely unsubscribes the UI.
 *   - `messages` is the merged view: the live execution's store when one
 *     exists, otherwise the global chat store (DB-painted history).
 */
export function useChat(options: UseChatOptions = {}) {
  const { conversationId, onConversationCreated } = options;
  const { currentConversationId: currentConversationIdFromStore } =
    useConversationStore();
  const { clearMessages } = useChatStore();
  const { setCurrentTurnId: setCurrentTodoTurnId, reset: resetTodoTurn } = useResearchStore();

  // The execution this hook STARTED (new-chat turns run before the
  // conversation exists — the registry can't key them yet).
  const activeExecIdRef = useRef<string | null>(null);
  const [activeExecId, setActiveExecId] = useState<string | null>(null);

  // ── EXECUTION SUBSCRIPTION ─────────────────────────────────────────────
  const convExec = useExecutionFor(currentConversationIdFromStore ?? conversationId ?? null);
  const activeExec = useExecutionById(activeExecId);
  const execSummary = convExec ?? activeExec;
  const messages = useExecutionMessages(execSummary?.id ?? null);
  const execPendingQuestions = useExecutionChatValue<AskUserQuestion[] | null>(
    execSummary?.id ?? null,
    (s) => s.pendingQuestions,
    null,
  );
  const execRateLimitStatus = useExecutionChatValue<string | null>(
    execSummary?.id ?? null,
    (s) => s.rateLimitStatus,
    null,
  );
  const execProcessing = useExecutionChatValue<boolean>(
    execSummary?.id ?? null,
    (s) => s.isProcessing,
    false,
  );
  const isProcessing = execSummary?.status === "running" && execProcessing;

  // Outbound queue: messages typed while a turn is in flight. Held here (not
  // in the chat history) so the UI can surface them as cancellable "pending"
  // entries above the input.
  const messageQueueRef = useRef<QueuedMessage[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const modelRef = useRef<string | null>(null);
  const providerIdRef = useRef<string | null>(null);
  const temperatureRef = useRef<number | null>(null);
  const thinkingEffortRef = useRef<"low" | "medium" | "high" | null>(null);

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

  // Tell the hub which conversation this UI is viewing (persist-snapshot
  // gate + finish-time sync-back target).
  useEffect(() => {
    executionHub.setViewed(currentConversationIdFromStore ?? conversationId ?? null);
    return () => {
      executionHub.setViewed(null);
    };
  }, [currentConversationIdFromStore, conversationId]);

  // Clear the local active-execution pointer once the execution ends (the
  // registry keeps the terminal summary until unregister).
  useEffect(() => {
    if (activeExecId && execSummary && execSummary.id === activeExecId && execSummary.status !== "running") {
      activeExecIdRef.current = null;
      setActiveExecId(null);
    }
  }, [activeExecId, execSummary]);

  /**
   * Load the provider config + system prompt for the current user. Called
   * fresh from `doSend` so model/provider overrides picked up via the
   * setters are honored.
   */
  const buildTurnOptions = useCallback(
    async (
      userId: string,
      message: string,
      fileIds?: string[],
      emit?: (event: import("@/types").WSEvent) => void,
    ): Promise<AgentTurnOptions | null> => {
      // Provider: explicit override (providerIdRef) → first active provider.
      let providers = await aiProviderService.list(userId, true);
      // If no providers found for this user ID (non-auth migration), load ALL
      if (providers.length === 0) {
        const { db } = await import("@/lib/db");
        providers = await db.ai_providers.toArray();
      }
      if (providers.length === 0) {
        emit?.({
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
        emit?.({ type: "error", data: { message: "Selected AI provider not found." } });
        return null;
      }
      const apiKey = await aiProviderService.getDecryptedApiKey(selectedProvider.id);
      const model = modelOverride ?? selectedProvider.models[0] ?? "";

      // Dev instrumentation (PRD §15).
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
      const basePrompt =
        (settings.system_prompt_enabled && settings.system_prompt
          ? settings.system_prompt
          : frameworkPrompt) ?? "";
      const systemPrompt = basePrompt.trim()
        ? `${basePrompt.trim()}\n\n${WEB_RESEARCH_DIRECTIVE}`
        : WEB_RESEARCH_DIRECTIVE;

      return {
        userId,
        conversationId: currentConversationIdFromStore ?? conversationId ?? null,
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
          disabledParams: (selectedProvider as { disabled_params?: string[] }).disabled_params ?? [],
        },
        systemPrompt,
        temperature: temperatureRef.current,
        thinkingEffort: thinkingEffortRef.current,
        emit: emit ?? (() => {}),
      };
    },
    [conversationId, currentConversationIdFromStore],
  );

  const doSend = useCallback(
    async (content: string, fileIds?: string[], files?: ChatMessageFile[]) => {
      const userId = useAuthStore.getState().user?.id;
      if (!userId) {
        console.warn("[useChat] sendMessage called without an authenticated user.");
        return;
      }

      // ── CREATE THE EXECUTION FIRST ─────────────────────────────────────
      // The hub owns it from here on: its headless store carries the
      // optimistic user message + every agent event, its consumer/checkpoint
      // loop keeps running no matter where the user navigates. This hook
      // merely subscribes (already done via execSummary above).
      const convId = currentConversationIdFromStore ?? conversationId ?? null;
      const wantBackground = useBackgroundRunStore.getState().enabled;
      const execution: ExecutionRecord = executionHub.createExecution({
        conversationId: convId,
        mode: wantBackground ? "background" : "foreground",
        // New-chat turns: the runtime creates the conversation mid-turn —
        // notify the host (sidebar refresh) alongside the hub's re-key.
        onConversationCreated,
      });
      activeExecIdRef.current = execution.id;
      setActiveExecId(execution.id);

      const userMessageId = nanoid();
      execution.processor.setUserMessageId(userMessageId);
      // A new AI response is starting with this user message — pick this
      // response's random orb ONCE (25 variants, no immediate repeat).
      beginResponseOrb();
      execution.store.getState().addMessage({
        id: userMessageId,
        role: "user",
        content,
        timestamp: new Date(),
        conversationId: convId || undefined,
        fileIds,
        files,
      });

      // Upload attached files to the E2B sandbox if cloud mode is active.
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
            void (async () => {
              for (const fid of fileIds) {
                try {
                  const blob = await readFileBytes(fid);
                  if (blob) {
                    const file = new File([blob], files?.find((f) => f.id === fid)?.filename ?? fid, {
                      type: files?.find((f) => f.id === fid)?.mime_type,
                    });
                    await uploadFileToSandbox(file, sandboxKey, convId, sandboxMode);
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

      // Build the runtime options (loads provider + system prompt). The
      // execution's processor is the emit pipeline; its abort controller is
      // the turn's signal (fg) — both owned by the hub, both surviving
      // navigation.
      //
      // INVISIBLE FILE TAG: when files are attached, append a hidden tag to
      // the message sent to the AI so it knows what files were uploaded and
      // can check the workspace. This tag is NOT shown in the UI.
      let aiContent = content;
      if (files && files.length > 0) {
        const fileTags = files
          .map((f) => `<@${f.filename} is uploaded check the workspace>`)
          .join(" ");
        aiContent = `${content}\n\n${fileTags}`;
      }
      const opts = await buildTurnOptions(userId, aiContent, fileIds, execution.processor.handle);
      if (!opts) {
        executionHub.finishExecution(execution.id, "failed");
        return;
      }

      // ── BACKGROUND RUN (E2B) ──────────────────────────────────────────
      // When enabled AND an E2B key is configured, the turn executes INSIDE
      // the sandbox as a background command — it keeps working after the
      // browser closes, stops, minimizes, or the user navigates anywhere in
      // the app; on return we re-subscribe and the missed events are already
      // in the execution store. Falls back to the in-browser runtime when
      // the launch fails or no key.
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
            emit: execution.processor.handle,
            onFinished: () => {
              // Last-resort safety net — the terminal events (done/error)
              // route through the processor and finish the execution with
              // the correct status. If none arrived, close it out.
              executionHub.finishExecution(execution.id, "failed");
            },
            store: execution.store,
          });
          if (handle) {
            executionHub.registerBackgroundHandle(
              execution.id,
              handle,
              (handle as { sandboxId?: string }).sandboxId,
            );
            return; // the background job owns this turn now
          }
          // Launch failed — fall through to the in-browser runtime.
          executionHub.patchMode(execution.id, "foreground");
        }
      }

      // Foreground: the fetch lives in the browser page, owned by the hub.
      // It survives route changes/chat switches (nothing aborts it); it ends
      // on completion or explicit Stop. (Browser refresh closes fg turns —
      // background mode is the durable path and is on by default.)
      executionHub.runForeground(execution.id, opts);
    },
    [buildTurnOptions, conversationId, currentConversationIdFromStore, onConversationCreated],
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
   * Blocked while an execution is live (same as before); reads the merged
   * message view (execution store or global store — same content either way).
   */
  const regenerate = useCallback(
    (assistantMessageId: string) => {
      if (isProcessing) return;

      const msgs = messages;
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
      if (userIdx < 0) return;
      const userMsg = msgs[userIdx]!;
      const targetMsg = msgs[idx]!;

      const convId = targetMsg.conversationId ?? conversationId ?? null;
      if (!convId) return;

      // 1. Drop both messages from the live store (the global store — no
      //    execution is live here) + 2. delete both rows from Dexie.
      const global = useChatStore.getState();
      global.removeMessage(targetMsg.id);
      global.removeMessage(userMsg.id);
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
          console.warn("[useChat] regenerate: failed to delete old rows from Dexie", err);
        }
      })();

      // 3. Re-run the turn with the original prompt.
      void doSend(userMsg.content, userMsg.fileIds, userMsg.files);
    },
    [isProcessing, messages, conversationId, doSend],
  );

  const sendAskUserResponses = useCallback((answers: AskUserAnswer[]) => {
    // Optimistically hide the panel, then unblock the runtime's wait.
    const convId = useConversationStore.getState().currentConversationId;
    const summary = convId ? executionHub.getFor(convId) : null;
    if (summary) {
      executionHub.getStore(summary.id)?.getState().setPendingQuestions(null);
    } else {
      // No live execution (legacy path) — nothing to clear visually.
    }
    respondToAskUser(answers);
  }, []);

  // ── STOP (explicit user action ONLY) ───────────────────────────────────
  const stopGeneration = useCallback(() => {
    const convId = currentConversationIdFromStore ?? conversationId ?? null;
    // 1. The execution this hook started (new-chat turns may not be keyed
    //    in the registry yet). 2. Otherwise whatever runs for the viewed
    //    conversation. Both routes kill the fg fetch AND the E2B job.
    const activeId = activeExecIdRef.current;
    if (activeId) {
      activeExecIdRef.current = null;
      setActiveExecId(null);
      executionHub.stopExecution(activeId);
    } else {
      executionHub.stopFor(convId);
    }
  }, [conversationId, currentConversationIdFromStore]);

  // ── RESUME (reload / re-entry into a conversation with a live E2B job) ──
  // Idempotent: the hub guards against double-resume; if an execution is
  // already registered for the conversation we simply re-subscribe (the
  // execSummary above). Navigating away NEVER stops it.
  useEffect(() => {
    const turnId = currentConversationIdFromStore ?? conversationId ?? null;
    if (!turnId) return;
    if (!useBackgroundRunStore.getState().enabled) return;
    if (executionHub.getFor(turnId)) return;
    void (async () => {
      const userId = useAuthStore.getState().user?.id;
      if (!userId) return;
      let e2bKey: string | null = null;
      try {
        e2bKey = await getEffectiveE2BKey(userId);
      } catch {
        return;
      }
      if (!e2bKey) return;
      await executionHub.ensureResumed(turnId, userId, e2bKey).catch(() => null);
    })();
  }, [currentConversationIdFromStore, conversationId]);

  /**
   * Local-only todo action controls (unchanged).
   */
  const sendTodoAction = useCallback(
    (action: "dismiss" | "reset" | "snapshot") => {
      if (action === "dismiss") useResearchStore.getState().dismiss();
      if (action === "reset") {
        const turnId = useResearchStore.getState().currentTurnId ?? "default";
        useResearchStore.getState().reset(turnId);
      }
    },
    [],
  );

  // Stable setters for model / provider / temperature / thinking effort.
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

  // Drain message queue when processing finishes. Re-runs on the
  // isProcessing flip so a busy turn ending → drains the next one.
  useEffect(() => {
    if (!isProcessing && messageQueueRef.current.length > 0) {
      const next = messageQueueRef.current.shift();
      setQueuedMessages([...messageQueueRef.current]);
      if (next) {
        setTimeout(() => void doSend(next.content, next.fileIds, next.files), 100);
      }
    }
  }, [isProcessing, doSend]);

  // NOTE: there is deliberately NO unmount abort. The execution is owned by
  // the module-level hub — unmounting this hook only unsubscribes the UI.
  // Route changes, chat switches and settings navigation never cancel a
  // running agent (spec §7/§29/§30). The ONLY cancellation path is
  // stopGeneration → executionHub.stopExecution.

  const connect = useCallback(() => {}, []);
  const disconnect = useCallback(() => {}, []);

  return {
    messages,
    isConnected: true,
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
    pendingQuestions: execPendingQuestions,
    sendAskUserResponses,
    /** Rate-limit backoff status (PRD §7) — non-null while retrying. */
    rateLimitStatus: execRateLimitStatus,
    // Todo tool: live plan panel control (local-only)
    sendTodoAction,
  };
}
