"use client";
import { useState, useCallback, useMemo } from "react";
import { Loader2, ThumbsUp, ThumbsDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { RatingValue, type UserRating } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface RatingButtonsProps {
  messageId: string;
  conversationId: string;
  currentRating: UserRating;
  ratingCount?: { likes: number; dislikes: number };
  onRatingChange?: (data: {
    rating: UserRating;
    rating_count: { likes: number; dislikes: number };
  }) => void;
  isAssistant: boolean;
}

/**
 * Message rating (👍 / 👎) — LOCAL-FIRST persistence.
 *
 * The app is backendless (Dexie/IndexedDB): the old implementation POSTed to
 * `/api/conversations/:id/messages/:id/rate`, a REST endpoint that does not
 * exist in this architecture — every rating 404'd, so nothing was ever stored
 * and the UI only ever showed transient hover feedback ("the button reacts but
 * nothing happens"). Ratings now go through `ratingService` (Dexie
 * `message_ratings` table) and the visual state is applied ONLY after the
 * write actually succeeded (PRD: never confirm an action that didn't happen).
 */
export function RatingButtons({
  messageId,
  conversationId,
  currentRating,
  ratingCount,
  onRatingChange,
  isAssistant,
}: RatingButtonsProps) {
  const t = useTranslations("chat");
  const tc = useTranslations("common");
  const [showCommentDialog, setShowCommentDialog] = useState(false);
  const [pendingRating, setPendingRating] = useState<RatingValue>(RatingValue.DISLIKE);
  const [comment, setComment] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const calculateNewCounts = useMemo(
    () =>
      (oldRating: UserRating, newRating: UserRating): { likes: number; dislikes: number } => {
        const likes = ratingCount?.likes ?? 0;
        const dislikes = ratingCount?.dislikes ?? 0;

        let newLikes = likes;
        let newDislikes = dislikes;
        if (oldRating === RatingValue.LIKE) newLikes -= 1;
        if (oldRating === RatingValue.DISLIKE) newDislikes -= 1;

        if (newRating === RatingValue.LIKE) newLikes += 1;
        if (newRating === RatingValue.DISLIKE) newDislikes += 1;

        return { likes: Math.max(0, newLikes), dislikes: Math.max(0, newDislikes) };
      },
    [ratingCount],
  );

  // submitRating must be declared before handleRate since handleRate uses it.
  // Persisted via the LOCAL rating service (Dexie) — see the component doc
  // comment. The UI callback (`onRatingChange`) fires only on success.
  const submitRating = useCallback(
    async (rating: RatingValue, commentText: string | null) => {
      const { ratingService } = await import("@/lib/services");
      const { useAuthStore } = await import("@/stores");
      const userId = useAuthStore.getState().user?.id;
      if (!userId) {
        toast.error(t("ratingFailed"));
        return;
      }

      setIsLoading(true);
      try {
        await ratingService.rate(messageId, userId, rating, commentText ?? undefined);

        const newCounts = calculateNewCounts(currentRating, rating);
        // Success FIRST, visual state AFTER — the selected thumb now reflects
        // a rating that genuinely lives in the database.
        onRatingChange?.({ rating, rating_count: newCounts });
        toast.success(t("thankYouFeedback"));
        setShowCommentDialog(false);
        setComment("");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("ratingFailed"));
      } finally {
        setIsLoading(false);
      }
    },
    [messageId, currentRating, calculateNewCounts, onRatingChange, t],
  );

  const handleRate = useCallback(
    async (rating: RatingValue) => {
      if (!conversationId || conversationId === "") {
        toast.error(t("saveConversationToRate"));
        return;
      }

      if (currentRating === rating) {
        // Toggle OFF: remove the stored rating, then update the UI.
        const { ratingService } = await import("@/lib/services");
        const { useAuthStore } = await import("@/stores");
        const userId = useAuthStore.getState().user?.id;
        if (!userId) {
          toast.error("Failed to remove rating");
          return;
        }
        setIsLoading(true);
        try {
          await ratingService.remove(messageId, userId);
          const newCounts = calculateNewCounts(currentRating, null);
          onRatingChange?.({ rating: null, rating_count: newCounts });
          toast.success(t("ratingRemoved"));
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Failed to remove rating");
        } finally {
          setIsLoading(false);
        }
      } else {
        setPendingRating(rating);
        if (rating === RatingValue.DISLIKE) {
          setShowCommentDialog(true);
        } else {
          void submitRating(rating, null);
        }
      }
    },
    [conversationId, messageId, currentRating, calculateNewCounts, onRatingChange, submitRating, t],
  );

  const handleCloseDialog = useCallback(() => {
    setShowCommentDialog(false);
    setComment("");
  }, []);

  if (!isAssistant) return null;

  // Disable rating if conversationId is not set (e.g. new conversation not yet saved)
  const isMissingConversationId = !conversationId || conversationId === "";

  return (
    <>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void handleRate(RatingValue.LIKE);
          }}
          disabled={isLoading || isMissingConversationId}
          className={cn(
            "inline-flex items-center rounded-md p-1.5 transition-colors",
            "hover:bg-muted/80",
            "opacity-100 sm:opacity-0 sm:group-hover:opacity-100",
            currentRating === RatingValue.LIKE &&
              "bg-green-500/30 text-green-600 dark:text-green-400",
            isMissingConversationId && "cursor-not-allowed opacity-50",
          )}
          title={isMissingConversationId ? t("saveConversationToRate") : t("helpful")}
          aria-pressed={currentRating === RatingValue.LIKE}
          aria-label={t("helpful")}
        >
          {isLoading && currentRating !== RatingValue.DISLIKE ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ThumbsUp className="h-4 w-4" />
          )}
          {ratingCount && ratingCount.likes > 0 && (
            <span className="ml-1 text-xs">{ratingCount.likes}</span>
          )}
        </button>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void handleRate(RatingValue.DISLIKE);
          }}
          disabled={isLoading || isMissingConversationId}
          className={cn(
            "inline-flex items-center rounded-md p-1.5 transition-colors",
            "hover:bg-muted/80",
            "opacity-100 sm:opacity-0 sm:group-hover:opacity-100",
            currentRating === RatingValue.DISLIKE && "bg-red-500/30 text-red-600 dark:text-red-400",
            isMissingConversationId && "cursor-not-allowed opacity-50",
          )}
          title={isMissingConversationId ? t("saveConversationToRate") : t("notHelpful")}
          aria-pressed={currentRating === RatingValue.DISLIKE}
          aria-label={t("notHelpful")}
        >
          {isLoading && currentRating !== RatingValue.LIKE ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ThumbsDown className="h-4 w-4" />
          )}
          {ratingCount && ratingCount.dislikes > 0 && (
            <span className="ml-1 text-xs">{ratingCount.dislikes}</span>
          )}
        </button>
      </div>

      <Dialog open={showCommentDialog} onOpenChange={setShowCommentDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("whatWentWrong")}</DialogTitle>
            <DialogDescription>{t("feedbackHelp")}</DialogDescription>
          </DialogHeader>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t("describeIssue")}
            className="bg-background min-h-[100px] w-full rounded-md border p-2"
            maxLength={2000}
            autoFocus
          />
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs">{comment.length} / 2000</span>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={handleCloseDialog} disabled={isLoading}>
                {tc("cancel")}
              </Button>
              <Button
                variant="outline"
                onClick={() => void submitRating(pendingRating, null)}
                disabled={isLoading}
              >
                {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {t("skipComment")}
              </Button>
              <Button
                onClick={() => void submitRating(pendingRating, comment.trim() || null)}
                disabled={isLoading}
              >
                {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {tc("submit")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
