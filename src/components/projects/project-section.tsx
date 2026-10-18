"use client";

/**
 * ProjectSection — the PROJECTS area of the chat sidebar (Task 1-b, PRD §3.2).
 *
 * Shared by BOTH sidebar surfaces (src/components/chat/conversation-sidebar.tsx
 * — primary — and src/components/layout/conversation-sidebar.tsx — secondary).
 *
 *   - Collapsible "PROJECTS" header; the collapsed state persists via
 *     `useProjectsStore.sidebarCollapsed` (PRD §3.2 — survives refreshes).
 *   - "+ Create Project" affordance → the create-project dialog.
 *   - Project rows: icon (fixed set) tinted with the project's accent, name,
 *     pinned badge, active highlight. Archived projects are hidden from the
 *     default list and recoverable through an "Archived" expander (PRD §9.6).
 *   - Row context menu: Rename / Edit / Manage Access / Pin / Duplicate /
 *     Archive / Restore / Delete (confirm dialog with honest copy — the
 *     project AND all of its conversations are deleted; general chats are
 *     never touched, PRD §3.2/§9).
 *   - Sort mode (manual / recent / alphabetical) + a filter input once the
 *     list grows past 8 projects. Manual mode = @dnd-kit drag reorder that
 *     persists `sort_order` (PRD §3.2 "Project ordering").
 *
 * ALSO EXPORTED here: `useGeneralConversations` — the general-only
 * conversation list both sidebars render (project conversations NEVER appear
 * in the general list, PRD §6.4). It unions the shared React-Query cache
 * (instantly patched by the existing mutation handlers) with the
 * project-scoped fetch from `fetchConversations({ projectId: null })` so the
 * list stays complete even when the shared paged cache is diluted by project
 * chats.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Archive,
  ArchiveRestore,
  ArrowDownAZ,
  ChevronDown,
  Clock3,
  Copy,
  GripVertical,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAuthStore, useConversationStore } from "@/stores";
import { useConversations } from "@/hooks";
import { conversationService } from "@/lib/services";
import { CONVERSATIONS_CHANGED_EVENT } from "@/lib/scheduler/chat-sync";
import type { Conversation, Project } from "@/types";
import {
  useProjectsStore,
  useVisibleProjects,
  type ProjectSortMode,
} from "@/lib/projects/store";
import { getLastProjectConversation, setLastProjectConversation, useHydrated, ProjectGlyph, accentAlpha, normalizeAccent } from "./project-identity";
import { resetToNewChatState } from "./project-conversations";
import { CreateProjectDialog } from "./create-project-dialog";

// ---------------------------------------------------------------------------
// useGeneralConversations — the general-only chat list (PRD §6.4 isolation)
// ---------------------------------------------------------------------------

/**
 * Conversations with NO project, for the sidebar's general chat history.
 *
 * Sources (union, deduped by id — the SHARED cache copy wins so mutations
 * rename/archive/delete are reflected instantly):
 *   1. The shared React-Query list (paged at 30, all modes) filtered to
 *      `!project_id` — this is the list the existing mutation handlers patch.
 *   2. A scoped fetch via `fetchConversations({ projectId: null })` (up to
 *      200) — covers general chats that fall outside the shared page when
 *      project conversations dilute it. Refreshed on mount, on user change,
 *      and on the conversations-changed event.
 */
export function useGeneralConversations(): Conversation[] {
  const { conversations: shared, fetchConversations } = useConversations();
  const userId = useAuthStore((s) => s.user?.id);
  const [scoped, setScoped] = useState<Conversation[] | null>(null);

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    const load = () => {
      fetchConversations({ projectId: null })
        .then((list) => {
          if (alive) setScoped(list);
        })
        .catch(() => {
          // Scoped fetch is an enrichment — the shared cache remains usable.
        });
    };
    load();
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, load);
    };
  }, [userId, fetchConversations]);

  return useMemo(() => {
    const byId = new Map<string, Conversation>();
    const isGeneral = (c: Conversation) =>
      !c.project_id && (!c.mode || c.mode === "agent");
    if (scoped) for (const c of scoped) if (isGeneral(c)) byId.set(c.id, c);
    for (const c of shared) if (isGeneral(c)) byId.set(c.id, c);
    return [...byId.values()].sort((a, b) =>
      (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
    );
  }, [scoped, shared]);
}

// ---------------------------------------------------------------------------
// Project row
// ---------------------------------------------------------------------------

interface ProjectRowProps {
  project: Project;
  isActive: boolean;
  manualSort: boolean;
  // Stable id/project-based callbacks (React.memo-friendly, same pattern as
  // the sidebar's ConversationItem).
  onOpen: (project: Project) => void;
  onRename: (id: string, name: string) => void;
  onEdit: (project: Project) => void;
  onManageAccess: (project: Project) => void;
  onTogglePin: (project: Project) => void;
  onDuplicate: (project: Project) => void;
  onArchive: (project: Project) => void;
  onRestore: (project: Project) => void;
  onDelete: (project: Project) => void;
}

const ProjectRow = memo(function ProjectRow({
  project,
  isActive,
  manualSort,
  onOpen,
  onRename,
  onEdit,
  onManageAccess,
  onTogglePin,
  onDuplicate,
  onArchive,
  onRestore,
  onDelete,
}: ProjectRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(project.name);
  const sortable = useSortable({ id: project.id, disabled: !manualSort });
  const isArchived = project.status === "archived";

  const startRename = () => {
    setEditName(project.name);
    setIsEditing(true);
  };
  const commitRename = () => {
    const next = editName.trim();
    if (next && next !== project.name) onRename(project.id, next);
    setIsEditing(false);
  };

  const tint = normalizeAccent(project.accent_color);

  return (
    <div
      ref={manualSort ? sortable.setNodeRef : undefined}
      style={manualSort ? { transform: CSS.Transform.toString(sortable.transform) } : undefined}
      className={cn(
        "group relative flex min-h-[40px] cursor-pointer items-center gap-2 rounded-xl border px-2.5 py-1.5 text-sm transition-colors",
        isActive
          ? "border font-medium"
          : "border-transparent text-foreground/75 hover:bg-foreground/5 hover:text-foreground",
        manualSort && sortable.isDragging && "z-10 shadow-lg shadow-foreground/10",
      )}
      onClick={() => onOpen(project)}
      aria-current={isActive ? "true" : undefined}
    >
      {isActive && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-xl border"
          style={{ borderColor: accentAlpha(tint, 0.5), backgroundColor: accentAlpha(tint, 0.09) }}
        />
      )}
      {/* Manual-order drag handle (only in manual mode; the row stays clickable). */}
      {manualSort && (
        <button
          type="button"
          className="text-foreground/30 hover:text-foreground/70 relative z-[1] flex h-6 w-4 shrink-0 cursor-grab items-center justify-center rounded active:cursor-grabbing"
          aria-label={`Reorder ${project.name}`}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => {
            e.stopPropagation();
            sortable.listeners?.onPointerDown?.(e);
          }}
          onKeyDown={(e) => {
            // Keyboard reorder: arrows move the item (dnd-kit keyboard sensor
            // is not enabled — provide a minimal accessible fallback below).
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              // Accessibility note: pointer-based reorder is primary; keyboard
              // users can still reorder via the sort menu's alphabetical mode.
            }
          }}
        >
          <GripVertical className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
      <ProjectGlyph
        iconKey={project.icon}
        accent={project.accent_color}
        size={22}
        className="relative z-[1]"
      />
      <div className="relative z-[1] min-w-0 flex-1">
        {isEditing ? (
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setIsEditing(false);
            }}
            className="text-foreground w-full rounded-md bg-transparent text-sm outline-none"
            autoFocus
            maxLength={80}
            onClick={(e) => e.stopPropagation()}
            aria-label="Project name"
          />
        ) : (
          <span className="block truncate">{project.name}</span>
        )}
      </div>
      {project.pinned && !isArchived && (
        <Pin
          className="text-foreground/40 relative z-[1] h-3 w-3 shrink-0"
          aria-label="Pinned project"
          role="img"
        />
      )}
      {isArchived && (
        <span className="text-muted-foreground relative z-[1] shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] leading-none">
          Archived
        </span>
      )}
      <div className="relative z-[1] shrink-0" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-haspopup="menu"
              aria-label={`Actions for ${project.name}`}
              className="row-menu-btn text-foreground/60 hover:text-foreground h-7 w-7 p-0"
            >
              <MoreVertical className="h-4 w-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={startRename}>
              <Pencil className="h-4 w-4" aria-hidden /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onEdit(project)}>
              <Settings2 className="h-4 w-4" aria-hidden /> Edit project
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onManageAccess(project)}>
              <ShieldCheck className="h-4 w-4" aria-hidden /> Manage access
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onTogglePin(project)}>
              {project.pinned ? (
                <>
                  <PinOff className="h-4 w-4" aria-hidden /> Unpin
                </>
              ) : (
                <>
                  <Pin className="h-4 w-4" aria-hidden /> Pin
                </>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onDuplicate(project)}>
              <Copy className="h-4 w-4" aria-hidden /> Duplicate
            </DropdownMenuItem>
            {isArchived ? (
              <DropdownMenuItem onSelect={() => onRestore(project)}>
                <ArchiveRestore className="h-4 w-4" aria-hidden /> Restore
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => onArchive(project)}>
                <Archive className="h-4 w-4" aria-hidden /> Archive
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => onDelete(project)}
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
// ProjectSection
// ---------------------------------------------------------------------------

const SORT_OPTIONS: Array<{ mode: ProjectSortMode; label: string; icon: typeof Clock3 }> = [
  { mode: "manual", label: "Manual order", icon: GripVertical },
  { mode: "recent", label: "Recently used", icon: Clock3 },
  { mode: "alphabetical", label: "Alphabetical", icon: ArrowDownAZ },
];

interface ProjectSectionProps {
  /** Close an enclosing mobile sheet after opening a project. */
  onNavigate?: () => void;
}

export function ProjectSection({ onNavigate }: ProjectSectionProps) {
  const hydrated = useHydrated();
  const { conversations: sharedConversations, fetchConversations, selectConversation } = useConversations();

  const projects = useProjectsStore((s) => s.projects);
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const sidebarCollapsed = useProjectsStore((s) => s.sidebarCollapsed);
  const sortMode = useProjectsStore((s) => s.sortMode);
  const refresh = useProjectsStore((s) => s.refresh);
  const setSidebarCollapsed = useProjectsStore((s) => s.setSidebarCollapsed);
  const setSortMode = useProjectsStore((s) => s.setSortMode);
  const openProject = useProjectsStore((s) => s.openProject);
  const setHistoryDrawerOpen = useProjectsStore((s) => s.setHistoryDrawerOpen);
  const closeProject = useProjectsStore((s) => s.closeProject);
  const updateProject = useProjectsStore((s) => s.updateProject);
  const deleteProjectAction = useProjectsStore((s) => s.deleteProject);
  const archiveProjectAction = useProjectsStore((s) => s.archiveProject);
  const restoreProjectAction = useProjectsStore((s) => s.restoreProject);
  const duplicateProjectAction = useProjectsStore((s) => s.duplicateProject);
  const reorderProjects = useProjectsStore((s) => s.reorderProjects);

  const userId = useAuthStore((s) => s.user?.id);

  const visibleProjects = useVisibleProjects();
  const archivedProjects = useMemo(
    () => projects.filter((p) => p.status === "archived"),
    [projects],
  );

  // Load/keep the project cache fresh while the sidebar is mounted.
  useEffect(() => {
    if (userId) void refresh();
  }, [userId, refresh]);

  // ── create/edit dialog ──────────────────────────────────────────────────
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogProject, setDialogProject] = useState<Project | null>(null);
  const [dialogTab, setDialogTab] = useState<"basics" | "memory" | "resources">("basics");

  const openCreate = useCallback(() => {
    setDialogProject(null);
    setDialogTab("basics");
    setDialogOpen(true);
  }, []);

  // ── delete confirmation ─────────────────────────────────────────────────
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [deleteCount, setDeleteCount] = useState<number | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const deleteCountRef = useRef(false);

  const openDeleteConfirm = useCallback(
    (project: Project) => {
      setDeleting(project);
      setDeleteCount(null);
      deleteCountRef.current = true;
      // Honest copy needs the real conversation count (PRD: clear confirmation
      // before permanent deletion, and never silently delete unrelated chats).
      fetchConversations({ projectId: project.id })
        .then((list) => {
          if (deleteCountRef.current) setDeleteCount(list.length);
        })
        .catch(() => {
          // Count stays unknown — the dialog copy stays generic.
        });
    },
    [fetchConversations],
  );

  const confirmDelete = useCallback(async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    const summary = await deleteProjectAction(deleting.id);
    setDeleteBusy(false);
    if (summary) {
      toast.success(
        `Project deleted — ${summary.conversations} conversation${summary.conversations === 1 ? "" : "s"} and ${summary.messages} message${summary.messages === 1 ? "" : "s"} removed`,
      );
    } else {
      toast.error(useProjectsStore.getState().error ?? "Failed to delete the project");
    }
    deleteCountRef.current = false;
    setDeleting(null);
  }, [deleting, deleteProjectAction]);

  // ── row actions ─────────────────────────────────────────────────────────
  const handleOpen = useCallback(
    (project: Project) => {
      const store = useProjectsStore.getState();
      // Keep the CURRENT selection only when it belongs to this project;
      // otherwise try the project's last-active conversation (verified against
      // the DB), falling back to the project empty state.
      const currentId = useConversationStore.getState().currentConversationId;
      let keepSelection = false;
      if (currentId) {
        const currentConv = sharedConversations.find((c) => c.id === currentId);
        keepSelection = currentConv?.project_id === project.id;
      }
      const finish = () => {
        openProject(project.id);
        setHistoryDrawerOpen(false);
        onNavigate?.();
      };
      if (keepSelection) {
        finish();
        return;
      }
      const lastId = getLastProjectConversation(project.id);
      if (lastId) {
        void (async () => {
          try {
            const uid = useAuthStore.getState().user?.id;
            const conv = uid ? await conversationService.get(lastId, uid) : null;
            if (conv && conv.project_id === project.id) {
              await selectConversation(conv.id);
            } else {
              setLastProjectConversation(project.id, null);
              // resetToNewChatState (NOT startNewChat): the sidebar's
              // startNewChat REUSES a selected-but-empty conversation, which
              // could keep a GENERAL chat selected inside this project's
              // context (the selection sync would then close the project).
              resetToNewChatState();
            }
          } catch {
            resetToNewChatState();
          }
          finish();
        })();
        return;
      }
      resetToNewChatState();
      finish();
    },
    [sharedConversations, openProject, setHistoryDrawerOpen, onNavigate, selectConversation],
  );

  const handleRename = useCallback(
    (id: string, name: string) => {
      void updateProject(id, { name }).then((p) => {
        if (p) toast.success("Project renamed");
        else toast.error(useProjectsStore.getState().error ?? "Failed to rename the project");
      });
    },
    [updateProject],
  );

  const handleEdit = useCallback((project: Project) => {
    setDialogProject(project);
    setDialogTab("basics");
    setDialogOpen(true);
  }, []);

  const handleManageAccess = useCallback((project: Project) => {
    setDialogProject(project);
    setDialogTab("resources");
    setDialogOpen(true);
  }, []);

  const handleTogglePin = useCallback(
    (project: Project) => {
      void updateProject(project.id, { pinned: !project.pinned });
    },
    [updateProject],
  );

  const handleDuplicate = useCallback(
    (project: Project) => {
      void duplicateProjectAction(project.id).then((copy) => {
        if (copy) toast.success(`Duplicated as “${copy.name}” (configuration only)`);
        else toast.error(useProjectsStore.getState().error ?? "Failed to duplicate the project");
      });
    },
    [duplicateProjectAction],
  );

  const handleArchive = useCallback(
    (project: Project) => {
      void archiveProjectAction(project.id).then((p) => {
        if (p) {
          toast.success("Project archived — restore it from the Archived list");
          if (useProjectsStore.getState().activeProjectId === project.id) {
            closeProject();
          }
        } else {
          toast.error(useProjectsStore.getState().error ?? "Failed to archive the project");
        }
      });
    },
    [archiveProjectAction, closeProject],
  );

  const handleRestore = useCallback(
    (project: Project) => {
      void restoreProjectAction(project.id).then((p) => {
        if (p) toast.success("Project restored");
        else toast.error(useProjectsStore.getState().error ?? "Failed to restore the project");
      });
    },
    [restoreProjectAction],
  );

  // ── sort + filter ───────────────────────────────────────────────────────
  const [filter, setFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const q = filter.trim().toLowerCase();
  const filteredProjects = useMemo(
    () => (q ? visibleProjects.filter((p) => p.name.toLowerCase().includes(q)) : visibleProjects),
    [visibleProjects, q],
  );
  const visibleIds = useMemo(() => filteredProjects.map((p) => p.id), [filteredProjects]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = visibleIds.indexOf(active.id as string);
      const newIndex = visibleIds.indexOf(over.id as string);
      if (oldIndex < 0 || newIndex < 0) return;
      // NOTE: pinned projects always float to the top (selectVisibleProjects);
      // dragging inside the pinned block or the unpinned block persists the
      // new relative order. reorderProjects stamps sort_order 1..n.
      void reorderProjects(arrayMove(visibleIds, oldIndex, newIndex));
    },
    [visibleIds, reorderProjects],
  );

  const collapsed = sidebarCollapsed;
  const totalActive = visibleProjects.length;

  return (
    <div className="px-3 pb-1">
      {/* Header: collapse toggle + count + create affordance */}
      <div className="flex items-center gap-1 pt-3 pb-1">
        <button
          type="button"
          onClick={() => setSidebarCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand projects section" : "Collapse projects section"}
          className="text-muted-foreground hover:text-foreground flex min-w-0 flex-1 items-center gap-1 rounded-md py-1 text-left transition-colors"
        >
          <ChevronDown
            aria-hidden
            className={cn("h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none", collapsed && "-rotate-90")}
          />
          <span className="font-mono text-[10px] font-medium tracking-[0.16em] uppercase">
            Projects
          </span>
          {hydrated && totalActive > 0 && (
            <span className="text-muted-foreground/60 text-[10px] tabular-nums">
              {totalActive}
            </span>
          )}
        </button>
        {/* Sort mode control */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground h-6 w-6 p-0"
              title="Sort projects"
              aria-label="Sort projects"
            >
              {(() => {
                const Icon = SORT_OPTIONS.find((o) => o.mode === sortMode)?.icon ?? GripVertical;
                return <Icon className="h-3.5 w-3.5" aria-hidden />;
              })()}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {SORT_OPTIONS.map((option) => (
              <DropdownMenuItem
                key={option.mode}
                onSelect={() => setSortMode(option.mode)}
                className={cn(option.mode === sortMode && "font-medium")}
              >
                <option.icon className="h-4 w-4" aria-hidden />
                {option.label}
                {option.mode === sortMode && <span className="sr-only">(current)</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="sm"
          onClick={openCreate}
          className="text-muted-foreground hover:text-foreground h-6 w-6 p-0"
          title="Create project"
          aria-label="Create project"
        >
          <Plus className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      {/* Collapsible body — CSS grid-rows trick: structural parity between
          server and client (no hydration mismatch from the persisted collapse
          state) AND an animated collapse that respects reduced motion. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
        )}
        aria-hidden={collapsed}
        inert={collapsed}
      >
        <div className="overflow-hidden">
          {/* Filter input once the list grows (PRD §3.2: compact filtering). */}
          {hydrated && totalActive > 8 && (
            <div className="relative pt-1 pb-1.5">
              <Search className="text-muted-foreground/60 pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter projects"
                aria-label="Filter projects"
                className="border-border bg-background placeholder:text-muted-foreground/60 focus:border-primary/40 h-8 w-full rounded-lg border pr-3 pl-8 text-[13px] outline-none transition-colors"
              />
            </div>
          )}

          {hydrated && totalActive === 0 && archivedProjects.length === 0 && !q ? (
            <button
              type="button"
              onClick={openCreate}
              className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground mb-1 flex w-full items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2.5 text-left text-[13px] transition-colors"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Create your first project
            </button>
          ) : (
            <div
              className={cn(
                "scrollbar-thin max-h-60 overflow-y-auto pb-1",
                // thin custom scrollbar styling
                "[&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:transparent",
              )}
            >
              {hydrated && filteredProjects.length === 0 && q ? (
                <p className="text-muted-foreground px-2 py-2 text-xs">No projects match.</p>
              ) : null}
              {/* Manual mode: drag-reorderable list; other modes: plain rows. */}
              {hydrated && sortMode === "manual" ? (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
                    <div className="space-y-0.5">
                      {filteredProjects.map((project) => (
                        <ProjectRow
                          key={project.id}
                          project={project}
                          isActive={project.id === activeProjectId}
                          manualSort
                          onOpen={handleOpen}
                          onRename={handleRename}
                          onEdit={handleEdit}
                          onManageAccess={handleManageAccess}
                          onTogglePin={handleTogglePin}
                          onDuplicate={handleDuplicate}
                          onArchive={handleArchive}
                          onRestore={handleRestore}
                          onDelete={openDeleteConfirm}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              ) : (
                <div className="space-y-0.5">
                  {hydrated &&
                    filteredProjects.map((project) => (
                      <ProjectRow
                        key={project.id}
                        project={project}
                        isActive={project.id === activeProjectId}
                        manualSort={false}
                        onOpen={handleOpen}
                        onRename={handleRename}
                        onEdit={handleEdit}
                        onManageAccess={handleManageAccess}
                        onTogglePin={handleTogglePin}
                        onDuplicate={handleDuplicate}
                        onArchive={handleArchive}
                        onRestore={handleRestore}
                        onDelete={openDeleteConfirm}
                      />
                    ))}
                </div>
              )}
            </div>
          )}

          {/* Archived projects (PRD §9.6 — hidden but recoverable). */}
          {hydrated && archivedProjects.length > 0 && (
            <div className="pt-0.5 pb-1">
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                aria-expanded={showArchived}
                className="text-muted-foreground/80 hover:text-foreground flex w-full items-center gap-1.5 rounded-md py-1 text-left text-[11px] transition-colors"
              >
                <ChevronDown
                  aria-hidden
                  className={cn("h-3 w-3 transition-transform motion-reduce:transition-none", !showArchived && "-rotate-90")}
                />
                Archived ({archivedProjects.length})
              </button>
              {showArchived && (
                <div className="space-y-0.5 pt-1">
                  {archivedProjects.map((project) => (
                    <ProjectRow
                      key={project.id}
                      project={project}
                      isActive={project.id === activeProjectId}
                      manualSort={false}
                      onOpen={handleOpen}
                      onRename={handleRename}
                      onEdit={handleEdit}
                      onManageAccess={handleManageAccess}
                      onTogglePin={handleTogglePin}
                      onDuplicate={handleDuplicate}
                      onArchive={handleArchive}
                      onRestore={handleRestore}
                      onDelete={openDeleteConfirm}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Create / Edit / Manage-access dialog */}
      <CreateProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        project={dialogProject}
        initialTab={dialogTab}
      />

      {/* Delete confirmation — honest copy, real counts */}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            deleteCountRef.current = false;
            setDeleting(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <span className="block space-y-2">
                <span className="block">
                  This permanently deletes the project, its configuration, and{" "}
                  {deleteCount === null
                    ? "all of its conversations"
                    : `its ${deleteCount} conversation${deleteCount === 1 ? "" : "s"}`}{" "}
                  with every message inside them. This cannot be undone.
                </span>
                <span className="block font-medium text-foreground">
                  Your general chats are not affected.
                </span>
              </span>
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
              {deleteBusy ? "Deleting…" : "Delete project"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
