"use client";

/**
 * BusinessDashboard (Task 4-a) — the Business Mode landing page.
 *
 * Lists every business (active + archived) with honest, live per-business
 * stats (agent count, open tasks, drafts awaiting review, last activity —
 * all read straight from Dexie, nothing simulated), the template
 * quick-start grid, and the create-business entry point. Also carries the
 * shared "no AI provider" gate with the one-click Pollinations quick-start.
 *
 * All user-facing copy comes from the business UI dictionary (bt()).
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale } from "next-intl";
import { toast } from "sonner";
import { motion, useReducedMotion } from "framer-motion";
import {
  Archive,
  ArchiveRestore,
  Briefcase,
  Building2,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  ListTodo,
  Loader2,
  MapPin,
  Megaphone,
  Microscope,
  MoreHorizontal,
  Package,
  PenLine,
  PlugZap,
  Plus,
  Rocket,
  ShoppingCart,
  Trash2,
  Users,
  type LucideIcon,
} from "lucide-react";

import { PageHeader } from "@/components/dashboard/page-header";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Skeleton,
} from "@/components/ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { bt, setBusinessTextLocale } from "@/lib/business/ui-text";
import { BUSINESS_TEMPLATES } from "@/lib/business/templates";
import {
  businessAgentService,
  businessDraftService,
  businessEventService,
  businessService,
  businessTaskService,
} from "@/lib/business/data";
import type { BusinessRow } from "@/lib/business/types";
import { useBusinessStore } from "@/stores/business-store";
import { useAuth } from "@/hooks";
import { useAuthStore } from "@/stores/auth-store";
import { aiProviderService } from "@/lib/services";
import { cn, getErrorMessage, timeAgo } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Template quick-start icons (one fitting lucide mark per template key).
// ---------------------------------------------------------------------------

const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  "online-store": ShoppingCart,
  "content-agency": PenLine,
  "software-startup": Rocket,
  "freelance-service": Briefcase,
  "local-service": MapPin,
  "digital-products": Package,
  "marketing-agency": Megaphone,
  "research-workspace": Microscope,
};

// ---------------------------------------------------------------------------
// Per-business live stats (real Dexie reads — no cached/faked numbers).
// ---------------------------------------------------------------------------

interface BusinessStats {
  agents: number;
  openTasks: number;
  draftsWaiting: number;
  lastActivity: string | null;
}

/** Task statuses that no longer count as "open". */
const CLOSED_TASK_STATUSES: string[] = ["completed", "failed", "cancelled"];

/** Draft statuses that mean "waiting for the owner's review". */
const WAITING_DRAFT_STATUSES: string[] = ["draft", "in_review"];

async function loadBusinessStats(
  businesses: BusinessRow[],
): Promise<Record<string, BusinessStats>> {
  const entries = await Promise.all(
    businesses.map(async (b) => {
      const [agents, tasks, drafts, events] = await Promise.all([
        businessAgentService.list(b.id),
        businessTaskService.list(b.id),
        businessDraftService.list(b.id),
        // list(id, 1) returns the single MOST RECENT event.
        businessEventService.list(b.id, 1),
      ]);
      const stats: BusinessStats = {
        agents: agents.length,
        openTasks: tasks.filter((t) => !CLOSED_TASK_STATUSES.includes(t.status))
          .length,
        draftsWaiting: drafts.filter((d) =>
          WAITING_DRAFT_STATUSES.includes(d.status),
        ).length,
        lastActivity:
          events[events.length - 1]?.created_at ?? b.updated_at ?? null,
      };
      return [b.id, stats] as const;
    }),
  );
  return Object.fromEntries(entries);
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function BusinessDashboard() {
  const router = useRouter();
  const locale = useLocale();
  // Module-level dictionary locale (EN base, PL overrides) — idempotent.
  setBusinessTextLocale(locale);

  const reduceMotion = useReducedMotion();

  // useAuth's mount effect runs authStore.init(); authResolved gates every
  // Dexie read so the transient pre-auth user id is never queried (same
  // pattern as the knowledge-base page).
  const { user } = useAuth();
  const authResolved = useAuthStore((s) => s.authResolved);
  const userId = user?.id ?? null;

  const businesses = useBusinessStore((s) => s.businesses);
  const businessesLoaded = useBusinessStore((s) => s.businessesLoaded);
  const loadBusinesses = useBusinessStore((s) => s.loadBusinesses);
  const setBusiness = useBusinessStore((s) => s.setBusiness);

  // Provider gate: null = checking, true/false = result.
  const [hasProvider, setHasProvider] = React.useState<boolean | null>(null);
  const [addingProvider, setAddingProvider] = React.useState(false);

  const [stats, setStats] = React.useState<Record<string, BusinessStats>>({});
  const [archivedOpen, setArchivedOpen] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<BusinessRow | null>(
    null,
  );

  // ---- Data loading -------------------------------------------------------

  const refreshProviders = React.useCallback(async () => {
    if (!authResolved || !userId) return;
    try {
      const rows = await aiProviderService.list(userId);
      setHasProvider(rows.length > 0);
    } catch {
      // Leave the gate open (null) — the wizard/discovery surfaces the
      // honest provider error when a call is actually attempted.
    }
  }, [authResolved, userId]);

  React.useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  // Load businesses once per session (guarded by businessesLoaded — the
  // orchestrator re-runs loadBusinesses after create/archive/delete too).
  React.useEffect(() => {
    if (!authResolved || !userId) return;
    if (useBusinessStore.getState().businessesLoaded) return;
    void loadBusinesses();
  }, [authResolved, userId, loadBusinesses]);

  // Live stats for the current roster (re-read whenever the list changes).
  React.useEffect(() => {
    if (!businessesLoaded || businesses.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const next = await loadBusinessStats(businesses);
        if (!cancelled) setStats(next);
      } catch {
        // Non-fatal — cards render without counts until the next change.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businesses, businessesLoaded]);

  // ---- Actions ------------------------------------------------------------

  async function handleAddPollinations() {
    if (!userId || addingProvider) return;
    setAddingProvider(true);
    try {
      await aiProviderService.create(userId, {
        name: "Pollinations",
        base_url: "https://gen.pollinations.ai/v1",
        api_key: "", // keyless — Pollinations anonymous tier
        models: ["openai"],
        is_active: true,
        model_type: "chat",
      });
      toast.success(bt("toast.providerAdded"));
      await refreshProviders();
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setAddingProvider(false);
    }
  }

  async function handleToggleArchive(business: BusinessRow) {
    const next = business.status === "archived" ? "active" : "archived";
    setBusyId(business.id);
    try {
      await businessService.update(business.id, { status: next });
      const row = await businessService.get(business.id);
      if (row) setBusiness(row);
      await loadBusinesses();
      toast.success(bt("toast.saved"));
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await businessService.remove(deleteTarget.id);
      await loadBusinesses();
      toast.success(bt("toast.businessDeleted"));
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  // ---- Derived ------------------------------------------------------------

  const loading = !authResolved || !businessesLoaded;
  const active = businesses.filter((b) => b.status !== "archived");
  const archived = businesses.filter((b) => b.status === "archived");

  const openBusiness = (id: string) => router.push(`/business/${id}`);

  // Subtle entrance (≤300ms); reduced-motion renders static.
  const entrance = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.25, ease: [0.32, 0.72, 0, 1] as const },
      };

  // ---- Render ---------------------------------------------------------------

  return (
    <div className="scrollbar-thin relative h-full overflow-y-auto px-3 py-4 sm:px-6 sm:py-8">
      <div className="mx-auto max-w-6xl space-y-8 pb-8">
        <PageHeader
          title={bt("dashboard.title")}
          description={bt("dashboard.subtitle")}
          actions={
            <Button
              size="lg"
              onClick={() => router.push("/business/new")}
              className="min-h-11"
            >
              <Plus className="size-4" />
              {bt("dashboard.createBusiness")}
            </Button>
          }
        />

        {/* Provider gate — Business Mode needs at least one AI provider. */}
        {hasProvider === false && (
          <motion.div {...entrance}>
            <Alert>
              <PlugZap className="size-4" />
              <AlertTitle>{bt("wizard.noProviderTitle")}</AlertTitle>
              <AlertDescription>
                <p>{bt("wizard.noProviderBody")}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onClick={handleAddPollinations}
                    disabled={addingProvider}
                    className="min-h-9"
                  >
                    {addingProvider ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <PlugZap className="size-4" />
                    )}
                    {bt("wizard.addPollinations")}
                  </Button>
                  <Button size="sm" variant="ghost" asChild className="min-h-9">
                    <Link href="/settings/config">
                      {bt("wizard.goToSettings")}
                    </Link>
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          </motion.div>
        )}

        {/* Loading skeletons — while auth resolves or the list loads. */}
        {loading ? (
          <div
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
            aria-busy="true"
            aria-label={bt("common.loading")}
          >
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-48 rounded-xl" />
            ))}
          </div>
        ) : (
          <>
            {/* Empty state — first-run guidance. */}
            {active.length === 0 && (
              <motion.section
                {...entrance}
                className="rounded-2xl border border-dashed px-6 py-14 text-center"
              >
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                  <Building2 aria-hidden className="h-6 w-6 text-primary" />
                </div>
                <h2 className="font-display mt-5 text-lg font-semibold tracking-tight text-foreground">
                  {bt("dashboard.emptyTitle")}
                </h2>
                <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                  {bt("dashboard.emptySubtitle")}
                </p>
                <div className="mt-5">
                  <Button
                    size="lg"
                    onClick={() => router.push("/business/new")}
                    className="min-h-11"
                  >
                    <Plus className="size-4" />
                    {bt("dashboard.createBusiness")}
                  </Button>
                </div>
              </motion.section>
            )}

            {/* Active businesses. */}
            {active.length > 0 && (
              <section aria-label={bt("dashboard.activeSection")} className="space-y-4">
                <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">
                  {bt("dashboard.activeSection")}
                </h2>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {active.map((business, i) => (
                    <BusinessCard
                      key={business.id}
                      business={business}
                      stats={stats[business.id]}
                      index={i}
                      busy={busyId === business.id}
                      onOpen={openBusiness}
                      onToggleArchive={() => void handleToggleArchive(business)}
                      onDelete={() => setDeleteTarget(business)}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Template quick-starts. */}
            <section
              aria-label={bt("dashboard.templatesTitle")}
              className="space-y-4"
            >
              <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">
                {bt("dashboard.templatesTitle")}
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {BUSINESS_TEMPLATES.map((t) => {
                  const Icon = TEMPLATE_ICONS[t.key] ?? Building2;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() =>
                        router.push(`/business/new?template=${t.key}`)
                      }
                      className="glass-card hover:border-primary/40 focus-visible:ring-ring group flex min-h-[76px] items-start gap-3 rounded-xl p-4 text-left transition-colors focus-visible:ring-1 focus-visible:outline-none"
                    >
                      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-primary/10 text-primary">
                        <Icon aria-hidden className="size-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="text-foreground block text-sm font-semibold">
                          {bt(t.titleKey)}
                        </span>
                        <span className="text-muted-foreground mt-1 line-clamp-2 block text-xs leading-relaxed">
                          {bt(t.descriptionKey)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Archived businesses (collapsible, only when present). */}
            {archived.length > 0 && (
              <Collapsible
                open={archivedOpen}
                onOpenChange={setArchivedOpen}
              >
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="min-h-9 gap-1.5">
                    {archivedOpen ? (
                      <ChevronDown aria-hidden className="size-4" />
                    ) : (
                      <ChevronRight aria-hidden className="size-4" />
                    )}
                    {archivedOpen
                      ? bt("dashboard.hideArchived")
                      : bt("dashboard.showArchived", { count: archived.length })}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {archived.map((business, i) => (
                      <BusinessCard
                        key={business.id}
                        business={business}
                        stats={stats[business.id]}
                        index={i}
                        busy={busyId === business.id}
                        onOpen={openBusiness}
                        onToggleArchive={() =>
                          void handleToggleArchive(business)
                        }
                        onDelete={() => setDeleteTarget(business)}
                      />
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </>
        )}
      </div>

      {/* Delete confirmation — cascades every child table. */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{bt("dashboard.deleteBusiness")}</AlertDialogTitle>
            <AlertDialogDescription>
              {bt("dashboard.deleteWarning")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {bt("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault(); // keep the dialog open while deleting
                void handleDelete();
              }}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {bt("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Business card
// ---------------------------------------------------------------------------

function BusinessCard({
  business,
  stats,
  index,
  busy,
  onOpen,
  onToggleArchive,
  onDelete,
}: {
  business: BusinessRow;
  stats?: BusinessStats;
  index: number;
  busy: boolean;
  onOpen: (id: string) => void;
  onToggleArchive: () => void;
  onDelete: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const archived = business.status === "archived";

  // Staggered entrance, capped so long lists settle fast; static when the
  // user prefers reduced motion.
  const entrance = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        transition: {
          duration: 0.25,
          delay: Math.min(index * 0.04, 0.2),
          ease: [0.32, 0.72, 0, 1] as const,
        },
      };

  const lastActivityText = stats
    ? bt("dashboard.lastActivity", {
        time: stats.lastActivity
          ? timeAgo(stats.lastActivity) || bt("common.justNow")
          : bt("common.never"),
      })
    : null;

  return (
    <motion.article
      {...entrance}
      className={cn(
        "glass-card flex flex-col gap-3 rounded-xl p-4 sm:p-5",
        archived && "opacity-70",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={() => onOpen(business.id)}
          className="focus-visible:ring-ring min-w-0 flex-1 cursor-pointer rounded-md text-left focus-visible:ring-1 focus-visible:outline-none"
        >
          <h3 className="text-foreground truncate font-semibold">
            {business.name}
          </h3>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={business.name}
              disabled={busy}
              className="size-9"
            >
              {busy ? (
                <Loader2 aria-hidden className="size-4 animate-spin" />
              ) : (
                <MoreHorizontal aria-hidden className="size-4" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onToggleArchive}>
              {archived ? (
                <ArchiveRestore aria-hidden className="size-4" />
              ) : (
                <Archive aria-hidden className="size-4" />
              )}
              {archived ? bt("dashboard.restore") : bt("dashboard.archive")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 aria-hidden className="size-4" />
              {bt("dashboard.deleteBusiness")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {business.description?.trim() ? (
        <p className="text-muted-foreground line-clamp-2 min-h-10 text-sm leading-relaxed">
          {business.description}
        </p>
      ) : null}

      {business.industry?.trim() ? (
        <div>
          <Badge variant="secondary">{business.industry}</Badge>
        </div>
      ) : null}

      {/* Live stats — skeletons until the real counts land. */}
      <dl className="text-muted-foreground grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <div className="flex items-center gap-1.5">
          <Users aria-hidden className="size-3.5 shrink-0" />
          <dd className="truncate">
            {stats ? (
              stats.agents === 1
                ? bt("dashboard.oneAgent")
                : bt("dashboard.agents", { count: stats.agents })
            ) : (
              <Skeleton className="h-3 w-14" />
            )}
          </dd>
        </div>
        <div className="flex items-center gap-1.5">
          <ListTodo aria-hidden className="size-3.5 shrink-0" />
          <dd className="truncate">
            {stats ? (
              bt("dashboard.openTasks", { count: stats.openTasks })
            ) : (
              <Skeleton className="h-3 w-14" />
            )}
          </dd>
        </div>
        <div className="flex items-center gap-1.5">
          <FileText aria-hidden className="size-3.5 shrink-0" />
          <dd
            className={cn(
              "truncate",
              stats && stats.draftsWaiting > 0 && "text-primary font-medium",
            )}
          >
            {stats ? (
              bt("dashboard.draftsWaiting", { count: stats.draftsWaiting })
            ) : (
              <Skeleton className="h-3 w-14" />
            )}
          </dd>
        </div>
        <div className="flex items-center gap-1.5">
          <Clock aria-hidden className="size-3.5 shrink-0" />
          <dd className="truncate">
            {lastActivityText ?? <Skeleton className="h-3 w-14" />}
          </dd>
        </div>
      </dl>

      <div className="mt-auto flex items-center gap-2 pt-1">
        <Button
          onClick={() => onOpen(business.id)}
          className="min-h-10 flex-1"
        >
          {bt("dashboard.open")}
        </Button>
      </div>
    </motion.article>
  );
}
