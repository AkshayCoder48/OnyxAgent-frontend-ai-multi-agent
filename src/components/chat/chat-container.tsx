"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { useChat } from "@/hooks";
import { ChatControls } from "./chat-controls";
import { ChatEmptyState } from "./chat-empty-state";
import { ChatInput } from "./chat-input";
import { FilePreviewPanel } from "./file-preview-panel";
import { SourcesPanel } from "./sources-panel";
import { MessageList } from "./message-list";
import { PendingMessages } from "./pending-messages";
import { ResearchPanel } from "./research-panel";
import { ToolApprovalDialog } from "./tool-approval-dialog";
import { QuestionPrompt } from "@/components/ui";
import type { PendingApproval, AskUserQuestion, AskUserAnswer, Decision } from "@/types";
import { useConversationStore, useChatStore } from "@/stores";
import { reconcilePersisted, setPersistedConversationId } from "@/stores/chat-store";
import { useConversations } from "@/hooks";
import { useSlashCommands } from "@/hooks";
import { useSingleRoundMode } from "@/hooks/use-single-round-mode";
import { conversationMessageToChatMessage } from "@/lib/conversation-to-chat";
import { Orb, ThinkingIndicator } from "@/components/assistant-ui/elements";
import { Zap } from "lucide-react";

const SCROLL_NEAR_BOTTOM_THRESHOLD_PX = 150;

/**
 * Thinking status line shown between send and first token: the Orb lattice
 * glyph + the ThinkingIndicator element (pulsing dot, shimmering label,
 * ticking elapsed badge). Mounts fresh per turn, so the elapsed clock
 * starts from zero each time.
 */
function ThinkingStatus() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const id = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, []);
  return (
    <>
      <Orb variant="S1" />
      <ThinkingIndicator label="Thinking" elapsed={`${elapsed}s`} />
    </>
  );
}

export function ChatContainer({ onOpenSettings }: { onOpenSettings?: () => void } = {}) {
  const {
    currentConversationId,
    currentMessages,
    isLoading: isConversationLoading,
  } = useConversationStore();
  const { addMessage: addChatMessage } = useChatStore();
  const { fetchConversations } = useConversations();
  const { singleRoundMode, toggleSingleRoundMode } = useSingleRoundMode();
  const prevConversationIdRef = useRef<string | null | undefined>(undefined);

  const handleConversationCreated = useCallback(() => {
    fetchConversations();
  }, [fetchConversations]);

  const {
    messages,
    isConnected,
    isProcessing,
    sendMessage,
    stopGeneration,
    clearMessages,
    queuedMessages,
    cancelQueued,
    clearQueued,
    setModel,
    setProviderId,
    setTemperature,
    setThinkingEffort,
    pendingApproval,
    sendResumeDecisions,
    pendingQuestions,
    sendAskUserResponses,
    sendTodoAction,
  } = useChat({
    conversationId: currentConversationId,
    onConversationCreated: handleConversationCreated,
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // true = user deliberately scrolled up; suppress auto-scroll until they return to bottom
  const userScrolledUpRef = useRef(false);

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
    wasNewChatTransitionRef.current = (prevId === null && currId !== null);

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
      // Reset model + provider selection so it doesn't leak into the new chat.
      setModel(null);
      setProviderId(null);
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
  }, [currentConversationId, clearMessages, clearQueued, setModel, setProviderId, isProcessing, stopGeneration]);

  // Load DB messages into the chat store when the conversation changes OR when
  // currentMessages populates after a fetch.
  //
  // CRITICAL: when a new chat is created (conversationId goes from null → new ID),
  // the user's message is ALREADY in the chat store (added by use-chat.ts before
  // the runtime creates the conversation). We must NOT clear it. The
  // `prevConversationIdRef` tracks the previous ID so we can detect the
  // null → ID transition and skip the load (the messages are already there).
  useEffect(() => {
    // No conversation selected — nothing to load. Reset the loaded-id tracker
    // so a subsequent selection of a previously-loaded conversation reloads.
    if (!currentConversationId) {
      loadedConvIdRef.current = null;
      return;
    }

    // Already loaded this conversation's messages into the chat store — skip.
    if (loadedConvIdRef.current === currentConversationId) return;

    // NEW CHAT TRANSITION: if we just went from null → new ID, the user's
    // message is already in the chat store (added by use-chat.ts). Don't
    // clear it — just mark as loaded so we don't try to load again.
    // This flag is set by the clear-effect which runs BEFORE this effect.
    //
    // BUT: on page refresh, the conversation store starts with null, then
    // fetchConversations() sets it to the URL's ?id=. This is ALSO a
    // null→ID transition, but it's NOT a new chat — it's loading an
    // existing conversation. We distinguish by checking if the chat store
    // has any messages (new chat = user message already added; page load
    // = empty chat store).
    if (wasNewChatTransitionRef.current) {
      wasNewChatTransitionRef.current = false; // consume the flag
      const existingMessages = useChatStore.getState().messages;
      if (existingMessages.length > 0) {
        // Real new chat — user's message is in the store. Don't load.
        loadedConvIdRef.current = currentConversationId;
        setPersistedConversationId(currentConversationId);
        return;
      }
      // Page refresh — chat store is empty, need to load from DB.
      // Fall through to the normal loading logic below.
    }

    // Mark as loaded BEFORE mutating so a synchronous re-render doesn't double-
    // apply.
    loadedConvIdRef.current = currentConversationId;

    clearMessages();
    if (currentMessages.length === 0) {
      // Reset the ref so the effect re-fires when messages arrive.
      loadedConvIdRef.current = null;
      return;
    }

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
  }, [currentMessages, addChatMessage, clearMessages, currentConversationId]);

  // Track whether the user has manually scrolled up so we don't hijack their position
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      userScrolledUpRef.current = distFromBottom > SCROLL_NEAR_BOTTOM_THRESHOLD_PX;
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll on every messages update unless user has scrolled up.
  // PERF: Use `behavior: "auto"` (instant) instead of "smooth" during
  // streaming. `smooth` triggers a compositor animation on every 30ms
  // text-delta flush, which stacks up and causes the browser to jank /
  // freeze. Instant scroll is invisible to the user because the content
  // is already at the bottom — there's nothing to animate.
  useEffect(() => {
    if (userScrolledUpRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [messages]);

  const { commands: slashCommands } = useSlashCommands();

  const handleRegenerate = useCallback(
    (assistantMessageId: string) => {
      const idx = messages.findIndex((m) => m.id === assistantMessageId);
      if (idx < 0) return;
      for (let i = idx - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role === "user") {
          sendMessage(m.content, m.fileIds, m.files);
          return;
        }
      }
    },
    [messages, sendMessage],
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
      pendingApproval={pendingApproval}
      onResumeDecisions={sendResumeDecisions}
      pendingQuestions={pendingQuestions}
      onAnswerQuestions={sendAskUserResponses}
      onTodoAction={sendTodoAction}
      onStop={stopGeneration}
      conversationId={currentConversationId}
      singleRoundMode={singleRoundMode}
      onToggleSingleRound={toggleSingleRoundMode}
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
  pendingApproval?: PendingApproval | null;
  onResumeDecisions?: (decisions: Decision[]) => void;
  pendingQuestions?: AskUserQuestion[] | null;
  onAnswerQuestions?: (answers: AskUserAnswer[]) => void;
  onTodoAction?: (action: "dismiss" | "reset" | "snapshot") => void;
  onStop?: () => void;
  /** Single-round mode state for the Zap toggle in ChatInput. */
  singleRoundMode?: boolean;
  onToggleSingleRound?: () => void;
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
  pendingApproval,
  onResumeDecisions,
  pendingQuestions,
  onAnswerQuestions,
  onTodoAction,
  onStop,
  singleRoundMode,
  onToggleSingleRound,
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
            <MessageList messages={messages} onRegenerate={onRegenerate} />
          )}
          {/* Thinking bar — shows as soon as the user sends a message and
              stays until the AI generates its first character/tool call.
              assistant-ui "ThinkingIndicator" + "Orb" elements: a pulsing
              dot + shimmering label + ticking elapsed badge, led by the Orb
              lattice indicator. */}
          {isProcessing && !messages.some((m) => m.isStreaming) && (
            <div className="animate-slide-up-fade flex items-center gap-2.5 px-1 py-3">
              <ThinkingStatus />
            </div>
          )}
          {/* Todo tool: live plan panel rendered INLINE IN THE RESPONSE FLOW
              (on the ai response bar — not a stuck card above the prompt
              box). The agent emits `todo_event` WS frames for every plan
              mutation; this panel renders the live TodoList-element
              checklist with a progress bar and a "Cut" button. */}
          {onTodoAction && (
            <ResearchPanel onDismiss={() => onTodoAction("dismiss")} />
          )}
          {/* Loading state: show empty state until the AI generates its first
              letter. When the user sends the first message, we keep the empty
              state visible (with the user's message below it) until the
              assistant starts streaming. This prevents the jarring instant
              switch to a blank MessageList. */}
          <div ref={messagesEndRef} />
        </div>{" "}
        {pendingApproval && onResumeDecisions && (
          <div className="px-2 pb-2 sm:px-4 sm:pb-2">
            <ToolApprovalDialog
              actionRequests={pendingApproval.actionRequests}
              reviewConfigs={pendingApproval.reviewConfigs}
              onDecisions={onResumeDecisions}
              disabled={!isConnected}
            />
          </div>
        )}
        {pendingQuestions && pendingQuestions.length > 0 && onAnswerQuestions && (
          <div className="px-2 pb-2 sm:px-4 sm:pb-2">
            <QuestionPrompt
              questions={pendingQuestions}
              disabled={!isConnected}
              onComplete={onAnswerQuestions}
            />
          </div>
        )}
        {/* Single-round mode indicator + queued messages live next to the
            composer; the todo plan panel now lives INSIDE the scroll
            container (inline in the response flow) above. */}
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
                  !!pendingApproval ||
                  !!(pendingQuestions && pendingQuestions.length)
                }
                isProcessing={isProcessing}
                onStop={onStop}
                slashContext={slashContext}
                commands={slashCommands}
                singleRoundMode={singleRoundMode}
                onToggleSingleRound={onToggleSingleRound}
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
                {singleRoundMode && (
                  <span className="bg-primary/10 text-primary inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold tracking-wider uppercase">
                    <Zap className="h-2.5 w-2.5 fill-current" />
                    1-Round
                  </span>
                )}
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
