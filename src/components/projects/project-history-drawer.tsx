"use client";

/**
 * ProjectHistoryDrawer (Task 1-b, PRD §6) — the per-project chat-history drawer.
 *
 * THE PULLING ARROW (PRD §6.3): ONE shared framer-motion `progress` value
 * (0 = closed, 1 = open) drives BOTH the drawer panel's x-transform AND the
 * header arrow's rotation + translate — they are physically connected by the
 * same number, so the motion can never feel like two unrelated transitions.
 *   - open:  progress 0 → 1 (spring) — panel slides in, arrow rotates from
 *            pointing into the drawer to pointing back out.
 *   - close: progress 1 → 0 (240ms) — both reverse together.
 *   - reduced-motion: duration 0 (instant) and NO arrow rotation.
 *   - rapid-click safe: a phase state machine ("closed" | "opening" | "open"
 *     | "closing") gates the handlers; re-clicking mid-animation just
 *     retargets the same MotionValue (framer-motion cancels the prior
 *     animation), so no glitch stacks.
 *
 * The drawer is a portal dialog (role="dialog" aria-modal, Escape + backdrop
 * close, Tab trapped inside, arrow label synchronized with the drawer state)
 * and is visually DISTINCT from the main sidebar: the project's accent tints
 * the surface, hairline and buttons.
 *
 * Body (PRD §6.5): + New Project Chat, search-within-project (title filter —
 * Task 2-b upgrades this to the semantic engine), sort by recent/created,
 * pinned-first, date-grouped list (Today/Yesterday/Earlier) with the active
 * conversation highlighted, per-row rename / pin / delete-with-confirm, and
 * a lazy list (first 50 + "Load more").
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "framer-motion";
import {
  ArrowLeft,
  Bot,
  Clock3,
  Hash,
  Loader2,
  MessageSquare,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  User,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAuthStore, useConversationStore } from "@/stores";
import { useConversations } from "@/hooks";
import { useProjectsStore, useActiveProject } from "@/lib/projects/store";
import type { Conversation, Project } from "@/types";
// SEMANTIC SEARCH (Task 2-b): the drawer's search input also surfaces
// MESSAGE-CONTENT hits from this project (hybrid engine), and delete/rename
// propagate into the message search index.
import { searchChats, type SearchHit } from "@/lib/search/search";
import {
  removeConversationFromIndex,
  updateConversationTitleCache,
} from "@/lib/search/indexer";
import { revealMessageAnchor } from "@/components/search/global-search-dialog";
import { accentAlpha, normalizeAccent } from "./project-identity";
import {
  getPinnedProjectChats,
  togglePinnedProjectChat,
  subscribeProjectPins,
  setLastProjectConversation,
  getLastProjectConversation,
} from "./project-identity";
import { useProjectConversations } from "./project-conversations";

// ---------------------------------------------------------------------------
// Date grouping (drawer-flavored: Today / Yesterday / Earlier)
// ---------------------------------------------------------------------------

const DRAWER_GROUPS = ["Today", "Yesterday", "Earlier"] as const;
type DrawerGroup = (typeof DRAWER_GROUPS)[number];

function groupKeyFor(iso: string): DrawerGroup {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.floor((startOfDay(now).getTime() - startOfDay(d).getTime()) / dayMs);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return "Earlier";
}

const LAZY_PAGE = 50;

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface DrawerRowProps {
  conversation: Conversation;
  project: Project;
  isActive: boolean;
  isPinned: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (conv: Conversation) => void;
  onTogglePin: (id: string) => void;
}

const DrawerRow = memo(function DrawerRow({
  conversation,
  project,
  isActive,
  isPinned,
  onSelect,
  onRename,
  onDelete,
  onTogglePin,
}: DrawerRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(conversation.title || "");
  const accent = normalizeAccent(project.accent_color);

  const commitRename = () => {
    const next = editTitle.trim();
    if (next && next !== conversation.title) onRename(conversation.id, next);
    setIsEditing(false);
  };

  return (
    <div
      className={cn(
        "group relative flex min-h-[44px] cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-sm transition-colors",
        isActive ? "font-medium" : "text-foreground/75 hover:bg-foreground/5 hover:text-foreground",
      )}
      onClick={() => onSelect(conversation.id)}
      aria-current={isActive ? "true" : undefined}
    >
      {isActive && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-xl border"
          style={{ borderColor: accentAlpha(accent, 0.5), backgroundColor: accentAlpha(accent, 0.09) }}
        />
      )}
      <MessageSquare
        className={cn("relative z-[1] h-4 w-4 shrink-0", isActive ? "" : "text-foreground/40")}
        style={isActive ? { color: accent } : undefined}
        aria-hidden
      />
      <div className="relative z-[1] min-w-0 flex-1">
        {isEditing ? (
          <input
            type="text"
            value={editTitle}
            maxLength={120}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setIsEditing(false);
            }}
            className="text-foreground w-full rounded-md bg-transparent text-sm outline-none"
            autoFocus
            onClick={(e) => e.stopPropagation()}
            aria-label="Chat title"
          />
        ) : (
          <span className="block truncate">
            {conversation.title?.trim() || "New conversation"}
          </span>
        )}
      </div>
      {isPinned && (
        <Pin className="relative z-[1] h-3 w-3 shrink-0 text-foreground/40" aria-label="Pinned" role="img" />
      )}
      <div className="relative z-[1] shrink-0" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-haspopup="menu"
              aria-label={`Actions for ${conversation.title || "chat"}`}
              className="row-menu-btn text-foreground/60 hover:text-foreground h-7 w-7 p-0"
            >
              <MoreVertical className="h-4 w-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onSelect={() => setIsEditing(true)}>
              <Pencil className="h-4 w-4" aria-hidden /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onTogglePin(conversation.id)}>
              {isPinned ? (
                <>
                  <PinOff className="h-4 w-4" aria-hidden /> Unpin
                </>
              ) : (
                <>
                  <Pin className="h-4 w-4" aria-hidden /> Pin
                </>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => onDelete(conversation)}
            >
              <Trash2 className="h-4 w-4" aria-hidden /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// The drawer
// ---------------------------------------------------------------------------

type Phase = "closed" | "opening" | "open" | "closing";

export function ProjectHistoryDrawer() {
  const project = useActiveProject();
  const open = useProjectsStore((s) => s.historyDrawerOpen);
  const setHistoryDrawerOpen = useProjectsStore((s) => s.setHistoryDrawerOpen);

  // ── the SHARED motion value (0 = closed → 1 = open) ──────────────────────
  const progress = useMotionValue(0);
  const reduceMotion = useReducedMotion();

  /** Rapid-click guard: the animation intent currently in flight (or done). */
  const intentRef = useRef<"open" | "close" | null>(null);

  // Mount/phase transitions are DERIVED at render time via the React
  // "adjust state when a prop changes" pattern (setState during render —
  // never inside an effect body, which cascades renders). The effect below
  // only runs the animations; phase settles asynchronously in .then()s.
  const [phase, setPhase] = useState<Phase>(open ? "opening" : "closed");
  const [mounted, setMounted] = useState(open);
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setMounted(true);
      setPhase((p) => (p === "closed" ? "opening" : p === "closing" ? "opening" : p));
    } else if (mounted) {
      setPhase((p) => (p === "open" || p === "opening" ? "closing" : p));
    }
  }

  // Drawer slide: closed sits fully off-screen to the left.
  const panelX = useTransform(progress, (v) => `${(1 - v) * 100}%`);
  const backdropOpacity = useTransform(progress, [0, 1], [0, 0.42]);
  // The ARROW shares the same progress: as the drawer arrives (0→1) the arrow
  // rotates from pointing into the drawer (pulling it open) to pointing back
  // out (push it closed) and settles a touch left. Close reverses both.
  const arrowRotate = useTransform(progress, [0, 1], [0, -180]);
  const arrowX = useTransform(progress, [0, 1], [6, 0]);

  // Phase machine — ONE animation per intent; re-clicking mid-flight simply
  // retargets the SAME MotionValue (framer-motion cancels the previous
  // animation), so rapid toggling can never stack glitched transitions.
  useEffect(() => {
    if (phase === "opening") {
      intentRef.current = "open";
      const controls = animate(
        progress,
        1,
        reduceMotion
          ? { duration: 0 }
          : { type: "spring", stiffness: 420, damping: 38, mass: 0.9 },
      );
      void controls.then(() => {
        if (intentRef.current === "open") setPhase("open");
      });
      return () => controls.stop();
    }
    if (phase === "closing") {
      intentRef.current = "close";
      const controls = animate(
        progress,
        0,
        reduceMotion ? { duration: 0 } : { duration: 0.24, ease: [0.32, 0.72, 0, 1] },
      );
      void controls.then(() => {
        if (intentRef.current !== "close") return; // reopened mid-close
        setPhase("closed");
        setMounted(false);
      });
      return () => controls.stop();
    }
  }, [phase, progress, reduceMotion]);

  const requestClose = useCallback(() => {
    setHistoryDrawerOpen(false);
  }, [setHistoryDrawerOpen]);

  if (!project || !mounted) return null;
  return (
    <DrawerPortalBody
      project={project}
      phase={phase}
      panelX={panelX}
      backdropOpacity={backdropOpacity}
      arrowRotate={reduceMotion ? undefined : arrowRotate}
      arrowX={reduceMotion ? undefined : arrowX}
      onRequestClose={requestClose}
    />
  );
}

// ---------------------------------------------------------------------------
// Portal body (separated so the motion values stay referential to ONE open)
// ---------------------------------------------------------------------------

interface DrawerPortalProps {
  project: Project;
  phase: Phase;
  panelX: MotionValue<string>;
  backdropOpacity: MotionValue<number>;
  arrowRotate?: MotionValue<number>;
  arrowX?: MotionValue<number>;
  onRequestClose: () => void;
}

function DrawerPortalBody({
  project,
  phase,
  panelX,
  backdropOpacity,
  arrowRotate,
  arrowX,
  onRequestClose,
}: DrawerPortalProps) {
  const accent = normalizeAccent(project.accent_color);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const arrowRef = useRef<HTMLButtonElement | null>(null);

  const currentConversationId = useConversationStore((s) => s.currentConversationId);
  const {
    selectConversation,
    createConversation,
    deleteConversation,
    renameConversation,
  } = useConversations();

  const { conversations, isLoading, reload } = useProjectConversations(project.id);
  // Refresh the list each time the drawer opens.
  const open = useProjectsStore((s) => s.historyDrawerOpen);
  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  // Pinned chats (localStorage affordance; the pin toggle fires an event that
  // bumps pinsTick → re-read below re-renders the rows).
  const [pinsTick, setPinsTick] = useState(0);
  useEffect(
    () => subscribeProjectPins(project.id, () => setPinsTick((t) => t + 1)),
    [project.id],
  );
  const pinnedIds = useMemo(
    () => new Set(getPinnedProjectChats(project.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pinsTick is the invalidation signal
    [project.id, pinsTick],
  );

  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<"recent" | "created">("recent");
  const [visibleCount, setVisibleCount] = useState(LAZY_PAGE);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Focus the panel on open; trap Tab; Escape closes.
  const interactive = phase === "opening" || phase === "open" || phase === "closing";
  useEffect(() => {
    if (phase === "opening" || phase === "open") {
      panelRef.current?.focus();
    }
  }, [phase]);

  useEffect(() => {
    if (!interactive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onRequestClose();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [interactive, onRequestClose]);

  // ── actions ──────────────────────────────────────────────────────────────
  const handleNewProjectChat = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const conv = await createConversation(undefined, { projectId: project.id });
      if (conv) {
        setLastProjectConversation(project.id, conv.id);
        await selectConversation(conv.id);
        onRequestClose();
      } else {
        toast.error("Failed to create the project chat");
      }
    } finally {
      setCreating(false);
    }
  }, [creating, createConversation, project.id, selectConversation, onRequestClose]);

  const handleSelect = useCallback(
    (id: string) => {
      setLastProjectConversation(project.id, id);
      void selectConversation(id);
      onRequestClose();
    },
    [project.id, selectConversation, onRequestClose],
  );

  const handleRename = useCallback(
    (id: string, title: string) => {
      void renameConversation(id, title);
      // Task 2-b: keep the search index's title cache in sync (best-effort).
      void updateConversationTitleCache(id, title).catch(() => {});
    },
    [renameConversation],
  );

  const handleTogglePin = useCallback(
    (id: string) => {
      const nowPinned = togglePinnedProjectChat(project.id, id);
      toast.success(nowPinned ? "Chat pinned" : "Chat unpinned");
    },
    [project.id],
  );

  const confirmDelete = useCallback(async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await deleteConversation(deleting.id);
      // Task 2-b: purge the conversation's rows from the search index
      // (best-effort; searchChats lazily purges orphans as the safety net).
      void removeConversationFromIndex(deleting.id).catch(() => {});
      if (getLastProjectConversation(project.id) === deleting.id) {
        setLastProjectConversation(project.id, null);
      }
      setDeleting(null);
    } finally {
      setDeleteBusy(false);
    }
  }, [deleting, deleteConversation, project.id]);

  // ── list derivation ──────────────────────────────────────────────────────
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const base = q
      ? conversations.filter((c) => (c.title || "").toLowerCase().includes(q))
      : conversations;
    const pinned = base.filter((c) => pinnedIds.has(c.id));
    const rest = base.filter((c) => !pinnedIds.has(c.id));
    const sorter = (a: Conversation, b: Conversation) =>
      sortMode === "recent"
        ? (b.updated_at || b.created_at).localeCompare(a.updated_at || a.created_at)
        : (b.created_at || "").localeCompare(a.created_at || "");
    return { pinned: pinned.sort(sorter), rest: rest.sort(sorter) };
  }, [conversations, q, pinnedIds, sortMode]);

  const visible = useMemo(
    () => [...filtered.pinned, ...filtered.rest].slice(0, visibleCount),
    [filtered, visibleCount],
  );
  const totalCount = filtered.pinned.length + filtered.rest.length;
  const remaining = totalCount - visible.length;

  const groups = useMemo(() => {
    const map = new Map<DrawerGroup, Conversation[]>();
    for (const label of DRAWER_GROUPS) map.set(label, []);
    const pinnedSet = new Set(filtered.pinned.map((c) => c.id));
    for (const c of visible) {
      if (pinnedSet.has(c.id)) continue; // pinned rows render in their own section
      map.get(groupKeyFor(c.updated_at || c.created_at))!.push(c);
    }
    return map;
  }, [visible, filtered.pinned]);

  // ── MESSAGE-CONTENT HITS (Task 2-b) ─────────────────────────────────────
  // The search input doubles as a hybrid message search scoped to THIS
  // project (lexical always, semantic best-effort) — debounced 250ms,
  // rendered as a clearly separated "Messages" subsection below the title
  // matches. Stale debounce results can never win (sequence guard).
  const authUserId = useAuthStore((s) => s.user?.id);
  const [messageHits, setMessageHits] = useState<SearchHit[] | null>(null);
  const [messagesSearching, setMessagesSearching] = useState(false);
  const messagesSeqRef = useRef(0);
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      messagesSeqRef.current++;
      setMessageHits(null);
      setMessagesSearching(false);
      return;
    }
    const seq = ++messagesSeqRef.current;
    setMessagesSearching(true);
    const timer = window.setTimeout(() => {
      void searchChats(trimmed, {
        scope: { projectId: project.id },
        userId: authUserId ?? "",
        limit: 8,
      })
        .then((res) => {
          if (messagesSeqRef.current !== seq) return;
          setMessageHits(res.hits);
        })
        .catch(() => {
          if (messagesSeqRef.current !== seq) return;
          setMessageHits([]);
        })
        .finally(() => {
          if (messagesSeqRef.current === seq) setMessagesSearching(false);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, project.id, authUserId]);

  const handleOpenMessageHit = useCallback(
    (hit: SearchHit) => {
      setLastProjectConversation(project.id, hit.conversationId);
      onRequestClose();
      void (async () => {
        try {
          if (useConversationStore.getState().currentConversationId !== hit.conversationId) {
            await selectConversation(hit.conversationId);
          }
          await revealMessageAnchor(hit.messageId);
        } catch {
          // best-effort anchor — the conversation still opens via the store
        }
      })();
    },
    [project.id, selectConversation, onRequestClose],
  );

  const arrowLabel =
    phase === "closing" || phase === "closed" ? "Open chat history" : "Close chat history";

  return createPortal(
    <>
      {/* Backdrop — the same progress drives its opacity. */}
      <motion.div
        aria-hidden
        onClick={onRequestClose}
        style={{ opacity: backdropOpacity }}
        className="fixed inset-0 z-[80] bg-black"
      />

      {/* The drawer panel — visually distinct from the main sidebar: the
          project accent tints surface, hairlines and the primary action. */}
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Chat history — ${project.name}`}
        tabIndex={-1}
        style={{
          x: panelX,
          backgroundColor: `color-mix(in srgb, ${accent} 5%, var(--background))`,
          borderColor: accentAlpha(accent, 0.35),
        }}
        className="fixed inset-y-0 left-0 z-[81] flex w-[min(88vw,340px)] flex-col border-r shadow-2xl shadow-foreground/20 outline-none"
        data-project-history-drawer={project.id}
      >
        {/* Header: the PULLING ARROW + project name. ONE shared motion value
            (see file doc) rotates + translates the arrow with the drawer. */}
        <div
          className="flex h-14 shrink-0 items-center gap-1.5 border-b px-2.5 py-2"
          style={{ borderColor: accentAlpha(accent, 0.28) }}
        >
          <Button
            ref={arrowRef}
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRequestClose}
            aria-label={arrowLabel}
            className="h-10 w-10 shrink-0 rounded-xl p-0"
          >
            <motion.span
              className="flex items-center justify-center"
              style={arrowRotate !== undefined ? { rotate: arrowRotate, x: arrowX ?? 0 } : undefined}
            >
              <ArrowLeft className="h-4.5 w-4.5" aria-hidden />
            </motion.span>
          </Button>
          <h2 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-tight">
            {project.name}
          </h2>
        </div>

        {/* New project chat + search + sort */}
        <div className="space-y-2 px-3 pt-3">
          <button
            type="button"
            onClick={() => void handleNewProjectChat()}
            disabled={creating}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-xl px-3 text-sm font-medium text-white shadow-sm transition-opacity disabled:opacity-60"
            style={{ backgroundColor: accent }}
          >
            {creating ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Plus className="h-4 w-4 shrink-0" aria-hidden />
            )}
            New Project Chat
          </button>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setVisibleCount(LAZY_PAGE);
              }}
              placeholder="Search project chats…"
              aria-label={`Search chats in ${project.name}`}
              className="h-8.5 w-full rounded-lg border border-border bg-background pl-8 pr-3 text-[13px] outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/40 sm:h-9"
            />
          </div>

          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Project chats · {totalCount}
            </span>
            <div className="flex items-center rounded-lg border border-border p-0.5">
              {(
                [
                  { mode: "recent", label: "Recent", Icon: Clock3 },
                  { mode: "created", label: "Created", Icon: Hash },
                ] as const
              ).map(({ mode, label, Icon }) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setSortMode(mode)}
                  aria-pressed={sortMode === mode}
                  className={cn(
                    "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                    sortMode === mode
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-3 w-3" aria-hidden />
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* The list — pinned first, then date groups; lazy (50 + Load more). */}
        <div
          className={cn(
            "scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-3",
            "[&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:transparent",
          )}
        >
          {isLoading && conversations.length === 0 ? (
            <div className="space-y-2 py-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-9 animate-pulse rounded-xl bg-foreground/5" aria-hidden />
              ))}
            </div>
          ) : totalCount === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1.5 py-10 text-center">
              <MessageSquare className="mb-1 h-5 w-5 text-muted-foreground/60" aria-hidden />
              <p className="text-sm font-medium text-foreground">
                {q ? "No matches" : "No project chats yet"}
              </p>
              <p className="max-w-[240px] text-xs text-muted-foreground">
                {q
                  ? "Try a different search."
                  : "Start one above — every chat you have inside this project stays here."}
              </p>
            </div>
          ) : (
            <>
              {filtered.pinned.length > 0 && (
                <div className="pb-1">
                  <p className="px-2 pt-2 pb-1 font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                    Pinned
                  </p>
                  <div className="space-y-0.5">
                    {filtered.pinned.map((c) => (
                      <DrawerRow
                        key={c.id}
                        conversation={c}
                        project={project}
                        isActive={c.id === currentConversationId}
                        isPinned
                        onSelect={handleSelect}
                        onRename={handleRename}
                        onDelete={setDeleting}
                        onTogglePin={handleTogglePin}
                      />
                    ))}
                  </div>
                </div>
              )}
              {DRAWER_GROUPS.map((label) => {
                const rows = groups.get(label);
                if (!rows || rows.length === 0) return null;
                return (
                  <div key={label} className="pb-1">
                    <p className="px-2 pt-2 pb-1 font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                      {label}
                    </p>
                    <div className="space-y-0.5">
                      {rows.map((c) => (
                        <DrawerRow
                          key={c.id}
                          conversation={c}
                          project={project}
                          isActive={c.id === currentConversationId}
                          isPinned={pinnedIds.has(c.id)}
                          onSelect={handleSelect}
                          onRename={handleRename}
                          onDelete={setDeleting}
                          onTogglePin={handleTogglePin}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
              {remaining > 0 && (
                <button
                  type="button"
                  onClick={() => setVisibleCount((n) => n + LAZY_PAGE)}
                  className="mt-2 w-full rounded-xl border border-dashed border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                >
                  Load more ({remaining} remaining)
                </button>
              )}
            </>
          )}

          {/* MESSAGE-CONTENT HITS (Task 2-b) — a clearly separated subsection
              below the title matches; shows whenever the search box has text.
              Hits open the conversation AT the message (scroll + highlight). */}
          {(q || messagesSearching) && (
            <div
              className="mt-2 border-t pt-2"
              style={{ borderColor: accentAlpha(accent, 0.25) }}
              data-project-message-search={project.id}
            >
              <p className="px-2 pt-1 pb-1 font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                Messages{messageHits ? ` · ${messageHits.length} match${messageHits.length === 1 ? "" : "es"}` : ""}
              </p>
              {messagesSearching && !messageHits ? (
                <div className="space-y-1.5 px-1 py-1" aria-hidden>
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-9 animate-pulse rounded-lg bg-foreground/5" />
                  ))}
                </div>
              ) : messageHits && messageHits.length > 0 ? (
                <div className="space-y-0.5">
                  {messageHits.map((hit) => (
                    <button
                      key={hit.messageId}
                      type="button"
                      onClick={() => handleOpenMessageHit(hit)}
                      className="flex w-full items-start gap-2 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-foreground/5"
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md",
                          hit.role === "user"
                            ? "bg-foreground/8 text-foreground/70"
                            : "bg-foreground/5 text-foreground/60",
                        )}
                        title={hit.role === "user" ? "USER" : "ASSISTANT"}
                      >
                        {hit.role === "user" ? (
                          <User className="h-3 w-3" aria-hidden />
                        ) : (
                          <Bot className="h-3 w-3" aria-hidden />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        {/* Highlighted excerpt — engine-authored <mark> spans
                            over HTML-escaped text (search.ts). */}
                        <span
                          className="block text-xs leading-snug text-foreground/80 [&_mark]:rounded [&_mark]:bg-primary/20 [&_mark]:px-0.5 [&_mark]:font-medium [&_mark]:text-foreground"
                          dangerouslySetInnerHTML={{
                            __html: hit.excerpt || "<em>(no text)</em>",
                          }}
                        />
                        <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                          <span className="font-mono uppercase tracking-wider">
                            {hit.role === "user" ? "USER" : "ASSISTANT"}
                          </span>
                          {" · "}
                          {new Date(hit.createdAt).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                          {" · "}
                          {hit.conversationTitle || "Untitled conversation"}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="px-2 pb-1 text-xs text-muted-foreground">
                  No message contents matched — titles are listed above.
                </p>
              )}
            </div>
          )}
        </div>
      </motion.div>

      {/* Delete confirmation — honest copy. */}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete “{deleting?.title?.trim() || "this chat"}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the chat and every message inside it from this project.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              disabled={deleteBusy}
            >
              {deleteBusy ? "Deleting…" : "Delete chat"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>,
    document.body,
  );
}
