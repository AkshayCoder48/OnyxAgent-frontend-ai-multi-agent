"use client";

/**
 * Business Mode — TasksView (Task 4-c).
 *
 * Filterable task list with expandable rows (description, dependencies,
 * output, error, execution log, draft link). Row actions:
 *  - failed/interrupted → Retry (orchestrator.retryBusinessTask, fire-and-forget)
 *  - backlog/ready/blocked (no running turn) → Cancel
 * Running tasks show no action — the Stop control lives in the chat.
 */

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useLocale } from "next-intl";
import { toast } from "sonner";
import { motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  Ban,
  ChevronDown,
  FileText,
  ListTodo,
  RotateCcw,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { AgentLogo } from "@/components/business/agent-logos";
import { businessEventService, businessTaskService } from "@/lib/business/data";
import { bt } from "@/lib/business/ui-text";
import { retryBusinessTask } from "@/lib/business/orchestrator";
import type { BusinessEventType, BusinessTaskRow, BusinessTaskStatus, TaskPriority } from "@/lib/business/types";
import { useBusinessStore } from "@/stores/business-store";
import { cn, timeAgo } from "@/lib/utils";

const ALL_TASK_STATUSES: BusinessTaskStatus[] = [
  "backlog",
  "ready",
  "running",
  "blocked",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

/** Local, human labels for execution-log events (not part of bt dictionary). */
const EVENT_LABELS: Partial<Record<BusinessEventType, string>> = {
  "task.created": "Task created",
  "task.started": "Task started",
  "task.progress": "Progress",
  "task.blocked": "Blocked",
  "task.awaiting_approval": "Awaiting approval",
  "task.completed": "Completed",
  "task.failed": "Failed",
  "task.cancelled": "Cancelled",
  "task.retried": "Retried",
  "browser.activity": "Web research",
  "draft.created": "Draft created",
  "agent.message": "Agent message",
};

function taskStatusBadgeClass(status: BusinessTaskStatus): string {
  switch (status) {
    case "running":
      return "border-amber-500/40 text-amber-600 dark:text-amber-400";
    case "completed":
      return "border-emerald-500/40 text-emerald-600 dark:text-emerald-400";
    case "failed":
    case "interrupted":
      return "border-destructive/50 text-destructive";
    case "blocked":
    case "awaiting_approval":
      return "border-primary/50 text-primary";
    default:
      return "border-border text-muted-foreground";
  }
}

function priorityBadgeClass(priority: TaskPriority): string {
  switch (priority) {
    case "urgent":
      return "border-destructive/50 text-destructive";
    case "high":
      return "border-amber-500/40 text-amber-600 dark:text-amber-400";
    case "medium":
      return "";
    default:
      return "border-border text-muted-foreground";
  }
}

/** Humanized duration, e.g. "45s" / "1m 32s" / "2h 5m". */
function humanizeDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function payloadDetail(payload: Record<string, unknown>): string {
  for (const key of ["title", "name", "query", "error", "status", "count"]) {
    const v = payload?.[key];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

export function TasksView() {
  const params = useParams<{ businessId?: string }>();
  const locale = useLocale();
  const activeBusinessId = useBusinessStore((s) => s.activeBusinessId);
  const businessId = params?.businessId ?? activeBusinessId ?? "";
  const tasks = useBusinessStore((s) => s.tasks);
  const agents = useBusinessStore((s) => s.agents);
  const events = useBusinessStore((s) => s.events);
  const drafts = useBusinessStore((s) => s.drafts);
  const turnRunning = useBusinessStore((s) => s.turnRunning);
  const upsertTask = useBusinessStore((s) => s.upsertTask);

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const reduceMotion = useReducedMotion();

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const draftById = useMemo(() => new Map(drafts.map((d) => [d.id, d])), [drafts]);

  const visibleTasks = useMemo(() => {
    return tasks.filter((t) => {
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (agentFilter !== "all" && t.assigned_agent_id !== agentFilter) return false;
      return true;
    });
  }, [tasks, statusFilter, agentFilter]);

  const draftsTabHref = `/${locale}/business/${businessId}/drafts`;

  function handleRetry(task: BusinessTaskRow) {
    // Fire-and-forget — the orchestrator mirrors every status change.
    void retryBusinessTask(task.id).catch((err) => {
      toast.error(err instanceof Error ? err.message : String(err));
    });
    toast.success(bt("toast.taskRetried"));
  }

  async function handleCancel(task: BusinessTaskRow) {
    if (!businessId) return;
    setCancellingId(task.id);
    try {
      await businessTaskService.update(task.id, { status: "cancelled" });
      const updated: BusinessTaskRow = {
        ...task,
        status: "cancelled",
        updated_at: new Date().toISOString(),
      };
      upsertTask(updated);
      await businessEventService.append({
        business_id: businessId,
        task_id: task.id,
        agent_id: task.assigned_agent_id,
        event_type: "task.cancelled",
        payload: { title: task.title },
      });
      toast.success(bt("toast.taskCancelled"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{bt("tasks.title")}</h1>
        <div className="flex flex-wrap gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-11 w-[150px]" aria-label={bt("tasks.title")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{bt("common.all")}</SelectItem>
              {ALL_TASK_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {bt(`taskStatus.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={agentFilter} onValueChange={setAgentFilter}>
            <SelectTrigger className="h-11 w-[170px]" aria-label={bt("tasks.filterAgent")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{bt("tasks.filterAgent")}</SelectItem>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      {visibleTasks.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-14 text-center">
          <ListTodo className="size-10 text-muted-foreground/60" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">{bt("tasks.empty")}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {visibleTasks.map((task, i) => (
            <TaskRow
              key={task.id}
              task={task}
              index={i}
              reduceMotion={reduceMotion}
              agent={task.assigned_agent_id ? (agentById.get(task.assigned_agent_id) ?? null) : null}
              expanded={expandedId === task.id}
              onToggle={() => setExpandedId((prev) => (prev === task.id ? null : task.id))}
              events={events}
              taskById={taskById}
              draftById={draftById}
              draftsHref={draftsTabHref}
              cancelAvailable={
                !turnRunning &&
                (task.status === "backlog" || task.status === "ready" || task.status === "blocked")
              }
              cancelling={cancellingId === task.id}
              onRetry={() => handleRetry(task)}
              onCancel={() => void handleCancel(task)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task row.
// ---------------------------------------------------------------------------

function TaskRow({
  task,
  index,
  reduceMotion,
  agent,
  expanded,
  onToggle,
  events,
  taskById,
  draftById,
  draftsHref,
  cancelAvailable,
  cancelling,
  onRetry,
  onCancel,
}: {
  task: BusinessTaskRow;
  index: number;
  reduceMotion: boolean | null;
  agent: { id: string; name: string; svg_logo: string } | null;
  expanded: boolean;
  onToggle: () => void;
  events: { id: string; task_id?: string; event_type: BusinessEventType; payload: Record<string, unknown>; created_at: string }[];
  taskById: Map<string, BusinessTaskRow>;
  draftById: Map<string, { id: string; title: string }>;
  draftsHref: string;
  cancelAvailable: boolean;
  cancelling: boolean;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const running = task.status === "running";
  const canRetry = task.status === "failed" || task.status === "interrupted";

  const dependencyTitles = (task.dependencies ?? [])
    .map((id) => taskById.get(id)?.title)
    .filter((t): t is string => Boolean(t));

  const draft = task.output_artifacts?.draft_id
    ? draftById.get(task.output_artifacts.draft_id)
    : undefined;

  const duration =
    task.status === "completed" && task.started_at && task.completed_at
      ? humanizeDuration(new Date(task.completed_at).getTime() - new Date(task.started_at).getTime())
      : "";

  const logEvents = events
    .filter((e) => e.task_id === task.id)
    .slice(0, 50);

  return (
    <motion.li
      initial={reduceMotion ? undefined : { opacity: 0, y: 8 }}
      animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.2) }}
      className="rounded-xl border"
    >
      <div className="flex flex-col gap-2 p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={taskStatusBadgeClass(task.status)}>
                {running && (
                  <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-amber-500" />
                )}
                {bt(`taskStatus.${task.status}`)}
              </Badge>
              <Badge
                variant={task.priority === "medium" ? "secondary" : "outline"}
                className={priorityBadgeClass(task.priority)}
              >
                {bt(`priority.${task.priority}`)}
              </Badge>
            </div>
            <h3 className="mt-2 font-medium">{task.title}</h3>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
              {agent ? (
                <span className="inline-flex items-center gap-1.5">
                  <AgentLogo logo={agent.svg_logo} className="size-5" />
                  {agent.name}
                </span>
              ) : (
                <span>{bt("tasks.unassigned")}</span>
              )}
              <span>{bt("tasks.created", { time: timeAgo(task.created_at) })}</span>
              {task.retry_count > 0 && (
                <span>{bt("tasks.attempts", { count: task.retry_count + 1 })}</span>
              )}
              {duration && <span>{bt("tasks.duration", { duration })}</span>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {canRetry && (
              <Button
                variant="outline"
                size="sm"
                className="h-11 px-3"
                onClick={onRetry}
                aria-label={bt("tasks.retry")}
              >
                <RotateCcw className="mr-1.5 size-4" />
                <span className="hidden sm:inline">{bt("common.retry")}</span>
              </Button>
            )}
            {cancelAvailable && (
              <Button
                variant="outline"
                size="sm"
                className="h-11 px-3"
                onClick={onCancel}
                disabled={cancelling}
                aria-label={bt("tasks.cancelTask")}
              >
                <Ban className="mr-1.5 size-4" />
                <span className="hidden sm:inline">{bt("common.cancel")}</span>
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              onClick={onToggle}
              aria-expanded={expanded}
              aria-label={expanded ? bt("common.close") : bt("common.view")}
            >
              <ChevronDown
                className={cn("size-4 transition-transform", expanded && "rotate-180")}
              />
            </Button>
          </div>
        </div>

        {expanded && (
          <div className="flex flex-col gap-3 border-t pt-3">
            {task.description && (
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {task.description}
              </p>
            )}

            <p className="text-xs">
              <span className="text-muted-foreground">{bt("tasks.dependencies")}: </span>
              {dependencyTitles.length > 0 ? (
                <span className="text-foreground">
                  {bt("tasks.blockedBy", { tasks: dependencyTitles.join(", ") })}
                </span>
              ) : (
                <span className="text-muted-foreground">{bt("tasks.noDeps")}</span>
              )}
            </p>

            {task.error && (
              <Alert variant="destructive">
                <AlertTriangle className="size-4" />
                <AlertDescription>{bt("tasks.error", { error: task.error })}</AlertDescription>
              </Alert>
            )}

            {task.output_artifacts?.summary && (
              <div className="rounded-lg border bg-muted/30 p-3">
                <pre className="max-h-48 overflow-y-auto scrollbar-thin whitespace-pre-wrap break-words text-sm">
                  {task.output_artifacts.summary}
                </pre>
              </div>
            )}

            {draft && (
              <Link
                href={draftsHref}
                className="inline-flex min-h-11 items-center gap-2 self-start rounded-lg border px-3 text-sm font-medium transition-colors hover:border-primary/40 hover:text-primary"
              >
                <FileText className="size-4" />
                {bt("tasks.openDraft")}: {draft.title}
              </Link>
            )}

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{bt("tasks.execLog")}</span>
              {logEvents.length === 0 ? (
                <p className="text-xs text-muted-foreground">—</p>
              ) : (
                <ol className="max-h-48 overflow-y-auto scrollbar-thin rounded-lg border p-2">
                  {logEvents.map((e) => (
                    <li key={e.id} className="flex items-baseline gap-2 px-1 py-1 text-xs">
                      <time className="shrink-0 text-muted-foreground" dateTime={e.created_at}>
                        {new Date(e.created_at).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                      <span className="font-medium">{EVENT_LABELS[e.event_type] ?? e.event_type}</span>
                      {payloadDetail(e.payload) && (
                        <span className="min-w-0 truncate text-muted-foreground">
                          {payloadDetail(e.payload)}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}
      </div>
    </motion.li>
  );
}
