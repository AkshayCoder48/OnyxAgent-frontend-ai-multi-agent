"use client";

import { useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { conversationService } from "@/lib/services";
import { useAuthStore } from "@/stores";
import { qk } from "@/lib/query-keys";
import { getErrorMessage, setUrlParam } from "@/lib/utils";
import { useConversationStore, useChatStore } from "@/stores";
import type { Conversation } from "@/types";

const PAGE_SIZE = 30;

/**
 * Read the current user id from the auth store. Throws a friendly error if no
 * user is signed in — every call to `conversationService` needs the id so
 * Dexie can scope the query.
 */
function useUserId(): () => string {
  return useCallback(() => {
    const userId = useAuthStore.getState().user?.id;
    if (!userId) {
      throw new Error("You must be signed in to access conversations.");
    }
    return userId;
  }, []);
}

export function useConversations() {
  const queryClient = useQueryClient();
  const getUserId = useUserId();
  // Subscribe to auth store so the query re-enables when the user loads.
  const userId = useAuthStore((s) => s.user?.id);
  const {
    currentConversationId,
    currentMessages,
    hydratedConversationId,
    isLoading: selectLoading,
    error,
    setCurrentConversationId,
    setMessagesFor,
    setLoading,
    setError,
  } = useConversationStore();
  const { clearMessages } = useChatStore();
  const hasMoreRef = useRef(true);
  // Tracks the in-flight message fetch so a rapid conversation switch can abort
  // the previous request — otherwise a slower earlier fetch could resolve last
  // and overwrite the messages of the conversation the user actually selected.
  const messagesAbortRef = useRef<AbortController | null>(null);
  // Monotonic request id — incremented on every `selectConversation` /
  // `fetchConversations`-driven message fetch. After each await, we compare
  // the captured id against the latest; if they differ, a newer select
  // superseded us and we must NOT touch the store. This is defense-in-depth
  // on top of the AbortController guard (the controller only flips aborted
  // for the PREVIOUS request, but IndexedDB queries can't actually be
  // cancelled — both guards together cover every interleaving).
  const selectRequestIdRef = useRef(0);

  // React Query owns the list: cached across navigations, deduped, no refetch
  // storms. Both active and archived are fetched in one call so the sidebar
  // tabs can partition them client-side. Mutations patch the cache directly.
  const { data: conversations = [], isLoading: listLoading } = useQuery({
    queryKey: qk.conversations.list(),
    queryFn: async () => {
      const userId = getUserId();
      const items = await conversationService.list(userId, {
        limit: PAGE_SIZE,
        includeArchived: true,
      });
      hasMoreRef.current = items.length >= PAGE_SIZE;
      return items;
    },
    // Don't fetch until the auth store has a user. The sidebar calls
    // fetchConversations() on mount, but the user might not be loaded yet
    // (the auth store initializes async). Without this guard, getUserId()
    // throws, the query fails, and conversations don't show until a manual
    // refresh. With enabled, React Query retries once the user is set.
    enabled: !!userId,
  });

  const writeCache = useCallback(
    (updater: (prev: Conversation[]) => Conversation[]) =>
      queryClient.setQueryData<Conversation[]>(qk.conversations.list(), (prev = []) =>
        updater(prev),
      ),
    [queryClient],
  );

  // `isLoading` historically reflected both the list fetch and the
  // select-messages fetch; preserve that union.
  const isLoading = listLoading || selectLoading;

  // Shared guarded loader used by BOTH the URL auto-hydration and the
  // sidebar `selectConversation`. Behaviors:
  //  - Re-clicking the CURRENTLY LOADED conversation is a no-op (PRD §21 —
  //    never destructively clear the visible messages).
  //  - Switching conversations atomically clears the stale message array,
  //    fetches, and stores the result tagged with the id it belongs to.
  //  - `verifyInList` (URL auto-hydration) additionally checks the fetched
  //    list and drops the selection when the conversation no longer exists
  //    (PRD §18.3 — verify activeChatId exists).
  const loadConversationMessages = useCallback(
    async (id: string, opts?: { verifyInList?: boolean }) => {
      // Already the selected AND loaded conversation — no destructive reload.
      const state0 = useConversationStore.getState();
      if (state0.currentConversationId === id && state0.hydratedConversationId === id) {
        return;
      }

      // Abort any previous in-flight message fetch so an earlier, slower request
      // can't resolve after this one and show the wrong messages.
      messagesAbortRef.current?.abort();
      const controller = new AbortController();
      messagesAbortRef.current = controller;
      const myRequestId = ++selectRequestIdRef.current;

      // Atomically switch id + clear messages + flag loading. The clear is
      // the critical fix: `currentMessages` can never hold the PREVIOUS
      // conversation's messages while the id points at the new one.
      useConversationStore.getState().selectConversation(id, { loading: true });
      // Also synchronously clear the chat-store (streaming buffer) when this
      // is a real SWITCH so the previous conversation's streamed content
      // doesn't bleed in. (On URL auto-hydration after refresh the chat
      // store may hold the sessionStorage-restored messages for THIS SAME
      // conversation — keep those; the DB fetch replaces them below.)
      if (state0.currentConversationId !== id) {
        clearMessages();
      }
      setUrlParam("id", id);
      setError(null);
      try {
        const msgs = await conversationService.getMessages(id);
        // Guard against a superseded request resolving after a newer select.
        if (controller.signal.aborted || selectRequestIdRef.current !== myRequestId) {
          return;
        }
        if (opts?.verifyInList) {
          // PRD §18.3 — verify the conversation actually exists, DIRECTLY
          // against the database (Dexie get-by-id), NOT the React Query list
          // cache: on a hard refresh the auth user resolves asynchronously
          // (transient default user first), so the list query may still be
          // disabled and the cache empty at this moment — treating that as
          // "conversation deleted" wrongly cleared the selection + URL.
          // Existence is checked WITHOUT user scoping (see
          // conversationService.exists) because the local-first app has
          // transient/legacy user identities.
          const exists = await conversationService.exists(id);
          if (controller.signal.aborted || selectRequestIdRef.current !== myRequestId) {
            return;
          }
          if (!exists) {
            // Not accessible (deleted, no permission) — clear the stale id.
            useConversationStore.getState().selectConversation(null, { loading: false });
            setUrlParam("id", null);
            return;
          }
        }
        setMessagesFor(id, msgs);
      } catch (err) {
        // Ignore aborted/superseded requests — they're expected on rapid switch.
        if (
          controller.signal.aborted ||
          selectRequestIdRef.current !== myRequestId ||
          (err instanceof DOMException && err.name === "AbortError")
        ) {
          return;
        }
        const message = getErrorMessage(err, "Failed to fetch messages");
        setError(message);
      } finally {
        // Only the most recent request owns the loading flag.
        if (messagesAbortRef.current === controller) {
          if (selectRequestIdRef.current === myRequestId) {
            setLoading(false);
          }
          messagesAbortRef.current = null;
        }
      }
    },
    [clearMessages, setMessagesFor, setLoading, setError, queryClient],
  );

  // Tracks whether the URL-driven auto-hydration has already run for this
  // page load (PRD §18). On mount, `currentConversationId` is pre-hydrated
  // from the URL `?id=` — so the naive check "id already selected → skip
  // loading" left the app on the EMPTY home screen with zero messages after
  // every refresh. Auto-hydration runs at most once per page load, only when
  // the messages for the URL id haven't been loaded, and never while a turn
  // is streaming (the live chat store is authoritative then).
  const autoHydratedRef = useRef(false);

  const fetchConversations = useCallback(async () => {
    // The list query auto-fetches and dedupes; force a fresh pull here to keep
    // the previous explicit-refresh semantics (e.g. after a new conversation
    // is created during an agent turn). Start it FIRST so the verifyInList
    // check below can see fresh list data.
    const listPromise = queryClient.invalidateQueries({ queryKey: qk.conversations.list() });

    const urlId = new URLSearchParams(window.location.search).get("id");
    const convState = useConversationStore.getState();
    const needsHydration =
      !!urlId &&
      (convState.currentConversationId !== urlId || convState.hydratedConversationId !== urlId);

    if (urlId && needsHydration && !autoHydratedRef.current && !useChatStore.getState().isStreaming) {
      autoHydratedRef.current = true;
      await listPromise;
      // `loadConversationMessages` performs the full guarded select+fetch.
      // It is safe even when the id is already "selected" — the point is
      // that its MESSAGES were never loaded for this page load.
      await loadConversationMessages(urlId, { verifyInList: true });
    } else {
      await listPromise;
    }
  }, [queryClient, loadConversationMessages]);

  const loadingMoreRef = useRef(false);

  const fetchMoreConversations = useCallback(async () => {
    if (!hasMoreRef.current || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    const current = queryClient.getQueryData<Conversation[]>(qk.conversations.list()) ?? [];
    try {
      const userId = getUserId();
      const more = await conversationService.list(userId, {
        limit: PAGE_SIZE,
        skip: current.length,
        includeArchived: true,
      });
      if (more.length > 0) {
        // Dedupe in case a refetch raced with the append.
        writeCache((prev) => {
          const seen = new Set(prev.map((c) => c.id));
          return [...prev, ...more.filter((c) => !seen.has(c.id))];
        });
      }
      hasMoreRef.current = more.length >= PAGE_SIZE;
    } catch {
    } finally {
      loadingMoreRef.current = false;
    }
  }, [queryClient, writeCache, getUserId]);

  const createConversation = useCallback(
    async (title?: string): Promise<Conversation | null> => {
      setLoading(true);
      setError(null);
      try {
        const userId = getUserId();
        const newConversation = await conversationService.create(userId, title);
        writeCache((prev) => [newConversation, ...prev]);
        return newConversation;
      } catch (err) {
        const message = getErrorMessage(err, "Failed to create conversation");
        setError(message);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [writeCache, setLoading, setError, getUserId],
  );

  const archiveConversation = useCallback(
    async (id: string) => {
      try {
        await conversationService.update(id, { is_archived: true });
        writeCache((prev) => prev.map((c) => (c.id === id ? { ...c, is_archived: true } : c)));
        toast.success("Conversation archived");
      } catch (err) {
        const message = getErrorMessage(err, "Failed to archive conversation");
        setError(message);
        toast.error(message);
      }
    },
    [writeCache, setError],
  );

  const unarchiveConversation = useCallback(
    async (id: string) => {
      try {
        await conversationService.update(id, { is_archived: false });
        writeCache((prev) => prev.map((c) => (c.id === id ? { ...c, is_archived: false } : c)));
        toast.success("Conversation restored");
      } catch (err) {
        const message = getErrorMessage(err, "Failed to restore conversation");
        setError(message);
        toast.error(message);
      }
    },
    [writeCache, setError],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      try {
        await conversationService.delete(id);
        writeCache((prev) => prev.filter((c) => c.id !== id));
        // Mirror the old store behavior: clear the active selection if it was
        // the conversation we just removed.
        if (useConversationStore.getState().currentConversationId === id) {
          setCurrentConversationId(null);
        }
        toast.success("Conversation deleted");
      } catch (err) {
        const message = getErrorMessage(err, "Failed to delete conversation");
        setError(message);
        toast.error(message);
      }
    },
    [writeCache, setCurrentConversationId, setError],
  );

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      try {
        await conversationService.update(id, { title });
        writeCache((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
        toast.success("Conversation renamed");
      } catch (err) {
        const message = getErrorMessage(err, "Failed to rename conversation");
        setError(message);
        toast.error(message);
      }
    },
    [writeCache, setError],
  );

  const updateActiveKBs = useCallback(
    async (conversationId: string, kbIds: string[]) => {
      writeCache((prev) =>
        prev.map((c) =>
          c.id === conversationId ? { ...c, active_knowledge_base_ids: kbIds } : c,
        ),
      );
      try {
        await conversationService.update(conversationId, {
          active_knowledge_base_ids: kbIds,
        });
      } catch {
        toast.error("Failed to update knowledge bases");
      }
    },
    [writeCache],
  );

  const startNewChat = useCallback(async () => {
    // If current conversation is empty (no messages), just reuse it
    const currentId = useConversationStore.getState().currentConversationId;
    if (currentId) {
      const msgs = useConversationStore.getState().currentMessages;
      if (msgs.length === 0) {
        clearMessages();
        return;
      }
    }
    clearMessages();
    // Atomically reset: id -> null, messages -> [], hydrated -> null.
    useConversationStore.getState().selectConversation(null, { loading: false });
    // Strip the stale ?id= immediately so a refresh mid-flight lands on a
    // fresh /chat instead of the old conversation. The new id will be set
    // by the agent runtime's `conversation_created` event on first message.
    setUrlParam("id", null);
  }, [clearMessages]);

  return {
    conversations,
    currentConversationId,
    currentMessages,
    isLoading,
    error,
    fetchConversations,
    fetchMoreConversations,
    hasMore: hasMoreRef.current,
    createConversation,
    selectConversation: loadConversationMessages,
    archiveConversation,
    unarchiveConversation,
    deleteConversation,
    renameConversation,
    startNewChat,
    updateActiveKBs,
  };
}
