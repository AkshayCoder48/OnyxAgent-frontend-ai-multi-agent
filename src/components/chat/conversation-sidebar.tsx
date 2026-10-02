"use client";

import { memo, useEffect, useMemo, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useConversations } from "@/hooks";
import { useAuthStore } from "@/stores";
import { Button, Skeleton } from "@/components/ui";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetClose } from "@/components/ui";
import { useResizableSidebar } from "@/components/ui/resize-handle";
import { cn } from "@/lib/utils";
import { ROUTES } from "@/lib/constants";
import { useChatSidebarStore } from "@/stores";
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Feather,
  MessageSquare,
  MoreVertical,
  Pencil,
  Search,
  Settings,
  Share2,
  SquarePen,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import type { Conversation } from "@/types";
import type { SafeScheduledTask } from "@/lib/scheduler/types";
import { noteSchedulerTasks, schedulerApi } from "@/lib/scheduler/client";
import {
  addLinkedChat,
  CHAT_LINKS_CHANGED_EVENT,
  CONVERSATIONS_CHANGED_EVENT,
  getLinkedChatIds,
  OPEN_CONVERSATION_EVENT,
  removeLinkedChat,
} from "@/lib/scheduler/chat-sync";
import { ShareDialog } from "./share-dialog";
import { RunningExecutionsSection } from "./running-executions";

/** Window event broadcast when a row menu opens — every OTHER open row menu
 *  closes itself (single-open menus, like native context menus). */
const CHAT_ROW_MENU_OPEN_EVENT = "onyx:chat-row-menu-open";

/* ---------------------------------------------------------------------------
 * Date grouping for the Terra editorial history: tracked-caps day buckets.
 * ------------------------------------------------------------------------- */
const GROUP_ORDER = ["Today", "Yesterday", "This week", "Older"] as const;

/** Collapsed icon-rail width in px (w-12). Keep in sync with ChatPage's
 *  COLLAPSED_RAIL_WIDTH — the auto-rail math there assumes this width. */
const COLLAPSED_RAIL_WIDTH = 48;
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
  /** CHAT-ONLY SCHEDULED TASKS: this conversation is a task's dedicated
   *  chat → subtle clock badge next to the title. */
  isScheduled?: boolean;
  // STABLE id-based callbacks (React.memo-friendly): the parent passes the
  // SAME function references for every row — the row's own conversation.id
  // is threaded through at call time, so a memoized row only re-renders
  // when ITS data/flags actually change (30+ rows × per-tick re-renders was
  // a real cost before the render-isolation fixes).
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onShare: (id: string) => void;
}

const ConversationItem = memo(function ConversationItem({
  conversation,
  isActive,
  isScheduled = false,
  onSelect,
  onDelete,
  onArchive,
  onUnarchive,
  onRename,
  onShare,
}: ConversationItemProps) {
  const t = useTranslations("chat");
  // PORTAL POP-UP MENU: the old in-row `absolute` popover was clipped by
  // the sidebar's scroll container (overflow-y auto also clips the x-axis)
  // — the menu rendered half-transparent/half-cut over the rows below and
  // taps landed on the ROWS, not the menu items ("options aren't working").
  // The menu now portals to document.body with fixed coordinates measured
  // from the button's rect: never clipped, always opaque, always on top.
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(conversation.title || "");

  const closeMenu = useCallback(() => setShowMenu(false), []);

  // SINGLE-OPEN MENUS: only ONE row menu can be open at a time — opening a
  // menu broadcasts a window event; every OTHER row's menu closes itself.
  useEffect(() => {
    if (!showMenu) return;
    const onOtherOpen = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== conversation.id) closeMenu();
    };
    window.addEventListener(CHAT_ROW_MENU_OPEN_EVENT, onOtherOpen);
    return () => window.removeEventListener(CHAT_ROW_MENU_OPEN_EVENT, onOtherOpen);
  }, [showMenu, conversation.id, closeMenu]);

  // Open at the button's rect, clamped to the viewport (flips above when
  // there is no room below). A plain function (not useCallback): the React
  // compiler could not preserve memoization through the conditional
  // early-return, and this is a one-tap handler — per-render identity is
  // irrelevant.
  const openMenu = () => {
    window.dispatchEvent(new CustomEvent(CHAT_ROW_MENU_OPEN_EVENT, { detail: conversation.id }));
    const rect = menuBtnRef.current?.getBoundingClientRect();
    if (!rect) {
      setMenuPos(null);
      setShowMenu(true);
      return;
    }
    const MENU_W = 176; // w-44
    const MENU_H = 216; // 4 items ≈ 4×48 + padding
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = rect.right - MENU_W;
    left = Math.max(8, Math.min(left, vw - MENU_W - 8));
    let top = rect.bottom + 6;
    if (top + MENU_H > vh - 8) top = Math.max(8, rect.top - MENU_H - 6);
    setMenuPos({ top, left });
    setShowMenu(true);
  };

  // Escape closes; any scroll (the list scrolls INSIDE the sidebar, so use
  // capture phase) or resize closes so the fixed menu can't detach from its
  // row. Cleanup on unmount.
  useEffect(() => {
    if (!showMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeMenu();
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
    };
  }, [showMenu, closeMenu]);

  const handleRename = () => {
    if (editTitle.trim()) {
      onRename(conversation.id, editTitle.trim());
    }
    setIsEditing(false);
  };

  const displayTitle = conversation.title || t("newConversation");

  // Menu items — built once per open; each carries THIS row's conversation
  // id via the closure (PRD §11: the action can never target another chat).
  const menuItems: Array<{
    key: string;
    icon: typeof Pencil;
    label: string;
    danger?: boolean;
    run: () => void;
  }> = conversation.is_archived
    ? [
        { key: "rename", icon: Pencil, label: t("rename"), run: () => setIsEditing(true) },
        { key: "share", icon: Share2, label: t("share"), run: () => onShare(conversation.id) },
        { key: "restore", icon: ArchiveRestore, label: "Restore", run: () => onUnarchive(conversation.id) },
        { key: "delete", icon: Trash2, label: t("delete"), danger: true, run: () => onDelete(conversation.id) },
      ]
    : [
        { key: "rename", icon: Pencil, label: t("rename"), run: () => setIsEditing(true) },
        { key: "share", icon: Share2, label: t("share"), run: () => onShare(conversation.id) },
        { key: "archive", icon: Archive, label: t("archive"), run: () => onArchive(conversation.id) },
        { key: "delete", icon: Trash2, label: t("delete"), danger: true, run: () => onDelete(conversation.id) },
      ];

  return (
    <div
      className={cn(
        // Date-grouped history rows — the ACTIVE row is a soft-terracotta
        // pill (#F0E3D5 fill, #EAD6C4 hairline) with a terracotta icon.
        // New rows materialize softly (PRD §20 motion system).
        "mb-fade-in-soft group relative flex min-h-[40px] cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-all",
        isActive
          ? "bg-accent text-accent-foreground border border-[#a5f3fc] dark:border-[#155e75]"
          : "text-foreground/70 hover:bg-foreground/5 hover:text-foreground border border-transparent",
      )}
      onClick={() => onSelect(conversation.id)}
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
          {/* key on the text → the generated title (naming call) reveals with
              the same fade/slide/blur settle as the subheader (PRD §12). */}
          <span key={displayTitle} className="title-reveal block truncate">
            {displayTitle}
          </span>
        </div>
      )}

      {/* CHAT-ONLY SCHEDULED TASKS: subtle clock badge on a task's dedicated
          chat (the link registry below keeps it in sync with the server). */}
      {isScheduled && (
        <CalendarClock
          className="h-3.5 w-3.5 shrink-0 text-foreground/35"
          role="img"
          aria-label="Scheduled task"
        />
      )}

      <div className="relative shrink-0">
        <Button
          ref={menuBtnRef}
          variant="ghost"
          size="sm"
          aria-haspopup="menu"
          aria-expanded={showMenu}
          aria-label={`${t("rename")} / ${t("archive")} / ${t("delete")}`}
          className={cn(
            // VISIBILITY (see .row-menu-btn in globals.css): devices WITH
            // hover reveal the button on row hover/focus or while its menu
            // is open; devices WITHOUT hover (phones/tablets) always show
            // it. The old `touch:opacity-100` utility was a dead class —
            // the button sat invisible-but-tappable on touch devices.
            "row-menu-btn text-foreground/60 hover:text-foreground h-8 w-8 p-0",
          )}
          onClick={(e) => {
            e.stopPropagation();
            if (showMenu) closeMenu();
            else openMenu();
          }}
        >
          <MoreVertical className="h-4 w-4" />
        </Button>

        {/* PORTAL MENU — fixed-position, opaque, animated (enter/exit via
            the app's framer-motion system). Renders outside the sidebar's
            clipping scroll container. */}
        {typeof document !== "undefined" &&
          createPortal(
            <AnimatePresence>
              {showMenu && (
                <>
                  {/* Transparent backdrop — click/right-click closes. */}
                  <motion.div
                    key="chat-menu-backdrop"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.12 }}
                    className="fixed inset-0 z-[70]"
                    onClick={closeMenu}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      closeMenu();
                    }}
                    aria-hidden
                  />
                  <motion.div
                    key="chat-menu-popover"
                    role="menu"
                    aria-label={displayTitle}
                    initial={{ opacity: 0, scale: 0.96, y: -2 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.97, y: -2 }}
                    transition={{ duration: 0.16, ease: [0.32, 0.72, 0, 1] }}
                    style={
                      menuPos
                        ? { top: menuPos.top, left: menuPos.left }
                        : { top: "50%", left: "50%", transform: "translate(-50%, -50%)" }
                    }
                    className="bg-popover text-popover-foreground fixed z-[71] w-44 origin-top-right overflow-hidden rounded-xl border border-border shadow-xl shadow-foreground/10"
                  >
                    {menuItems.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        role="menuitem"
                        className={cn(
                          "hover:bg-secondary focus-visible:bg-secondary active:bg-secondary flex w-full items-center gap-2.5 px-3 py-3 text-left text-[13px] font-medium outline-none transition-colors",
                          item.danger ? "text-destructive hover:text-destructive" : "text-foreground/90",
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          closeMenu();
                          item.run();
                        }}
                      >
                        <item.icon className="h-4 w-4 shrink-0" aria-hidden />
                        {item.label}
                      </button>
                    ))}
                  </motion.div>
                </>
              )}
            </AnimatePresence>,
            document.body,
          )}
      </div>
    </div>
  );
});

type ConversationView = "active" | "archived";

/* ---------------------------------------------------------------------------
 * CHAT-ONLY SCHEDULED TASKS: every task IS a chat — no separate section, no
 * task dashboard. This poller converges the local link registry
 * (localStorage `onyx-chat-links`) with the server's task list so the
 * dedicated chats get the clock badge AND the 45s pull/mirror sync (the
 * registry is what chat-sync keys on). It also discovers chats created
 * server-side (legacy-task migration) or on other devices: once linked, the
 * pull loop merges their server messages in, which creates the local
 * conversation row (ensureConversation) — the chat then shows up in the
 * sidebar like any conversation.
 * ------------------------------------------------------------------------- */

/** The linked-chat id set, reactive to registry changes (window event). */
function useLinkedChatIds(): Set<string> {
  const [linked, setLinked] = useState<Set<string>>(() => new Set(getLinkedChatIds()));
  useEffect(() => {
    const reread = () => setLinked(new Set(getLinkedChatIds()));
    reread();
    window.addEventListener(CHAT_LINKS_CHANGED_EVENT, reread);
    return () => window.removeEventListener(CHAT_LINKS_CHANGED_EVENT, reread);
  }, []);
  return linked;
}

/** Converge the link registry with the server's task list every 60s while
 *  the sidebar is mounted (silent; failures never touch the registry).
 *  Also feeds the zero-task tick skip (noteSchedulerTasks) — with no
 *  scheduled tasks the heartbeat skips its expensive tick entirely. */
function useScheduledChatLinks(userId: string | null | undefined): Set<string> {
  const linked = useLinkedChatIds();
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const converge = async () => {
      const res = await schedulerApi(userId, "list");
      if (cancelled || !res.ok || !Array.isArray(res.tasks)) return;
      noteSchedulerTasks(res.tasks.length);
      const serverIds = new Set<string>();
      for (const task of res.tasks) {
        const chatId = (task as SafeScheduledTask).chatId;
        if (chatId) serverIds.add(chatId);
      }
      const local = getLinkedChatIds();
      for (const id of serverIds) {
        if (!local.includes(id)) addLinkedChat(id);
      }
      for (const id of local) {
        if (!serverIds.has(id)) removeLinkedChat(id);
      }
      // addLinkedChat/removeLinkedChat fire CHAT_LINKS_CHANGED_EVENT on
      // actual changes — the useLinkedChatIds listener re-reads the
      // registry, which re-renders the badge set.
    };
    void converge().catch(() => {});
    const id = window.setInterval(() => void converge().catch(() => {}), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [userId]);
  return linked;
}


interface ConversationListProps {
  conversations: Conversation[];
  currentConversationId: string | null;
  isLoading: boolean;
  /** CHAT-ONLY SCHEDULED TASKS: chat ids that are a task's dedicated chat
   *  (drives the clock badge on the conversation rows). */
  scheduledChatIds?: Set<string>;
  /** Which experience this sidebar lists: "code" = OnyxCode app chats only
   *  (entry button hidden, "New app" label); absent/"agent" = normal chats
   *  (Code Mode entry button shown below New conversation). */
  mode?: "agent" | "code";
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
  scheduledChatIds = new Set(),
  mode,
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
  const router = useRouter();
  const isCode = mode === "code";
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

  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id);
      onNavigate?.();
    },
    [onSelect, onNavigate],
  );

  // Stable per-row-callbacks (React.memo): every ConversationItem receives
  // the SAME references — the row threads its own conversation.id through.
  const handleShare = useCallback((id: string) => setShareConversationId(id), []);

  const handleNewChat = () => {
    onNewChat();
    onNavigate?.();
  };

  const handleOpenCodeMode = () => {
    router.push(ROUTES.CODE);
    onNavigate?.();
  };

  const handleOpenAgentMode = () => {
    router.push(ROUTES.CHAT);
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
          className="bg-primary text-primary-foreground hover:bg-[#0e7490] flex h-10 w-full items-center justify-between gap-2 rounded-xl px-3.5 text-sm font-medium shadow-sm transition-colors"
        >
          <span className="inline-flex items-center gap-2">
            <SquarePen className="h-4 w-4 shrink-0" />
            {isCode ? "New app" : t("newChat")}
          </span>
          <kbd className="text-primary-foreground/70 font-mono text-[10px] tracking-wider">
            ⌘N
          </kbd>
        </button>
      </div>

      {/* OnyxCode Code Mode entry (agent sidebar only) — the OnyxAgent logo
          (same feather chip as the header) + permanent black Beta badge.
          Tapping it opens the /code route with its own, separate chats. */}
      {!isCode && (
        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={handleOpenCodeMode}
            className="border-border bg-card hover:border-primary/40 hover:bg-accent/50 flex h-10 w-full items-center justify-between gap-2 rounded-xl border px-3.5 text-sm font-medium shadow-sm transition-colors"
            title="OnyxCode (Beta) — build apps with the agent"
          >
            <span className="inline-flex min-w-0 items-center gap-2">
              <span className="bg-primary/10 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
                <Feather className="text-primary h-3.5 w-3.5" aria-hidden />
              </span>
              <span className="truncate">Code Mode</span>
              <span className="ml-1 rounded bg-black px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white dark:bg-white dark:text-black">
                Beta
              </span>
            </span>
            <TerminalSquare className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden />
          </button>
        </div>
      )}

      {/* Agent Mode entry (OnyxCode sidebar only — OnyxCode PRD §40): the
          SAME mode-switch concept the agent sidebar shows, mirrored. While
          inside Code Mode the button is labeled "Agent Mode" and returns the
          user to the normal OnyxAgent chats. */}
      {isCode && (
        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={handleOpenAgentMode}
            className="border-border bg-card hover:border-primary/40 hover:bg-accent/50 flex h-10 w-full items-center justify-between gap-2 rounded-xl border px-3.5 text-sm font-medium shadow-sm transition-colors"
            title="Back to OnyxAgent — the normal chat agent"
          >
            <span className="inline-flex min-w-0 items-center gap-2">
              <span className="bg-primary/10 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
                <MessageSquare className="text-primary h-3.5 w-3.5" aria-hidden />
              </span>
              <span className="truncate">Agent Mode</span>
            </span>
            <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden />
          </button>
        </div>
      )}

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
            className="border-border bg-background placeholder:text-muted-foreground/60 focus:border-primary/40 h-8.5 w-full rounded-lg border pr-3 pl-8 text-[13px] outline-none transition-colors sm:h-9"
          />
        </div>
      </div>

      <div className="px-3 pb-2">
        <div className="bg-background border-border/60 flex rounded-lg border p-0.5">
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
                        isScheduled={scheduledChatIds.has(conversation.id)}
                        onSelect={handleSelect}
                        onDelete={onDelete}
                        onArchive={onArchive}
                        onUnarchive={onUnarchive}
                        onRename={onRename}
                        onShare={handleShare}
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
  /** Which experience this sidebar lists ("code" = OnyxCode app chats,
   *  filtered; default "agent" = normal chats, Code Mode entry shown). */
  mode?: "agent" | "code";
}

export function ConversationSidebar({ className, mode = "agent" }: ConversationSidebarProps) {
  const t = useTranslations("chat");
  const router = useRouter();
  // Collapse state lives in the chat-sidebar store (not local state) so the
  // workspace layout (ChatPage) can auto-collapse the rail to its icon form
  // when a right-hand panel needs the horizontal space. SELECTOR-based
  // subscriptions only — the old no-selector call re-rendered the whole
  // sidebar (every conversation row) on any chat-sidebar-store field change;
  // actions are stable references and never re-render.
  const isOpen = useChatSidebarStore((s) => s.isOpen);
  const close = useChatSidebarStore((s) => s.close);
  const expand = useChatSidebarStore((s) => s.expand);
  const collapse = useChatSidebarStore((s) => s.collapse);
  const isCollapsed = useChatSidebarStore((s) => s.collapsed);
  const [convSidebarWidth, setConvSidebarWidth] = useResizableSidebar(
    "conversation-sidebar-width",
    256,
    200,
    450,
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

  // CHAT-ONLY SCHEDULED TASKS — converge the link registry with the server's
  // task list (drives the clock badge + the pull/mirror sync; see the
  // useScheduledChatLinks doc above).
  const scheduledChatIds = useScheduledChatLinks(authUserId);

  // Conversations changed OUTSIDE React Query (a scheduled-task tool created
  // the dedicated chat, a server-message merge created/updated a local
  // conversation) → refetch the list.
  useEffect(() => {
    const on = () => {
      void fetchConversations();
    };
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, on);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, on);
  }, [fetchConversations]);

  // In-page conversation switch requests from outside the sidebar (the
  // scheduled-task tool result cards' "Open chat" action).
  useEffect(() => {
    const on = (event: Event) => {
      const chatId = (event as CustomEvent<string>).detail;
      if (typeof chatId === "string" && chatId) {
        void selectConversation(chatId);
        close(); // dismiss the mobile Sheet when open
      }
    };
    window.addEventListener(OPEN_CONVERSATION_EVENT, on);
    return () => window.removeEventListener(OPEN_CONVERSATION_EVENT, on);
  }, [selectConversation, close]);

  // Code Mode keeps its own, separate chats (OnyxCode PRD §7): the sidebar
  // only lists conversations stamped with this sidebar's mode. Unstamped
  // (legacy) conversations count as normal agent chats.
  const modeConversations = useMemo(
    () =>
      mode === "code"
        ? conversations.filter((c) => c.mode === "code")
        : conversations.filter((c) => !c.mode || c.mode === "agent"),
    [conversations, mode],
  );

  const listProps = {
    conversations: modeConversations,
    currentConversationId,
    isLoading,
    scheduledChatIds,
    mode,
    onSelect: selectConversation,
    onDelete: deleteConversation,
    onArchive: archiveConversation,
    onUnarchive: unarchiveConversation,
    onRename: renameConversation,
    onNewChat: startNewChat,
    onLoadMore: fetchMoreConversations,
  };

  // ── ANIMATED COLLAPSE/EXPAND (user request: "the chat sidebar appears
  // suddenly — copy the other sidebars' animation"). Same motion language
  // as the right-hand docked panels: ONE persistent aside whose WIDTH
  // transitions between the icon-rail width and the persisted sidebar
  // width (250ms cubic-bezier(0.32, 0.72, 0, 1) — see .conv-sidebar in
  // globals.css). The full pane keeps a FIXED inner width (content never
  // reflows mid-animation) and cross-fades with the icon-rail overlay.
  // The two states used to be two SEPARATE DOM trees — the swap was an
  // instant jump with no transition at all.
  //
  // While collapsed (or mid-animation) the aside clips its content
  // (overflow hidden); at rest EXPANDED it returns to overflow visible so
  // the conversation rows' context menus can hang past the sidebar edge
  // exactly like before. The transient data-animating flag is written
  // DIRECTLY on the DOM node (no React state → no cascading renders).
  const asideRef = useRef<HTMLElement | null>(null);
  const [resizing, setResizing] = useState(false);
  const prevCollapsedRef = useRef(isCollapsed);
  useEffect(() => {
    if (prevCollapsedRef.current === isCollapsed) return;
    prevCollapsedRef.current = isCollapsed;
    const aside = asideRef.current;
    if (!aside) return;
    // Any collapse/expand — user chevron, auto-rail from ChatPage, anything
    // that flips the store flag — runs the width transition; clip for its
    // duration (320ms covers the 250ms curve + tail). Direct DOM mutation:
    // React does not manage this attribute, and no re-render is needed.
    aside.setAttribute("data-animating", "true");
    const t = window.setTimeout(() => {
      aside.setAttribute("data-animating", "false");
    }, 320);
    return () => window.clearTimeout(t);
  }, [isCollapsed]);

  const handleConvResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setResizing(true);
      const startX = e.clientX;
      const startWidth = convSidebarWidth;
      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX;
        setConvSidebarWidth(startWidth + delta);
      };
      const handleMouseUp = () => {
        setResizing(false);
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

  return (
    <>
      <aside
        ref={asideRef}
        data-collapsed={isCollapsed}
        data-resizing={resizing}
        aria-label={t("conversations")}
        className={cn(
          "conv-sidebar bg-secondary relative hidden shrink-0 border-r md:flex",
          className,
        )}
        style={{ width: isCollapsed ? COLLAPSED_RAIL_WIDTH : convSidebarWidth }}
      >
        {/* Full sidebar pane — fixed inner width so nothing reflows while
            the outer aside animates; fades out while collapsed. */}
        <div
          className="conv-sidebar-pane flex h-full flex-col"
          style={{ width: convSidebarWidth }}
          inert={isCollapsed}
          aria-hidden={isCollapsed}
        >
          <div className="flex h-11 shrink-0 items-center justify-between px-4 pt-1">
            <h2 className="font-display text-[15px] font-semibold tracking-tight">{t("conversations")}</h2>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={collapse}
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
        </div>

        {/* Icon rail overlay — expand + new chat only; fades in as the pane
            fades out (scheduled chats are ordinary conversation rows, they
            are simply not listed while collapsed). */}
        <div
          className="conv-sidebar-rail absolute inset-y-0 left-0 z-10 flex w-12 flex-col items-center py-4"
          inert={!isCollapsed}
          aria-hidden={!isCollapsed}
        >
          <Button
            variant="ghost"
            size="sm"
            className="mb-4 h-10 w-10 p-0"
            onClick={expand}
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
          {mode !== "code" && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground mt-2 h-10 w-10 p-0"
              onClick={() => router.push(ROUTES.CODE)}
              title="Code Mode (Beta)"
              aria-label="Open Code Mode"
            >
              <TerminalSquare className="h-4 w-4" aria-hidden />
            </Button>
          )}
          {mode === "code" && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground mt-2 h-10 w-10 p-0"
              onClick={() => router.push(ROUTES.CHAT)}
              title="Agent Mode — back to OnyxAgent"
              aria-label="Back to Agent Mode"
            >
              <MessageSquare className="h-4 w-4" aria-hidden />
            </Button>
          )}
        </div>

        {/* Resize handle on the right edge — only while expanded (the rail
            has no resizable width). */}
        {!isCollapsed && (
          <div
            onMouseDown={handleConvResizeStart}
            className="absolute inset-y-0 right-0 z-50 w-1 cursor-col-resize transition-colors hover:bg-primary/40"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize conversations sidebar"
          >
            {/* Invisible wider hit area for easier grabbing */}
            <div className="absolute inset-y-0 -inset-x-2" />
          </div>
        )}
      </aside>

      {/* Mobile drawer — keepMountedOnceOpen: once the chat list has been
          opened on mobile it stays mounted (hidden) after every close, so
          re-opens are instant instead of remounting the whole conversation
          list + framer-motion rows on every tap. */}
      <Sheet open={isOpen} onOpenChange={close} keepMountedOnceOpen>
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
