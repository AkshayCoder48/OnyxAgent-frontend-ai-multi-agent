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
import { useConversationStore, useResearchStore } from "@/stores";
import { messageOwnershipVerified, logChatIntegrity } from "@/lib/chat/integrity";
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
import { chatCompletionsUrl, listUsableProviders, resolveProviderForModel } from "@/lib/agent/provider-resolution";
import { kiloAnonProvider } from "@/lib/agent/kilo-anon";
import { sandboxEventFeeder } from "@/lib/agent/sandbox-stream-events";
import {
  recordProofEvent,
  recordProofStatus,
} from "@/lib/agent/execution-proof";

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

/** Wait (bounded) for the persisted auth store to hydrate on a cold reload.
 *  The orphaned-turn adoption effect must not bail before the user id
 *  exists — an instant bail froze interrupted turns forever (the reported
 *  "stuck after closing the app" symptom). */
async function waitForAuthUser(timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = useAuthStore.getState() as { authResolved?: boolean; user?: { id?: string } | null };
    if (state.authResolved) return state.user?.id ?? null;
    await new Promise((r) => setTimeout(r, 300));
  }
  const state = useAuthStore.getState() as { user?: { id?: string } | null };
  return state.user?.id ?? null;
}

// ── Detached (E2B sandbox) run helpers ─────────────────────────────────────
// Shared by the live detached send path (runDetachedTurn) and the
// reattach-on-return orphan effect below.

/** Rewrite the conversation's rows into the chat store — the live progress
 *  + landing refresh for detached runs (only when the user is viewing the
 *  conversation). */
async function refreshConversationRows(conversationId: string, userId: string): Promise<void> {
  try {
    const refreshed = await conversationService.getMessages(conversationId, userId);
    const { conversationMessageToChatMessage } = await import("@/lib/conversation-to-chat");
    if (
      (useConversationStore.getState().currentConversationId ?? null) === conversationId
    ) {
      useChatStore.setState({
        messages: refreshed.map((row) =>
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
        ),
      });
    }
  } catch {
    // best-effort — rows refresh on the next poll / load instead
  }
}

/** Rewrite ONE message row's content (single text part + flat content kept
 *  in sync) — the in-bubble status/final update path for detached runs. */
async function writeBubbleStatus(
  messageId: string,
  content: string,
  streaming: boolean,
): Promise<void> {
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
}

/** Map sandbox runner stream events → the processor vocabulary: the shared,
 *  unit-tested mapper lives in lib/agent/sandbox-stream-events.ts (imported
 *  below) so the live send path and the reattach-on-return path feed the
 *  processor identically. */

/** Throttled REAL-TIME CACHE (PRD persistence layer 2): persist the
 *  in-progress assistant message (content + parts + streaming flag) into the
 *  bubble Dexie row every ~2.5s while events stream, so a page refresh
 *  mid-run — or a sandbox wipe before landing — never loses the work that
 *  already streamed. The final landing rewrites the row authoritatively. */
function makeStreamCheckpointer(
  getStoreMessages: () => Array<{
    id: string;
    role: string;
    content?: string;
    parts?: unknown[] | null;
    thinking?: string | null;
  }>,
  bubbleId: string | null,
): { schedule: () => void; flushNow: () => Promise<void> } {
  let lastAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing = false;
  const flush = async () => {
    if (!bubbleId || writing) return;
    writing = true;
    try {
      const msgs = getStoreMessages();
      const mine = [...msgs].reverse().find((m) => m.role === "assistant");
      if (mine && (mine.parts?.length || (mine.content ?? "").trim())) {
        await conversationService.updateMessage(bubbleId, {
          content: mine.content ?? "",
          // Keep the row's thinking column in sync with the streamed
          // thinking parts so the thinking panel survives a refresh too.
          thinking: mine.thinking ?? "",
          is_streaming: true,
          parts: (mine.parts ?? []) as never,
        } as never);
      }
    } catch {
      // best-effort — the landing rewrite is authoritative
    } finally {
      writing = false;
    }
  };
  return {
    schedule: () => {
      const now = Date.now();
      if (now - lastAt < 2500) {
        if (!timer) {
          timer = setTimeout(() => {
            timer = null;
            lastAt = Date.now();
            void flush();
          }, 2500 - (now - lastAt));
        }
        return;
      }
      lastAt = now;
      void flush();
    },
    flushNow: flush,
  };
}

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
  const viewConversationId = currentConversationIdFromStore ?? conversationId ?? null;
  const convExec = useExecutionFor(viewConversationId);
  const activeExecSummary = useExecutionById(activeExecId);
  // STREAMING ISOLATION (PRD §7): this hook's OWN execution may only render
  // while the view is the genuine NEW-CHAT state (null) AND the execution
  // itself has no conversation identity yet — the first-turn window before
  // `conversation_created` re-keys it. Once the user leaves (switched to
  // another conversation, or hit New Chat), the old conversation's live
  // stream must NOT render under the new view's header/sidebar/URL — it
  // keeps streaming + persisting to ITS OWN conversation in the background
  // (the hub never aborts on navigation). Before this guard, switching to a
  // conversation with no running execution made the fallback render the
  // previous chat's stream under the new chat's chrome.
  const execSummary =
    convExec ??
    (viewConversationId === null && (activeExecSummary?.conversationId ?? null) === null
      ? activeExecSummary
      : undefined);
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
  // route to the right turn bucket. The prompt-box todo dock is TEMPORARY
  // and chat-scoped (PRD §10): entering ANY conversation state — switching
  // A → B, opening a chat, or starting a new chat — starts with an EMPTY
  // dock, so the previous chat's todos can never bleed into the view and
  // stale todos from a previous session are never rehydrated into it.
  // (Dexie todo_lists stays untouched — it is the model's own cross-refresh
  // plan state for its manage_todo rounds, and the message-embedded
  // TodoPreview tables render from their own per-message snapshots.)
  useEffect(() => {
    const turnId = currentConversationIdFromStore ?? conversationId ?? null;
    setCurrentTodoTurnId(turnId);
    resetTodoTurn(turnId ?? undefined);
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
      /** SUBMIT-TIME conversation identity (PRD §6/§8): captured by the
       *  caller AT SEND TIME from the selection SSOT — never re-derived
       *  from render scope here, where a switch mid-await would silently
       *  re-aim the turn at another conversation. */
      convId?: string | null,
    ): Promise<AgentTurnOptions | null> => {
      // Provider resolution — the SAME shared contract as subagents
      // (resolveApiConfig), via
      // lib/agent/provider-resolution (endpoint-migration PRD §2/§8):
      //
      //   LEGACY-CLASSIC GUARD — stale text.pollinations.ai (Classic) rows
      //   self-heal (repoint-to-gen / delete) and are NEVER returned, so the
      //   retired Classic endpoint — which answers the "…isn't on the
      //   Classic API" 404 for gen-catalog models — is unreachable from the
      //   main chat too, everywhere.
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
      // ZERO-CONFIG DEFAULT (sandbox-native PRD): a user with NO AI provider
      // no longer hits a hard refusal — the turn runs on the built-in
      // ANONYMOUS KILO gateway, executed from INSIDE the E2B sandbox (the
      // gateway is not browser-CORS-callable, so doSend's fork forces the
      // detached lane whenever a sandbox key exists — personal or the
      // server's managed E2B_API_KEY).
      const zeroConfig = providers.length === 0 ? kiloAnonProvider() : null;
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
      //   ZERO-CONFIG — no providers at all: the anonymous Kilo default
      //   replaces the whole chain (model = the default free-tier id).
      let resolvedProvider: AgentTurnOptions["provider"];
      if (zeroConfig) {
        resolvedProvider = {
          baseUrl: zeroConfig.baseUrl,
          apiKey: zeroConfig.apiKey,
          model: zeroConfig.model,
          toolsEnabled: true,
        };
      } else {
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

        resolvedProvider = {
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
        };
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
        const activeProjectId = useProjectsStore.getState().activeProjectId;
        const contextPackage = await buildProjectContextPackage(
          convId ?? null,
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
        // The submit-time identity threaded in by the caller — immutable for
        // the whole turn no matter how the selection changes mid-await.
        conversationId: convId ?? null,
        userMessage: message,
        fileIds,
        // AUTO ROUTER: when candidates exist, the fallback `provider` IS the
        // first candidate (same config object) so router-unaware code paths
        // (background turns) and the non-routing degenerate case behave
        // identically; the runtime re-picks per round from
        // `providerCandidates`.
        provider: routerCandidates
          ? routerCandidates[0]!.provider
          : resolvedProvider,
        // ZERO-CONFIG: mark anonymous-default turns so the send fork routes
        // them into the sandbox (the gateway rejects browser CORS).
        ...(zeroConfig ? { providerIsAnonymous: true } : {}),
        ...(routerCandidates ? { providerCandidates: routerCandidates } : {}),
        systemPrompt: finalSystemPrompt,
        temperature: temperatureRef.current,
        thinkingEffort: thinkingEffortRef.current,
        emit: emit ?? (() => {}),
      };
    },
    [],
  );

  /**
   * DETACHED SANDBOX TURN ("close and resume") — the E2B variant of
   * doSend's tail. Instead of running the in-browser agent loop (which
   * dies with the tab), this persists the user message, hands the prompt +
   * history + provider config to the headless runner INSIDE the E2B sandbox
   * (a detached process that survives the app closing — the server resets
   * the sandbox window to 24h on start, and pause/rotation guards protect
   * live runners), then adopts the run live: the placeholder bubble shows
   * progress and the finished work (tool parts + final text) lands in it.
   * Reload / close cannot cut the run — the reattach effect adopts it again
   * from the persisted Dexie row.
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

      // ONE detached run per sandbox at a time — a second would overwrite
      // the run config + collide on chat_history.json.
      const active = useDetachedRunStore.getState().runs[convId];
      if (active && (active.status === "running" || active.status === "starting")) {
        failTurn(
          "A sandbox run is already active in this chat — wait for it to finish or press Stop, then send again.",
        );
        return;
      }

      // ── PROVIDER RESOLUTION — the user's own BYOK provider when one is
      // configured, otherwise the built-in KILO ANONYMOUS gateway
      // (zero-configuration sandbox AI — no user provider needed; verified
      // live: anonymous tool-calling + streaming on the :free tier). The
      // sandbox runner calls whichever gateway from INSIDE the sandbox.
      const provider = opts.provider;
      let chatUrl: string;
      let runApiKey: string;
      let runModel: string;
      let runFallbackModels: readonly string[] = [];
      if (opts.providerIsAnonymous) {
        // The zero-config default (buildTurnOptions injected it): use the
        // FULL kilo config including the concrete :free fallback models —
        // the virtual tier id reroutes server-side and concrete ids rotate.
        const kilo = kiloAnonProvider();
        chatUrl = chatCompletionsUrl(kilo.baseUrl);
        runApiKey = kilo.apiKey; // anonymous — no Authorization header
        runModel = kilo.model;
        runFallbackModels = kilo.fallbackModels;
      } else if (provider.baseUrl?.trim()) {
        chatUrl = chatCompletionsUrl(provider.baseUrl, provider.noPrefix);
        runApiKey = provider.apiKey ?? "";
        runModel = provider.model;
      } else {
        const kilo = kiloAnonProvider();
        chatUrl = chatCompletionsUrl(kilo.baseUrl);
        runApiKey = kilo.apiKey; // anonymous — no Authorization header
        runModel = kilo.model;
        runFallbackModels = kilo.fallbackModels;
      }

      // No E2B key → honest FALLBACK to the in-browser loop (a sandbox run
      // needs a sandbox). The toggle stays on; adding a key in Settings →
      // API Keys makes the next send detached again.
      const { getEffectiveE2BKey } = await import("@/lib/e2b/env-key");
      const e2bKey = await getEffectiveE2BKey(userId);
      if (!e2bKey) {
        toast.warning("No E2B sandbox key — running in this tab instead", {
          description: "Add one in Settings → API Keys to run background turns inside your sandbox.",
        });
        execution.processor.handle({
          type: "model_request_start",
          data: { round: 1, generation_id: opts.generationId ?? nanoid() },
        });
        executionHub.runForeground(execution.id, opts);
        return;
      }

      // Load the history BEFORE persisting the new user row, so the seed
      // never duplicates the prompt we are about to append.
      let history: Array<{ role: string; content: string }> = [];
      try {
        const rows = await conversationService.getMessages(convId, userId);
        history = rows.map((r) => ({ role: r.role, content: r.content }));
      } catch {
        // empty seed (first message) — fine
      }

      try {
        await conversationService.addMessage(convId, userId, {
          role: "user",
          content: opts.userMessage,
          fileIds,
        });
      } catch (err) {
        console.warn("[useChat] detached: failed to persist the user message", err);
      }

      // Dispatch to the sandbox (deploy → run config → detached launch →
      // durable Dexie row + store mirror).
      const { startDetachedRun, adoptDetachedRun } = await import(
        "@/lib/agent/detached-run"
      );
      let started: Awaited<ReturnType<typeof startDetachedRun>>;
      try {
        started = await startDetachedRun({
          userId,
          conversationId: convId,
          prompt: opts.userMessage,
          systemPrompt: opts.systemPrompt ?? "",
          chatUrl,
          apiKey: runApiKey,
          model: runModel,
          fallbackModels: runFallbackModels,
          temperature: opts.temperature ?? null,
          history,
          maxRounds: 400,
        });
      } catch (err) {
        failTurn(
          `Failed to start the sandbox run: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
      if (!started.ok) {
        failTurn(`Sandbox run failed to start: ${started.error ?? "unknown error"}`);
        return;
      }

      // Placeholder bubble — a REAL Dexie row created up front (deterministic
      // id, no scanning): the SSE stream renders into it live, the throttled
      // checkpointer caches partial work every ~2.5s, the landing rewrites it
      // in place, and the reattach-on-return path adopts it after a reload.
      // DIRECT-VISIBLE-STREAM copy (PRD §6): present-tense, in-chat — never
      // "working in the background, wait until it finishes" framing, which
      // read like a background-job queue instead of a live response.
      const workingText =
        "Onyx is working — the response will stream here in real time.";
      let bubbleId: string | null = null;
      try {
        const placeholder = await conversationService.addMessage(convId, userId, {
          role: "assistant",
          content: workingText,
          parts: [{ id: `part_${nanoid(8)}`, type: "text", content: workingText }],
        });
        await conversationService.updateMessage(placeholder.id, {
          is_streaming: true,
        } as never);
        bubbleId = placeholder.id;
      } catch (err) {
        console.warn("[useChat] detached: placeholder bubble could not be persisted", err);
      }

      // The hub-side streaming placeholder (what the user watches while the
      // events stream in) shares the RUN's id as its generation id — every
      // streamed round, tool card and token lands in the same message.
      const generationId = started.runId;
      execution.processor.handle({
        type: "model_request_start",
        data: { round: 1, generation_id: generationId, model: runModel },
      });

      toast.success("Running in your E2B sandbox", {
        description:
          "You can close the app — the sandbox keeps working and the finished result lands in this chat.",
      });

      // LIVE STREAMING — the SSE bridge forwards sandbox events; the feeder
      // maps them onto the processor's AgentEvent vocabulary (the same
      // shapes the foreground runtime emits) so the existing streaming UI
      // renders tokens + tool cards in real time; the checkpointer caches.
      const feeder = sandboxEventFeeder(execution.processor, generationId);
      const checkpointer = makeStreamCheckpointer(
        () => execution.store.getState().messages as never,
        bubbleId,
      );

      // ADOPT LIVE: poll the sandbox to terminal (the watchdog + the
      // authoritative landing) while the SSE bridge streams. Stop flows
      // through stopGeneration → stopDetachedRun → the runner's stopped
      // marker → this loop lands it.
      const result = await adoptDetachedRun({
        userId,
        conversationId: convId,
        messageId: bubbleId,
        sandboxId: started.sandboxId,
        isCancelled: () => false,
        onProgress: async (st) => {
          recordProofStatus(st);
          if (!bubbleId) return;
          // LIVENESS LINE — only while the bubble is still EMPTY (nothing
          // streamed yet). The old unconditional rewrite REPLACED the row's
          // parts every 4s, racing the 2.5s checkpointer and wiping the
          // checkpointed partial whenever the status write won last — a
          // refresh then showed a gutted bubble ("not even saving a single
          // thing"). Once any content exists, the checkpoint is the only
          // row writer.
          const liveMsgs = execution.store.getState().messages as Array<{
            role: string;
            content?: string;
            parts?: unknown[] | null;
          }>;
          const liveMine = [...liveMsgs].reverse().find((m) => m.role === "assistant");
          const hasContent =
            (liveMine?.parts?.length ?? 0) > 0 || !!(liveMine?.content ?? "").trim();
          if (!hasContent) {
            const line = st.current_tool
              ? `⏳ Working in the sandbox — running ${st.current_tool}… (round ${st.round ?? "?"}${
                  st.total_rounds ? `/${st.total_rounds}` : ""
                })`
              : "Onyx is working — the response will stream here in real time.";
            await writeBubbleStatus(bubbleId, line, true);
          }
          await refreshConversationRows(convId, userId);
        },
        onEvent: (ev) => {
          recordProofEvent(ev);
          feeder(ev);
          checkpointer.schedule();
        },
      });
      // LANDED — never flush the checkpointer AFTER the landing. The landing
      // is authoritative (full history from the sandbox); the STORE can be
      // minutes behind it when the SSE bridge died mid-run (serverless
      // hiccup), and the old unconditional flushNow() REVERTED the landed
      // final answer into the stale partial + is_streaming:true — the
      // reported "refreshed, it stopped, didn't continue from what it
      // processed in bg". Only a CANCELLED adopt (page dying mid-run)
      // checkpoints its partial for the next reattach.
      if (result.cancelled) await checkpointer.flushNow();

      if (result.cancelled) return;
      executionHub.finishExecution(
        execution.id,
        result.status === "completed" ? "completed" : "failed",
      );
      await refreshConversationRows(convId, userId);
    },
    [],
  );

  const doSend = useCallback(
    async (
      content: string,
      fileIds?: string[],
      files?: ChatMessageFile[],
      turnOpts?: {
        /** CHAT BRANCHES — regenerate: fork from the EXISTING user message
         *  (no new user row; the fresh reply lands as its sibling). */
        reuseUserMessageId?: string;
        /** CHAT BRANCHES — edit: the fork point the NEW user message
         *  hangs from (the original's parent). */
        parentMessageId?: string | null;
      },
    ) => {
      const userId = useAuthStore.getState().user?.id;
      if (!userId) {
        console.warn("[useChat] sendMessage called without an authenticated user.");
        return;
      }

      // ── SUBMIT-TIME OWNERSHIP (PRD §6) ───────────────────────────────────
      // ONE conversation identity for the whole turn, read from the
      // selection SSOT AT SEND TIME — never the render-scope value (the
      // render can lag a switch/New-Chat by a frame; the old closure capture
      // is what shipped messages into the previous conversation).
      const activeChatId = useConversationStore.getState().currentConversationId ?? null;
      // The composer that captured this click renders `conversationId`
      // (its own view of the selection). A disagreement with the store
      // means this send came from a STALE view — block it honestly instead
      // of guessing; the very next click lands on the fresh view. All-null
      // is the legitimate new-chat case (the create path below owns it).
      if (
        activeChatId !== null &&
        !messageOwnershipVerified({
          activeChatId,
          composerChatId: conversationId ?? null,
          contextChatId: activeChatId,
        })
      ) {
        const { toast } = await import("sonner");
        toast.error("The chat just changed — send your message again.");
        return;
      }
      let convId = activeChatId;
      logChatIntegrity("message_submitted", {
        activeChatId,
        composerChatId: conversationId ?? null,
        contextChatId: convId,
      });

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
          conversationId: convId,
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
      // merely subscribes (already done via execSummary above). `convId` is
      // the submit-time identity captured above — immutable for the whole
      // turn (re-keyed by the hub only when the runtime creates the
      // conversation mid-turn).
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
      // CHAT BRANCHES — regenerate mode: the user message is ALREADY in the
      // seeded view (the execution store mirrors the global store, which
      // still holds it). Point the processor at the existing id (user_prompt
      // becomes a no-op swap) and skip the optimistic duplicate bubble.
      if (turnOpts?.reuseUserMessageId) {
        execution.processor.setUserMessageId(turnOpts.reuseUserMessageId);
      } else {
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
      }

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
      // Submit-time convId threaded in (5th arg) so the turn's context +
      // persistence target can never drift from the verified identity.
      const opts = await buildTurnOptions(
        userId,
        aiContent,
        fileIds,
        execution.processor.handle,
        convId,
      );
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

      // CHAT BRANCHES — thread the fork parameters into the runtime options
      // (regenerate reuses the user row; edit forks at the original's parent).
      if (turnOpts?.reuseUserMessageId) {
        opts.reuseUserMessageId = turnOpts.reuseUserMessageId;
      }
      if (turnOpts?.parentMessageId !== undefined) {
        opts.parentMessageId = turnOpts.parentMessageId;
      }

      // ── DETACHED SANDBOX RUN MODE ("close and resume") ────────────────
      // When the toggle is on, the whole turn is handed to the headless
      // runner inside the E2B sandbox — the user can close the app
      // immediately. The streaming placeholder is emitted AFTER a
      // successful dispatch (inside runDetachedTurn), and the live adoption
      // loop streams progress + the finished result into that bubble.
      let detachedMode = useDetachedRunStore.getState().detachedMode;
      // ZERO-CONFIG FORCING: an anonymous-default turn (no user AI provider)
      // can ONLY execute in the sandbox — the Kilo gateway is not
      // browser-CORS-callable — so the detached lane is forced whenever a
      // sandbox key exists (personal or managed env). Without any key the
      // turn cannot run at all: fail honestly instead of a CORS 500 in the
      // foreground loop.
      if (!detachedMode && opts.providerIsAnonymous) {
        const { getEffectiveE2BKey } = await import("@/lib/e2b/env-key");
        if (await getEffectiveE2BKey(userId)) {
          detachedMode = true;
        } else {
          execution.processor.handle({
            type: "error",
            data: {
              message:
                "No AI provider and no sandbox key configured. Zero-config runs execute inside the E2B sandbox — add an E2B key in Settings → API Keys (or set E2B_API_KEY on the server), or configure an AI provider in Settings → Agent Settings.",
            },
          });
          executionHub.finishExecution(execution.id, "failed");
          return;
        }
      }
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

      // Foreground: the fetch lives in the browser page, owned by the hub.
      // It survives route changes/chat switches (nothing aborts it); it ends
      // on completion or explicit Stop. (Browser refresh closes fg turns —
      // use the Background runs toggle when the work must survive closing.)
      executionHub.runForeground(execution.id, opts);
    },
    [buildTurnOptions, conversationId, onConversationCreated, runDetachedTurn],
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
    async (
      content: string,
      fileIds?: string[],
      files?: ChatMessageFile[],
      turnOpts?: { reuseUserMessageId?: string; parentMessageId?: string | null },
    ) => {
      try {
        await doSend(content, fileIds, files, turnOpts);
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
   * REGENERATE (PRD §6) — re-run the turn that produced an assistant
   * message. CHAT BRANCHES (2026-11-05): NON-DESTRUCTIVE — the original
   * reply (and everything after it) stays saved as a sibling branch; the
   * fresh reply forks from the SAME user message and becomes the new
   * active branch (the ‹ i/n › picker appears on both). Blocked while an
   * execution is live; reads the merged message view (execution store or
   * global store — same content either way).
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

      // 1. Retire the old branch from the LIVE VIEW ONLY — the rows stay
      //    in Dexie as the sibling branch (no deletes; the execution store
      //    is seeded from this trimmed view below).
      const doomed = msgs.slice(idx);
      const global = useChatStore.getState();
      for (const m of doomed) global.removeMessage(m.id);

      // 2. Re-run the turn reusing the EXISTING user message row (the
      //    fresh reply lands as its child — a sibling of the retired one).
      void doSendGuarded(userMsg.content, userMsg.fileIds, userMsg.files, {
        reuseUserMessageId: userMsg.id,
      });
    },
    [isProcessing, getMergedMessages, conversationId, doSendGuarded],
  );

  /**
   * EDIT USER MESSAGE (assistant-ui "Edit user message" flow) — re-run the
   * conversation from an edited prompt. CHAT BRANCHES (2026-11-05): NON-
   * DESTRUCTIVE — the edited message and everything after it stay saved as
   * a sibling branch; the edited text forks from the SAME parent and
   * becomes the new active branch (the ‹ i/n › picker appears on both).
   * The legacy rows are only retired from the LIVE VIEW (the execution
   * store is seeded from the trimmed view).
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

      // The fork point: the edited prompt hangs from its predecessor on the
      // active branch (null when editing the first message — root fork).
      const forkParentId = idx > 0 ? (msgs[idx - 1]?.id ?? null) : null;

      // 1. Retire the old branch from the LIVE VIEW ONLY — the rows stay
      //    in Dexie as the sibling branch (no deletes).
      const doomed = msgs.slice(idx);
      const global = useChatStore.getState();
      for (const m of doomed) global.removeMessage(m.id);

      // 2. Backfill the ORIGINAL row's fork parent (legacy rows have none)
      //    so the original and the edited prompt are true siblings — the
      //    ‹ i/n › picker then counts them together.
      if (convId && !userMsg.isTemporaryId && userMsg.parent_id == null) {
        void (async () => {
          try {
            const { conversationService } = await import("@/lib/services");
            await conversationService.setMessageParent(userMsg.id, forkParentId);
          } catch (err) {
            console.warn("[useChat] editUserMessage: failed to backfill fork parent", err);
          }
        })();
      }

      // 3. Send the edited text as a fresh turn FORKED at the original's
      //    parent (doSend re-attaches the upload tags from the original
      //    file set; guarded — a start failure surfaces as a chat error
      //    instead of a stuck spinner).
      void doSendGuarded(trimmed, userMsg.fileIds, userMsg.files, {
        parentMessageId: forkParentId,
      });
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
    // DETACHED (E2B sandbox) RUN FIRST: Stop must kill the sandbox runner
    // (not just the local execution). The adoption loop observes the
    // runner's "stopped" marker, lands the partial work + an honest stopped
    // note, and settles the execution itself.
    if (convId) {
      const view = useDetachedRunStore.getState().runs[convId];
      if (view && (view.status === "running" || view.status === "starting")) {
        const userId = useAuthStore.getState().user?.id;
        if (userId) {
          void import("@/lib/agent/detached-run").then((m) =>
            m.stopDetachedRun(userId, convId!),
          );
          return;
        }
      }
    }
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

  // ── ORPHANED-TURN SETTLE / DETACHED-RUN REATTACH (reload / re-entry) ────
  // Idempotent: if an execution is already registered for the conversation
  // we simply re-subscribe (the execSummary above). Navigating away NEVER
  // stops it.
  //
  // A browser refresh / app cut while a DETACHED (E2B sandbox) run was in
  // flight is NOT an interruption — the headless runner kept working inside
  // the sandbox (detached process, 24h window, pause-on-timeout guards).
  // On return the persisted Dexie `detached_runs` row (still running) is
  // re-adopted: the interrupted bubble becomes a live status bubble and the
  // finished work lands straight into it. Runs with no live row (the app
  // died before the dispatch completed, or the run already synced) settle
  // silently — no interruption notes in the chat (user directive).
  useEffect(() => {
    const turnId = currentConversationIdFromStore ?? conversationId ?? null;
    if (!turnId) return;
    if (executionHub.getFor(turnId)) return;
    let cancelled = false;
    void (async () => {
      // AUTH-HYDRATION WAIT: on a cold reload the persisted auth store may
      // not have rehydrated when this effect first runs — poll until the
      // store resolves (bounded), or re-adoption never happens.
      const userId = await waitForAuthUser(10_000);
      if (!userId || cancelled) return;
      if (useChatStore.getState().isStreaming) return;
      if (executionHub.getFor(turnId)) return;

      // ── 1) DETACHED-RUN REATTACH — a sandbox run is still in flight. ──
      try {
        const { getDetachedRunForConversation, adoptDetachedRun, readStreamRef } =
          await import("@/lib/agent/detached-run");
        const row = await getDetachedRunForConversation(userId, turnId);
        const liveRow =
          row &&
          (row.status === "running" || row.status === "starting") &&
          !row.result_message_id
            ? row
            : null;
        // LOST-ROW FALLBACK (PRD §7): the Dexie row can be MISSING (its
        // write failed — quota, a locked DB, a failed upgrade; saveRunRow
        // swallows the error) or a STALE settled row from an older run can
        // survive while the new run's row write failed. The localStorage
        // stream ref — written at dispatch and on every streamed event,
        // independent of Dexie — still points at the live run. adopt from
        // it; without this the adoption silently no-op'd and the bubble
        // froze at its checkpoint forever (the reported "only a single
        // reasoning block survived the refresh").
        let fallbackRef: import("@/lib/agent/detached-run").BgStreamRef | null = null;
        if (!liveRow) {
          const ref = readStreamRef(turnId);
          if (
            ref?.sandboxId &&
            Date.now() - ref.updatedAt < 30 * 60_000 // BG_STREAM_REF_MAX_AGE_MS
          ) {
            fallbackRef = ref;
          }
        }
        if (liveRow || fallbackRef) {
          const rows = await conversationService.getMessages(turnId, userId);
          const streamingRows = rows.filter(
            (r) =>
              r.role === "assistant" &&
              (r as { is_streaming?: boolean }).is_streaming === true,
          );
          const bubble = streamingRows[streamingRows.length - 1] ?? null;
          // LIVENESS LINE — only when the checkpointed bubble is still EMPTY.
          // The old unconditional writeBubbleStatus REPLACED the row's parts
          // with a single status line; when the SSE replay then failed
          // (serverless cold start / proxy), the bubble stayed gutted — the
          // reported "refreshed and it saved nothing / didn't continue from
          // the tool call". The checkpointed partial must survive the
          // reattach; the replay + checkpointer rebuild on top of it.
          const bubbleHasContent =
            ((bubble as { parts?: unknown[] | null } | null)?.parts?.length ?? 0) > 0 ||
            !!(bubble as { content?: string } | null)?.content?.trim();
          if (bubble && !bubbleHasContent) {
            await writeBubbleStatus(
              bubble.id,
              "Onyx is still working — the live stream is reconnecting…",
              true,
            );
          }
          await refreshConversationRows(turnId, userId);

          // RESUME EXECUTION — register a background execution for the
          // live run so the reattach renders the SAME real-time stream a
          // live send does: the SSE bridge replays every event from the
          // start (agent_events.jsonl is the replay log — Last-Event-ID 0),
          // the feeder maps them onto the processor, and the throttled
          // checkpointer keeps caching partial work into the bubble row.
          const execution = executionHub.createExecution({
            conversationId: turnId,
            mode: "background",
            trigger: "resume",
          });
          // DETERMINISTIC SEED (PRD §10 recovery priority 1–2): the exec
          // store starts as the conversation's OWN DB rows — fetched one
          // step above, no sessionStorage/global-store race — so the
          // history + the checkpointed bubble render immediately while the
          // bridge warms up. The old createExecution seed depended on
          // getPersistedConversationId() matching at effect time; on a
          // cold reload that race could seed EMPTY (the user message
          // vanished until landing) or with a stale painted view.
          try {
            const { conversationMessageToChatMessage } = await import(
              "@/lib/conversation-to-chat"
            );
            execution.store.getState().replaceAllMessages(
              rows.map((r) =>
                conversationMessageToChatMessage({
                  id: r.id,
                  conversation_id: r.conversation_id,
                  role: r.role,
                  content: r.content,
                  created_at: r.created_at,
                  tool_calls: r.tool_calls,
                  user_rating: r.user_rating,
                  rating_count: r.rating_count,
                  files: r.files,
                  thinking: (r as { thinking?: string | null }).thinking,
                  reasoning: (r as { reasoning?: string | null }).reasoning,
                  parts: (r as { parts?: unknown[] | null }).parts as
                    | import("@/types").MessagePart[]
                    | null
                    | undefined,
                }),
              ),
            );
          } catch {
            // best-effort — an unseeded store still renders via the
            // global-store fallback until the first replayed event lands
          }
          // ADOPT THE BUBBLE (PRD §6 "one continuous response"): the
          // processor claims the CHECKPOINTED bubble row as its streaming
          // message and resets it — the SSE replay then rebuilds the full
          // timeline INTO that row. Without adoption the processor
          // createNewMessage()s a SECOND assistant bubble next to the
          // checkpointed one: the post-refresh view showed the frozen
          // checkpoint bubble AND a duplicate live bubble replaying the
          // same rounds below it.
          if (bubble) {
            execution.processor.adoptStreamingMessage(
              bubble.id,
              liveRow?.id ?? fallbackRef?.runId ?? null,
            );
          }
          const feeder = sandboxEventFeeder(
            execution.processor,
            liveRow?.id ?? fallbackRef?.runId ?? `resume_${turnId}`,
          );
          const checkpointer = makeStreamCheckpointer(
            () => execution.store.getState().messages as never,
            bubble?.id ?? null,
          );
          const result = await adoptDetachedRun({
            userId,
            conversationId: turnId,
            messageId: bubble?.id ?? null,
            sandboxId: liveRow?.sandbox_id ?? fallbackRef?.sandboxId ?? null,
            // HUB-OWNED CANCELLATION — NOT the effect closure's `cancelled`
            // flag. On a cold reload the conversation store hydrates AFTER
            // this effect first ran; the dep flip fires the cleanup (which
            // flips the closure flag) while the adopt loop is mid-flight —
            // the loop then returned "cancelled", NOTHING landed, and the
            // effect's second run bailed on the already-registered execution
            // (getFor(turnId)) → the run finished in the sandbox but the
            // bubble froze at its checkpoint forever (the reported
            // auto-stop). The loop now dies ONLY on an explicit user stop
            // (stopGeneration → stopExecution → status "stopped") or on its
            // own terminal landing; effect re-runs and unmounts (chat
            // switches never cancel a run — spec §7/§29/§30) re-subscribe
            // via the hub instead.
            isCancelled: () =>
              executionHub.getSummary(execution.id)?.status === "stopped",
            fallbackRef,
            onProgress: async (st) => {
              recordProofStatus(st);
              if (!bubble) return;
              // LIVENESS LINE — only while the replayed bubble is still EMPTY
              // (same guard as the live path; the old unconditional rewrite
              // raced the checkpointer and could wipe the checkpointed
              // partial to a bare status line every 4s).
              const liveMsgs = execution.store.getState().messages as Array<{
                role: string;
                content?: string;
                parts?: unknown[] | null;
              }>;
              const liveMine = [...liveMsgs].reverse().find((m) => m.role === "assistant");
              const hasContent =
                (liveMine?.parts?.length ?? 0) > 0 || !!(liveMine?.content ?? "").trim();
              if (!hasContent) {
                const line = st.current_tool
                  ? `⏳ Working in the sandbox — running ${st.current_tool}… (round ${st.round ?? "?"}${
                      st.total_rounds ? `/${st.total_rounds}` : ""
                    })`
                  : "Onyx is still working — the live stream is reconnecting…";
                await writeBubbleStatus(bubble.id, line, true);
              }
              await refreshConversationRows(turnId, userId);
            },
            onEvent: (ev) => {
              recordProofEvent(ev);
              feeder(ev);
              checkpointer.schedule();
            },
          });
          // LANDED — never flush the checkpointer AFTER the landing (same
          // guard as the live path): the landing wrote the authoritative
          // full history; a store left stale by a dead SSE bridge would
          // revert it to the checkpointed partial ("stopped after refresh,
          // didn't continue from what it processed in bg"). Only a cancelled
          // adopt (page dying mid-run) checkpoints its partial.
          if (result.cancelled) await checkpointer.flushNow();
          if (!result.cancelled) {
            executionHub.finishExecution(
              execution.id,
              result.status === "completed" ? "completed" : "failed",
            );
          }
          await refreshConversationRows(turnId, userId);
          return;
        }
      } catch {
        // best-effort — fall through to the silent settle below
      }

      // ── 2) NO LIVE RUN — settle any interrupted streaming rows ────────
      // SILENTLY (user directive 2026-11-14 — the "This task was
      // interrupted…" commentary is gone from the product; the user just
      // continues with a new message).
      try {
        const settledIds = await conversationService.settleInterruptedMessages(turnId);
        if (settledIds.length > 0) {
          await refreshConversationRows(turnId, userId);
        }
        // No live row and no fresh ref reached this point — the localStorage
        // recovery pointer (if any residue) is stale; drop it so it can never
        // trigger a bogus adoption later.
        try {
          const { clearStreamRef } = await import("@/lib/agent/detached-run");
          clearStreamRef(turnId);
        } catch {
          // best-effort
        }
      } catch {
        // best-effort — the rows settle on the next load instead
      }
    })();
    return () => {
      cancelled = true;
    };
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
