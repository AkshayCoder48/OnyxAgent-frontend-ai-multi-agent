"use client";

/**
 * Business Mode — inline draft card for the chat transcript (Task 4-b).
 *
 * Shows a draft linked from an agent message with a markdown preview and the
 * real approval actions (approve / request changes / reject). Every decision
 * is persisted as an approval record, a draft update and an
 * approval.completed event, then mirrored into the live store.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, ChevronRight, Edit3, FileText, Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth-store";
import { useBusinessStore } from "@/stores/business-store";
import { businessApprovalService, businessDraftService, businessEventService } from "@/lib/business/data";
import { bt } from "@/lib/business/ui-text";
import type { ApprovalDecision } from "@/lib/business/types";
import { renderBusinessMarkdown } from "./business-message-item";

/** Statuses that still accept a user decision. */
const ACTIONABLE_STATUSES = new Set(["draft", "in_review", "changes_requested"]);

/** A concrete user decision (approval records never store "pending" here). */
type DraftDecision = Exclude<ApprovalDecision, "pending">;

export function BusinessDraftCard({ draftId }: { draftId: string }) {
  const router = useRouter();
  const draft = useBusinessStore((s) => s.drafts.find((d) => d.id === draftId));
  const creatorName = useBusinessStore((s) => {
    const d = s.drafts.find((row) => row.id === draftId);
    if (!d?.created_by_agent_id) return undefined;
    return s.agents.find((a) => a.id === d.created_by_agent_id)?.name;
  });
  const [pending, setPending] = React.useState<DraftDecision | null>(null);

  if (!draft) return null;

  const actionable = ACTIONABLE_STATUSES.has(draft.status);

  const decide = async (decision: DraftDecision) => {
    if (pending) return;
    setPending(decision);
    try {
      const userId = useAuthStore.getState().user?.id ?? "local-user";
      await businessApprovalService.record(draft.business_id, {
        draft_id: draft.id,
        draft_version: draft.version,
        requested_action: "user_approval",
        decision,
        reviewer_id: userId,
      });
      await businessDraftService.update(draft.id, {
        status:
          decision === "approved" ? "approved" : decision === "rejected" ? "rejected" : "changes_requested",
        approved_version: decision === "approved" ? draft.version : undefined,
      });
      await businessEventService.append({
        business_id: draft.business_id,
        agent_id: draft.created_by_agent_id,
        event_type: "approval.completed",
        payload: { draftId: draft.id, decision },
      });
      const fresh = await businessDraftService.get(draft.id);
      if (fresh) useBusinessStore.getState().upsertDraft(fresh);
      if (decision === "approved") toast.success(bt("toast.draftApproved", { version: draft.version }));
      else if (decision === "rejected") toast.success(bt("toast.draftRejected"));
      else toast.success(bt("toast.changesRequested"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="rounded-xl border bg-card p-4 text-left shadow-sm">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-accent/10 text-accent-foreground"
        >
          <FileText className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-sm font-semibold leading-tight">{draft.title}</p>
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-medium">
              {bt("drafts.version", { version: draft.version })}
            </Badge>
            <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium text-muted-foreground">
              {bt(`draftStatus.${draft.status}`)}
            </Badge>
          </div>
          {creatorName && (
            <p className="mt-1 text-[11px] text-muted-foreground">{bt("drafts.createdBy", { agent: creatorName })}</p>
          )}
        </div>
      </div>

      <div className="scrollbar-thin mt-3 max-h-60 overflow-y-auto rounded-lg bg-muted/30 p-3 text-sm">
        {renderBusinessMarkdown(draft.content, { keyPrefix: `draftcard-${draft.id}` })}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => router.push(`/business/${draft.business_id}/drafts`)}
          className="inline-flex items-center gap-0.5 text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          {bt("chat.viewDraft")}
          <ChevronRight className="size-3" aria-hidden />
        </button>
        {actionable && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => void decide("approved")}
              disabled={pending !== null}
            >
              {pending === "approved" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              {bt("chat.approve")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-9 gap-1.5"
              onClick={() => void decide("changes_requested")}
              disabled={pending !== null}
            >
              {pending === "changes_requested" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Edit3 className="size-3.5" />
              )}
              {bt("chat.requestChanges")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-9 gap-1.5 text-destructive hover:text-destructive"
              onClick={() => void decide("rejected")}
              disabled={pending !== null}
            >
              {pending === "rejected" ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
              {bt("chat.reject")}
            </Button>
          </div>
        )}
      </div>

      <p className="mt-2 text-[10px] text-muted-foreground/70">{bt("drafts.approvalNote")}</p>
    </div>
  );
}
