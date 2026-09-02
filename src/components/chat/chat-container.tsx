"use client";

import { useEffect, useMemo, useRef, useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { useChat } from "@/hooks";
import { ChatControls } from "./chat-controls";
import { ChatEmptyState } from "./chat-empty-state";
import { ChatInput } from "./chat-input";
import { FilePreviewPanel } from "./file-preview-panel";
import { SourcesPanel } from "./sources-panel";
import { MessageList } from "./message-list";
import { PendingMessages } from "./pending-messages";
import { QuestionPrompt } from "@/components/ui";
import type { AskUserQuestion, AskUserAnswer } from "@/types";
import { useConversationStore, useChatStore } from "@/stores";
import { reconcilePersisted, setPersistedConversationId } from "@/stores/chat-store";
import { useConversations } from "@/hooks";
import { useSlashCommands } from "@/hooks";
import { conversationMessageToChatMessage } from "@/lib/conversation-to-chat";
import { Orb } from "@/components/assistant-ui/elements";
import { AgentStatus } from "@/components/assistant-ui/elements";
import { formatClock } from "@/lib/agent-tool-steps";
import { currentResponseOrb } from "@/components/assistant-ui/elements/response-orb";
import { genuiPerfLog } from "@/lib/genui/perf";
import { Hourglass } from "lucide-react";

const SCROLL_NEAR_BOTTOM_THRESHOLD_PX = 150;

/**
 * SINGLE SCROLL OWNER (PRD §8–§11 — scroll jank fix).
 *
 * The old auto-scroll had two failure modes that produced the "pushes up
 * and down at the same time" oscillation during GenUI streaming:
 *
 *   1. `messagesEndRef.scrollIntoView()` ran synchronously on EVERY store
 *      flush (~33×/sec). `scrollIntoView` also scrolls EVERY scrollable
 *      ancestor (page/body on mobile), not just the chat container — competing
 *      scroll contexts fighting each other.
 *   2. "User scrolled up" was inferred from raw scroll POSITION: when a
 *      large GenUI card landed in one flush, dist-from-bottom spiked past
 *      150px and the controller wrongly concluded the user had scrolled,
 *      permanently stopping the follow (the user appeared stuck off-bottom
 *      while the content kept growing).
 *
 * The new controller:
 *   - Tracks USER INTENT (wheel-up / touch-drag-up / arrow-up keys) — the
 *     only thing that disables auto-follow. Content growth can never
 *     masquerade as user intent.
 *   - Resumes follow automatically whenever the viewport is back at/near
 *     the bottom (momentum, keyboard, or our own follow).
 *   - Writes scrolls via container-scoped `scrollTop` (never touches
 *     ancestors) and coalesces them through requestAnimationFrame — at
 *     most ONE scroll write per animation frame, no matter how many
 *     message updates arrive.
 */
function useChatScrollController(
  scrollContainerRef: React.RefObject<HTMLDivElement | null>,
  messages: unknown[],
) {
  /** True once the user takes the viewport; false again when back at bottom. */
  const userTookScrollRef = useRef(false);
  /** Pending rAF handle for the coalesced follow-bottom write. */
  const scrollRafRef = useRef<number | null>(null);
  /** Stable handle to the frame-scheduled follow (set once on mount). */
  const scheduleFollowRef = useRef<(() => void) | null>(null);

  // Attach intent listeners + define the ONE scroll primitive.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const distFromBottom = () =>
      container.scrollHeight - container.scrollTop - container.clientHeight;

    const clearRaf = () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };

    // The ONE scroll write path: container-scoped, instant, frame-scheduled,
    // and re-checked inside the frame (a user scroll arriving mid-frame wins).
    const scheduleFollowBottom = () => {
      if (scrollRafRef.current !== null) return; // already scheduled this frame
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        if (userTookScrollRef.current) return;
        genuiPerfLog("Scroll", "follow-bottom");
        container.scrollTop = container.scrollHeight;
      });
    };
    scheduleFollowRef.current = scheduleFollowBottom;

    // ── USER INTENT: only explicit user input disables auto-follow ──
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) userTookScrollRef.current = true;
      else if (distFromBottom() <= SCROLL_NEAR_BOTTOM_THRESHOLD_PX)
        userTookScrollRef.current = false;
    };
    let lastTouchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      lastTouchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (lastTouchY !== null && y !== undefined && y > lastTouchY + 3) {
        // Finger moving down = dragging content up = user scrolling up.
        userTookScrollRef.current = true;
      }
      lastTouchY = y ?? lastTouchY;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") {
        userTookScrollRef.current = true;
      } else if (distFromBottom() <= SCROLL_NEAR_BOTTOM_THRESHOLD_PX) {
        userTookScrollRef.current = false;
      }
    };

    // ── POSITION re-arm: back at the bottom (however it happened) resumes
    // auto-follow. Content growth alone doesn't fire scroll events, so this
    // can't be fooled the way the old position-only detector was.
    const onScroll = () => {
      if (distFromBottom() <= SCROLL_NEAR_BOTTOM_THRESHOLD_PX) {
        userTookScrollRef.current = false;
      }
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKeyDown);

    return () => {
      clearRaf();
      scheduleFollowRef.current = null;
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKeyDown);
    };
    // The container element is stable for ChatContainer's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the bottom when messages update — through the frame scheduler,
  // so a burst of flushes still produces at most one scroll write per frame.
  useEffect(() => {
    scheduleFollowRef.current?.();
  }, [messages]);
}

/**
 * Thinking status line shown between send and first token: the Orb lattice
 * glyph leading the AgentStatus element (state dot + crossfading label +
 * ticking m:ss elapsed + pause wired to stopGeneration — the assistant-ui
 * "Agent status" recipe, so the trailing control actually stops the turn).
 * Mounts fresh per turn, so the elapsed clock starts from zero each time.
 *
 * ORB (PRD §23–§28): the orb is the response's RANDOM pick (one of the full
 * 25-variant collection, chosen once when the response began — never per
 * chunk), noticeably LARGER than before (28px, up from 18px), and the pill
 * shares ONE flex row with `items-center` so the text sits exactly on the
 * lattice's midline at any font size — no fixed offsets, no baseline drift,
 * stable while the label changes and the orb animates.
 */
function ThinkingStatus({ onStop }: { onStop?: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  // Read once per mount — the module singleton holds the response's orb; a
  // remount (next turn) re-reads it, and nothing else re-renders from this.
  const orbVariant = useMemo(() => currentResponseOrb(), []);
  useEffect(() => {
    const startedAt = Date.now();
    const id = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className="flex min-h-8 w-fit items-center gap-2.5">
      <Orb variant={orbVariant} size={28} className="shrink-0" />
      <AgentStatus
        state="working"
        label="Thinking"
        elapsed={formatClock(elapsed)}
        onPauseClick={onStop}
      />
    </span>
  );
}

export function ChatContainer({ onOpenSettings }: { onOpenSettings?: () => void } = {}) {
  const {
    currentConversationId,
    currentMessages,
    hydratedConversationId,
    isLoading: isConversationLoading,
  } = useConversationStore();
  const { addMessage: addChatMessage, restorePersisted } = useChatStore();
  const { fetchConversations } = useConversations();
  const prevConversationIdRef = useRef<string | null | undefined>(undefined);

  const handleConversationCreated = useCallback(
    (conversationId?: string) => {
      // NEW-CHAT TRANSITION GUARD: remember the id the RUNTIME just created
      // (conversation_created). The clear-effect below only treats a null → ID
      // transition as "a new chat being saved" when the ID matches THIS
      // marker — navigating back to an EXISTING chat from the "new chat"
      // (null) state must NOT be misclassified, or the load-effect skips the
      // DB paint and the chat renders empty until the user switches away and
      // back (the "tap new chat → open same chat → blank" bug).
      if (conversationId) {
        runtimeCreatedConvIdRef.current = conversationId;
      }
      fetchConversations();
    },
    [fetchConversations],
  );
  // The conversation id the runtime JUST created this turn (null once
  // consumed). See handleConversationCreated above.
  const runtimeCreatedConvIdRef = useRef<string | null>(null);

  const {
    messages,
    isConnected,
    isProcessing,
    sendMessage,
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
    pendingQuestions,
    sendAskUserResponses,
    sendTodoAction,
    rateLimitStatus,
  } = useChat({
    conversationId: currentConversationId,
    onConversationCreated: handleConversationCreated,
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // SINGLE SCROLL OWNER (PRD §8–§11): the one controller for the chat scroll
  // container — user-intent based auto-follow, container-scoped writes,
  // rAF-coalesced to at most one scroll per animation frame. Replaces the
  // old position-only "userScrolledUp" + per-flush scrollIntoView pair that
  // fought itself during GenUI streaming.
  useChatScrollController(scrollContainerRef, messages);

  // Tracks which conversation's messages are CURRENTLY loaded into the chat
  // store. The load-effect (below) uses this to decide whether to (re)load.
  const loadedConvIdRef = useRef<string | null | undefined>(undefined);

  // Tracks whether the LAST conversation ID change was a null → ID transition
  // (i.e. a new chat being saved). Set by the clear-effect, read by the
  // load-effect. This is needed because the clear-effect updates
  // prevConversationIdRef BEFORE the load-effect runs, so the load-effect
  // can't check "was the previous ID null?" by reading prevConversationIdRef.
  const wasNewChatTransitionRef = useRef(false);

  // Clear messages when conversation changes, but NOT when going from null to a new ID
  // (that happens when a new chat is saved - we want to keep the messages)
  useEffect(() => {
    const prevId = prevConversationIdRef.current;
    const currId = currentConversationId;
    // Skip initial mount
    if (prevId === undefined) {
      prevConversationIdRef.current = currId;
      // Reconcile persisted messages with the active conversation ID.
      // CRITICAL: call this even when currId is null — otherwise stale
      // messages from the PREVIOUS chat (still in sessionStorage) leak
      // into the new chat / no-chat state after a page refresh.
      reconcilePersisted(currId);
      // POST-HYDRATION RESTORE: the chat store starts empty so the first
      // client render matches the server HTML (sessionStorage is
      // client-only). Now that hydration has completed, restore the
      // persisted messages — reconcilePersisted above already wiped them
      // when they belong to a different conversation.
      restorePersisted();
      return;
    }

    // No-op when the id didn't actually change (e.g. a sibling store update
    // caused a re-render but currentConversationId is the same).
    if (prevId === currId) {
      wasNewChatTransitionRef.current = false;
      return;
    }

    // Track whether this is a null → ID transition (new chat being saved).
    // The load-effect reads this to decide whether to skip loading.
    // CRITICAL: ONLY a runtime-created id counts as "a new chat being saved"
    // (see handleConversationCreated). A user navigating BACK to an existing
    // chat from the new-chat (null) state is a normal selection — the DB
    // load-effect must run and paint its messages.
    const isRuntimeCreatedTransition =
      prevId === null &&
      currId !== null &&
      runtimeCreatedConvIdRef.current === currId;
    wasNewChatTransitionRef.current = isRuntimeCreatedTransition;
    if (isRuntimeCreatedTransition) {
      // Consume the marker — the transition is being handled.
      runtimeCreatedConvIdRef.current = null;
    }

    // Clear messages when:
    // 1. Going from a conversation to null (new chat)
    // 2. Switching between two different conversations
    // Do NOT clear when going from null to a conversation (new chat being saved)
    const shouldClear =
      currId === null || // Going to new chat
      (prevId !== null && prevId !== currId); // Switching between conversations

    if (shouldClear) {
      // Abort any in-flight AI stream BEFORE clearing messages — otherwise
      // the stream keeps writing to currentMessageIdRef which points to a
      // message in the OLD conversation, causing messages to vanish or
      // appear in the wrong chat (PRD §26, §27, §28).
      if (isProcessing) {
        stopGeneration();
      }
      clearMessages();
      // Drop any pending queue when switching threads — those messages were
      // typed in the previous conversation's context, sending them into a
      // different conversation would surprise the user.
      clearQueued();
      // NOTE: the model + provider selection is deliberately NOT reset here.
      // Resetting it (the old `setModel(null); setProviderId(null);`) was the
      // model-desync bug: ChatControls' local state kept showing the user's
      // pick while the runtime silently fell back to the provider default,
      // so the NEXT request used a different model than the UI claimed. The
      // selection is now session-level state owned by the chat store (single
      // source of truth) and survives conversation switches — PRD §12/§17:
      // "navigate between chats … the selected model must remain".
    }

    // Reset the loaded-conversation tracker so the load-effect re-loads
    // messages for the new conversation. Without this, switching A → B → A
    // would skip loading A's messages because `loadedConvIdRef` still held
    // "A" from the first visit — the load-effect would think A was already
    // loaded and short-circuit, leaving the chat store empty.
    loadedConvIdRef.current = null;

    // Remember which conversation the persisted messages belong to.
    setPersistedConversationId(currId);

    prevConversationIdRef.current = currId;
  }, [currentConversationId, clearMessages, clearQueued, isProcessing, stopGeneration, restorePersisted]);

  // Load DB messages into the chat store when a conversation's messages arrive.
  //
  // HYDRATION GUARD (PRD §17–22): `currentMessages` are only painted when
  // `hydratedConversationId === currentConversationId` — i.e. the message
  // array was FETCHED FOR the conversation that is actually selected. A
  // stale fetch for conversation A arriving after the user switched to B
  // can never paint (setMessagesFor already drops it, this is defense in
  // depth). Messages not yet hydrated → show the persisted/live store
  // messages (or the loading skeleton) — NOT an empty home screen.
  //
  // NEW CHAT TRANSITION: when a new chat is created (null → new ID), the
  // user's message is ALREADY in the chat store (added by use-chat.ts
  // before the runtime creates the conversation) and the runtime is
  // streaming into it. We must NOT clear it — mark as loaded and wait.
  useEffect(() => {
    // No conversation selected — nothing to load. Reset the loaded-id tracker
    // so a subsequent selection of a previously-loaded conversation reloads.
    if (!currentConversationId) {
      loadedConvIdRef.current = null;
      return;
    }

    // New chat transition (null → ID): the live chat store is authoritative.
    // Consume the flag set by the clear-effect and skip the DB paint.
    if (wasNewChatTransitionRef.current) {
      wasNewChatTransitionRef.current = false;
      loadedConvIdRef.current = currentConversationId;
      return;
    }

    // Messages must belong to the conversation that is currently selected.
    // Until they do, keep whatever the chat store already shows (restored
    // sessionStorage messages or a previous paint) — never blank out.
    if (hydratedConversationId !== currentConversationId) return;

    // Already painted this conversation's messages into the chat store.
    if (loadedConvIdRef.current === currentConversationId) return;

    // Mark as painted BEFORE mutating so a synchronous re-render doesn't
    // double-apply.
    loadedConvIdRef.current = currentConversationId;

    clearMessages();
    currentMessages.forEach((msg) => {
      // Use the shared helper that preserves thinking, reasoning, parts,
      // and tool calls — the manual rebuild below discarded thinking and
      // reasoning, causing them to vanish after page reload.
      const chatMsg = conversationMessageToChatMessage({
        id: msg.id,
        conversation_id: msg.conversation_id,
        role: msg.role,
        content: msg.content,
        created_at: msg.created_at,
        tool_calls: msg.tool_calls,
        user_rating: msg.user_rating,
        rating_count: msg.rating_count,
        files: msg.files,
        thinking: (msg as { thinking?: string | null }).thinking,
        reasoning: (msg as { reasoning?: string | null }).reasoning,
        parts: (msg as { parts?: unknown[] | null }).parts as
          | import("@/types").MessagePart[]
          | null
          | undefined,
      });
      addChatMessage(chatMsg);
    });
  }, [currentMessages, hydratedConversationId, addChatMessage, clearMessages, currentConversationId]);

  // Auto-scroll is owned ENTIRELY by useChatScrollController above (see its
  // doc comment). The old per-flush `messagesEndRef.scrollIntoView()` was
  // removed: it scrolled every scrollable ancestor (not just the chat
  // container), ran ~33×/sec synchronously, and its position-only "user
  // scrolled" detection misfired whenever a large GenUI card landed in one
  // flush — the up/down scroll fight.

  const { commands: slashCommands } = useSlashCommands();

  // REGENERATE: delegated to use-chat's `regenerate` — it drops the old
  // assistant response + its user prompt from the store AND Dexie, then
  // re-runs the turn with the currently selected model/provider (the old
  // version re-sent the prompt via sendMessage, duplicating the pair).
  const handleRegenerate = useCallback(
    (assistantMessageId: string) => {
      regenerate(assistantMessageId);
    },
    [regenerate],
  );

  // Slash command handlers — passed down to ChatInput so the / palette can
  // run them locally without going through the agent.
  const slashContext = {
    // `/clear` deletes messages from BOTH memory and Dexie so they don't
    // reappear on navigation. This is different from the internal
    // `clearMessages` which only clears memory (used when switching chats).
    clearChat: async () => {
      const convId = currentConversationId;
      if (convId) {
        try {
          const { conversationService } = await import("@/lib/services");
          await conversationService.deleteMessagesByConversation(convId);
        } catch {
          // Non-fatal — messages will still be cleared from memory.
        }
      }
      clearMessages();
    },
    regenerateLast: () => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === "assistant") {
          handleRegenerate(m.id);
          return;
        }
      }
    },
    openSettings: () => {
      if (onOpenSettings) {
        onOpenSettings();
      } else {
        document.querySelector<HTMLButtonElement>("[data-chat-settings-trigger]")?.click();
      }
    },
  };

  return (
    <ChatUI
      messages={messages}
      isConnected={isConnected}
      isProcessing={isProcessing}
      isLoadingConversation={
        currentConversationId !== null && isConversationLoading && messages.length === 0
      }
      sendMessage={sendMessage}
      onModelChange={setModel}
      onProviderChange={setProviderId}
      onTemperatureChange={setTemperature}
      onThinkingEffortChange={setThinkingEffort}
      onRegenerate={handleRegenerate}
      slashContext={slashContext}
      slashCommands={slashCommands}
      queuedMessages={queuedMessages}
      onCancelQueued={cancelQueued}
      messagesEndRef={messagesEndRef}
      scrollContainerRef={scrollContainerRef}
      pendingQuestions={pendingQuestions}
      onAnswerQuestions={sendAskUserResponses}
      onTodoAction={sendTodoAction}
      onStop={stopGeneration}
      rateLimitStatus={rateLimitStatus}
      conversationId={currentConversationId}
    />
  );
}

interface ChatUIProps {
  messages: import("@/types").ChatMessage[];
  isConnected: boolean;
  isProcessing: boolean;
  /** True while a saved conversation is being loaded — show a skeleton, not empty state. */
  isLoadingConversation?: boolean;
  /** Active conversation id (null = new chat). Used to remount ChatInput on conversation switch. */
  conversationId?: string | null;
  sendMessage: (
    content: string,
    fileIds?: string[],
    files?: import("@/types").ChatMessageFile[],
  ) => void;
  onModelChange?: (model: string | null) => void;
  onProviderChange?: (providerId: string | null) => void;
  onTemperatureChange?: (temperature: number | null) => void;
  onThinkingEffortChange?: (effort: "low" | "medium" | "high" | null) => void;
  onRegenerate?: (messageId: string) => void;
  slashContext?: import("./slash-commands").SlashCommandContext;
  slashCommands?: import("./slash-commands").SlashCommand[];
  queuedMessages?: import("@/hooks/use-chat").QueuedMessage[];
  onCancelQueued?: (id: string) => void;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  pendingQuestions?: AskUserQuestion[] | null;
  onAnswerQuestions?: (answers: AskUserAnswer[]) => void;
  onTodoAction?: (action: "dismiss" | "reset" | "snapshot") => void;
  onStop?: () => void;
  /** Rate-limit backoff note (PRD §7) — shown instead of a dead-looking turn. */
  rateLimitStatus?: string | null;
}

function ChatUI({
  messages,
  isConnected,
  isProcessing,
  isLoadingConversation,
  conversationId,
  sendMessage,
  onModelChange,
  onProviderChange,
  onTemperatureChange,
  onThinkingEffortChange,
  onRegenerate,
  slashContext,
  slashCommands,
  queuedMessages,
  onCancelQueued,
  messagesEndRef,
  scrollContainerRef,
  pendingQuestions,
  onAnswerQuestions,
  onTodoAction,
  onStop,
  rateLimitStatus,
}: ChatUIProps) {
  const tc = useTranslations("common");
  return (
    <div className="flex h-full w-full">
      {/* Centered ~760px message thread column (Terra editorial spec). */}
      <div className="mx-auto flex h-full w-full max-w-[760px] min-w-0 flex-1 flex-col">
        <div
          ref={scrollContainerRef}
          className="flex-1 scrollbar-thin overflow-y-auto px-2 py-4 sm:px-4 sm:py-6"
        >
          {isLoadingConversation ? (
            <ConversationSkeleton />
          ) : messages.length === 0 ? (
            <div className="flex h-full items-center">
              <ChatEmptyState onPick={(prompt) => sendMessage(prompt)} />
            </div>
          ) : (
            <MessageList
              messages={messages}
              onRegenerate={onRegenerate}
              onTodoDismiss={onTodoAction ? () => onTodoAction("dismiss") : undefined}
              isRegenerating={isProcessing}
              onStop={onStop}
            />
          )}
          {/* Thinking bar — shows as soon as the user sends a message and
              stays until the AI generates its first character/tool call.
              The RANDOM response orb (one of 25, picked once per response)
              leads the shimmering label + ticking elapsed badge on ONE
              items-center flex row — vertically centered, no drift. */}
          {isProcessing && !messages.some((m) => m.isStreaming) && (
            <div className="animate-slide-up-fade px-1 py-2">
              <ThinkingStatus onStop={onStop} />
            </div>
          )}
          {/* Rate-limit backoff (PRD §7): the runtime is retrying with
              exponential backoff — show a clear state instead of a
              dead-looking turn. Agent state is preserved; nothing is
              duplicated while this shows. */}
          {rateLimitStatus && (
            <div
              className="animate-slide-up-fade flex items-center gap-2 rounded-lg bg-foreground/[0.04] px-3 py-2 text-xs text-foreground/70"
              role="status"
              aria-live="polite"
            >
              <Hourglass className="text-primary h-3.5 w-3.5 shrink-0 animate-pulse" aria-hidden />
              <span className="min-w-0">{rateLimitStatus}</span>
            </div>
          )}
          {/* Todo tool: the live plan panel is rendered INLINE IN THE
              MESSAGE THREAD now — inside the assistant message that
              generated it, at the exact position where the todo tool ran
              (see MessageList / MessageItem). Nothing is pinned above the
              composer anymore. */}
          {/* Loading state: show empty state until the AI generates its first
              letter. When the user sends the first message, we keep the empty
              state visible (with the user's message below it) until the
              assistant starts streaming. This prevents the jarring instant
              switch to a blank MessageList. */}
          <div ref={messagesEndRef} />
        </div>{" "}
        {pendingQuestions && pendingQuestions.length > 0 && onAnswerQuestions && (
          <div className="px-2 pb-2 sm:px-4 sm:pb-2">
            <QuestionPrompt
              questions={pendingQuestions}
              disabled={!isConnected}
              onComplete={onAnswerQuestions}
            />
          </div>
        )}
        {/* Queued messages live next to the composer; the todo plan panel
            lives INSIDE the scroll container (inline in the response flow). */}
        <div className="px-2 pb-2 sm:px-4 sm:pb-4">
          {queuedMessages && queuedMessages.length > 0 && onCancelQueued && (
            <PendingMessages messages={queuedMessages} onCancel={onCancelQueued} />
          )}
          <div className="glass-card border-border focus-within:border-primary/40 rounded-2xl border transition-all input-focus-glow">
            <div className="px-2.5 pt-2.5 sm:px-4 sm:pt-4">
              <ChatInput
                key={conversationId ?? "new-chat"}
                onSend={sendMessage}
                disabled={
                  !isConnected ||
                  !!(pendingQuestions && pendingQuestions.length)
                }
                isProcessing={isProcessing}
                onStop={onStop}
                slashContext={slashContext}
                commands={slashCommands}
              />
            </div>
            <div className="border-foreground/8 flex items-center justify-between gap-2 border-t px-2.5 py-1.5 sm:px-4 sm:py-2">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={`inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] tracking-wider uppercase ${isConnected ? "text-muted-foreground" : "text-destructive"}`}
                >
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                      isConnected ? "bg-primary" : "bg-destructive"
                    }`}
                  />
                  {isConnected ? tc("live") : tc("offline")}
                </span>
              </div>
              <div className="flex min-w-0 items-center gap-1">
                {/* "⏎ to send" hint (Terra spec) */}
                <kbd className="mr-1 hidden select-none font-mono text-[10px] text-muted-foreground/60 sm:inline-flex">
                  ⏎ to send
                </kbd>
                <ChatControls
                  onModelChange={onModelChange}
                  onProviderSelect={(p) => onProviderChange?.(p ? p.id : null)}
                  onTemperatureChange={onTemperatureChange}
                  onThinkingEffortChange={onThinkingEffortChange}
                />
              </div>
            </div>
          </div>
          {/* Centered disclaimer below the composer card (Terra spec). */}
          <p className="text-muted-foreground/80 mt-2 text-center text-[11px]">
            OnyxAgent can make mistakes. Double-check important information.
          </p>
        </div>
      </div>
      <FilePreviewPanel />
      <SourcesPanel />
    </div>
  );
}

function ConversationSkeleton() {
  // Two faux turns — a frameless assistant turn (left) and a soft-terracotta
  // user card (right) — matching the Terra editorial message layout, so the
  // exchange doesn't pop when messages arrive.
  return (
    <div className="space-y-6 py-4 sm:py-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="bg-primary/30 h-4 w-4 animate-pulse rounded" />
          <div className="bg-foreground/10 h-3.5 w-24 animate-pulse rounded-md" />
        </div>
        <div className="bg-foreground/10 h-4 w-1/3 animate-pulse rounded-md" />
        <div className="bg-foreground/8 h-4 w-4/5 animate-pulse rounded-md" />
        <div className="bg-foreground/8 h-4 w-2/3 animate-pulse rounded-md" />
      </div>
      <div className="flex flex-col items-end gap-2">
        <div className="bg-accent border-border/60 h-10 w-1/3 animate-pulse rounded-2xl rounded-tr-sm border" />
        <div className="bg-accent border-border/60 h-10 w-1/5 animate-pulse rounded-2xl rounded-tr-sm border" />
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="bg-primary/30 h-4 w-4 animate-pulse rounded" />
          <div className="bg-foreground/10 h-3.5 w-24 animate-pulse rounded-md" />
        </div>
        <div className="bg-foreground/8 h-4 w-3/4 animate-pulse rounded-md" />
        <div className="bg-foreground/8 h-4 w-1/2 animate-pulse rounded-md" />
      </div>
    </div>
  );
}
