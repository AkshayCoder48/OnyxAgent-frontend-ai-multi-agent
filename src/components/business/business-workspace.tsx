"use client";

/**
 * Business Mode — workspace shell (Task 4-b).
 *
 * Sticky glass header (back to dashboard, identity + turn status, model chip,
 * overflow menu), horizontally scrollable tab navigation with live badge
 * counts, and the full-height content area. The active business lives in the
 * zustand store — NOT in this component — so switching tabs (or remounting
 * the shell) never reloads the business or kills a running turn: the mount
 * effect only calls openBusiness when the store's active id differs.
 */

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import {
  Activity,
  ArrowLeft,
  Brain,
  CheckCircle2,
  Circle,
  Cpu,
  Download,
  FileText,
  FolderOpen,
  Globe,
  Info,
  Keyboard,
  ListTodo,
  MessageSquare,
  MoreHorizontal,
  Network,
  Settings,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useBusinessStore } from "@/stores/business-store";
import { bt } from "@/lib/business/ui-text";
import type { BusinessTaskStatus } from "@/lib/business/types";
import { cn } from "@/lib/utils";
import { AgentLogo } from "./agent-logos";
import { BusinessChat } from "./business-chat";
import { renderBusinessMarkdown } from "./business-message-item";
import { SwarmView } from "./swarm-view";
import { TasksView } from "./tasks-view";
import { DraftsView } from "./drafts-view";
import { FilesView } from "./files-view";
import { MemoryView } from "./memory-view";
import { ActivityView } from "./activity-view";
import { BrowserPanel } from "./browser-panel";
import { BusinessSettingsDialog } from "./business-settings-dialog";
import { ExportDialog } from "./export-dialog";

export type BusinessTab =
  | "chat"
  | "swarm"
  | "tasks"
  | "drafts"
  | "files"
  | "memory"
  | "activity";

/** Task statuses that are finished — everything else counts as "open". */
const TERMINAL_TASK_STATUSES: ReadonlySet<BusinessTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** Draft statuses waiting on the user. */
const REVIEW_DRAFT_STATUSES = new Set(["draft", "in_review"]);

export function BusinessWorkspace({ tab }: { tab: BusinessTab }) {
  const params = useParams<{ businessId: string }>();
  const businessId = params?.businessId;
  const router = useRouter();

  const activeBusinessId = useBusinessStore((s) => s.activeBusinessId);
  const business = useBusinessStore((s) => s.activeBusiness);
  const turnRunning = useBusinessStore((s) => s.turnRunning);
  const tasks = useBusinessStore((s) => s.tasks);
  const drafts = useBusinessStore((s) => s.drafts);

  const reduceMotion = useReducedMotion();
  const contentEntrance = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.22, ease: [0.32, 0.72, 0, 1] as const },
      };

  // Local overlays.
  const [browserOpen, setBrowserOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [exportOpen, setExportOpen] = React.useState(false);
  const [infoOpen, setInfoOpen] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);

  // Open the business ONLY when the store isn't already on it — tab switches
  // remount this shell but must never reload data or interrupt a live turn.
  const [opened, setOpened] = React.useState(false);
  React.useEffect(() => {
    if (!businessId) return;
    if (useBusinessStore.getState().activeBusinessId !== businessId) {
      void useBusinessStore.getState().openBusiness(businessId);
    }
    setOpened(true);
  }, [businessId]);
  // NOTE: no cleanup reset — leaving is explicit (the back link calls
  // openBusiness(null)) so the store, and any running turn, survive route
  // changes between tabs of the same business.

  // ── TRIGGER.DEV CLOUD HANDOFF ADOPTION ──────────────────────────────────
  // When the app closed mid-turn, pagehide dispatched the business turn to
  // the operator's trigger.dev Cloud project. On return: adopt the run (Dexie
  // mirror + task token), land the result when it finishes, and poll while
  // it is still live. Closing THIS tab never cancels it (the cloud owns the
  // lifecycle) — the interval just stops.
  React.useEffect(() => {
    if (!businessId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const tick = async () => {
      try {
        const { useAuthStore: auth } = await import("@/stores/auth-store");
        const userId = auth.getState().user?.id;
        if (!userId) return;
        const mod = await import("@/lib/agent/turn-cloud-handoff");
        if (!mod.readBusinessCloudHandoffMeta(businessId)) {
          stop(); // nothing pending (landed / lost / never existed)
          return;
        }
        const res = await mod.adoptBusinessCloudHandoff(userId, businessId);
        if (cancelled) return;
        if (res.landed || !res.run) {
          stop(); // finished — result landed (or the run was lost honestly)
        } else if (!timer) {
          timer = setInterval(() => void tick(), 6000);
        }
      } catch {
        // best-effort — the next mount retries the adoption
      }
    };
    void tick();
    return () => {
      cancelled = true;
      stop();
    };
  }, [businessId]);

  const loading = !business && (!opened || activeBusinessId === businessId);
  const notFound = opened && !business && activeBusinessId !== businessId;

  if (notFound) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <AgentLogo logo="generic" className="size-12 p-2.5" />
        <Button asChild variant="outline" size="sm" className="h-10">
          <Link href="/business" onClick={() => void useBusinessStore.getState().openBusiness(null)}>
            <ArrowLeft className="size-4" aria-hidden />
            {bt("ws.backToDashboard")}
          </Link>
        </Button>
      </div>
    );
  }

  if (loading || !business) {
    return (
      <div className="flex h-full flex-col" aria-busy="true">
        <div className="glass-header flex items-center gap-3 border-b px-3 py-2.5 sm:px-4">
          <Skeleton className="size-9 rounded-xl" />
          <Skeleton className="size-8 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
          <Skeleton className="h-9 w-24 rounded-full" />
        </div>
        <div className="mx-auto w-full max-w-3xl flex-1 space-y-4 px-4 py-6">
          <Skeleton className="ml-auto h-10 w-2/5 rounded-2xl" />
          <Skeleton className="h-16 w-3/4 rounded-2xl" />
          <Skeleton className="h-6 w-1/2 rounded-lg" />
          <Skeleton className="h-24 w-full rounded-2xl" />
        </div>
      </div>
    );
  }

  const openTaskCount = tasks.filter((t) => !TERMINAL_TASK_STATUSES.has(t.status)).length;
  const reviewDraftCount = drafts.filter((d) => REVIEW_DRAFT_STATUSES.has(d.status)).length;

  const tabs: { key: BusinessTab; label: string; icon: typeof MessageSquare; href: string; count?: number }[] = [
    { key: "chat", label: bt("ws.tab.chat"), icon: MessageSquare, href: `/business/${businessId}` },
    { key: "swarm", label: bt("ws.tab.swarm"), icon: Network, href: `/business/${businessId}/swarm` },
    {
      key: "tasks",
      label: bt("ws.tab.tasks"),
      icon: ListTodo,
      href: `/business/${businessId}/tasks`,
      count: openTaskCount,
    },
    {
      key: "drafts",
      label: bt("ws.tab.drafts"),
      icon: FileText,
      href: `/business/${businessId}/drafts`,
      count: reviewDraftCount,
    },
    {
      key: "files",
      label: bt("ws.tab.files"),
      icon: FolderOpen,
      href: `/business/${businessId}/files`,
    },
    { key: "memory", label: bt("ws.tab.memory"), icon: Brain, href: `/business/${businessId}/memory` },
    { key: "activity", label: bt("ws.tab.activity"), icon: Activity, href: `/business/${businessId}/activity` },
  ];

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* ---------------------------------------------------------------- */}
      {/* Header (sticky, glass like the app header) */}
      {/* ---------------------------------------------------------------- */}
      <header className="glass-header sticky top-0 z-30 shrink-0 border-b">
        <div className="flex items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-4">
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="size-9 shrink-0 rounded-xl"
          >
            <Link
              href="/business"
              aria-label={bt("ws.backToDashboard")}
              title={bt("ws.backToDashboard")}
              onClick={() => void useBusinessStore.getState().openBusiness(null)}
            >
              <ArrowLeft className="size-4" aria-hidden />
            </Link>
          </Button>

          <AgentLogo logo="orb" label={bt("ws.mainAgent")} className="size-8" />

          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-sm font-bold sm:text-base">{business.name}</h1>
              {turnRunning ? (
                <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-primary">
                  <span className="relative flex size-2" aria-hidden>
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
                    <span className="relative inline-flex size-2 rounded-full bg-primary" />
                  </span>
                  {bt("ws.turnRunning")}
                </span>
              ) : business.status === "setup" ? (
                <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                  {bt("ws.statusSetup")}
                </Badge>
              ) : business.status === "archived" ? (
                <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px] text-muted-foreground">
                  {bt("dashboard.archived")}
                </Badge>
              ) : (
                <span className="shrink-0 inline-flex size-2 rounded-full bg-emerald-500/80" aria-hidden />
              )}
            </div>
            <p className="truncate text-[11px] leading-tight text-muted-foreground">{business.description}</p>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSettingsOpen(true)}
            className="h-9 shrink-0 gap-1.5 rounded-full text-xs font-medium"
            aria-label={bt("ws.mainModel")}
            title={bt("ws.mainModel")}
          >
            <Cpu className="size-3.5 text-primary" aria-hidden />
            <span className="max-w-[90px] truncate sm:max-w-[140px]">
              {business.configuration.mainModel ?? "Auto"}
            </span>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-9 shrink-0 rounded-xl" aria-label="More actions">
                <MoreHorizontal className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={() => setBrowserOpen(true)}>
                <Globe aria-hidden />
                {bt("ws.menu.browser")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => router.push(`/business/${businessId}/activity`)}>
                <Activity aria-hidden />
                {bt("ws.menu.agentActivity")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setExportOpen(true)}>
                <Download aria-hidden />
                {bt("ws.menu.export")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setInfoOpen(true)}>
                <Info aria-hidden />
                {bt("ws.menu.businessInfo")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShortcutsOpen(true)}>
                <Keyboard aria-hidden />
                {bt("ws.menu.shortcuts")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
                <Settings aria-hidden />
                {bt("ws.menu.settings")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Tab navigation */}
        <nav aria-label={bt("dashboard.title")} className="scrollbar-none overflow-x-auto">
          <div className="flex min-w-max items-stretch gap-1 px-3 sm:px-4">
            {tabs.map(({ key, label, icon: Icon, href, count }) => {
              const active = tab === key;
              return (
                <Link
                  key={key}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                    active
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-4" aria-hidden />
                  <span>{label}</span>
                  {count != null && count > 0 && (
                    <span className="rounded-full bg-primary/15 px-1.5 py-px text-[10px] font-semibold leading-4 text-primary tabular-nums">
                      {count}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </nav>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* Content — each view manages its own scroll inside this flex box. */}
      {/* ---------------------------------------------------------------- */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <motion.div key={tab} {...contentEntrance} className="h-full">
          {tab === "chat" ? (
            <BusinessChat />
          ) : tab === "swarm" ? (
            <SwarmView />
          ) : tab === "tasks" ? (
            <TasksView />
          ) : tab === "drafts" ? (
            <DraftsView />
          ) : tab === "files" ? (
            <FilesView />
          ) : tab === "memory" ? (
            <MemoryView />
          ) : (
            <ActivityView />
          )}
        </motion.div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Overlays */}
      {/* ---------------------------------------------------------------- */}
      <BrowserPanel open={browserOpen} onOpenChange={setBrowserOpen} />
      <BusinessSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />

      {/* Business information — profile markdown (incl. assumptions folded
          in by discovery), goals and the honest "no profile yet" fallback. */}
      <Sheet open={infoOpen} onOpenChange={setInfoOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader>
            <div className="min-w-0">
              <SheetTitle className="truncate">{business.name}</SheetTitle>
              <SheetDescription className="mt-0.5 line-clamp-2">{business.description}</SheetDescription>
            </div>
            <SheetClose onClick={() => setInfoOpen(false)} />
          </SheetHeader>
          <SheetBody className="scrollbar-thin overflow-y-auto">
            <div className="space-y-5 p-4 text-sm">
              {business.goals.length > 0 && (
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {bt("wizard.section.goals")}
                  </h3>
                  <ul className="mt-2 space-y-1.5">
                    {business.goals.map((goal) => (
                      <li key={goal.id} className="flex items-start gap-2">
                        {goal.status === "completed" ? (
                          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                        ) : (
                          <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" aria-hidden />
                        )}
                        <span className={cn(goal.status === "completed" && "text-muted-foreground line-through")}>
                          {goal.title}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {bt("wizard.blueprintTitle")}
                </h3>
                <div className="mt-2 text-sm">
                  {renderBusinessMarkdown(business.business_profile || business.description, {
                    keyPrefix: `bizinfo-${business.id}`,
                  })}
                </div>
              </section>
            </div>
          </SheetBody>
        </SheetContent>
      </Sheet>

      {/* Keyboard shortcuts — the real ones this workspace implements. */}
      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{bt("ws.menu.shortcuts")}</DialogTitle>
            <DialogDescription className="sr-only">{bt("ws.menu.shortcuts")}</DialogDescription>
          </DialogHeader>
          <ul className="space-y-2.5 text-sm">
            {[
              { keys: "Enter", label: "Send message" },
              { keys: "Shift + Enter", label: "New line" },
              { keys: "@", label: bt("chat.mentionHint") },
              { keys: "↑ ↓ · Enter", label: "Pick a mentioned agent" },
              { keys: "Esc", label: "Close the mention list" },
            ].map((row) => (
              <li key={row.keys} className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">{row.label}</span>
                <kbd className="shrink-0 rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
                  {row.keys}
                </kbd>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}
