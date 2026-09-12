"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useConversations } from "@/hooks";
import { useAuthStore } from "@/stores";
import { Button, Skeleton } from "@/components/ui";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetClose } from "@/components/ui";
import { useResizableSidebar } from "@/components/ui/resize-handle";
import { cn } from "@/lib/utils";
import { useChatSidebarStore } from "@/stores";
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  MoreVertical,
  Pencil,
  Search,
  Settings,
  Share2,
  SquarePen,
  Trash2,
} from "lucide-react";
import type { Conversation } from "@/types";
import { ROUTES } from "@/lib/constants";
import type { SafeScheduledTask } from "@/lib/scheduler/types";
import { schedulerApi } from "@/lib/scheduler/client";
import { describeSchedule } from "@/lib/scheduler/tz-cron";
import { statusOf } from "@/components/scheduled/task-card";
import { ShareDialog } from "./share-dialog";
import { RunningExecutionsSection } from "./running-executions";

/* ---------------------------------------------------------------------------
 * Date grouping for the Terra editorial history: tracked-caps day buckets.
 * ------------------------------------------------------------------------- */
const GROUP_ORDER = ["Today", "Yesterday", "This week", "Older"] as const;
type DateGroup = (typeof GROUP_ORDER)[number];

function groupKeyFor(iso: string): DateGroup {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.floor((startOfDay(now).getTime() - startOfDay(d).getTime()) / dayMs);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays <= 7) return "This week";
  return "Older";
}

function groupByDate(conversations: Conversation[]): Map<DateGroup, Conversation[]> {
  const map = new Map<DateGroup, Conversation[]>();
  for (const label of GROUP_ORDER) map.set(label, []);
  for (const c of conversations) {
    map.get(groupKeyFor(c.updated_at || c.created_at))!.push(c);
  }
  return map;
}

/* Initials avatar for the account row (ink on soft-terracotta). */
function accountInitials(user: { full_name?: string | null; email: string } | null): string {
  if (!user) return "·";
  const name = (user.full_name || user.email || "").trim();
  if (!name) return "·";
  const parts = name.split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  const base = name.includes("@") ? name.split("@")[0]! : name;
  return base.slice(0, 2).toUpperCase();
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onRename: (title: string) => void;
  onShare: () => void;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  onDelete,
  onArchive,
  onUnarchive,
  onRename,
  onShare,
}: ConversationItemProps) {
  const t = useTranslations("chat");
  const [showMenu, setShowMenu] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(conversation.title || "");

  const handleRename = () => {
    if (editTitle.trim()) {
      onRename(editTitle.trim());
    }
    setIsEditing(false);
  };

  const displayTitle = conversation.title || t("newConversation");

  return (
    <div
      className={cn(
        // Date-grouped history rows — the ACTIVE row is a soft-terracotta
        // pill (#F0E3D5 fill, #EAD6C4 hairline) with a terracotta icon.
        "group relative flex min-h-[40px] cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-all",
        isActive
          ? "bg-accent text-accent-foreground border border-[#ead6c4] dark:border-[#4c3d2a]"
          : "text-foreground/70 hover:bg-foreground/5 hover:text-foreground border border-transparent",
      )}
      onClick={onSelect}
    >
      <MessageSquare
        className={cn("h-4 w-4 shrink-0", isActive ? "text-primary" : "text-foreground/40")}
      />
      {isEditing ? (
        <input
          type="text"
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          onBlur={handleRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleRename();
            if (e.key === "Escape") setIsEditing(false);
          }}
          className="text-foreground flex-1 bg-transparent outline-none"
          autoFocus
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="min-w-0 flex-1">
          <span className="block truncate">{displayTitle}</span>
        </div>
      )}

      <div className="relative">
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "touch:opacity-100 h-8 w-8 p-0 opacity-0 group-hover:opacity-100",
            showMenu && "opacity-100",
          )}
          onClick={(e) => {
            e.stopPropagation();
            setShowMenu(!showMenu);
          }}
        >
          <MoreVertical className="h-4 w-4" />
        </Button>

        {showMenu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
            <div className="bg-popover absolute top-8 right-0 z-20 w-40 rounded-md border shadow-lg">
              <button
                className="hover:bg-secondary flex min-h-[44px] w-full items-center gap-2 px-3 py-3 text-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsEditing(true);
                  setShowMenu(false);
                }}
              >
                <Pencil className="h-4 w-4" />
                {t("rename")}
              </button>
              <button
                className="hover:bg-secondary flex min-h-[44px] w-full items-center gap-2 px-3 py-3 text-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onShare();
                  setShowMenu(false);
                }}
              >
                <Share2 className="h-4 w-4" />
                {t("share")}
              </button>
              {conversation.is_archived ? (
                <button
                  className="hover:bg-secondary flex min-h-[44px] w-full items-center gap-2 px-3 py-3 text-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onUnarchive();
                    setShowMenu(false);
                  }}
                >
                  <ArchiveRestore className="h-4 w-4" />
                  Restore
                </button>
              ) : (
                <button
                  className="hover:bg-secondary flex min-h-[44px] w-full items-center gap-2 px-3 py-3 text-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onArchive();
                    setShowMenu(false);
                  }}
                >
                  <Archive className="h-4 w-4" />
                  {t("archive")}
                </button>
              )}
              <button
                className="text-destructive hover:bg-destructive/10 flex min-h-[44px] w-full items-center gap-2 px-3 py-3 text-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                  setShowMenu(false);
                }}
              >
                <Trash2 className="h-4 w-4" />
                {t("delete")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

type ConversationView = "active" | "archived";

/* ---------------------------------------------------------------------------
 * Scheduled Tasks sidebar section — the header row navigates to the
 * management page; below it, the task rows themselves (chat-linked rows open
 * the conversation, standalone rows go to /scheduled-tasks). The list is
 * fetched via schedulerApi (OnyxBase key resolved at call time — never
 * stored); when it is NOT_CONFIGURED or absent, ONLY the header row renders.
 * ------------------------------------------------------------------------- */

/** Fetch the user's scheduled tasks every 30s while the sidebar is mounted
 *  (silent; failures → empty list → header row only, never an error). */
function useSidebarScheduledTasks(userId: string | null | undefined): SafeScheduledTask[] | null {
  const [tasks, setTasks] = useState<SafeScheduledTask[] | null>(null);
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const load = async () => {
      const res = await schedulerApi(userId, "list");
      if (cancelled) return;
      // NOT_CONFIGURED / no key / network error → header row only, no error.
      setTasks(res.ok ? (res.tasks ?? []) : []);
    };
    void load().catch(() => {});
    const id = window.setInterval(() => void load().catch(() => {}), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [userId]);
  return tasks;
}

function ScheduledTasksSection({
  tasks,
  onSelect,
  onNavigate,
}: {
  /** The sidebar's SHARED task list (fetched once in ConversationSidebar —
   *  the expanded list and the collapsed rail dot use the same poller). */
  tasks: SafeScheduledTask[] | null;
  /** Same handler a conversation row uses — opens the linked chat. */
  onSelect: (id: string) => void;
  onNavigate?: () => void;
}) {
  const ts = useTranslations("scheduled");
  const router = useRouter();

  const rows = (tasks ?? []).slice(0, 4);
  const more = (tasks?.length ?? 0) - rows.length;

  const goManage = () => {
    router.push(ROUTES.SCHEDULED_TASKS);
    onNavigate?.();
  };

  return (
    <div className="px-3 pb-2" data-testid="scheduled-tasks-section">
      {/* Header row — a section label that still opens the management page. */}
      <button
        type="button"
        onClick={goManage}
        className="group flex min-h-[44px] w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-colors hover:bg-foreground/5"
        aria-label={ts("navLabel")}
      >
        <CalendarClock className="h-4 w-4 shrink-0 text-foreground/40" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/70 group-hover:text-foreground">
          {ts("navLabel")}
        </span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-foreground/30" aria-hidden />
      </button>

      {/* Task rows — name + one-line schedule summary + status dot. */}
      <div className="space-y-0.5">
        {rows.map((task) => {
          const dot = statusOf(task).dot;
          return (
            <button
              key={task.id}
              type="button"
              onClick={() => {
                if (task.chatId) {
                  onSelect(task.chatId);
                  onNavigate?.();
                } else {
                  goManage();
                }
              }}
              className="flex min-h-[44px] w-full cursor-pointer items-center gap-2.5 rounded-xl border border-transparent px-3 py-1.5 text-left transition-colors hover:bg-foreground/5"
              aria-label={`${ts("navLabel")}: ${task.name}`}
            >
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dot)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] leading-tight text-foreground/80">
                  {task.name}
                </span>
                <span className="block truncate text-[11px] leading-tight text-foreground/45">
                  {describeSchedule(task as never)}
                </span>
              </span>
            </button>
          );
        })}

        {/* Overflow row → the management page. */}
        {more > 0 && (
          <button
            type="button"
            onClick={goManage}
            className="flex min-h-[40px] w-full cursor-pointer items-center gap-2 rounded-xl px-3 py-1.5 text-left text-[12px] text-foreground/50 transition-colors hover:bg-foreground/5 hover:text-foreground"
            aria-label={ts("moreTasks", { count: more })}
          >
            <span className="w-4 shrink-0" aria-hidden />
            {ts("moreTasks", { count: more })} →
          </button>
        )}
      </div>
    </div>
  );
}

interface ConversationListProps {
  conversations: Conversation[];
  currentConversationId: string | null;
  isLoading: boolean;
  /** The sidebar's scheduled-task list (shared poller — see
   *  useSidebarScheduledTasks in ConversationSidebar). */
  scheduledTasks?: SafeScheduledTask[] | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onNewChat: () => void;
  onNavigate?: () => void;
  onLoadMore?: () => void;
}

function ConversationList({
  conversations = [],
  currentConversationId,
  isLoading,
  scheduledTasks = null,
  onSelect,
  onDelete,
  onArchive,
  onUnarchive,
  onRename,
  onNewChat,
  onNavigate,
  onLoadMore,
}: ConversationListProps) {
  const t = useTranslations("chat");
  const [view, setView] = useState<ConversationView>("active");
  const [shareConversationId, setShareConversationId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const all = conversations ?? [];
  const activeCount = all.filter((c) => !c.is_archived).length;
  const archivedCount = all.filter((c) => c.is_archived).length;
  const filtered = all.filter((c) => (view === "active" ? !c.is_archived : c.is_archived));
  const q = query.trim().toLowerCase();
  const visible = q
    ? filtered.filter((c) => (c.title || "").toLowerCase().includes(q))
    : filtered;

  // Date-grouped history (Terra spec): TODAY / YESTERDAY / THIS WEEK / OLDER.
  const groups = groupByDate(visible);

  const handleSelect = (id: string) => {
    onSelect(id);
    onNavigate?.();
  };

  const handleNewChat = () => {
    onNewChat();
    onNavigate?.();
  };

  const isArchivedView = view === "archived";

  return (
    <>
      {/* Full-width terracotta "New conversation" button with ⌘N hint. */}
      <div className="px-3 pt-3 pb-2">
        <button
          type="button"
          onClick={handleNewChat}
          className="bg-primary text-primary-foreground hover:bg-[#a8421f] flex h-10 w-full items-center justify-between gap-2 rounded-xl px-3.5 text-sm font-medium shadow-sm transition-colors"
        >
          <span className="inline-flex items-center gap-2">
            <SquarePen className="h-4 w-4 shrink-0" />
            {t("newChat")}
          </span>
          <kbd className="text-primary-foreground/70 font-mono text-[10px] tracking-wider">
            ⌘N
          </kbd>
        </button>
      </div>

      {/* Scheduled Tasks — the automation section, directly below the New
          conversation button: a header row to the management page + the task
          rows themselves (chat-linked rows open the conversation). Present in
          the expanded sidebar AND the mobile Sheet (both render this list);
          the collapsed rail keeps an icon-only twin with an emerald pulse
          dot while any task is active. */}
      <ScheduledTasksSection
        tasks={scheduledTasks}
        onSelect={(id) => handleSelect(id)}
        onNavigate={onNavigate}
      />

      {/* LIVE EXECUTIONS (spec §13): every running agent execution — they
          keep streaming no matter where the user navigates; clicking a row
          re-subscribes the chat UI to the execution's live store. */}
      <RunningExecutionsSection
        conversations={all}
        currentConversationId={currentConversationId}
        onSelect={(id) => handleSelect(id)}
      />

      {/* Search chats */}
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="text-muted-foreground/60 pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
            className="border-border bg-background/70 placeholder:text-muted-foreground/60 focus:border-primary/40 h-8.5 w-full rounded-lg border pr-3 pl-8 text-[13px] outline-none transition-colors sm:h-9"
          />
        </div>
      </div>

      <div className="px-3 pb-2">
        <div className="bg-background/60 border-border/60 flex rounded-lg border p-0.5">
          <ViewTab
            label="Active"
            count={activeCount}
            active={view === "active"}
            onClick={() => setView("active")}
          />
          <ViewTab
            label="Archived"
            count={archivedCount}
            active={view === "archived"}
            onClick={() => setView("archived")}
          />
        </div>
      </div>

      <div
        className="flex-1 scrollbar-thin overflow-y-auto px-3 pb-3"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (!isLoading && el.scrollHeight - el.scrollTop - el.clientHeight < 100) {
            onLoadMore?.();
          }
        }}
      >
        {isLoading && conversations.length === 0 ? (
          <div className="space-y-2 py-2">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-9 w-full rounded-md" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <span
              aria-hidden
              className="bg-muted text-muted-foreground mb-4 flex h-12 w-12 items-center justify-center rounded-full"
            >
              {isArchivedView ? (
                <Archive className="h-5 w-5" />
              ) : (
                <MessageSquare className="h-5 w-5" />
              )}
            </span>
            <p className="text-foreground text-sm font-medium">
              {isArchivedView ? "No archived conversations" : q ? "No matches" : t("noConversations")}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              {isArchivedView
                ? "Conversations you archive will appear here."
                : q
                  ? "Try a different search."
                  : t("startNewChat")}
            </p>
          </div>
        ) : (
          <div>
            {GROUP_ORDER.map((label) => {
              const rows = groups.get(label);
              if (!rows || rows.length === 0) return null;
              return (
                <div key={label} className="pb-1">
                  {/* Tracked-caps date group header (Terra spec) */}
                  <p className="text-muted-foreground/70 px-2 pt-3 pb-1 font-mono text-[10px] font-medium tracking-[0.16em] uppercase">
                    {label}
                  </p>
                  <div className="space-y-0.5">
                    {rows.map((conversation) => (
                      <ConversationItem
                        key={conversation.id}
                        conversation={conversation}
                        isActive={conversation.id === currentConversationId}
                        onSelect={() => handleSelect(conversation.id)}
                        onDelete={() => onDelete(conversation.id)}
                        onArchive={() => onArchive(conversation.id)}
                        onUnarchive={() => onUnarchive(conversation.id)}
                        onRename={(title) => onRename(conversation.id, title)}
                        onShare={() => setShareConversationId(conversation.id)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {shareConversationId && (
        <ShareDialog
          conversationId={shareConversationId}
          open={!!shareConversationId}
          onOpenChange={(open) => {
            if (!open) setShareConversationId(null);
          }}
        />
      )}
    </>
  );
}

interface ConversationSidebarProps {
  className?: string;
}

export function ConversationSidebar({ className }: ConversationSidebarProps) {
  const t = useTranslations("chat");
  const router = useRouter();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { isOpen, close } = useChatSidebarStore();
  const [convSidebarWidth, setConvSidebarWidth] = useResizableSidebar(
    "conversation-sidebar-width",
    256,
    200,
    450,
  );
  const handleConvResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = convSidebarWidth;
      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX;
        setConvSidebarWidth(startWidth + delta);
      };
      const handleMouseUp = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [convSidebarWidth, setConvSidebarWidth],
  );
  const {
    conversations,
    currentConversationId,
    isLoading,
    fetchConversations,
    fetchMoreConversations,
    selectConversation,
    deleteConversation,
    archiveConversation,
    unarchiveConversation,
    renameConversation,
    startNewChat,
  } = useConversations();

  // Subscribe to the auth store's user ID so we can refetch conversations
  // when the user loads (the auth store initializes async — the user might
  // be null on first render, which prevents the React Query from running).
  const authUserId = useAuthStore((s) => s.user?.id);
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  // Refetch when the user ID becomes available (e.g. after auth init completes).
  useEffect(() => {
    if (authUserId) {
      fetchConversations();
    }
  }, [authUserId, fetchConversations]);

  // Scheduled-tasks poller — ONE fetch loop per sidebar (shared by the
  // expanded/Sheet rows and the collapsed-rail pulse dot below).
  const sidebarTasks = useSidebarScheduledTasks(authUserId);
  const anyTaskActive = (sidebarTasks ?? []).some((t) => statusOf(t).key === "active");

  const listProps = {
    conversations,
    currentConversationId,
    isLoading,
    scheduledTasks: sidebarTasks,
    onSelect: selectConversation,
    onDelete: deleteConversation,
    onArchive: archiveConversation,
    onUnarchive: unarchiveConversation,
    onRename: renameConversation,
    onNewChat: startNewChat,
    onLoadMore: fetchMoreConversations,
  };

  // Collapsed-rail twin of the Scheduled Tasks section — the icon button + a
  // small emerald pulse dot while any task is active (the shared poller
  // above feeds it; only the collapsed branch renders this twin).
  if (isCollapsed) {
    return (
      <div
        className={cn(
          "bg-secondary hidden w-12 flex-col items-center border-r py-4 md:flex",
          className,
        )}
      >
        <Button
          variant="ghost"
          size="sm"
          className="mb-4 h-10 w-10 p-0"
          onClick={() => setIsCollapsed(false)}
          aria-label="Expand conversations sidebar"
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-10 w-10 p-0"
          onClick={startNewChat}
          title="New Chat"
          aria-label="New chat"
        >
          <SquarePen className="h-4 w-4" aria-hidden />
        </Button>
        {/* Scheduled Tasks — icon-only twin for the collapsed rail, with a
            small emerald pulse dot while any task is active. */}
        <Button
          variant="ghost"
          size="sm"
          className="relative h-10 w-10 p-0"
          onClick={() => router.push(ROUTES.SCHEDULED_TASKS)}
          title="Scheduled Tasks"
          aria-label="Scheduled Tasks"
        >
          <CalendarClock className="h-4 w-4" aria-hidden />
          {anyTaskActive && (
            <span
              aria-hidden
              className="absolute top-1.5 right-1.5 size-1.5 animate-pulse rounded-full bg-emerald-500"
            />
          )}
        </Button>
      </div>
    );
  }

  return (
    <>
      <aside
        className={cn("bg-secondary hidden shrink-0 flex-col border-r md:flex relative overflow-visible", className)}
        style={{ width: `${convSidebarWidth}px` }}
      >
        {/* Resize handle on the right edge */}
        <div
          onMouseDown={handleConvResize}
          className="absolute top-0 bottom-0 right-0 z-50 cursor-col-resize transition-colors hover:bg-primary/40"
          style={{ width: "4px", marginRight: "-2px" }}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize conversations sidebar"
        >
          {/* Invisible wider hit area for easier grabbing */}
          <div className="absolute inset-y-0 -inset-x-2" />
        </div>
          <div className="flex h-11 shrink-0 items-center justify-between px-4 pt-1">
            <h2 className="font-display text-[15px] font-semibold tracking-tight">{t("conversations")}</h2>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => setIsCollapsed(true)}
              aria-label="Collapse conversations sidebar"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        <ConversationList {...listProps} />
        {/* Account row pinned to the base (Terra spec): ink initial avatar +
            name + plan + gear. */}
        <div className="flex shrink-0 items-center gap-2.5 border-t px-3 py-2.5">
          <span
            aria-hidden
            className="bg-foreground text-background flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
          >
            {accountInitials(user)}
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[13px] font-medium text-foreground">
              {user?.full_name || user?.email || "Guest"}
            </p>
            <p className="text-muted-foreground truncate text-[10px]">Free plan</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground h-8 w-8 shrink-0 p-0"
            onClick={() => router.push("/en/settings")}
            title="Settings"
            aria-label="Settings"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </aside>

      <Sheet open={isOpen} onOpenChange={close}>
        <SheetContent side="left" className="w-80 p-0 flex flex-col bg-secondary">
          <SheetHeader className="h-12 shrink-0 px-4">
            <SheetTitle className="font-display tracking-tight">{t("conversations")}</SheetTitle>
            <SheetClose onClick={close} />
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ConversationList {...listProps} onNavigate={close} />
          </div>
          {/* Account row pinned to the base */}
          <div className="flex shrink-0 items-center gap-2.5 border-t px-3 py-2.5">
            <span
              aria-hidden
              className="bg-foreground text-background flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
            >
              {accountInitials(user)}
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-[13px] font-medium text-foreground">
                {user?.full_name || user?.email || "Guest"}
              </p>
              <p className="text-muted-foreground truncate text-[10px]">Free plan</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground h-8 w-8 shrink-0 p-0"
              onClick={() => { router.push("/en/settings"); close(); }}
              title="Settings"
              aria-label="Settings"
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function ViewTab({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      <span
        className={cn(
          "text-[10px] tabular-nums",
          active ? "text-foreground" : "text-muted-foreground/60",
        )}
      >
        {count}
      </span>
    </button>
  );
}
