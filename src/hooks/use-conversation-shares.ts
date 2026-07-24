"use client";

import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { shareService } from "@/lib/services";
import { useAuthStore } from "@/stores";
import { qk } from "@/lib/query-keys";
import { getErrorMessage } from "@/lib/utils";
import type { Conversation, ConversationShare } from "@/types";

/**
 * Backendless conversation sharing.
 *
 * In backendless mode there's no server to share with another user. The
 * foundation's `shareService.share` writes a row to `conversation_shares`
 * (mostly for logging) and `shareService.listForConversation` reads them.
 * The actual "share" UX is a self-contained lz-string URL hash built
 * elsewhere (see `share-dialog.tsx` / `shared-view.tsx`) — this hook just
 * records that a share was generated.
 *
 * `sharedWithMe` is always empty in backendless mode (there's no inbox of
 * conversations other users shared with you) — kept in the return signature
 * so `share-dialog.tsx` and any other consumers don't break.
 */
export function useConversationShares() {
  const queryClient = useQueryClient();
  const getUserId = useCallback(() => {
    const userId = useAuthStore.getState().user?.id;
    if (!userId) throw new Error("You must be signed in to manage shares.");
    return userId;
  }, []);

  // The shares list belongs to whichever conversation was last requested via
  // fetchShares. React Query owns the cache; we just track which key is active.
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [sharedWithMeParams, setSharedWithMeParams] = useState<{
    skip: number;
    limit: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sharesQuery = useQuery({
    queryKey: conversationId
      ? qk.conversationShares.list(conversationId)
      : qk.conversationShares.all(),
    queryFn: async () => {
      const userId = getUserId();
      return shareService.listForConversation(conversationId!, userId);
    },
    enabled: !!conversationId,
  });

  // `sharedWithMe` is paginated in the original API but the foundation's
  // `listSharedWithMe(userId)` returns a flat array. We still track the
  // requested window so the query key changes (forces refetch); the actual
  // returned array is sliced client-side to honor the limit.
  const sharedWithMeQuery = useQuery({
    queryKey: sharedWithMeParams
      ? qk.conversationShares.sharedWithMe(sharedWithMeParams.skip, sharedWithMeParams.limit)
      : qk.conversationShares.sharedWithMe(0, 50),
    queryFn: async () => {
      const userId = getUserId();
      const all = await shareService.listSharedWithMe(userId);
      const { skip, limit } = sharedWithMeParams!;
      return {
        items: all.slice(skip, skip + limit),
        total: all.length,
      };
    },
    enabled: !!sharedWithMeParams,
  });

  const shares: ConversationShare[] = sharesQuery.data ?? [];
  // `sharedWithMe` is always empty in backendless mode — there's no inbox of
  // conversations other users shared with you. The cast keeps the original
  // `Conversation[]` return type so consumers don't break.
  const sharedWithMe: Conversation[] = (sharedWithMeQuery.data?.items ?? []) as unknown as Conversation[];
  const sharedWithMeTotal = sharedWithMeQuery.data?.total ?? 0;
  const isLoading = sharesQuery.isFetching || sharedWithMeQuery.isFetching;

  const shareConversation = useCallback(
    async (
      conversationId: string,
      data: {
        shared_with?: string;
        permission?: "view" | "edit";
        generate_link?: boolean;
      },
    ) => {
      setError(null);
      try {
        const userId = getUserId();
        const share = await shareService.share(conversationId, userId, {
          sharedWith: data.shared_with,
          permission: data.permission,
        });
        // Optimistically prepend so the dialog updates instantly, then refetch.
        queryClient.setQueryData<ConversationShare[]>(
          qk.conversationShares.list(conversationId),
          (prev = []) => [share, ...prev],
        );
        queryClient.invalidateQueries({
          queryKey: qk.conversationShares.list(conversationId),
        });
        return share;
      } catch (err: unknown) {
        const message = getErrorMessage(err, "Failed to share");
        setError(message);
        throw err;
      }
    },
    [queryClient, getUserId],
  );

  const fetchShares = useCallback(
    async (conversationId: string) => {
      setError(null);
      setConversationId(conversationId);
      try {
        await queryClient.invalidateQueries({
          queryKey: qk.conversationShares.list(conversationId),
        });
      } catch (err: unknown) {
        const message = getErrorMessage(err, "Failed to load shares");
        setError(message);
      }
    },
    [queryClient],
  );

  const revokeShare = useCallback(
    async (conversationId: string, shareId: string) => {
      setError(null);
      try {
        const userId = getUserId();
        await shareService.revoke(shareId, userId);
        queryClient.setQueryData<ConversationShare[]>(
          qk.conversationShares.list(conversationId),
          (prev = []) => prev.filter((s) => s.id !== shareId),
        );
        queryClient.invalidateQueries({
          queryKey: qk.conversationShares.list(conversationId),
        });
      } catch (err: unknown) {
        const message = getErrorMessage(err, "Failed to revoke");
        setError(message);
        throw err;
      }
    },
    [queryClient, getUserId],
  );

  const fetchSharedWithMe = useCallback(
    async (skip = 0, limit = 50) => {
      setError(null);
      setSharedWithMeParams({ skip, limit });
      try {
        await queryClient.invalidateQueries({
          queryKey: qk.conversationShares.sharedWithMe(skip, limit),
        });
      } catch (err: unknown) {
        const message = getErrorMessage(err, "Failed to load shared");
        setError(message);
      }
    },
    [queryClient],
  );

  return {
    shares,
    sharedWithMe,
    sharedWithMeTotal,
    isLoading,
    error,
    shareConversation,
    fetchShares,
    revokeShare,
    fetchSharedWithMe,
  };
}
