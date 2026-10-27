"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import type { AgentTurnOptions } from "@/lib/agent/runtime";
import { respondToAskUser } from "@/lib/agent/runtime";
import { aiProviderService, conversationService, settingsService } from "@/lib/services";
import { stripUploadTags } from "@/lib/uploads/registry";
import { useChatStore, useAuthStore } from "@/stores";
import type {
  AskUserAnswer,
  AskUserQuestion,
  ChatMessage,
  ChatMessageFile,
} from "@/types";
import { restoreTodos } from "@/lib/tools/todos";
import { useConversationStore, useResearchStore } from "@/stores";
import { useDetachedRunStore } from "@/stores/detached-run-store";
import {
  AUTO_ROUTER_PROVIDER_ID,
  type RouterCandidate,
} from "@/lib/auto-router";
import { notifyConversationsChanged } from "@/lib/chat-events";
import {
  executionHub,
  useExecutionById,
  useExecutionFor,
  useExecutionMessages,
  useExecutionChatValue,
  type ExecutionRecord,
} from "@/lib/agent/execution-hub";
import {
  registerTurnHandoff,
  pruneFinishedTurnHandoffs,
} from "@/lib/agent/turn-handoff";
import {
  clearChatHandoffMeta,
  cloudHandoffActive,
  readCloudHandoffMeta,
} from "@/lib/agent/turn-cloud-handoff";
import { chatCompletionsUrl, listUsableProviders, resolveProviderForModel } from "@/lib/agent/provider-resolution";

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

// The system-prompt base for every turn: the Onyx AI framework prompt.
// Onyx AI is OnyxAgent's native agent framework — and the ONLY framework;
// there is no framework selection anymore, so this preset is always used
// unless the user enables a custom system-prompt override in settings.
//
// CRITICAL: the prompt MUST instruct the AI to use the FUNCTION-CALLING
// API (not text) to invoke tools (see the original long comment in git
// history).
// Beta V1.2 — mandatory web research + inline citations. Appended to every
// turn's system prompt so the agent ALWAYS grounds factual answers in a live
// web search and cites sources with [n] markers.
const WEB_RESEARCH_DIRECTIVE = `## Web Research & Citations (MANDATORY)
- For EVERY user message that involves facts, current events, technology, documentation, versions, prices, names, or anything verifiable, you MUST call the web_search tool BEFORE answering. NEVER answer such questions purely from memory — search first, then answer from the results.
- The web_search results are NUMBERED (1, 2, 3 …). Cite them inline in your answer with bracket markers like [1] or [2], placed immediately after the claim they support. Example: "Transformers scale well with data and compute[1], though attention is quadratic[2]."
- Every non-trivial factual claim in your answer should carry at least one [n] citation marker. Never invent citation numbers — only cite numbers that exist in the search results you received.
- Use web_fetch to deep-read a promising result when a short snippet is not enough.
- Purely creative tasks (write a story, refactor this file) do not need citations — but anything you state as fact does.`;

// Onyx AI — OnyxAgent's native agent framework (renamed from the legacy
// "pydantic_ai" option; stored values are normalized on read). This is THE
// framework prompt: Onyx AI is the only framework the app uses.
// EXPORTED for the Settings → Agent Settings system-prompt editor (the
// "Insert default" button seeds the textarea with the baseline so users can
// customize FROM it instead of from a blank page).
export const ONYX_AI_SYSTEM_PROMPT = `You are an AI agent built with Onyx AI — OnyxAgent's native agent framework. You have access to tools that you can call to help the user.
Follow Onyx AI conventions:
- Call tools using the FUNCTION-CALLING API when they would help answer the user's request. NEVER write tool calls as text (e.g. "Action: run_terminal Input: {...}"). ALWAYS use the tool-calling mechanism.
- Structure your responses clearly with markdown
- When using tools, explain what you're doing briefly
- Handle errors gracefully and suggest alternatives
- Be precise and type-safe in your reasoning`;

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
 *     is viewing (creating executions on send). Unmounting merely
 *     unsubscribes the UI.
 *   - `messages` is the merged view: the live execution's store when one
 *     exists, otherwise the global chat store (DB-painted history).
 */
export function useChat(options: UseChatOptions = {}) {
  const { conversationId, onConversationCreated } = options;
  // SELECTOR-BASED SUBSCRIPTIONS (render isolation): the previous
  // no-selector destructure re-rendered every useChat consumer on ANY chat/
  // conversation store field change. Only the exact fields read here are
  // subscribed; actions are stable store references (never re-render).
  const currentConversationIdFromStore =
    useConversationStore((s) => s.currentConversationId);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const setCurrentTodoTurnId = useResearchStore((s) => s.setCurrentTurnId);
  const resetTodoTurn = useResearchStore((s) => s.reset);

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

  // STABLE MERGED MESSAGE READER (streaming-perf PRD): regenerate /
  // editUserMessage previously closed over `messages` in their deps — every
  // store flush (~30–60×/sec while streaming) gave the callbacks NEW
  // identities, cascading through ChatContainer → MessageItem props and
  // defeating MessageItem's React.memo for EVERY message in the list (the
  // dominant streaming lag on long threads). Both callbacks only ever run
  // on a user click (and are blocked while a turn is live), so reading the
  // store imperatively at call time is equally fresh — while the callback
  // identity stays stable across every flush.
  const execIdForMerged = execSummary?.id ?? null;
  const getMergedMessages = useCallback((): ChatMessage[] => {
    const execStore = execIdForMerged ? executionHub.getStore(execIdForMerged) : null;
    if (execStore) return execStore.getState().messages;
    return useChatStore.getState().messages;
  }, [execIdForMerged]);

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
      // Provider resolution — the SAME shared contract as Business Mode
      // (resolveBusinessLlmConfig) and subagents (resolveApiConfig), via
      // lib/agent/provider-resolution (endpoint-migration PRD §2/§8):
      //
      //   LEGACY-CLASSIC GUARD — stale text.pollinations.ai (Classic) rows
      //   self-heal (repoint-to-gen / delete) and are NEVER returned, so the
      //   retired Classic endpoint — which answers the "…isn't on the
      //   Classic API" 404 for gen-catalog models — is unreachable from the
      //   main chat too, not just Business Mode.
      //
      //   MODEL-FIRST — the chat store's selectedModel resolves together
      //   with the provider that OFFERS it; a stale selectedProviderId
      //   pointing at a deleted/legacy row can never send the selected
      //   model to a gateway that doesn't serve it. (The model picker sets
      //   model + owning provider atomically, so the two only diverge when
      //   the provider row went stale — exactly the case model-first
      //   recovers.)
      //
      // NOTE (stale "OnyxAI" ghost fix): no load-ALL fallback. The old
      // `db.ai_providers.toArray()` fallback pulled rows belonging to OTHER
      // (obsolete/transient) user ids — deleted legacy seed rows could ride
      // a turn on the wrong provider. An honest empty list errors below.
      const providers = await listUsableProviders(userId);
      if (providers.length === 0) {
        // (The emitted error event is mirrored into the Logs store by the
        // event processor — no double-logging here.)
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

      // ── AUTO ROUTER ────────────────────────────────────────────────────
      // The routing sentinel (picked in the model popover when >1 provider
      // exists) means "route EVERY round across all eligible providers"
      // instead of resolving one. Candidates = every ACTIVE provider with at
      // least one model + an API key, ONE candidate per provider (its first
      // model — bounded by design so routing stays cheap + comparable).
      // With ≤1 usable candidate the router degrades to the normal
      // single-provider path below (providers[0] IS that candidate).
      // NOTE (background turns): they are router-unaware — they resolve
      // opts.provider ONCE at turn start, so an auto-router background turn
      // runs entirely on the first candidate. Accepted limitation (the
      // per-round routing lives in the foreground runtime, runtime.ts).
      let routerCandidates: RouterCandidate[] | null = null;
      if (providerOverrideId === AUTO_ROUTER_PROVIDER_ID) {
        const candidates: RouterCandidate[] = [];
        for (const row of providers) {
          // ACTIVE rows only — listUsableProviders returns active + inactive
          // (the guard's contract); routing stays on providers the user
          // hasn't disabled.
          if (!row.is_active) continue;
          const firstModel = row.models?.[0];
          if (!firstModel || !row.api_key_encrypted) continue;
          try {
            const apiKey = await aiProviderService.getDecryptedApiKey(row.id);
            if (!apiKey) continue;
            candidates.push({
              key: row.id,
              model: firstModel,
              label: row.name,
              provider: {
                baseUrl: row.base_url,
                apiKey,
                model: firstModel,
                modelType: row.model_type,
                toolsEnabled: row.tools_enabled,
                noPrefix: (row as { no_prefix?: boolean }).no_prefix ?? false,
                thinkingEnabled:
                  (row as { thinking_enabled?: boolean }).thinking_enabled ?? false,
                disabledParams:
                  (row as { disabled_params?: string[] }).disabled_params ?? [],
              },
            });
          } catch {
            // Key decryption failed for THIS provider — skip it; its
            // siblings still route.
          }
        }
        if (candidates.length > 1) routerCandidates = candidates;
      }

      // Resolution chain (first match wins — mirrors subagent-runtime's
      // resolveApiConfig):
      //   1. MODEL-FIRST — the selected model with the provider that OWNS it
      //      (active preferred; inactive still matches when the model lives
      //      only there).
      //   2. the chat store's selectedProviderId (no model picked).
      //   3. first ACTIVE provider → providers[0] (the previous
      //      activeOnly=list semantics).
      const selectedProvider =
        resolveProviderForModel(providers, modelOverride) ??
        (providerOverrideId != null
          ? providers.find((p) => p.id === providerOverrideId)
          : undefined) ??
        providers.find((p) => p.is_active) ??
        providers[0];
      if (!selectedProvider) {
        emit?.({ type: "error", data: { message: "Selected AI provider not found." } });
        return null;
      }
      const apiKey = await aiProviderService.getDecryptedApiKey(selectedProvider.id);
      // Orphaned-selection recovery (shared contract): adopt the selected
      // model only when the resolved provider OFFERS it — a model id whose
      // provider was deleted/re-synced away falls to the provider's first
      // model instead of a guaranteed-404 id. When the provider lists NO
      // models, the explicit pick stays (best guess — never a hardcoded
      // fallback model; endpoint-migration PRD §4).
      let model = modelOverride ?? "";
      if (model && !(selectedProvider.models ?? []).includes(model)) {
        model = selectedProvider.models?.[0] ?? model;
      }
      if (!model) model = selectedProvider.models?.[0] ?? "";

      // Dev instrumentation (PRD §15).
      if (process.env.NODE_ENV !== "production") {
        console.debug(
          `[useChat] turn provider=${selectedProvider.name} model=${model || "(provider default)"}`,
        );
        if (routerCandidates) {
          console.debug(
            `[useChat] auto-router active: ${routerCandidates.length} candidates — ${routerCandidates
              .map((c) => `${c.label}:${c.model}`)
              .join(" | ")}`,
          );
        }
      }

      // Load user settings (system prompt, auto-approve, etc.)
      const settings = await settingsService.get(userId);

      // System prompt: user override (if enabled) → Onyx AI framework prompt
      // (Onyx AI is the only framework — no selection anymore).
      const basePrompt =
        (settings.system_prompt_enabled && settings.system_prompt
          ? settings.system_prompt
          : ONYX_AI_SYSTEM_PROMPT) ?? "";
      const parts = [basePrompt.trim()];
      if (basePrompt.trim()) parts.push(WEB_RESEARCH_DIRECTIVE);
      const systemPrompt = parts.filter(Boolean).join("\n\n");

      // ── PROJECT CONTEXT INJECTION (Task 2-d / PRD §7.1+§7.3) ──────────
      // For PROJECT conversations ONLY, append the project context package
      // (name/goal/instructions + budgeted memory + cross-chat retrieval)
      // built by buildProjectContextPackage. General chats are unchanged.
      // Best-effort: a retrieval failure must never block the turn. The
      // projectId hint covers the FIRST turn of a brand-new project chat
      // (its conversation row is created mid-turn, after this point).
      let finalSystemPrompt = systemPrompt;
      try {
        const { buildProjectContextPackage } = await import(
          "@/lib/projects/context-package"
        );
        const { useProjectsStore } = await import("@/lib/projects/store");
        const convId = currentConversationIdFromStore ?? conversationId ?? null;
        const activeProjectId = useProjectsStore.getState().activeProjectId;
        const contextPackage = await buildProjectContextPackage(
          convId,
          message,
          activeProjectId ? { projectId: activeProjectId } : {},
        );
        if (contextPackage) {
          finalSystemPrompt = `${systemPrompt}\n\n${contextPackage}`;
        }
      } catch {
        // best-effort — the base system prompt still ships
      }

      return {
        userId,
        conversationId: currentConversationIdFromStore ?? conversationId ?? null,
        userMessage: message,
        fileIds,
        // AUTO ROUTER: when candidates exist, the fallback `provider` IS the
        // first candidate (same config object) so router-unaware code paths
        // (background turns) and the non-routing degenerate case behave
        // identically; the runtime re-picks per round from
        // `providerCandidates`.
        provider: routerCandidates
          ? routerCandidates[0]!.provider
          : {
              baseUrl: selectedProvider.base_url,
              apiKey,
              model,
              modelType: selectedProvider.model_type,
              toolsEnabled: selectedProvider.tools_enabled,
              noPrefix: (selectedProvider as { no_prefix?: boolean }).no_prefix ?? false,
              thinkingEnabled:
                (selectedProvider as { thinking_enabled?: boolean }).thinking_enabled ?? false,
              disabledParams:
                (selectedProvider as { disabled_params?: string[] }).disabled_params ?? [],
            },
        ...(routerCandidates ? { providerCandidates: routerCandidates } : {}),
        systemPrompt: finalSystemPrompt,
        temperature: temperatureRef.current,
        thinkingEffort: thinkingEffortRef.current,
        emit: emit ?? (() => {}),
      };
    },
    [conversationId, currentConversationIdFromStore],
  );

  /**
   * BACKGROUND CLOUD TURN ("close and resume") — the Trigger.dev Cloud
   * variant of doSend's tail (USER DIRECTIVE: background work runs on
   * Trigger.dev Cloud, NOT in the E2B sandbox). Instead of running the
   * in-browser agent loop (which dies with the tab), this persists the user
   * message and dispatches the prompt + history + provider config to the
   * operator's trigger.dev Cloud project as a durable agent_run — reload,
   * close and navigate cannot touch it. The finished result lands directly
   * in this chat's bubbles (the invisible background lander syncs it).
   */
  const runDetachedTurn = useCallback(
    async (
      userId: string,
      convId: string,
      execution: ExecutionRecord,
      opts: AgentTurnOptions,
      fileIds?: string[],
    ) => {
      const { toast } = await import("sonner");
      const failTurn = (message: string) => {
        execution.processor.handle({ type: "error", data: { message } });
        executionHub.finishExecution(execution.id, "failed");
      };

      // Background turns run EXCLUSIVELY on Trigger.dev Cloud now — the
      // legacy E2B headless-runner lane was removed (user directive).
      if (!cloudHandoffActive()) {
        failTurn(
          "Background runs need a connected Trigger.dev Cloud key — add one in Settings → Config (the turn was not sent).",
        );
        return;
      }

      try {
        await conversationService.addMessage(convId, userId, {
          role: "user",
          content: opts.userMessage,
          fileIds,
        });
      } catch (err) {
        console.warn("[useChat] background dispatch: failed to persist the user message", err);
      }

      try {
        const { dispatchDetachedCloudTurn } = await import(
          "@/lib/agent/turn-cloud-handoff"
        );
        // CONFIG PROPAGATION (endpoint-migration PRD §9): the background
        // lane receives the SAME effective configuration the foreground
        // turn resolved — the selected provider's gateway URL, its key and
        // the selected model. Previously this pinned `chatUrl: ""`, which
        // silently rerouted every background chat turn onto the app's
        // keyless bridge model instead of the user's selected provider+model.
        // The bridge remains only as the documented fallback when no
        // provider gateway exists (empty base URL).
        const provider = opts.provider;
        await dispatchDetachedCloudTurn({
          userId,
          conversationId: convId,
          prompt: opts.userMessage,
          systemPrompt: opts.systemPrompt ?? "",
          chatUrl: provider.baseUrl
            ? chatCompletionsUrl(provider.baseUrl, provider.noPrefix)
            : "",
          apiKey: provider.apiKey,
          model: provider.model,
          temperature: opts.temperature ?? null,
          preferredProviderId: useChatStore.getState().selectedProviderId,
          title: opts.userMessage.replace(/\s+/g, " ").trim().slice(0, 60) || undefined,
        });
        toast.success("Running in the background", {
          description: "This turn is executing on Trigger.dev Cloud — the finished result will land in this chat. You can close the app.",
        });
        // The turn is the cloud's problem now — free the composer; the
        // invisible lander streams the result back into this chat.
        executionHub.finishExecution(execution.id, "completed");
      } catch (err) {
        failTurn(
          `Failed to start the background cloud run: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    [],
  );

  const doSend = useCallback(
    async (content: string, fileIds?: string[], files?: ChatMessageFile[]) => {
      const userId = useAuthStore.getState().user?.id;
      if (!userId) {
        console.warn("[useChat] sendMessage called without an authenticated user.");
        return;
      }

      // ── /image — DIRECT IMAGE GENERATION (no text-LLM round-trip) ──────
      // `/image <prompt>` (alias `/img`) bypasses the agent runtime entirely:
      // the prompt goes straight to the Pollinations image endpoint through
      // the same two-step confirmation + /api/pollinations/generate choke-
      // point the media_generation tool uses. Nothing is sent to the chat
      // model, so it works even when no text provider is reachable.
      const imageMatch = content.match(/^\/(?:image|img)\s+([\s\S]+?)\s*$/i);
      if (imageMatch) {
        const { runDirectImageTurn } = await import("@/lib/agent/direct-image-turn");
        await runDirectImageTurn({
          userId,
          prompt: imageMatch[1]!,
          conversationId: currentConversationIdFromStore ?? conversationId ?? null,
          onConversationCreated,
        });
        return;
      }

      // TAG NORMALIZATION (File Persistence PRD §29): a regenerate-after-
      // refresh re-sends a message whose content may still carry the hidden
      // upload tags. Strip them up front — the fresh tags are appended below
      // exactly once, so a turn can never accumulate duplicate tags.
      content = stripUploadTags(content) || content.trim();

      // ── CREATE THE EXECUTION FIRST ─────────────────────────────────────
      // The hub owns it from here on: its headless store carries the
      // optimistic user message + every agent event, its consumer/checkpoint
      // loop keeps running no matter where the user navigates. This hook
      // merely subscribes (already done via execSummary above).
      let convId = currentConversationIdFromStore ?? conversationId ?? null;
      const execution: ExecutionRecord = executionHub.createExecution({
        conversationId: convId,
        mode: "foreground",
        // New-chat turns: the runtime creates the conversation mid-turn —
        // notify the host (sidebar refresh) alongside the hub's re-key.
        onConversationCreated,
      });
      activeExecIdRef.current = execution.id;
      setActiveExecId(execution.id);

      const userMessageId = nanoid();
      execution.processor.setUserMessageId(userMessageId);
      execution.store.getState().addMessage({
        id: userMessageId,
        role: "user",
        content,
        timestamp: new Date(),
        conversationId: convId || undefined,
        fileIds,
        files,
      });

      // Mirror attached files into the E2B sandbox (best-effort, when a key
      // exists) so the sandbox-native tools (list_folder / read_file) see
      // them at uploads/<name>. Binary-safe (base64 over batch_write_bytes) —
      // the old text() path corrupted binaries. The CANONICAL AI access path
      // is the uploads registry (read_uploaded_file), which works even
      // without a sandbox.
      if (fileIds && fileIds.length > 0) {
        try {
          const sandboxKey = await settingsService.getDecryptedSandboxKey(userId);
          if (sandboxKey) {
            const { getUpload, mirrorUploadToSandbox } = await import("@/lib/uploads/registry");
            // Fire-and-forget — don't block the chat turn on the mirror.
            void (async () => {
              for (const fid of fileIds) {
                try {
                  const record = await getUpload(fid, userId);
                  if (record) await mirrorUploadToSandbox(record, sandboxKey);
                } catch (err) {
                  console.warn("[useChat] sandbox mirror failed for", fid, err);
                }
              }
            })();
          }
        } catch (err) {
          console.warn("[useChat] failed to check sandbox key for upload mirror:", err);
        }
      }

      // Build the runtime options (loads provider + system prompt). The
      // execution's processor is the emit pipeline; its abort controller is
      // the turn's signal (fg) — both owned by the hub, both surviving
      // navigation.
      //
      // STRUCTURED HIDDEN FILE TAG (File Persistence PRD §7): attached files
      // ride along as machine-readable `<user_uploaded_file file_id="…"
      // name="…" …/>` tags. The tag references the persistent registry record
      // (stable fileId) so the AI can read the file with read_uploaded_file
      // and the renderer reconstructs the attachment chip after a refresh.
      // The tag is NEVER shown to the user (message-item strips it).
      let aiContent = content;
      if (files && files.length > 0) {
        const { buildUploadTags } = await import("@/lib/uploads/registry");
        aiContent = `${content}\n\n${buildUploadTags(files)}`;
      }
      const opts = await buildTurnOptions(userId, aiContent, fileIds, execution.processor.handle);
      if (!opts) {
        executionHub.finishExecution(execution.id, "failed");
        return;
      }
      // ONE generation identity for the whole turn — the runtime adopts it
      // (opts.generationId) so the early `model_request_start` below (fired
      // during the naming call) and the runtime's own events share a
      // generation and reuse the SAME placeholder assistant message.
      const turnGenerationId = nanoid();
      opts.generationId = turnGenerationId;

      // ── DETACHED SANDBOX RUN MODE ("close and resume") ────────────────
      // When the toggle is on, the whole turn is dispatched to Trigger.dev
      // Cloud — the user can close the app immediately. No streaming
      // placeholder is created (nothing streams in-app); the invisible
      // lander + toast report progress and land the finished result.
      const detachedMode = useDetachedRunStore.getState().detachedMode;
      if (!detachedMode) {
        execution.processor.handle({
          type: "model_request_start",
          data: { round: 1, generation_id: turnGenerationId },
        });
      }
      if (!convId) {
        const conv = await conversationService.create(userId, "");
        convId = conv.id;
        // The pre-created conversation is what this turn runs against
        // (buildTurnOptions read the conversation id from the RENDER scope,
        // which was still null when this doSend closure captured it).
        opts.conversationId = conv.id;
        // Same event the runtime/background paths emit when THEY create the
        // conversation — the pipeline attaches the id, fixes the URL +
        // sessionStorage, stamps every store message with the id, re-keys
        // the execution, and notifies the host (sidebar refresh).
        execution.processor.handle({
          type: "conversation_created",
          data: { conversation_id: conv.id },
        });

        const collapsed = content.replace(/\s+/g, " ").trim();
        const finalTitle =
          collapsed.length > 60 ? `${collapsed.slice(0, 60)}…` : collapsed;
        await conversationService.update(conv.id, { title: finalTitle });
        // Sidebar + subheader re-render with the new title (React Query
        // refetch via the conversations-changed event).
        notifyConversationsChanged();
      }

      if (detachedMode) {
        await runDetachedTurn(userId, convId!, execution, opts, fileIds);
        return;
      }

      // ── AUTOMATIC CLOSE-HANDOFF REGISTRATION ──────────────────────────
      // If the app closes while this foreground turn is running, the
      // pagehide handler in turn-handoff.ts hands the turn to the sandbox
      // headless runner (sendBeacon agent_start) — "send, close, come back
      // to finished work" with NO toggle required. The snapshot is pure
      // in-memory state; pagehide builds the run config from it + the
      // execution store synchronously.
      const fgProvider = opts.provider;
      registerTurnHandoff({
        executionId: execution.id,
        conversationId: convId,
        userId,
        prompt: opts.userMessage,
        systemPrompt: opts.systemPrompt ?? "",
        // The ONE shared URL construction (provider-resolution) — the close
        // handoff carries the exact gateway the foreground turn is using.
        chatUrl: fgProvider.baseUrl
          ? chatCompletionsUrl(fgProvider.baseUrl, fgProvider.noPrefix)
          : "",
        apiKey: fgProvider.apiKey,
        model: fgProvider.model,
        temperature: opts.temperature ?? null,
        startedAt: Date.now(),
      });

      // Foreground: the fetch lives in the browser page, owned by the hub.
      // It survives route changes/chat switches (nothing aborts it); it ends
      // on completion or explicit Stop. (Browser refresh closes fg turns.)
      executionHub.runForeground(execution.id, opts);
    },
    [buildTurnOptions, conversationId, currentConversationIdFromStore, onConversationCreated, runDetachedTurn],
  );

  // ── HONEST TURN-START FAILURE (the eternal "Thinking" fix) ─────────────
  // ANY exception between createExecution (processing=true → the Thinking
  // spinner starts) and the turn actually running used to reject this async
  // function unhandled — the execution stayed "running" forever and the UI
  // spun eternally (user report 2026-10-21 "stuck at thinking, never
  // generates", with OperationError from getDecryptedApiKey in the global
  // log at the same timestamps). Every step below can throw (vault decrypt,
  // settings load, sandbox mirror, provider resolution) — the wrapper turns
  // any of those into a VISIBLE chat error and finishes the execution, so
  // the spinner always stops and the user always learns what to fix.
  const doSendGuarded = useCallback(
    async (content: string, fileIds?: string[], files?: ChatMessageFile[]) => {
      try {
        await doSend(content, fileIds, files);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[useChat] turn failed to start:", err);
        // The execution created inside doSend may still be running — find
        // the active one for this conversation and settle it honestly.
        const execId = activeExecIdRef.current;
        const record = execId ? executionHub.processorFor(execId) : null;
        if (record) {
          record.handle({
            type: "error",
            data: {
              message: `The message could not be sent: ${message}`,
            },
          });
        } else {
          // No execution (failed before createExecution) — surface a toast
          // so the failure is never silent.
          const { toast } = await import("sonner");
          toast.error(`The message could not be sent: ${message}`);
        }
      }
    },
    [doSend],
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
      void doSendGuarded(content, fileIds, files);
    },
    [isProcessing, doSendGuarded],
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

      const msgs = getMergedMessages();
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

      // 3. Re-run the turn with the original prompt (guarded — a start
      // failure surfaces as a chat error instead of a stuck spinner).
      void doSendGuarded(userMsg.content, userMsg.fileIds, userMsg.files);
    },
    [isProcessing, getMergedMessages, conversationId, doSendGuarded],
  );

  /**
   * EDIT USER MESSAGE (assistant-ui "Edit user message" flow) — re-run the
   * conversation from an edited prompt. The edited user message and EVERY
   * message after it are dropped from the live store + Dexie (no branching
   * in this app — editing rewrites the timeline from that point), then the
   * edited text is sent as a fresh turn with the same attachments.
   */
  const editUserMessage = useCallback(
    (userMessageId: string, newContent: string) => {
      if (isProcessing) return;
      const trimmed = newContent.trim();
      if (!trimmed) return;

      const msgs = getMergedMessages();
      const idx = msgs.findIndex((m) => m.id === userMessageId);
      if (idx < 0) return;
      const userMsg = msgs[idx]!;
      if (userMsg.role !== "user") return;
      const convId = userMsg.conversationId ?? conversationId ?? null;

      // 1. Drop the edited message + everything after it from the live store.
      const doomed = msgs.slice(idx);
      const global = useChatStore.getState();
      for (const m of doomed) global.removeMessage(m.id);

      // 2. Delete the same rows from Dexie (best-effort — a failure only
      //    means stale rows reappear on the next history load).
      void (async () => {
        if (!convId) return;
        try {
          const { conversationService } = await import("@/lib/services");
          for (const m of doomed) {
            if (!m.isTemporaryId) {
              await conversationService.deleteMessage(convId, m.id);
            }
          }
        } catch (err) {
          console.warn("[useChat] editUserMessage: failed to delete old rows from Dexie", err);
        }
      })();

      // 3. Send the edited text as a fresh turn (doSend re-attaches the
      //    upload tags from the original file set; guarded — a start
      //    failure surfaces as a chat error instead of a stuck spinner).
      void doSendGuarded(trimmed, userMsg.fileIds, userMsg.files);
    },
    [isProcessing, getMergedMessages, conversationId, doSendGuarded],
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

  // ── ORPHANED-TURN SETTLE (reload / re-entry) ────────────────────────────
  // Idempotent: if an execution is already registered for the conversation
  // we simply re-subscribe (the execSummary above). Navigating away NEVER
  // stops it.
  //
  // A browser refresh kills any in-flight turn mid-stream. When the closing
  // app dispatched the turn to Trigger.dev Cloud (pagehide beacon), the
  // interrupted chat bubble is taken over IN PLACE: it becomes a live
  // background status bubble ("Working in the background…") whose content
  // tracks the cloud run, and when the run finishes the finished answer is
  // written straight into that same bubble — no strips above the composer,
  // no scary "task was interrupted by the app closing" notes (USER
  // DIRECTIVE). Without a cloud handoff the orphan settles honestly.
  useEffect(() => {
    const turnId = currentConversationIdFromStore ?? conversationId ?? null;
    if (!turnId) return;
    if (executionHub.getFor(turnId)) return;
    let cancelled = false;
    void (async () => {
      const userId = useAuthStore.getState().user?.id;
      if (!userId) return;
      if (useChatStore.getState().isStreaming) return;
      if (executionHub.getFor(turnId)) return;
      const refreshRows = async () => {
        try {
          const refreshed = await conversationService.getMessages(turnId, userId);
          const { conversationMessageToChatMessage } = await import("@/lib/conversation-to-chat");
          const msgs = refreshed.map((row) =>
            conversationMessageToChatMessage({
              id: row.id,
              conversation_id: row.conversation_id,
              role: row.role,
              content: row.content,
              created_at: row.created_at,
              tool_calls: row.tool_calls,
              user_rating: row.user_rating,
              rating_count: row.rating_count,
              files: row.files,
              thinking: (row as { thinking?: string | null }).thinking,
              reasoning: (row as { reasoning?: string | null }).reasoning,
              parts: (row as { parts?: unknown[] | null }).parts as
                | import("@/types").MessagePart[]
                | null
                | undefined,
            }),
          );
          if (
            !executionHub.getFor(turnId) &&
            (useConversationStore.getState().currentConversationId ?? null) === turnId
          ) {
            useChatStore.setState({ messages: msgs });
          }
        } catch {
          // best-effort — rows refresh on the next load instead
        }
      };
      /** Rewrite ONE message row's content (single text part + flat content
       *  kept in sync) — the in-bubble status/final update path. */
      const writeBubble = async (messageId: string, content: string, streaming: boolean) => {
        try {
          await conversationService.updateMessage(messageId, {
            content,
            is_streaming: streaming,
            parts: [
              {
                id: `${messageId}:bg:${Date.now().toString(36)}`,
                type: "text",
                content,
              },
            ],
          } as never);
        } catch {
          // best-effort — the next poll rewrites the row anyway
        }
      };
      try {
        // CLOUD HANDOFF FIRST: a pending cloud-handoff meta means the
        // closing app dispatched this turn to Trigger.dev Cloud — it is NOT
        // "interrupted". The run keeps executing server-side; take over the
        // interrupted bubble and land the finished answer in it.
        const cloudMeta = readCloudHandoffMeta(turnId);
        if (cloudMeta) {
          const {
            resolveCloudRun,
            mirrorCloudRunWithToken,
            markCloudRunSynced,
            extractChatResult,
          } = await import("@/lib/agent/turn-cloud-handoff");
          const run = await resolveCloudRun(cloudMeta.taskId);
          if (!run) {
            // The beacon never landed (offline close, server error) — clear
            // the pointer and settle the orphan with the HONEST default note.
            clearChatHandoffMeta(turnId);
            const settledIds = await conversationService.settleInterruptedMessages(turnId);
            if (settledIds.length > 0) await refreshRows();
            return;
          }

          // Mirror the run WITH the token (cancel/sync authorization) and
          // take over the interrupted streaming row as the live bubble.
          await mirrorCloudRunWithToken(run, cloudMeta, userId, turnId);
          const rows = await conversationService.getMessages(turnId, userId);
          const streamingRows = rows.filter(
            (r) =>
              r.role === "assistant" &&
              (r as { is_streaming?: boolean }).is_streaming === true,
          );
          const bubble = streamingRows[streamingRows.length - 1] ?? null;

          const live = run.status === "queued" || run.status === "running";
          if (bubble && live) {
            // The EXACT required background banner copy (E2B persistent
            // background execution PRD §4): non-blocking, honest (only shown
            // while the cloud run is verifiably live), auto-updates when the
            // task finishes or fails (the poll loop below rewrites the
            // bubble with the landed answer).
            await writeBubble(
              bubble.id,
              "Onyx is working in the background. Wait until the task is finished to see the complete response here.",
              true,
            );
            await refreshRows();
          }

          // Poll until terminal (cancelled flag breaks on unmount; the next
          // mount re-adopts through the same meta).
          let current = run;
          while (
            !cancelled &&
            (current.status === "queued" || current.status === "running")
          ) {
            await new Promise((r) => setTimeout(r, 4000));
            if (cancelled) return;
            const next = await resolveCloudRun(cloudMeta.taskId);
            if (!next) return; // transient — the next mount retries
            const prevTool = (current as { progress?: { currentTool?: string | null } }).progress
              ?.currentTool;
            const nextTool = (next as { progress?: { currentTool?: string | null } }).progress
              ?.currentTool;
            current = next;
            if (bubble && nextTool !== prevTool) {
              await writeBubble(
                bubble.id,
                nextTool
                  ? `⏳ Working in the background — running ${nextTool}…`
                  : "⏳ Working in the background — the finished answer will appear here.",
                true,
              );
              await refreshRows();
            }
          }
          if (cancelled) return;

          // Terminal — land the finished result INTO the bubble (or fall
          // back to the generic sync when there is no bubble/artifacts).
          clearChatHandoffMeta(turnId);
          const failureText =
            current.status === "completed"
              ? null
              : `The background run ${
                  current.status === "failed" ? "failed" : "was stopped"
                }: ${current.error ?? "no error detail"}.`;
          let landedInPlace = false;
          if (bubble) {
            const text =
              failureText ??
              (await extractChatResult(current, cloudMeta.taskToken).catch(() => null));
            if (text) {
              await writeBubble(bubble.id, text, false);
              landedInPlace = true;
            }
          }
          if (landedInPlace) {
            // We landed it ourselves — mark the mirror so the background
            // lander never appends a second copy.
            await markCloudRunSynced(current);
          } else {
            // Fallback: settle the bubble and let the generic sync append.
            if (bubble) {
              await writeBubble(
                bubble.id,
                "The background run finished — the result follows below.",
                false,
              );
            }
            try {
              const { syncRunToConversation } = await import("@/lib/tasks/client");
              await syncRunToConversation(current.runId, userId);
            } catch {
              // best-effort — the lander keeps the run discoverable
            }
          }
          await refreshRows();
          return;
        }
        // No cloud handoff — settle orphans with the honest default note.
        const settledIds = await conversationService.settleInterruptedMessages(turnId);
        if (settledIds.length > 0) {
          await refreshRows();
        }
      } catch {
        // best-effort — the rows settle on the next load instead
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentConversationIdFromStore, conversationId]);

  // Prune spent handoff snapshots (drops the provider key from memory as
  // soon as the turn it belonged to is no longer running).
  useEffect(() => {
    if (!isProcessing) pruneFinishedTurnHandoffs();
  }, [isProcessing]);

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
        setTimeout(() => void doSendGuarded(next.content, next.fileIds, next.files), 100);
      }
    }
  }, [isProcessing, doSendGuarded]);

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
    /** Edit a sent user message + re-run the turn from the edited prompt. */
    editUserMessage,
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
