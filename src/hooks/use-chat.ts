"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import type { AgentTurnOptions } from "@/lib/agent/runtime";
import { respondToAskUser } from "@/lib/agent/runtime";
import { aiProviderService, conversationService, settingsService } from "@/lib/services";
import { getEffectiveE2BKey } from "@/lib/e2b/env-key";
import { stripUploadTags } from "@/lib/uploads/registry";
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
  AUTO_ROUTER_PROVIDER_ID,
  type RouterCandidate,
} from "@/lib/auto-router";
import { notifyConversationsChanged } from "@/lib/scheduler/chat-sync";
import {
  executionHub,
  useExecutionById,
  useExecutionFor,
  useExecutionMessages,
  useExecutionChatValue,
  type ExecutionRecord,
} from "@/lib/agent/execution-hub";

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
 *     is viewing (creating executions on send, resuming persisted E2B jobs
 *     on mount). Unmounting merely unsubscribes the UI.
 *   - `messages` is the merged view: the live execution's store when one
 *     exists, otherwise the global chat store (DB-painted history).
 */
/** Is this provider base URL reachable only from the user's own machine
 *  (or their private network)? Background turns execute inside E2B sandboxes
 *  — REMOTE VMs that cannot reach localhost / loopback / LAN addresses.
 *  A local gateway provider (e.g. an OpenAI-compatible server running on
 *  the user's machine) must therefore run its turns in the BROWSER, which
 *  CAN reach it. */
function isLocalProviderUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false;
  try {
    const { hostname } = new URL(baseUrl);
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "[::1]" ||
      hostname === "::1"
    ) {
      return true;
    }
    // RFC-1918 private ranges (10.x, 172.16–31.x, 192.168.x) + mDNS-style
    // hostnames — all unreachable from a cloud VM.
    if (/^10\./.test(hostname)) return true;
    if (/^192\.168\./.test(hostname)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
    if (
      hostname.endsWith(".local") ||
      hostname.endsWith(".lan") ||
      hostname.endsWith(".home") ||
      hostname.endsWith(".internal")
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

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
      // NOTE (stale "OnyxAI" ghost fix): no load-ALL fallback. The old
      // `db.ai_providers.toArray()` fallback pulled rows belonging to OTHER
      // (obsolete/transient) user ids — deleted legacy seed rows could ride
      // a turn on the wrong provider. An honest empty list errors below.
      const providers = await aiProviderService.list(userId, true);
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

      // ── FIRST MESSAGE = INSTANT FALLBACK TITLE ─────────────────────────
      // Chat name generation (the old PRD §12 dedicated naming call) was
      // REMOVED per user request: the extra AI call doubled request volume
      // on every new chat, burned rate-limited providers, and was itself a
      // frequent HTTP 400 source (strict gateways reject the naming prompt).
      // The title is now the first 60 chars of the user's message, applied
      // instantly — zero extra API calls, the main agent call starts
      // immediately.
      //
      // GEM VISIBILITY: `model_request_start` fires FIRST and creates the
      // streaming assistant placeholder immediately, so the OnyxAgent gem
      // header + shimmering "Thinking" indicator are visible from the very
      // first moment. Both the background and foreground main-call paths
      // re-run this event with the same round/generation — the placeholder
      // is reused, never duplicated.
      execution.processor.handle({
        type: "model_request_start",
        data: { round: 1, generation_id: turnGenerationId },
      });
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
        // LOCAL-PROVIDER GUARD: the background agent loop runs INSIDE the E2B
        // sandbox (a remote VM) — a provider only reachable from THIS machine
        // (localhost / loopback / LAN base URL) can never be contacted from
        // there, and the turn would burn its whole self-heal retry budget on
        // network AggregateErrors. Such turns run in the BROWSER instead (it
        // reaches the local provider directly).
        let providerIsLocal = false;
        try {
          const rows = await aiProviderService.list(userId, true);
          providerIsLocal = rows.some((p) => isLocalProviderUrl(p.base_url));
        } catch {
          // provider resolution failure → let the normal path surface it
        }
        if (e2bKey && !providerIsLocal) {
          const handle = await startBackgroundTurn({
            turn: opts,
            e2bApiKey: e2bKey,
            userId,
            conversationId: opts.conversationId,
            emit: execution.processor.handle,
            // Checkpoint coherence: land the processor's buffered render
            // deltas before each Dexie checkpoint so the persisted seq
            // cursor never runs ahead of the persisted content (an abrupt
            // reload would otherwise skip the last buffered token).
            flush: () => execution.processor.flush(),
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

      const msgs = messages;
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
      //    upload tags from the original file set).
      void doSend(trimmed, userMsg.fileIds, userMsg.files);
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
