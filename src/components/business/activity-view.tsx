"use client";

/**
 * Business Mode — ActivityView (Task 4-c).
 *
 * Audit timeline over the store's newest-first event feed. "Load more" pages
 * OLDER events in via businessEventService.list and merges them by id (live
 * store events stay prepended). Family icons + local human labels are derived
 * from event_type; payloads add title/name/query/error context when present.
 */

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useLocale } from "next-intl";
import { motion, useReducedMotion } from "framer-motion";
import {
  Activity as ActivityIcon,
  Bell,
  Bot,
  CheckCircle,
  FileText,
  Globe,
  ListTodo,
  PlayCircle,
  Route,
  Brain,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";

import { AgentLogo } from "@/components/business/agent-logos";
import { businessEventService } from "@/lib/business/data";
import { bt } from "@/lib/business/ui-text";
import type { BusinessEventRow, BusinessEventType } from "@/lib/business/types";
import { useBusinessStore } from "@/stores/business-store";
import { cn, timeAgo } from "@/lib/utils";

/** Event families (filter groups) — order drives the Select. */
const EVENT_FAMILIES: { key: string; label: string; icon: LucideIcon }[] = [
  { key: "task", label: "Tasks", icon: ListTodo },
  { key: "agent", label: "Agents", icon: Bot },
  { key: "draft", label: "Drafts", icon: FileText },
  { key: "approval", label: "Approvals", icon: CheckCircle },
  { key: "decision", label: "Decisions", icon: Route },
  { key: "browser", label: "Browser", icon: Globe },
  { key: "turn", label: "Turns", icon: PlayCircle },
  { key: "memory", label: "Memory", icon: Brain },
  { key: "notification", label: "Notifications", icon: Bell },
];

const FAMILY_ICON_FALLBACK: LucideIcon = ActivityIcon;

/** Local human labels per event_type (event names are technical identifiers,
 *  not part of the bt dictionary — sanctioned by the 4-c spec). */
const EVENT_LABELS: Record<BusinessEventType, string> = {
  "business.created": "Business created",
  "business.updated": "Business updated",
  "agent.created": "Agent created",
  "agent.updated": "Agent updated",
  "agent.status_changed": "Agent status changed",
  "agent.deleted": "Agent deleted",
  "task.created": "Task created",
  "task.started": "Task started",
  "task.progress": "Task progress",
  "task.blocked": "Task blocked",
  "task.awaiting_approval": "Task awaiting approval",
  "task.completed": "Task completed",
  "task.failed": "Task failed",
  "task.cancelled": "Task cancelled",
  "task.retried": "Task retried",
  "agent.message": "Agent message",
  "draft.created": "Draft created",
  "draft.updated": "Draft updated",
  "approval.requested": "Approval requested",
  "approval.completed": "Approval completed",
  "decision.completed": "Decision recorded",
  "browser.activity": "Web research",
  "chat.message": "Chat message",
  "turn.started": "Turn started",
  "turn.completed": "Turn completed",
  "turn.cancelled": "Turn cancelled",
  "memory.updated": "Memory updated",
  notification: "Notification",
};

const PAGE_SIZE = 100;

function payloadDetail(payload: Record<string, unknown>): string {
  for (const key of ["title", "name", "query", "error", "status", "decision", "label", "kind"]) {
    const v = payload?.[key];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

export function ActivityView() {
  const params = useParams<{ businessId?: string }>();
  const locale = useLocale();
  const activeBusinessId = useBusinessStore((s) => s.activeBusinessId);
  const businessId = params?.businessId ?? activeBusinessId ?? "";
  const storeEvents = useBusinessStore((s) => s.events);
  const agents = useBusinessStore((s) => s.agents);
  const tasks = useBusinessStore((s) => s.tasks);

  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [extra, setExtra] = useState<BusinessEventRow[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  const reduceMotion = useReducedMotion();

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  // Store events (live) + older paged-in events, merged newest-first by id.
  const mergedEvents = useMemo(() => {
    const seen = new Set<string>();
    const merged: BusinessEventRow[] = [];
    for (const e of [...storeEvents, ...extra]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      merged.push(e);
    }
    merged.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    return merged;
  }, [storeEvents, extra]);

  const visibleEvents = useMemo(() => {
    return mergedEvents.filter((e) => {
      if (typeFilter !== "all") {
        if (typeFilter === "notification" ? e.event_type !== "notification" : !e.event_type.startsWith(`${typeFilter}.`)) {
          return false;
        }
      }
      if (agentFilter !== "all" && e.agent_id !== agentFilter) return false;
      return true;
    });
  }, [mergedEvents, typeFilter, agentFilter]);

  const tasksTabHref = `/${locale}/business/${businessId}/tasks`;

  async function handleLoadMore() {
    if (!businessId || loadingMore) return;
    setLoadingMore(true);
    try {
      // Ask for more than we currently show; dedupe against the merged list.
      const count = mergedEvents.length + PAGE_SIZE;
      const rows = await businessEventService.list(businessId, count);
      const seen = new Set(mergedEvents.map((e) => e.id));
      const fresh = rows.filter((e) => !seen.has(e.id));
      if (fresh.length === 0) {
        setExhausted(true);
      } else {
        setExtra((prev) => [...prev, ...fresh.filter((e) => !prev.some((p) => p.id === e.id))]);
      }
    } catch {
      // Network/DB hiccup — the button stays available for another try.
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{bt("activity.title")}</h1>
          <p className="text-sm text-muted-foreground">{bt("activity.subtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="h-11 w-[160px]" aria-label={bt("activity.filterType")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{bt("activity.filterType")}</SelectItem>
              <SelectGroup>
                {EVENT_FAMILIES.map((f) => (
                  <SelectItem key={f.key} value={f.key}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select value={agentFilter} onValueChange={setAgentFilter}>
            <SelectTrigger className="h-11 w-[170px]" aria-label={bt("activity.byAgent")}>
              <SelectValue placeholder={bt("activity.byAgent")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{bt("common.all")}</SelectItem>
              <SelectGroup>
                <SelectLabel>{bt("activity.byAgent")}</SelectLabel>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </header>

      {visibleEvents.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-14 text-center">
          <ActivityIcon className="size-10 text-muted-foreground/60" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">{bt("activity.empty")}</p>
        </div>
      ) : (
        <>
          <ol className="relative max-h-[calc(100vh-220px)] overflow-y-auto scrollbar-thin pr-1">
            {/* Vertical timeline line. */}
            <span
              aria-hidden="true"
              className="absolute top-2 bottom-2 left-[19px] w-px bg-border"
            />
            {visibleEvents.map((e, i) => {
              const family = EVENT_FAMILIES.find((f) => e.event_type.startsWith(`${f.key}.`));
              const Icon = e.event_type === "notification" ? Bell : (family?.icon ?? FAMILY_ICON_FALLBACK);
              const agent = e.agent_id ? (agentById.get(e.agent_id) ?? null) : null;
              const task = e.task_id ? (taskById.get(e.task_id) ?? null) : null;
              const detail = payloadDetail(e.payload);
              return (
                <motion.li
                  key={e.id}
                  initial={reduceMotion ? undefined : { opacity: 0, x: -6 }}
                  animate={reduceMotion ? undefined : { opacity: 1, x: 0 }}
                  transition={{ duration: 0.18, delay: Math.min(i * 0.015, 0.15) }}
                  className="relative flex gap-3 py-2.5 pl-0"
                >
                  <span
                    className={cn(
                      "z-[1] mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full border bg-background",
                      family || e.event_type === "notification"
                        ? "border-border text-primary"
                        : "border-border text-muted-foreground",
                    )}
                  >
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1 rounded-lg border bg-background/50 px-3 py-2">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="text-sm font-medium">
                        {EVENT_LABELS[e.event_type] ?? e.event_type}
                      </span>
                      {detail && (
                        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                          {detail}
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {agent && (
                        <span className="inline-flex items-center gap-1.5">
                          <AgentLogo logo={agent.svg_logo} className="size-5" />
                          {agent.name}
                        </span>
                      )}
                      {task && (
                        <Link
                          href={tasksTabHref}
                          className="inline-flex min-h-6 items-center gap-1 rounded-md border border-border px-1.5 transition-colors hover:border-primary/40 hover:text-primary"
                        >
                          <ListTodo className="size-3" />
                          <span className="max-w-[160px] truncate">{task.title}</span>
                        </Link>
                      )}
                      <time
                        className="ml-auto"
                        dateTime={e.created_at}
                        title={timeAgo(e.created_at)}
                      >
                        {new Date(e.created_at).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </div>
                  </div>
                </motion.li>
              );
            })}
          </ol>

          {!exhausted && (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                onClick={() => void handleLoadMore()}
                disabled={loadingMore}
                className="h-11"
              >
                {loadingMore && <Spinner className="mr-2 size-4" />}
                {bt("activity.loadMore")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
