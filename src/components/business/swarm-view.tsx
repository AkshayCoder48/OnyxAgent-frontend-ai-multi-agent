"use client";

/**
 * Business Mode — SwarmView (Task 4-c).
 *
 * Agent roster for the active business: search + status filters, responsive
 * card grid (1/2/3 cols) and a collaboration graph whose edges are derived
 * ONLY from real task dependency records (dependency-task's agent →
 * dependent-task's agent). No simulated edges or statuses.
 */

import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ChevronDown, Network, Plus, Search, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";

import { AgentLogo } from "@/components/business/agent-logos";
import { AgentDetailSheet } from "@/components/business/agent-detail-sheet";
import { CreateAgentDialog } from "@/components/business/create-agent-dialog";
import { bt } from "@/lib/business/ui-text";
import type { AgentStatus, BusinessAgentRow } from "@/lib/business/types";
import { useBusinessStore } from "@/stores/business-store";
import { useAuthStore } from "@/stores/auth-store";
import { aiProviderService } from "@/lib/services";
import type { AIProviderRow } from "@/lib/db";
import { cn, timeAgo } from "@/lib/utils";

/** Chip-filterable statuses (subset of the 11 — the common ones). */
const STATUS_FILTERS: AgentStatus[] = [
  "idle",
  "working",
  "researching",
  "planning",
  "awaiting_approval",
  "paused",
  "failed",
];

/** Task statuses counted as "pending" for an agent. */
const PENDING_TASK_STATUSES = [
  "backlog",
  "ready",
  "running",
  "blocked",
  "awaiting_approval",
  "interrupted",
] as const;

function statusBadgeClass(status: AgentStatus, paused: boolean): string {
  if (paused || status === "paused" || status === "disabled") {
    return "border-border text-muted-foreground";
  }
  switch (status) {
    case "working":
    case "researching":
    case "planning":
    case "collaborating":
      return "border-amber-500/40 text-amber-600 dark:text-amber-400";
    case "awaiting_approval":
      return "border-primary/50 text-primary";
    case "waiting_input":
      return "border-amber-500/30 text-amber-600/90 dark:text-amber-400/90";
    case "completed":
      return "border-emerald-500/40 text-emerald-600 dark:text-emerald-400";
    case "failed":
      return "border-destructive/50 text-destructive";
    default:
      return "border-border text-muted-foreground";
  }
}

function isBusy(status: AgentStatus, paused: boolean): boolean {
  return (
    !paused &&
    (status === "working" ||
      status === "researching" ||
      status === "planning" ||
      status === "collaborating")
  );
}

export function SwarmView() {
  const agents = useBusinessStore((s) => s.agents);
  const tasks = useBusinessStore((s) => s.tasks);
  const userId = useAuthStore((s) => s.user?.id) ?? "local-user";

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [graphOpen, setGraphOpen] = useState(false);
  const [providers, setProviders] = useState<AIProviderRow[]>([]);

  const reduceMotion = useReducedMotion();

  // Provider names for the model chip (agent.provider_id → provider name).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const rows = await aiProviderService.list(userId);
        if (alive) setProviders(rows);
      } catch {
        // Model chips fall back to bt("swarm.inheritModel").
      }
    })();
    return () => {
      alive = false;
    };
  }, [userId]);

  const providerName = useMemo(() => {
    const map = new Map(providers.map((p) => [p.id, p.name]));
    return (agent: BusinessAgentRow) =>
      agent.model_id ??
      (agent.provider_id ? (map.get(agent.provider_id) ?? undefined) : undefined) ??
      bt("swarm.inheritModel");
  }, [providers]);

  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const pendingCount = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tasks) {
      if (!t.assigned_agent_id) continue;
      if (!(PENDING_TASK_STATUSES as readonly string[]).includes(t.status)) continue;
      map.set(t.assigned_agent_id, (map.get(t.assigned_agent_id) ?? 0) + 1);
    }
    return map;
  }, [tasks]);

  const visibleAgents = useMemo(() => {
    const q = search.trim().toLowerCase();
    return agents.filter((a) => {
      if (statusFilter !== "all") {
        if (statusFilter === "paused" ? !a.paused && a.status !== "paused" : a.status !== statusFilter) {
          return false;
        }
      }
      if (!q) return true;
      return (
        a.name.toLowerCase().includes(q) ||
        a.role.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q)
      );
    });
  }, [agents, search, statusFilter]);

  const detailAgent = detailId ? (agentById.get(detailId) ?? null) : null;

  // Real collaboration edges: dependency-task's agent → dependent-task's agent.
  const collaborationEdges = useMemo(() => {
    const pairs = new Map<string, { from: string; to: string }>();
    for (const t of tasks) {
      for (const depId of t.dependencies ?? []) {
        const dep = taskById.get(depId);
        if (!dep?.assigned_agent_id || !t.assigned_agent_id) continue;
        if (dep.assigned_agent_id === t.assigned_agent_id) continue;
        if (!agentById.has(dep.assigned_agent_id) || !agentById.has(t.assigned_agent_id)) continue;
        const key = `${dep.assigned_agent_id}->${t.assigned_agent_id}`;
        pairs.set(key, { from: dep.assigned_agent_id, to: t.assigned_agent_id });
      }
    }
    return [...pairs.values()];
  }, [tasks, taskById, agentById]);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{bt("swarm.title")}</h1>
          <p className="text-sm text-muted-foreground">{bt("swarm.subtitle")}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="h-11">
          <Plus className="mr-2 size-4" />
          {bt("swarm.createAgent")}
        </Button>
      </header>

      {/* Filters */}
      <div className="flex flex-col gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={bt("swarm.searchPlaceholder")}
            aria-label={bt("common.search")}
            className="h-11 pl-9"
          />
        </div>
        <div
          className="flex gap-2 overflow-x-auto scrollbar-none pb-1"
          role="group"
          aria-label={bt("common.all")}
        >
          <StatusChip
            active={statusFilter === "all"}
            onClick={() => setStatusFilter("all")}
            label={bt("common.all")}
          />
          {STATUS_FILTERS.map((s) => (
            <StatusChip
              key={s}
              active={statusFilter === s}
              onClick={() => setStatusFilter(s)}
              label={bt(`status.${s}`)}
            />
          ))}
        </div>
      </div>

      {/* Grid / empty state */}
      {agents.length === 0 ? (
        <EmptyState onCreate={() => setCreateOpen(true)} />
      ) : visibleAgents.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{bt("swarm.emptyTitle")}</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleAgents.map((agent, i) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              index={i}
              reduceMotion={reduceMotion}
              modelLabel={providerName(agent)}
              currentTaskTitle={
                agent.current_task_id
                  ? (taskById.get(agent.current_task_id)?.title ?? null)
                  : null
              }
              pending={pendingCount.get(agent.id) ?? 0}
              onOpen={() => setDetailId(agent.id)}
            />
          ))}
        </div>
      )}

      {/* Collaboration graph */}
      {agents.length > 0 && (
        <CollaborationGraph
          open={graphOpen}
          onOpenChange={setGraphOpen}
          agents={agents}
          edges={collaborationEdges}
        />
      )}

      <CreateAgentDialog open={createOpen} onOpenChange={setCreateOpen} />
      <AgentDetailSheet
        agent={detailAgent}
        open={detailAgent !== null}
        onOpenChange={(o) => {
          if (!o) setDetailId(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status filter chip.
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
// Agent card.
// ---------------------------------------------------------------------------

function AgentCard({
  agent,
  index,
  reduceMotion,
  modelLabel,
  currentTaskTitle,
  pending,
  onOpen,
}: {
  agent: BusinessAgentRow;
  index: number;
  reduceMotion: boolean | null;
  modelLabel: string;
  currentTaskTitle: string | null;
  pending: number;
  onOpen: () => void;
}) {
  const busy = isBusy(agent.status, agent.paused);
  return (
    <motion.div
      initial={reduceMotion ? undefined : { opacity: 0, y: 10 }}
      animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(index * 0.04, 0.25) }}
    >
      <Card
        role="button"
        tabIndex={0}
        aria-label={agent.name}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        className="cursor-pointer p-4 transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <div className="flex items-start gap-3">
          <AgentLogo logo={agent.svg_logo} className="size-10" label={agent.name} />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <h3 className="min-w-0 truncate font-medium">{agent.name}</h3>
              <Badge variant="outline" className={cn("shrink-0", statusBadgeClass(agent.status, agent.paused))}>
                {busy && (
                  <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-amber-500" />
                )}
                {bt(`status.${agent.status}`)}
              </Badge>
            </div>
            <Badge variant="secondary" className="mt-1">
              {agent.role}
            </Badge>
            {agent.description && (
              <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{agent.description}</p>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
          <span className="truncate rounded-md border border-border px-2 py-0.5">{modelLabel}</span>
          {pending > 0 && (
            <span className="font-medium text-foreground">
              {bt("swarm.pendingTasks", { count: pending })}
            </span>
          )}
          {currentTaskTitle && (
            <span className="min-w-0">
              {bt("swarm.currentTask")}: <span className="text-foreground">{currentTaskTitle}</span>
            </span>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t pt-2.5 text-xs text-muted-foreground">
          <span>
            {bt("swarm.tasksCompleted", { count: agent.metrics.tasks_completed })}
            {" · "}
            {bt("swarm.tasksFailed", { count: agent.metrics.tasks_failed })}
          </span>
          <span>
            {bt("swarm.lastActivity")}{" "}
            {agent.last_activity ? timeAgo(agent.last_activity) : bt("common.never")}
          </span>
        </div>
      </Card>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Empty state.
// ---------------------------------------------------------------------------

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-14 text-center">
      <Users className="size-10 text-muted-foreground/60" aria-hidden="true" />
      <div>
        <h2 className="font-medium">{bt("swarm.emptyTitle")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{bt("swarm.emptySubtitle")}</p>
      </div>
      <Button onClick={onCreate} className="mt-2 h-11">
        <Plus className="mr-2 size-4" />
        {bt("swarm.createAgent")}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collaboration graph — pure SVG, edges only from real task dependencies.
// ---------------------------------------------------------------------------

const GRAPH_W = 480;
const GRAPH_H = 340;
const NODE_R = 16;

function CollaborationGraph({
  open,
  onOpenChange,
  agents,
  edges,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: BusinessAgentRow[];
  edges: { from: string; to: string }[];
}) {
  // Agent node positions on an ellipse around the Main Agent orb.
  const positions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    const n = agents.length;
    agents.forEach((a, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(n, 1);
      map.set(a.id, {
        x: GRAPH_W / 2 + Math.cos(angle) * 185,
        y: GRAPH_H / 2 + Math.sin(angle) * 120,
      });
    });
    return map;
  }, [agents]);

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <Card className="p-4">
        <CollapsibleTrigger className="flex w-full items-center gap-2 text-left">
          <Network className="size-4 text-primary" aria-hidden="true" />
          <span className="flex-1 font-medium">{bt("swarm.graph")}</span>
          <span className="text-xs font-normal text-muted-foreground">{bt("swarm.graphHint")}</span>
          <ChevronDown
            className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
            aria-hidden="true"
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-3">
            {edges.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
                <Network className="size-6 text-muted-foreground/60" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">{bt("swarm.graphEmpty")}</p>
              </div>
            ) : (
              <svg
                viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`}
                role="img"
                aria-label={bt("swarm.graph")}
                className="h-auto w-full text-foreground"
              >
                <defs>
                  <marker
                    id="swarm-arrow"
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M0 0 L8 4 L0 8 z" className="fill-muted-foreground" />
                  </marker>
                </defs>

                {/* Real dependency edges (dependency agent → dependent agent). */}
                {edges.map((e) => {
                  const from = positions.get(e.from);
                  const to = positions.get(e.to);
                  if (!from || !to) return null;
                  const dx = to.x - from.x;
                  const dy = to.y - from.y;
                  const len = Math.hypot(dx, dy) || 1;
                  const ux = dx / len;
                  const uy = dy / len;
                  const x1 = from.x + ux * (NODE_R + 5);
                  const y1 = from.y + uy * (NODE_R + 5);
                  const x2 = to.x - ux * (NODE_R + 7);
                  const y2 = to.y - uy * (NODE_R + 7);
                  return (
                    <line
                      key={`${e.from}->${e.to}`}
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      strokeWidth={1.5}
                      className="stroke-muted-foreground/50"
                      markerEnd="url(#swarm-arrow)"
                    />
                  );
                })}

                {/* Main Agent orb (center) — no simulated edges. */}
                <g>
                  <circle
                    cx={GRAPH_W / 2}
                    cy={GRAPH_H / 2}
                    r={24}
                    className="fill-primary/10 stroke-primary/50"
                    strokeWidth={1.5}
                  />
                  <circle
                    cx={GRAPH_W / 2}
                    cy={GRAPH_H / 2}
                    r={12}
                    className="fill-primary/20 stroke-primary/60"
                    strokeWidth={1.2}
                  />
                  <circle cx={GRAPH_W / 2} cy={GRAPH_H / 2} r={3} className="fill-primary" />
                  <text
                    x={GRAPH_W / 2}
                    y={GRAPH_H / 2 + 42}
                    textAnchor="middle"
                    className="fill-muted-foreground text-[11px]"
                  >
                    {bt("ws.mainAgent")}
                  </text>
                </g>

                {/* Agent nodes. */}
                {agents.map((a) => {
                  const pos = positions.get(a.id);
                  if (!pos) return null;
                  const connected = edges.some((e) => e.from === a.id || e.to === a.id);
                  const label = a.name.length > 14 ? `${a.name.slice(0, 13)}…` : a.name;
                  return (
                    <g key={a.id}>
                      <circle
                        cx={pos.x}
                        cy={pos.y}
                        r={NODE_R}
                        className={cn(
                          connected
                            ? "fill-background stroke-primary/70"
                            : "fill-background stroke-border",
                        )}
                        strokeWidth={1.5}
                      />
                      <text
                        x={pos.x}
                        y={pos.y + 4}
                        textAnchor="middle"
                        className="fill-foreground text-[11px] font-semibold"
                      >
                        {a.name.charAt(0).toUpperCase()}
                      </text>
                      <text
                        x={pos.x}
                        y={pos.y + NODE_R + 14}
                        textAnchor="middle"
                        className="fill-muted-foreground text-[10px]"
                      >
                        {label}
                      </text>
                    </g>
                  );
                })}
              </svg>
            )}
          </div>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
