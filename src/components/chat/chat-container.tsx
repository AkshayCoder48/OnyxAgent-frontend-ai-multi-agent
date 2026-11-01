"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useChat } from "@/hooks";
import { ChatControls } from "./chat-controls";
import { ChatEmptyState } from "./chat-empty-state";
import { ChatInput } from "./chat-input";
// USER DIRECTIVE: the strips that used to sit above the composer are GONE —
// background-run progress + results land directly in the chat bubbles.
// The invisible lander keeps the polling + auto-landing machinery alive.
import { BackgroundTasksLander } from "./background-tasks-strip";
import { ContextIndicator } from "./context-indicator";
import { FilePreviewPanel } from "./file-preview-panel";
import { SourcesPanel } from "./sources-panel";
import { MessageList } from "./message-list";
import { PendingMessages } from "./pending-messages";
import { PollinationsConfirmDialog } from "./pollinations-confirm";
import { QuestionPrompt } from "@/components/ui";
import type { AskUserQuestion, AskUserAnswer } from "@/types";
import { useConversationStore, useChatStore, useAuthStore } from "@/stores";
import { reconcilePersisted, setPersistedConversationId } from "@/stores/chat-store";
import { useConversations } from "@/hooks";
import { useSlashCommands } from "@/hooks";
import { conversationMessageToChatMessage } from "@/lib/conversation-to-chat";
import { ThinkingIndicator } from "@/components/assistant-ui/elements";
import { genuiPerfLog } from "@/lib/genui/perf";
import { executionHub } from "@/lib/agent/execution-hub";
import { ArrowDown, Hourglass } from "lucide-react";
// PROJECTS (Task 1-b) — minimal, surgical additions: the project empty state
// swaps in for the generic one while a project workspace is open, and a
// conversation the RUNTIME creates mid-turn is claimed for the active
// project (see handleConversationCreated).
import { useActiveProject, useProjectsStore } from "@/lib/projects/store";
import { claimConversationForProject } from "@/components/projects/project-conversations";
import { ProjectEmptyState } from "@/components/projects/project-empty-state";

// ---------------------------------------------------------------------------
// LAST-ACTIVE CONVERSATION — a tiny localStorage companion to the in-memory
// selection so a FRESH page load on /chat (no ?id=, e.g. after a Settings
// visit and a reload) re-opens the thread the user was last in instead of
// an empty welcome screen. A deliberate "New Chat" persists null and is
// honored across reloads.
// ---------------------------------------------------------------------------
const LAST_ACTIVE_CONV_KEY = "onyx:last-conversation-id";

function setLastActiveConversation(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id === null) {
      window.localStorage.removeItem(LAST_ACTIVE_CONV_KEY);
    } else {
      window.localStorage.setItem(LAST_ACTIVE_CONV_KEY, id);
    }
  } catch {
    // Storage unavailable (private mode / quota) — non-fatal, session-only.
  }
}

function getLastActiveConversation(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LAST_ACTIVE_CONV_KEY);
  } catch {
    return null;
  }
}

const SCROLL_NEAR_BOTTOM_THRESHOLD_PX = 150;
/** Pinned at the TRUE bottom (not "near" it) — the only position that
 *  re-arms auto-follow after the user's scrolling settles. */
const PINNED_BOTTOM_PX = 4;
/** How long after the last USER scroll event the pinned-bottom re-arm check
 *  runs — the gesture must settle first, or the check fires mid-momentum. */
const REARM_SETTLE_MS = 350;
/** Programmatic scroll writes and their scroll events land within this
 *  window — those events must never re-arm follow (the OLD bug: our own
 *  ~33fps follow writes re-armed follow, so ANY scroll-up within 150px of
 *  the bottom was instantly yanked back down — "stuck to the bottom while
 *  streaming"). */
const PROGRAMMATIC_SCROLL_QUIET_MS = 120;

/**
 * SINGLE SCROLL OWNER (PRD §8–§11 — scroll jank fix, rev 2: the
 * "sticking to the bottom while streaming" fix, 2026-11-01).
 *
 * Rev 1 fixed the up/down oscillation (intent-based disengage, rAF-coalesced
 * container-scoped writes) but kept ONE position-based re-arm: any scroll
 * event landing within 150px of the bottom re-engaged auto-follow. During
 * streaming that re-armed on (a) OUR OWN follow writes — they land at
 * dist≈0 — and (b) every scroll-up that hadn't yet crossed 150px, so the
 * next flush snapped the user straight back down. Net effect: the user
 * could not scroll away from the stream — the reported "unwantedly sticking
 * us to bottom while streaming".
 *
 * Rev 2 rules:
 *   - DISENGAGE (auto-follow off): explicit user intent only — wheel-up,
 *     touch-drag-up, ArrowUp/PageUp/Home. Content growth can never
 *     masquerade as intent.
 *   - RE-ENGAGE (auto-follow on), in priority order:
 *       1. Explicit down-intent: wheel-down while near the bottom, or
 *          ArrowDown/PageDown/End keys.
 *       2. The "Jump to latest" pill (rendered while disengaged).
 *       3. A fresh USER message landing in the thread — always follow your
 *          own turn.
 *       4. The user manually settling PINNED at the true bottom (≤4px),
 *          checked 350ms after their LAST scroll event so mid-gesture
 *          positions never count. "Near" bottom (150px) does NOT re-arm.
 *   - Programmatic writes (ours) are timestamped; scroll events within
 *     120ms of one are ignored entirely — they can neither re-arm follow
 *     nor reset the settle debounce.
 *   - Writes stay container-scoped `scrollTop`/`scrollTo`, rAF-coalesced
 *     to at most one write per animation frame.
 */
function useChatScrollController(
  scrollContainerRef: React.RefObject<HTMLDivElement | null>,
  messages: unknown[],
) {
  /** True once the user takes the viewport; false again on explicit re-engage. */
  const userTookScrollRef = useRef(false);
  /** Pending rAF handle for the coalesced follow-bottom write. */
  const scrollRafRef = useRef<number | null>(null);
  /** Stable handle to the frame-scheduled follow (set once on mount). */
  const scheduleFollowRef = useRef<(() => void) | null>(null);
  /** Timestamp of the last PROGRAMMATIC scroll write (ours). */
  const lastProgrammaticWriteRef = useRef(0);
  /** Debounce timer for the settled pinned-bottom re-arm check. */
  const rearmTimerRef = useRef<number | null>(null);
  /** Mirror of userTookScrollRef for rendering the Jump pill. */
  const [followDisengaged, setFollowDisengaged] = useState(false);
  /** True when content arrived while disengaged (the pill's unread dot). */
  const [hasNewBelow, setHasNewBelow] = useState(false);

  const clearRearmTimer = useCallback(() => {
    if (rearmTimerRef.current !== null) {
      clearTimeout(rearmTimerRef.current);
      rearmTimerRef.current = null;
    }
  }, []);

  const disengage = useCallback(() => {
    clearRearmTimer();
    if (!userTookScrollRef.current) {
      userTookScrollRef.current = true;
      setFollowDisengaged(true);
    }
  }, [clearRearmTimer]);

  const engage = useCallback(() => {
    clearRearmTimer();
    if (userTookScrollRef.current) {
      userTookScrollRef.current = false;
      setFollowDisengaged(false);
    }
    setHasNewBelow(false);
  }, [clearRearmTimer]);

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

    /** Mark a scroll write as OURS so the scroll event it fires is ignored. */
    const writeScrollTop = (top: number) => {
      lastProgrammaticWriteRef.current = performance.now();
      container.scrollTop = top;
    };

    // The ONE scroll write path: container-scoped, instant, frame-scheduled,
    // and re-checked inside the frame (a user scroll arriving mid-frame wins).
    const scheduleFollowBottom = () => {
      if (scrollRafRef.current !== null) return; // already scheduled this frame
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        if (userTookScrollRef.current) {
          // Disengaged and content still arriving → unread marker on the pill.
          setHasNewBelow(true);
          return;
        }
        genuiPerfLog("Scroll", "follow-bottom");
        writeScrollTop(container.scrollHeight);
      });
    };
    scheduleFollowRef.current = scheduleFollowBottom;

    // ── USER INTENT: only explicit user input toggles auto-follow ──
    // Keyboard toggles only when the keys aren't being typed into an editor
    // (ArrowUp/Down in the composer must never move the thread).
    const isEditableTarget = (t: EventTarget | null) =>
      t instanceof HTMLElement &&
      (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        disengage();
      } else if (distFromBottom() <= SCROLL_NEAR_BOTTOM_THRESHOLD_PX) {
        engage(); // wheeling down near the bottom = heading to the latest
      }
    };
    let lastTouchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      lastTouchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (lastTouchY !== null && y !== undefined && y > lastTouchY + 3) {
        // Finger moving down = dragging content up = user scrolling up.
        disengage();
      }
      lastTouchY = y ?? lastTouchY;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") {
        disengage();
      } else if (e.key === "ArrowDown" || e.key === "PageDown" || e.key === "End") {
        engage();
      }
    };

    // ── POSITION re-arm (rev 2): only PINNED at the true bottom, only after
    // the user's scrolling has SETTLED, and never for our own writes. A
    // scroll event inside the programmatic quiet window is ignored outright
    // (the old code re-armed on every follow write — the sticking bug).
    const onScroll = () => {
      if (performance.now() - lastProgrammaticWriteRef.current < PROGRAMMATIC_SCROLL_QUIET_MS) {
        return; // our own write — not user intent, not a settle
      }
      if (rearmTimerRef.current !== null) clearTimeout(rearmTimerRef.current);
      rearmTimerRef.current = window.setTimeout(() => {
        rearmTimerRef.current = null;
        if (userTookScrollRef.current && distFromBottom() <= PINNED_BOTTOM_PX) {
          engage();
        }
      }, REARM_SETTLE_MS);
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKeyDown);

    return () => {
      clearRaf();
      clearRearmTimer();
      scheduleFollowRef.current = null;
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKeyDown);
    };
    // The container element is stable for ChatContainer's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disengage, engage]);

  // Follow the bottom when messages update — through the frame scheduler,
  // so a burst of flushes still produces at most one scroll write per frame.
  // A fresh USER message re-engages first: always follow your own turn.
  const lastUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    const last = messages[messages.length - 1] as { id?: string; role?: string } | undefined;
    if (last && last.role === "user" && typeof last.id === "string" && last.id !== lastUserIdRef.current) {
      lastUserIdRef.current = last.id;
      engage();
    }
    scheduleFollowRef.current?.();
  }, [messages, engage]);

  /** Explicit re-engage + smooth scroll to the very bottom (the pill). */
  const jumpToBottom = useCallback(() => {
    engage();
    const container = scrollContainerRef.current;
    if (!container) return;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    lastProgrammaticWriteRef.current = performance.now();
    container.scrollTo({
      top: container.scrollHeight,
      behavior: reduced ? "auto" : "smooth",
    });
  }, [engage, scrollContainerRef]);

  return {
    /** Render the "Jump to latest" pill while auto-follow is off. */
    showJump: followDisengaged && messages.length > 0,
    /** Unread marker — content arrived while the view was parked. */
    hasNewBelow,
    jumpToBottom,
  };
}

/**
 * Thinking status line shown between send and first token: the canonical
 * ThinkingIndicator — pulsing dot + STATIC "Thinking" label (Realtime PRD:
 * no orb glyph, no shimmering words; the companion carries the
 * personality). No status pill, no elapsed clock, no pause button — the
 * composer's stop button stops the turn. Mounts fresh per turn.
 */
function ThinkingStatus() {
  return <ThinkingIndicator label="Thinking" className="px-1" />;
}

export function ChatContainer(
  { onOpenSettings }: { onOpenSettings?: () => void } = {},
) {
  // SELECTOR-BASED SUBSCRIPTIONS (render isolation — the previous
  // no-selector destructure re-rendered this whole 900-line container on
  // ANY chat/conversation store field change). currentMessages is
  // legitimately subscribed (the DB-paint effect) — it only changes
  // identity when a conversation load lands, not per streaming tick.
  const currentConversationId = useConversationStore(
    (s) => s.currentConversationId,
  );
  const currentMessages = useConversationStore((s) => s.currentMessages);
  const hydratedConversationId = useConversationStore(
    (s) => s.hydratedConversationId,
  );
  const isConversationLoading = useConversationStore((s) => s.isLoading);
  const replaceAllMessages = useChatStore((s) => s.replaceAllMessages);
  const restorePersisted = useChatStore((s) => s.restorePersisted);
  const { fetchConversations, selectConversation } = useConversations();
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
        // PROJECTS: a turn started from inside a project workspace (its empty
        // state / "new chat") created this conversation WITHOUT a project id
        // (use-chat's creation call has no project notion). Claim it for the
        // ACTIVE project — best-effort, never blocks the streaming turn.
        const activeProjectId = useProjectsStore.getState().activeProjectId;
        if (activeProjectId) {
          void claimConversationForProject(conversationId, activeProjectId);
        }
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

  // SINGLE SCROLL OWNER (PRD §8–§11, rev 2): the one controller for the chat
  // scroll container — user-intent based auto-follow, container-scoped writes,
  // rAF-coalesced to at most one scroll per animation frame, re-armed ONLY by
  // explicit down-intent / the Jump pill / a fresh user message / settling
  // PINNED at the true bottom (never by our own writes — the sticking bug).
  const { showJump, hasNewBelow, jumpToBottom } = useChatScrollController(
    scrollContainerRef,
    messages,
  );

  // Tracks which conversation's messages are CURRENTLY loaded into the chat
  // store. The load-effect (below) uses this to decide whether to (re)load.
  const loadedConvIdRef = useRef<string | null | undefined>(undefined);

  // Tracks whether the LAST conversation ID change was a null → ID transition
  // (i.e. a new chat being saved). Set by the clear-effect, read by the
  // load-effect. This is needed because the clear-effect updates
  // prevConversationIdRef BEFORE the load-effect runs, so the load-effect
  // can't check "was the previous ID null?" by reading prevConversationIdRef.
  const wasNewChatTransitionRef = useRef(false);

  // The exact messages ARRAY last painted into the chat store by the
  // load-effect. A NEW array reference for the same conversation (a fresh
  // DB fetch landing after the mount-refresh below, or server-appended
  // messages) repaints; an unchanged reference is a no-op.
  const paintedMessagesRef = useRef<unknown[] | null>(null);

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
      // when they belong to a different conversation, and the orphan guard
      // inside drops key-less/foreign snapshots.
      restorePersisted(currId);
      // Remember the selection as the last-active conversation so a fresh
      // page load on /chat (no ?id=) can restore it (see the restore effect
      // below). On the INITIAL mount only a REAL selection is recorded —
      // writing null here would wipe the marker before the restore effect
      // below reads it (a fresh load starts unselected). A deliberate
      // "New Chat" writes null via the id-change path below.
      if (currId) setLastActiveConversation(currId);
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
      // NAVIGATION NEVER ABORTS (spec §7/§29/§30): switching conversations
      // DETACHES the UI from any running execution — it does NOT stop it.
      // The ExecutionHub (module-level) keeps streaming the old conversation's
      // agent, keeps checkpointing it to Dexie, and the sidebar's "Running"
      // list keeps showing it. When the user comes back, the load-effect
      // below sees the live execution and re-subscribes to its store.
      clearMessages();
      // Drop any pending queue when switching threads — those messages were
      // typed in the previous conversation's context, sending them into a
      // different conversation would surprise the user.
      clearQueued();
      // NOTE: the model + provider selection is deliberately NOT reset here.
      // The selection is session-level state owned by the chat store (single
      // source of truth) and survives conversation switches.
    }

    // Reset the loaded-conversation tracker so the load-effect re-loads
    // messages for the new conversation. Without this, switching A → B → A
    // would skip loading A's messages because `loadedConvIdRef` still held
    // "A" from the first visit — the load-effect would think A was already
    // loaded and short-circuit, leaving the chat store empty.
    loadedConvIdRef.current = null;
    paintedMessagesRef.current = null;

    // Track the last-active conversation for the fresh-load restore below.
    setLastActiveConversation(currId);

    // Remember which conversation the persisted messages belong to.
    setPersistedConversationId(currId);

    prevConversationIdRef.current = currId;
  }, [currentConversationId, clearMessages, clearQueued, restorePersisted]);

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

    // LIVE EXECUTION GATE: when the ExecutionHub has a running execution for
    // this conversation, its store IS the live view (seeded with this
    // conversation's history + streaming now) — painting the DB copy would
    // REPLACE live content with a stale snapshot. Mark as loaded and let the
    // execution store drive the UI (useChat's merged message source).
    if (executionHub.getFor(currentConversationId)?.status === "running") {
      loadedConvIdRef.current = currentConversationId;
      return;
    }

    // Messages must belong to the conversation that is currently selected.
    // Until they do, keep whatever the chat store already shows (restored
    // sessionStorage messages or a previous paint) — never blank out.
    if (hydratedConversationId !== currentConversationId) return;

    // Already painted THIS EXACT array for this conversation — a re-run with
    // unchanged deps (or an unrelated store update) must not clear + re-add
    // the same messages. A NEW array reference for the same id (a fresh DB
    // fetch from the mount-refresh below, or server-appended messages)
    // repaints with the newer copy.
    if (
      loadedConvIdRef.current === currentConversationId &&
      paintedMessagesRef.current === currentMessages
    ) {
      return;
    }

    // REMOUNT PROTECTION (the "chat gone empty after visiting Settings"
    // bug): on a FRESH mount of this component (route round-trip, e.g.
    // chat → settings → chat) the conversation store's `currentMessages`
    // can be STALE or outright EMPTY for the selected conversation —
    // runtime-created conversations hydrate via `attachConversation`, which
    // marks them hydrated with `currentMessages: []` because the live chat
    // store was authoritative. Painting that array here would clearMessages()
    // — wiping the SURVIVING live thread (zustand stores survive route
    // changes) and leaving the chat empty until the user switched chats.
    // When the chat store already holds this conversation's messages, they
    // are at least as fresh as any snapshot: keep them and let the
    // mount-refresh effect land the authoritative DB copy.
    if (loadedConvIdRef.current === undefined) {
      const surviving = useChatStore.getState().messages;
      const survivorsBelongToSelection =
        surviving.length > 0 &&
        surviving.every(
          (m) => m.conversationId == null || m.conversationId === currentConversationId,
        );
      if (survivorsBelongToSelection) {
        loadedConvIdRef.current = currentConversationId;
        paintedMessagesRef.current = currentMessages; // consume the stale array
        return;
      }
    }

    // Mark as painted BEFORE mutating so a synchronous re-render doesn't
    // double-apply.
    loadedConvIdRef.current = currentConversationId;
    paintedMessagesRef.current = currentMessages;

    // BATCHED PAINT (perf PRD §6): the old path issued clearMessages() + N
    // sequential addChatMessage() store writes — each one a full
    // subscription/render pass over the whole thread (O(N²) render work;
    // a 200-message switch painted ~20k component renders and visibly
    // froze low-end devices). One replaceAllMessages write lands the
    // entire array in a single pass.
    const painted: import("@/types").ChatMessage[] = [];
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
      painted.push(chatMsg);
    });
    replaceAllMessages(painted);
  }, [currentMessages, hydratedConversationId, replaceAllMessages, currentConversationId]);

  // ── MOUNT REFRESH ─────────────────────────────────────────────────────
  // Once per mount: when the selected conversation is ALREADY marked
  // hydrated in the conversation store (a remount after a route round-trip,
  // e.g. chat → settings → chat), no loader will ever re-fetch it — yet its
  // `currentMessages` may be stale or empty (runtime-created conversations
  // attach with []). Fetch the authoritative DB copy in the background and
  // land it via setMessagesFor; the NEW array reference makes the load-effect
  // above repaint (paintedMessagesRef mismatch) with the full, fresh thread.
  // The surviving chat-store messages stay on screen until the fetch lands —
  // no destructive clear, no empty flash.
  useEffect(() => {
    const id = useConversationStore.getState().currentConversationId;
    if (!id) return;
    // Only refresh conversations the store considers already-hydrated: one
    // that isn't hydrated yet is being fetched right now by the URL
    // auto-hydration / sidebar selection (double fetch would be redundant).
    if (useConversationStore.getState().hydratedConversationId !== id) return;
    // A live turn is authoritative — never repaint over it.
    if (useChatStore.getState().isStreaming) return;
    if (executionHub.getFor(id)?.status === "running") return;
    let cancelled = false;
    void (async () => {
      try {
        const { conversationService } = await import("@/lib/services");
        const userId = useAuthStore.getState().user?.id;
        const msgs = await conversationService.getMessages(id, userId);
        if (cancelled) return;
        const st = useConversationStore.getState();
        // setMessagesFor drops the result unless this conversation is still
        // the selected one (stale-fetch guard inside).
        if (st.currentConversationId === id) {
          st.setMessagesFor(id, msgs);
        }
      } catch {
        // Non-fatal — the surviving chat-store messages stay on screen.
      }
    })();
    return () => {
      cancelled = true;
    };
    // Mount-only by design: one refresh per ChatContainer mount.
  }, []);

  // ── LAST-ACTIVE RESTORE ───────────────────────────────────────────────
  // Landing on /chat with NO conversation selected (a fresh page load with
  // no ?id= — e.g. after visiting Settings and coming back) re-selects the
  // LAST ACTIVE conversation instead of showing an empty welcome screen over
  // an existing thread. Guards: nothing selected yet this session, no ?id in
  // the URL (auto-hydration owns that path), chat store empty (a deliberate
  // new-chat/draft state is respected), and a non-null last-active id (a
  // deliberate "New Chat" persists null and is honored).
  useEffect(() => {
    const st = useConversationStore.getState();
    if (st.currentConversationId !== null) return;
    if (new URLSearchParams(window.location.search).get("id")) return;
    if (useChatStore.getState().messages.length > 0) return;
    const lastId = getLastActiveConversation();
    if (!lastId) return;
    // Guarded loader: atomically selects + fetches; drops the selection when
    // the conversation no longer exists (verifyInList).
    void selectConversation(lastId, { verifyInList: true });
  }, [selectConversation]);
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

  // EDIT USER MESSAGE: drops the edited prompt + everything after it, then
  // re-runs the turn with the edited text (same attachments). Guarded
  // against live executions inside the hook itself.
  const handleEditUserMessage = useCallback(
    (userMessageId: string, newContent: string) => {
      editUserMessage(userMessageId, newContent);
    },
    [editUserMessage],
  );

  // Slash command handlers — passed down to ChatInput so the / palette can
  // run them locally without going through the agent.
  //
  // PERF: memoized + reading `messages` through a ref. This object was
  // rebuilt on every ChatContainer render (i.e. every store flush while
  // streaming) — an unstable `slashContext` prop defeats ChatInput's
  // React.memo, forcing a full composer re-render per token.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const slashContext = useMemo(() => ({
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
      const msgs = messagesRef.current;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
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
    // `/image <prompt>` — DIRECT image generation (user request 2026-10-21:
    // "add /image that directly triggers image gen, not call the text api").
    // The prompt rides back through sendMessage as a marked /image line so
    // use-chat's intercept owns the handling (one code path for palette
    // runs, pasted shorthand, and queued messages).
    generateImage: (prompt: string) => {
      void sendMessage(`/image ${prompt}`);
    },
  }), [currentConversationId, clearMessages, handleRegenerate, onOpenSettings, sendMessage]);

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
      slashContext={slashContext}
      slashCommands={slashCommands}
      queuedMessages={queuedMessages}
      onCancelQueued={cancelQueued}
      messagesEndRef={messagesEndRef}
      scrollContainerRef={scrollContainerRef}
      showJumpToLatest={showJump}
      hasNewBelow={hasNewBelow}
      onJumpToLatest={jumpToBottom}
      pendingQuestions={pendingQuestions}
      onAnswerQuestions={sendAskUserResponses}
      onTodoAction={sendTodoAction}
      onStop={stopGeneration}
      onRegenerate={handleRegenerate}
      onEditUserMessage={handleEditUserMessage}
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
  slashContext?: import("./slash-commands").SlashCommandContext;
  slashCommands?: import("./slash-commands").SlashCommand[];
  queuedMessages?: import("@/hooks/use-chat").QueuedMessage[];
  onCancelQueued?: (id: string) => void;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** Scroll owner (rev 2): render the Jump pill while auto-follow is off. */
  showJumpToLatest?: boolean;
  /** True when content arrived while the view was parked (unread dot). */
  hasNewBelow?: boolean;
  /** Explicit re-engage — the pill's click handler. */
  onJumpToLatest?: () => void;
  pendingQuestions?: AskUserQuestion[] | null;
  onAnswerQuestions?: (answers: AskUserAnswer[]) => void;
  onTodoAction?: (action: "dismiss" | "reset" | "snapshot") => void;
  onStop?: () => void;
  /** Message-action row (assistant-ui "Message actions"): re-run the turn
   *  that produced an assistant message. */
  onRegenerate?: (assistantMessageId: string) => void;
  /** User-message actions: edit a sent prompt + re-run the turn from it. */
  onEditUserMessage?: (userMessageId: string, newContent: string) => void;
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
  slashContext,
  slashCommands,
  queuedMessages,
  onCancelQueued,
  messagesEndRef,
  scrollContainerRef,
  showJumpToLatest,
  hasNewBelow,
  onJumpToLatest,
  pendingQuestions,
  onAnswerQuestions,
  onTodoAction,
  onStop,
  onRegenerate,
  onEditUserMessage,
  rateLimitStatus,
}: ChatUIProps) {
  const tc = useTranslations("common");
  // PROJECTS: while a project workspace is open, the zero-message screen is
  // the PROJECT's own empty state (orb + name + goal + suggestions that
  // populate THIS composer) instead of the generic welcome.
  const activeProject = useActiveProject();

  // PERF (streaming-perf PRD): these two were inline closures recreated on
  // every ChatUI render — i.e. on EVERY store flush while streaming. They
  // flowed into MessageList → MessageItem and ChatControls, defeating the
  // memoization that keeps settled messages and the composer from
  // re-rendering per token. Hoisted + stable.
  const handleTodoDismiss = useCallback(() => onTodoAction?.("dismiss"), [onTodoAction]);
  const handleProviderSelect = useCallback(
    (p: { id: string } | null) => onProviderChange?.(p ? p.id : null),
    [onProviderChange],
  );
  return (
    <div className="flex h-full w-full">
      {/* Centered ~760px message thread column (Terra editorial spec). The
          companion is the INLINE cursor riding the response stream
          (CompanionCursor in markdown-content) — no floating pet. */}
      <div className="mx-auto flex h-full w-full max-w-[760px] min-w-0 flex-1 flex-col">
        {/* Relative wrapper hosts the "Jump to latest" pill — the explicit
            re-engage affordance shown while auto-follow is disengaged (scroll
            owner rev 2). Without it, leaving the stream mid-answer had no way
            back except fighting the follow. */}
        <div className="relative min-h-0 flex-1">
        <div
          ref={scrollContainerRef}
          className="scrollbar-thin h-full overflow-y-auto px-2 py-4 sm:px-4 sm:py-6"
        >
          {isLoadingConversation ? (
            <ConversationSkeleton />
          ) : messages.length === 0 ? (
            <div className="flex h-full items-center">
              {activeProject ? (
                <ProjectEmptyState project={activeProject} />
              ) : (
                <ChatEmptyState onPick={(prompt) => sendMessage(prompt)} />
              )}
            </div>
          ) : (
            // Chat switching (PRD §20): the conversation store clears +
            // reloads messages — keying the wrapper on the conversation id
            // replays a light 150ms opacity cross-fade (.mb-thread-in) so
            // the new thread settles in instead of hard-cutting. Opacity
            // only: the thread can be a large subtree, so no blur/transform
            // here (mobile perf rule).
            <div key={conversationId ?? "new-chat"} className="mb-thread-in">
              <MessageList
                messages={messages}
                onTodoDismiss={onTodoAction ? handleTodoDismiss : undefined}
                onRegenerate={onRegenerate}
                onEditUserMessage={onEditUserMessage}
              />
            </div>
          )}
          {/* Thinking bar — shows as soon as the user sends a message and
              stays until the AI generates its first character/tool call:
              pulsing dot + static "Thinking" label (no orb, no shimmer). */}
          {isProcessing && !messages.some((m) => m.isStreaming) && (
            <div className="animate-slide-up-fade px-1 py-2">
              <ThinkingStatus />
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
        </div>
        {/* JUMP TO LATEST (scroll owner rev 2) — the explicit re-engage
            affordance while auto-follow is disengaged. The unread dot marks
            content that arrived while the view was parked; clicking smooth
            scrolls to the very bottom and re-engages the follow. */}
        {showJumpToLatest && onJumpToLatest && (
          <button
            type="button"
            onClick={onJumpToLatest}
            aria-label="Jump to the latest messages"
            className="border-border bg-background/85 text-foreground/85 hover:bg-accent hover:text-foreground absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur transition-colors"
          >
            <ArrowDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="whitespace-nowrap">Jump to latest</span>
            {hasNewBelow && (
              <span
                className="bg-primary h-1.5 w-1.5 shrink-0 rounded-full"
                aria-hidden
              />
            )}
          </button>
        )}
        </div>{" "}
        {/* Pollinations media_generation two-step confirmation — the tool
            BLOCKS until this dialog dispatches a response (same mount slot
            as QuestionPrompt; self-subscribes to the Pollinations store). */}
        <div className="px-2 sm:px-4">
          <PollinationsConfirmDialog />
        </div>
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
          {/* Invisible background-run lander (USER DIRECTIVE: no strips above
              the composer) — polls Trigger.dev Cloud runs and lands finished
              results directly in their conversations' chat bubbles. */}
          <BackgroundTasksLander />
          {queuedMessages && queuedMessages.length > 0 && onCancelQueued && (
            <PendingMessages messages={queuedMessages} onCancel={onCancelQueued} />
          )}
          <div className="glass-card border-border focus-within:border-primary/40 rounded-2xl border transition-[border-color,box-shadow] input-focus-glow">
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
                {/* Context usage pill (Onyx Infinite Context PRD §29) — opens
                    the inspector popover on click. */}
                <ContextIndicator />
              </div>
              <div className="flex min-w-0 items-center gap-1">
                {/* "⏎ to send" hint (Terra spec) */}
                <kbd className="mr-1 hidden select-none font-mono text-[10px] text-muted-foreground/60 sm:inline-flex">
                  ⏎ to send
                </kbd>
                <ChatControls
                  onModelChange={onModelChange}
                  onProviderSelect={handleProviderSelect}
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
