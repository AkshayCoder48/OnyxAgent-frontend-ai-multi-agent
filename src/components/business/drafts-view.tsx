"use client";

/**
 * Business Mode — DraftsView (Task 4-c).
 *
 * Draft list + detail sheet. Decisions (approve / reject / request changes)
 * mirror the chat draft-card flow: businessApprovalService.record →
 * businessDraftService.update → approval.completed event → store mirror.
 *
 * Editing keeps ONE row per draft: the edit bumps `version` on the same row
 * and clears `approved_version` (a new version invalidates prior approval,
 * PRD §13.3). Instead of a compare view (dropped — see worklog 4-c), the
 * sheet renders the real approval-history timeline from
 * businessApprovalService.listForDraft.
 */

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useLocale } from "next-intl";
import { toast } from "sonner";
import { motion, useReducedMotion } from "framer-motion";
import {
  Check,
  FileText,
  Pencil,
  ThumbsDown,
  ThumbsUp,
  Undo2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

import { AgentLogo } from "@/components/business/agent-logos";
import {
  businessApprovalService,
  businessDraftService,
  businessEventService,
} from "@/lib/business/data";
import { bt } from "@/lib/business/ui-text";
import type {
  ApprovalDecision,
  BusinessApprovalRow,
  BusinessDraftRow,
  DraftStatus,
} from "@/lib/business/types";
import { useBusinessStore } from "@/stores/business-store";
import { useAuthStore } from "@/stores/auth-store";
import { cn, timeAgo } from "@/lib/utils";

const COMMON_STATUS_FILTERS: DraftStatus[] = [
  "draft",
  "in_review",
  "changes_requested",
  "approved",
  "rejected",
];

const MORE_STATUS_FILTERS: DraftStatus[] = [
  "generating",
  "scheduled",
  "executing",
  "completed",
  "failed",
  "cancelled",
];

const WAITING_STATUSES: DraftStatus[] = ["draft", "in_review", "changes_requested"];

const ACTIONABLE_STATUSES: DraftStatus[] = ["draft", "in_review", "changes_requested"];

function draftStatusBadgeClass(status: DraftStatus): string {
  switch (status) {
    case "approved":
    case "completed":
      return "border-emerald-500/40 text-emerald-600 dark:text-emerald-400";
    case "rejected":
    case "failed":
      return "border-destructive/50 text-destructive";
    case "in_review":
    case "changes_requested":
    case "generating":
    case "executing":
      return "border-amber-500/40 text-amber-600 dark:text-amber-400";
    case "scheduled":
      return "border-primary/50 text-primary";
    default:
      return "border-border text-muted-foreground";
  }
}

function decisionBadgeClass(decision: ApprovalDecision): string {
  switch (decision) {
    case "approved":
      return "border-emerald-500/40 text-emerald-600 dark:text-emerald-400";
    case "rejected":
      return "border-destructive/50 text-destructive";
    case "changes_requested":
      return "border-amber-500/40 text-amber-600 dark:text-amber-400";
    default:
      return "border-border text-muted-foreground";
  }
}

function decisionLabel(decision: ApprovalDecision): string {
  if (decision === "approved") return bt("draftStatus.approved");
  if (decision === "rejected") return bt("draftStatus.rejected");
  if (decision === "changes_requested") return bt("draftStatus.changes_requested");
  return "Pending";
}

export function DraftsView() {
  const params = useParams<{ businessId?: string }>();
  const locale = useLocale();
  const activeBusinessId = useBusinessStore((s) => s.activeBusinessId);
  const businessId = params?.businessId ?? activeBusinessId ?? "";
  const drafts = useBusinessStore((s) => s.drafts);
  const agents = useBusinessStore((s) => s.agents);
  const tasks = useBusinessStore((s) => s.tasks);
  const upsertDraft = useBusinessStore((s) => s.upsertDraft);
  const userId = useAuthStore((s) => s.user?.id) ?? "local-user";

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [detailId, setDetailId] = useState<string | null>(null);

  const reduceMotion = useReducedMotion();

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const waitingCount = useMemo(
    () => drafts.filter((d) => WAITING_STATUSES.includes(d.status)).length,
    [drafts],
  );

  const visibleDrafts = useMemo(
    () => drafts.filter((d) => statusFilter === "all" || d.status === statusFilter),
    [drafts, statusFilter],
  );

  const detailDraft = detailId ? (drafts.find((d) => d.id === detailId) ?? null) : null;

  const tasksTabHref = `/${locale}/business/${businessId}/tasks`;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{bt("drafts.title")}</h1>
          {waitingCount > 0 && (
            <Badge variant="default" className="normal-case">
              {bt("drafts.waiting", { count: waitingCount })}
            </Badge>
          )}
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-11 w-[190px]" aria-label={bt("drafts.title")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{bt("common.all")}</SelectItem>
            {[...COMMON_STATUS_FILTERS, ...MORE_STATUS_FILTERS].map((s) => (
              <SelectItem key={s} value={s}>
                {bt(`draftStatus.${s}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </header>

      {/* Quick chips for the common statuses. */}
      <div className="flex gap-2 overflow-x-auto scrollbar-none pb-1" role="group" aria-label={bt("drafts.title")}>
        <StatusChip
          active={statusFilter === "all"}
          onClick={() => setStatusFilter("all")}
          label={bt("common.all")}
        />
        {COMMON_STATUS_FILTERS.map((s) => (
          <StatusChip
            key={s}
            active={statusFilter === s}
            onClick={() => setStatusFilter(s)}
            label={bt(`draftStatus.${s}`)}
          />
        ))}
      </div>

      {visibleDrafts.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-14 text-center">
          <FileText className="size-10 text-muted-foreground/60" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">{bt("drafts.empty")}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {visibleDrafts.map((draft, i) => {
            const agent = draft.created_by_agent_id
              ? (agentById.get(draft.created_by_agent_id) ?? null)
              : null;
            return (
              <motion.li
                key={draft.id}
                initial={reduceMotion ? undefined : { opacity: 0, y: 8 }}
                animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: Math.min(i * 0.03, 0.2) }}
              >
                <button
                  type="button"
                  onClick={() => setDetailId(draft.id)}
                  className="flex w-full flex-col gap-2 rounded-xl border p-4 text-left transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <div className="flex items-start gap-3">
                    <FileText className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate font-medium">{draft.title}</h3>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
                        <Badge variant="secondary">{draft.draft_type}</Badge>
                        <Badge variant="outline" className={draftStatusBadgeClass(draft.status)}>
                          {bt(`draftStatus.${draft.status}`)}
                        </Badge>
                        <Badge variant="outline" className="border-border text-muted-foreground">
                          {bt("drafts.version", { version: draft.version })}
                        </Badge>
                        {draft.approved_version ? (
                          <Badge
                            variant="outline"
                            className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                          >
                            {bt("drafts.approvedVersion", { version: draft.approved_version ?? 1 })}
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5 text-xs text-muted-foreground">
                      {agent && (
                        <span className="inline-flex items-center gap-1.5">
                          <AgentLogo logo={agent.svg_logo} className="size-5" />
                          {agent.name}
                        </span>
                      )}
                      <span>{timeAgo(draft.updated_at)}</span>
                    </div>
                  </div>
                </button>
              </motion.li>
            );
          })}
        </ul>
      )}

      <DraftDetailSheet
        draft={detailDraft}
        open={detailDraft !== null}
        onOpenChange={(o) => {
          if (!o) setDetailId(null);
        }}
        businessId={businessId}
        userId={userId}
        agentById={agentById}
        taskById={taskById}
        tasksTabHref={tasksTabHref}
        onUpsertDraft={upsertDraft}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status chip.
// ---------------------------------------------------------------------------

function StatusChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium whitespace-nowrap transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Draft detail sheet.
// ---------------------------------------------------------------------------

function DraftDetailSheet({
  draft,
  open,
  onOpenChange,
  businessId,
  userId,
  agentById,
  taskById,
  tasksTabHref,
  onUpsertDraft,
}: {
  draft: BusinessDraftRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  businessId: string;
  userId: string;
  agentById: Map<string, { id: string; name: string; svg_logo: string }>;
  taskById: Map<string, { id: string; title: string }>;
  tasksTabHref: string;
  onUpsertDraft: (row: BusinessDraftRow) => void;
}) {
  const [comment, setComment] = useState("");
  const [deciding, setDeciding] = useState<ApprovalDecision | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [history, setHistory] = useState<BusinessApprovalRow[]>([]);

  // Reset local state + load the real approval history per draft.
  useEffect(() => {
    if (!open || !draft) return;
    setComment("");
    setDeciding(null);
    setEditing(false);
    setEditContent("");
    let alive = true;
    (async () => {
      try {
        const rows = await businessApprovalService.listForDraft(draft.id);
        if (alive) setHistory(rows.slice().reverse()); // newest first
      } catch {
        if (alive) setHistory([]);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft?.id]);

  const agent = draft?.created_by_agent_id
    ? (agentById.get(draft.created_by_agent_id) ?? null)
    : null;
  const task = draft?.task_id ? (taskById.get(draft.task_id) ?? null) : null;
  const actionable = draft ? ACTIONABLE_STATUSES.includes(draft.status) : false;

  async function loadHistory(draftId: string) {
    try {
      const rows = await businessApprovalService.listForDraft(draftId);
      setHistory(rows.slice().reverse());
    } catch {
      setHistory([]);
    }
  }

  async function handleDecision(decision: Exclude<ApprovalDecision, "pending">) {
    if (!draft || !businessId) return;
    setDeciding(decision);
    try {
      await businessApprovalService.record(businessId, {
        draft_id: draft.id,
        draft_version: draft.version,
        requested_action: draft.approval_requirements[0] ?? "user_approval",
        decision,
        reviewer_id: userId,
        comments: comment.trim() || undefined,
      });
      const nextStatus: DraftStatus =
        decision === "approved" ? "approved" : decision === "rejected" ? "rejected" : "changes_requested";
      const patch: Partial<BusinessDraftRow> = {
        status: nextStatus,
        comments: comment.trim() || draft.comments,
      };
      if (decision === "approved") patch.approved_version = draft.version;
      await businessDraftService.update(draft.id, patch);
      const updated: BusinessDraftRow = {
        ...draft,
        ...patch,
        updated_at: new Date().toISOString(),
      } as BusinessDraftRow;
      onUpsertDraft(updated);
      await businessEventService.append({
        business_id: businessId,
        task_id: draft.task_id,
        agent_id: draft.created_by_agent_id,
        event_type: "approval.completed",
        payload: {
          draft_id: draft.id,
          title: draft.title,
          decision,
          version: draft.version,
        },
      });
      if (decision === "approved") {
        toast.success(bt("toast.draftApproved", { version: draft.version }));
      } else if (decision === "rejected") {
        toast.success(bt("toast.draftRejected"));
      } else {
        toast.success(bt("toast.changesRequested"));
      }
      await loadHistory(draft.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDeciding(null);
    }
  }

  async function handleSaveEdit() {
    if (!draft || !businessId) return;
    setSavingEdit(true);
    try {
      const nextVersion = draft.version + 1;
      // Single row per draft: bump the version, reset status to "draft" and
      // clear the approval (a new version needs fresh approval — PRD §13.3).
      // 0 (not undefined) actually clears the stored column.
      const patch: Partial<BusinessDraftRow> = {
        version: nextVersion,
        content: editContent,
        status: "draft",
        approved_version: 0,
      };
      await businessDraftService.update(draft.id, patch);
      const updated: BusinessDraftRow = {
        ...draft,
        ...patch,
        updated_at: new Date().toISOString(),
      } as BusinessDraftRow;
      onUpsertDraft(updated);
      await businessEventService.append({
        business_id: businessId,
        task_id: draft.task_id,
        agent_id: draft.created_by_agent_id,
        event_type: "draft.updated",
        payload: { draft_id: draft.id, title: draft.title, version: nextVersion },
      });
      toast.success(bt("toast.saved"));
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEdit(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl">
        <SheetHeader>
          <div className="flex min-w-0 items-center gap-3">
            <FileText className="size-5 shrink-0 text-primary" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate">{draft?.title ?? ""}</SheetTitle>
              <SheetDescription className="truncate text-xs">
                {draft ? bt("drafts.version", { version: draft.version }) : ""}
              </SheetDescription>
            </div>
            <SheetClose onClick={() => onOpenChange(false)} aria-label={bt("common.close")} />
          </div>
        </SheetHeader>

        {draft && (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto scrollbar-thin p-4">
            {/* Meta */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={draftStatusBadgeClass(draft.status)}>
                {bt(`draftStatus.${draft.status}`)}
              </Badge>
              <Badge variant="secondary">{draft.draft_type}</Badge>
              <Badge variant="outline" className="border-border text-muted-foreground">
                {bt("drafts.version", { version: draft.version })}
              </Badge>
              {draft.approved_version ? (
                <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
                  {bt("drafts.approvedVersion", { version: draft.approved_version ?? 1 })}
                </Badge>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {agent && (
                <span className="inline-flex items-center gap-1.5">
                  <AgentLogo logo={agent.svg_logo} className="size-5" />
                  {bt("drafts.createdBy", { agent: agent.name })}
                </span>
              )}
              {task && (
                <Link
                  href={tasksTabHref}
                  className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                >
                  {bt("drafts.linkedTask")}: {task.title}
                </Link>
              )}
              <span>{timeAgo(draft.updated_at)}</span>
            </div>

            {/* Content (read-only) or edit mode */}
            {editing ? (
              <div className="flex flex-col gap-2">
                <Textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  rows={14}
                  aria-label={draft.title}
                  className="font-mono text-xs"
                />
                <div className="flex gap-2">
                  <Button onClick={() => void handleSaveEdit()} disabled={savingEdit} className="h-11">
                    {savingEdit && <Spinner className="mr-2 size-4" />}
                    {bt("drafts.editSave")}
                  </Button>
                  <Button variant="outline" onClick={() => setEditing(false)} className="h-11">
                    {bt("common.cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border bg-muted/30 p-3">
                <pre className="max-h-[50vh] overflow-y-auto scrollbar-thin whitespace-pre-wrap break-words text-sm">
                  {draft.content}
                </pre>
              </div>
            )}

            {!editing && (
              <Button
                variant="outline"
                onClick={() => {
                  setEditContent(draft.content);
                  setEditing(true);
                }}
                className="h-11 self-start"
              >
                <Pencil className="mr-2 size-4" />
                {bt("common.edit")}
              </Button>
            )}

            {/* Sources */}
            {draft.sources && draft.sources.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {draft.sources.map((s, i) => (
                  <a
                    key={`${i}-${s.url}`}
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="max-w-[220px] truncate rounded-full border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                  >
                    {s.title || s.url}
                  </a>
                ))}
              </div>
            )}

            {/* Review actions */}
            {actionable && !editing && (
              <div className="flex flex-col gap-3 rounded-lg border p-4">
                <p className="text-xs text-muted-foreground">{bt("drafts.approvalNote")}</p>
                <Textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder={bt("drafts.commentPlaceholder")}
                  rows={2}
                  aria-label={bt("drafts.comments")}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => void handleDecision("approved")}
                    disabled={deciding !== null}
                    className="h-11"
                  >
                    {deciding === "approved" ? (
                      <Spinner className="mr-2 size-4" />
                    ) : (
                      <ThumbsUp className="mr-2 size-4" />
                    )}
                    {bt("drafts.approve")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void handleDecision("changes_requested")}
                    disabled={deciding !== null}
                    className="h-11"
                  >
                    {deciding === "changes_requested" ? (
                      <Spinner className="mr-2 size-4" />
                    ) : (
                      <Undo2 className="mr-2 size-4" />
                    )}
                    {bt("drafts.requestChanges")}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => void handleDecision("rejected")}
                    disabled={deciding !== null}
                    className="h-11"
                  >
                    {deciding === "rejected" ? (
                      <Spinner className="mr-2 size-4" />
                    ) : (
                      <ThumbsDown className="mr-2 size-4" />
                    )}
                    {bt("drafts.reject")}
                  </Button>
                </div>
              </div>
            )}

            {/* Approval history (real decisions only). */}
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{bt("drafts.history")}</h3>
              {history.length === 0 ? (
                <p className="text-sm text-muted-foreground">{bt("drafts.noHistory")}</p>
              ) : (
                <ol className="flex flex-col gap-2">
                  {history.map((h) => (
                    <li key={h.id} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                      {h.decision === "approved" && <Check className="size-4 text-emerald-600 dark:text-emerald-400" />}
                      {h.decision === "rejected" && <X className="size-4 text-destructive" />}
                      {h.decision === "changes_requested" && <Undo2 className="size-4 text-amber-600 dark:text-amber-400" />}
                      <Badge variant="outline" className={decisionBadgeClass(h.decision)}>
                        {decisionLabel(h.decision)}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {bt("drafts.version", { version: h.draft_version })}
                      </span>
                      {h.comments && (
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                          {h.comments}
                        </span>
                      )}
                      <time className="ml-auto text-xs text-muted-foreground" dateTime={h.created_at}>
                        {timeAgo(h.created_at)}
                      </time>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
