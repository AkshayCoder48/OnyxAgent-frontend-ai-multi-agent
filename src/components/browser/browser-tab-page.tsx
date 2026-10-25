"use client";

/**
 * BrowserTabPage — the Browser tab (Task 1-c).
 *
 * ONE place to watch the browser interaction of EVERY available agent:
 *
 *   1. Chat agents     — general conversations (no project), most recent
 *                        first, each with its own live sandbox-browser view.
 *   2. Project agents  — project conversations grouped under their project.
 *   3. Business agents — business agents do NOT run E2B sandbox browsers;
 *                        their web interaction is recorded as
 *                        `browser.activity` events (query, result count,
 *                        top URLs) shown as compact per-agent cards.
 *
 * Stream discipline (efficiency + correctness):
 *   - "shared" sandbox mode → every conversation drives the SAME sandbox
 *     browser, so ONE hoisted `useBrowserLive` stream feeds every
 *     chat/project card (each card carries a "shared sandbox" hint chip).
 *   - "separate" sandbox mode → each card mounts its OWN stream scoped to
 *     its conversation, capped at the 12 most recent conversations overall
 *     ("+N more" note for the rest) to keep concurrent SSE streams bounded.
 *
 * Event-honest throughout: no session → waiting state; no E2B key → error
 * with the Settings hint; business cards never fabricate entries.
 */

import * as React from "react";
import Link from "next/link";
import {
  Briefcase,
  FolderKanban,
  Globe,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";

import { PageHeader } from "@/components/dashboard/page-header";
import { Badge, Button, Skeleton } from "@/components/ui";
import { AgentBrowserCard } from "@/components/browser/agent-browser-card";
import { BusinessAgentCard } from "@/components/browser/business-agent-card";
import { useBrowserLive } from "@/hooks/use-browser-live";
import { useAuth, useConversations } from "@/hooks";
import { useSettings } from "@/hooks/use-data";
import { useProjectsStore } from "@/lib/projects/store";
import { useBusinessStore } from "@/stores/business-store";
import { useAuthStore } from "@/stores";
import { businessAgentService, businessEventService, businessService } from "@/lib/business/data";
import type {
  BusinessAgentRow,
  BusinessEventRow,
  BusinessRow,
} from "@/lib/business/types";
import { ROUTES } from "@/lib/constants";
import { timeAgo } from "@/lib/utils";
import type { Conversation } from "@/types";

/** Max concurrent per-conversation live streams ("separate" mode only). */
const SEPARATE_STREAM_CAP = 12;

// ---------------------------------------------------------------------------
// Loaded business data (services — the zustand store only holds the ACTIVE
// business; this tab needs every business's agents + browser.activity log).
// ---------------------------------------------------------------------------

interface BusinessBrowserData {
  businesses: BusinessRow[];
  /** businessId → agents (roster order). */
  agentsByBusiness: Record<string, BusinessAgentRow[]>;
  /** businessId → agentId → browser.activity events, NEWEST first. */
  browserEventsByBusiness: Record<string, Record<string, BusinessEventRow[]>>;
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function SectionHeader({
  icon: Icon,
  title,
  count,
  description,
}: {
  icon: LucideIcon;
  title: string;
  count?: number;
  description: string;
}) {
  return (
    <div className="min-w-0">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight text-foreground">
        <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="truncate">{title}</span>
        {typeof count === "number" ? (
          <span className="rounded-full bg-foreground/[0.05] px-2 py-0.5 font-mono text-[11px] font-medium text-muted-foreground">
            {count}
          </span>
        ) : null}
      </h2>
      <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function SectionEmpty({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  action?: { label: string; href: string };
}) {
  return (
    <div className="rounded-xl border border-dashed px-6 py-10 text-center">
      <Icon className="mx-auto h-6 w-6 text-muted-foreground/60" aria-hidden />
      <p className="mt-3 text-sm font-medium text-foreground/80">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
        {body}
      </p>
      {action ? (
        <Button asChild variant="outline" size="sm" className="mt-4 min-h-11">
          <Link href={action.href}>{action.label}</Link>
        </Button>
      ) : null}
    </div>
  );
}

/** "+N more" note for clipped (not streamed) conversations. */
function MoreNote({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <p className="rounded-lg bg-foreground/[0.03] px-3 py-2 text-xs text-muted-foreground">
      +{count} more conversation{count === 1 ? "" : "s"} not shown — live views are capped
      at the {SEPARATE_STREAM_CAP} most recent agents to keep connections fast.
    </p>
  );
}

function conversationSubtitle(c: Conversation): string | undefined {
  const ago = timeAgo(c.updated_at);
  return ago ? `Updated ${ago}` : undefined;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function BrowserTabPage() {
  // Auth (same pattern as the knowledge-base page — useAuth runs init()).
  const { user } = useAuth();
  const authResolved = useAuthStore((s) => s.authResolved);
  const userId = user?.id ?? null;

  // Sandbox allocation mode (Settings → Config → E2B Sandbox).
  const { settings } = useSettings();
  const mode = settings?.sandbox_mode ?? "shared";

  // Conversations — the shared React-Query cache, most recent first
  // (legacy "code"-mode rows are not agent browsers and are skipped).
  const { conversations, isLoading: conversationsLoading } = useConversations();

  // Projects — names for the project grouping (refresh once auth settles).
  const projects = useProjectsStore((s) => s.projects);
  const refreshProjects = useProjectsStore((s) => s.refresh);
  React.useEffect(() => {
    if (authResolved) void refreshProjects();
  }, [authResolved, refreshProjects]);

  // Business store — only the ACTIVE business's live agents/events (kept
  // fresh by the orchestrator's event listener) overlay the loaded data.
  const activeBusinessId = useBusinessStore((s) => s.activeBusinessId);
  const storeAgents = useBusinessStore((s) => s.agents);
  const storeEvents = useBusinessStore((s) => s.events);

  // ── Conversation partition ───────────────────────────────────────────────
  const agentConversations = React.useMemo(
    () =>
      conversations
        .filter((c) => c.mode !== "code")
        .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "")),
    [conversations],
  );
  const generalConversations = React.useMemo(
    () => agentConversations.filter((c) => !c.project_id),
    [agentConversations],
  );
  const projectConversations = React.useMemo(
    () => agentConversations.filter((c) => !!c.project_id),
    [agentConversations],
  );

  // ── Stream budget ────────────────────────────────────────────────────────
  // "separate": at most SEPARATE_STREAM_CAP live cards overall (chat first,
  // then projects, both most-recent-first). "shared": everything — one
  // hoisted stream feeds every card, so there is nothing to cap.
  const cap = mode === "separate" ? SEPARATE_STREAM_CAP : Infinity;
  const generalShown = generalConversations.slice(0, cap);
  const generalHidden = generalConversations.length - generalShown.length;
  const projectBudget = mode === "separate" ? Math.max(0, cap - generalShown.length) : Infinity;
  const projectShown = projectConversations.slice(0, projectBudget);
  const projectHidden = projectConversations.length - projectShown.length;

  // Project groups (only streamed/shown conversations; groups ordered by
  // their most recent conversation).
  const projectGroups = React.useMemo(() => {
    const byProject = new Map<string, Conversation[]>();
    for (const c of projectShown) {
      const pid = c.project_id as string;
      const list = byProject.get(pid) ?? [];
      list.push(c);
      byProject.set(pid, list);
    }
    return [...byProject.entries()].sort((a, b) =>
      (b[1][0]?.updated_at ?? "").localeCompare(a[1][0]?.updated_at ?? ""),
    );
  }, [projectShown]);

  const hasLiveCards = generalShown.length > 0 || projectShown.length > 0;

  // ── ONE hoisted stream for "shared" mode ─────────────────────────────────
  // Every conversation drives the same sandbox browser in this mode, so the
  // page opens a single stream and hands the result to every card. Disabled
  // entirely in "separate" mode (cards mount their own) and when there is
  // nothing to show.
  const sharedLive = useBrowserLive({
    enabled: mode === "shared" && hasLiveCards,
    conversationId: null,
    mode: "shared",
  });

  // ── Business data load (all businesses, once auth settles) ──────────────
  const [businessData, setBusinessData] = React.useState<BusinessBrowserData | null>(null);
  const [businessLoading, setBusinessLoading] = React.useState(true);

  React.useEffect(() => {
    if (!authResolved || !userId) return;
    let alive = true;
    setBusinessLoading(true);
    void (async () => {
      try {
        const businesses = await businessService.list(userId);
        const results = await Promise.all(
          businesses.map(async (business) => {
            const [agents, events] = await Promise.all([
              businessAgentService.list(business.id),
              businessEventService.list(business.id, 200),
            ]);
            return { business, agents, events };
          }),
        );
        if (!alive) return;
        const agentsByBusiness: Record<string, BusinessAgentRow[]> = {};
        const browserEventsByBusiness: Record<string, Record<string, BusinessEventRow[]>> = {};
        for (const { business, agents, events } of results) {
          agentsByBusiness[business.id] = agents;
          const byAgent: Record<string, BusinessEventRow[]> = {};
          // businessEventService.list returns CHRONOLOGICAL order —
          // prepend so each agent's list ends up newest-first.
          for (const e of events) {
            if (e.event_type !== "browser.activity" || !e.agent_id) continue;
            byAgent[e.agent_id] = [e, ...(byAgent[e.agent_id] ?? [])];
          }
          browserEventsByBusiness[business.id] = byAgent;
        }
        setBusinessData({ businesses, agentsByBusiness, browserEventsByBusiness });
      } catch {
        if (alive) setBusinessData({ businesses: [], agentsByBusiness: {}, browserEventsByBusiness: {} });
      } finally {
        if (alive) setBusinessLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [authResolved, userId]);

  // Business groups: businesses that have at least one agent; the ACTIVE
  // business's live store data (agents + newest events) overlays the loaded
  // rows so a running turn updates its cards in real time.
  const businessGroups = React.useMemo(() => {
    if (!businessData) return [];
    return businessData.businesses
      .map((business) => {
        const loadedAgents = businessData.agentsByBusiness[business.id] ?? [];
        const agents =
          business.id === activeBusinessId && storeAgents.length > 0
            ? storeAgents
            : loadedAgents;
        if (agents.length === 0) return null;

        let eventsByAgent = businessData.browserEventsByBusiness[business.id] ?? {};
        if (business.id === activeBusinessId && storeEvents.length > 0) {
          // Store events are newest-first; merge with the loaded (older)
          // list, deduped by id and re-sorted newest-first.
          const merged: Record<string, BusinessEventRow[]> = {};
          const add = (e: BusinessEventRow) => {
            if (!e.agent_id) return;
            merged[e.agent_id] = [e, ...(merged[e.agent_id] ?? [])];
          };
          for (const e of storeEvents) {
            if (e.event_type === "browser.activity") add(e);
          }
          const seen = new Set(storeEvents.map((e) => e.id));
          for (const [agentId, list] of Object.entries(eventsByAgent)) {
            for (const e of list) {
              if (!seen.has(e.id)) merged[agentId] = [...(merged[agentId] ?? []), e];
            }
          }
          eventsByAgent = Object.fromEntries(
            Object.entries(merged).map(([agentId, list]) => [
              agentId,
              [...list].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "")),
            ]),
          );
        }
        return { business, agents, eventsByAgent };
      })
      .filter((g): g is NonNullable<typeof g> => g !== null);
  }, [businessData, activeBusinessId, storeAgents, storeEvents]);

  // ── Loading / empty gates ────────────────────────────────────────────────
  const initialLoading = !authResolved || businessLoading || conversationsLoading;

  const businessAgentCount = businessGroups.reduce((n, g) => n + g.agents.length, 0);
  const noAgentsAtAll =
    generalConversations.length === 0 &&
    projectConversations.length === 0 &&
    businessAgentCount === 0;

  return (
    <div className="scrollbar-thin relative h-full overflow-y-auto px-3 py-4 sm:px-6 sm:py-8">
      <div className="mx-auto max-w-6xl space-y-8 pb-8">
        <PageHeader
          title="Browser"
          description="Live browsers of every agent — each agent works in its own browser."
          actions={
            <span className="hidden sm:block">
              <Badge variant="secondary" className="font-mono text-[11px]">
                Sandbox: {mode === "separate" ? "one per agent" : "shared"}
              </Badge>
            </span>
          }
        />

        {initialLoading ? (
          <div
            className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
            aria-busy="true"
            aria-label="Loading agents"
          >
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-80 rounded-xl" />
            ))}
          </div>
        ) : noAgentsAtAll ? (
          <section className="rounded-2xl border border-dashed px-6 py-14 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <Globe aria-hidden className="h-6 w-6 text-primary" />
            </div>
            <h2 className="font-display mt-5 text-lg font-semibold tracking-tight text-foreground">
              No agents yet
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
              Every agent gets its own browser view here. Start a chat or create a
              business — their live browsers and web research will appear on this tab.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              <Button asChild size="lg" className="min-h-11">
                <Link href={ROUTES.CHAT}>Open Chat</Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="min-h-11">
                <Link href={ROUTES.BUSINESS}>Open Business</Link>
              </Button>
            </div>
          </section>
        ) : (
          <>
            {/* ── Section 1 · Chat agents ─────────────────────────────── */}
            <section aria-label="Chat agents" className="space-y-4">
              <SectionHeader
                icon={MessageSquare}
                title="Chat agents"
                count={generalConversations.length}
                description="General conversations, most recent first — each agent gets its own live browser view."
              />
              {generalConversations.length === 0 ? (
                <SectionEmpty
                  icon={MessageSquare}
                  title="No chat agents yet"
                  body="Start a conversation in Chat — the agent's browser appears here the moment it uses its browser tool."
                  action={{ label: "Open Chat", href: ROUTES.CHAT }}
                />
              ) : (
                <div className="scrollbar-thin max-h-[28rem] overflow-y-auto pr-1">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {generalShown.map((c) => (
                      <AgentBrowserCard
                        key={c.id}
                        title={c.title?.trim() || "Untitled conversation"}
                        subtitle={conversationSubtitle(c)}
                        conversationId={c.id}
                        mode={mode}
                        live={mode === "shared" ? sharedLive : undefined}
                        shared={mode === "shared"}
                      />
                    ))}
                  </div>
                  <div className="pt-2">
                    <MoreNote count={generalHidden} />
                  </div>
                </div>
              )}
            </section>

            {/* ── Section 2 · Project agents ──────────────────────────── */}
            <section aria-label="Project agents" className="space-y-4">
              <SectionHeader
                icon={FolderKanban}
                title="Project agents"
                count={projectConversations.length}
                description="Conversations grouped by project — every project agent has its own browser."
              />
              {projectConversations.length === 0 ? (
                <SectionEmpty
                  icon={FolderKanban}
                  title="No project agents yet"
                  body="Chats inside a project show up here, grouped under their project. Start one from a project in the Chat sidebar."
                  action={{ label: "Open Chat", href: ROUTES.CHAT }}
                />
              ) : (
                <div className="scrollbar-thin max-h-[28rem] space-y-5 overflow-y-auto pr-1">
                  {projectGroups.map(([projectId, convs]) => {
                    const project = projects.find((p) => p.id === projectId);
                    return (
                      <div key={projectId} className="space-y-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <FolderKanban
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <h3
                            className="truncate text-sm font-medium text-foreground"
                            title={project?.name ?? projectId}
                          >
                            {project?.name ?? "Unknown project"}
                          </h3>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {convs.length} chat{convs.length === 1 ? "" : "s"}
                          </span>
                        </div>
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                          {convs.map((c) => (
                            <AgentBrowserCard
                              key={c.id}
                              title={c.title?.trim() || "Untitled conversation"}
                              subtitle={conversationSubtitle(c)}
                              conversationId={c.id}
                              mode={mode}
                              live={mode === "shared" ? sharedLive : undefined}
                              shared={mode === "shared"}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  <MoreNote count={projectHidden} />
                </div>
              )}
            </section>

            {/* ── Section 3 · Business agents ─────────────────────────── */}
            <section aria-label="Business agents" className="space-y-4">
              <SectionHeader
                icon={Briefcase}
                title="Business agents"
                count={businessAgentCount}
                description="Business agents don't run sandbox browsers — their web research is recorded per search."
              />
              {businessGroups.length === 0 ? (
                <SectionEmpty
                  icon={Briefcase}
                  title="No business agents yet"
                  body="Create a business and add agents — their recorded web research appears here after their first turn."
                  action={{ label: "Open Business", href: ROUTES.BUSINESS }}
                />
              ) : (
                <div className="scrollbar-thin max-h-[28rem] space-y-5 overflow-y-auto pr-1">
                  {businessGroups.map(({ business, agents, eventsByAgent }) => (
                    <div key={business.id} className="space-y-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <Briefcase
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                        <h3
                          className="truncate text-sm font-medium text-foreground"
                          title={business.name}
                        >
                          {business.name}
                        </h3>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {agents.length} agent{agents.length === 1 ? "" : "s"}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                        {agents.map((agent) => (
                          <BusinessAgentCard
                            key={agent.id}
                            agent={agent}
                            businessName={business.name}
                            events={eventsByAgent[agent.id] ?? []}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
