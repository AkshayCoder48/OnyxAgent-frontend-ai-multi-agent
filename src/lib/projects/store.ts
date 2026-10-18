"use client";

/**
 * Projects zustand store (Task 1-a foundation; consumed by the Projects UI
 * in Task 1-b).
 *
 * State:
 *   - `projects` — the Dexie-backed cache (refreshed from the service;
 *     persisted so the sidebar paints instantly on reload, then re-syncs),
 *   - `activeProjectId` — the open project workspace (persisted across
 *     reloads; null = general chat),
 *   - `sidebarCollapsed` — the sidebar PROJECTS section collapse state
 *     (PRD §3.2 — persists across navigation and refreshes),
 *   - `historyDrawerOpen` — the project chat-history drawer,
 *   - `sortMode` — manual / recent / alphabetical (PRD §3.2).
 *
 * Actions: `refresh()` loads from the projects service for the CURRENT user
 * (auth store, same pattern as use-conversations); the CRUD wrappers call
 * the service and refresh. Derived lists come from the exported pure
 * selector `selectVisibleProjects` (pinned first, archived excluded unless
 * requested) and the memo-safe `useVisibleProjects` hook.
 */

import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Project } from "@/types";
import { useAuthStore } from "@/stores";
import * as projectService from "./service";
import type {
  CreateProjectInput,
  DuplicateProjectOptions,
  ProjectDeleteSummary,
  UpdateProjectPatch,
} from "./service";

export type ProjectSortMode = "manual" | "recent" | "alphabetical";

/** Store-level create input — the user id is filled from the auth store
 *  when the caller doesn't pass one. */
export type StoreCreateProjectInput = Omit<CreateProjectInput, "user_id"> & {
  user_id?: string;
};

interface ProjectsState {
  // -- data ----------------------------------------------------------------
  projects: Project[];
  activeProjectId: string | null;
  sidebarCollapsed: boolean;
  historyDrawerOpen: boolean;
  sortMode: ProjectSortMode;
  /** Transient (NOT persisted): list refresh in flight / last error. */
  isLoading: boolean;
  error: string | null;

  // -- lifecycle ------------------------------------------------------------
  /** Reload the project list from Dexie for the current user. */
  refresh: () => Promise<void>;
  /** Open a project workspace (sets the active project). */
  openProject: (id: string) => void;
  /** Leave the project workspace (back to general chat). */
  closeProject: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setHistoryDrawerOpen: (open: boolean) => void;
  setSortMode: (mode: ProjectSortMode) => void;

  // -- pass-through CRUD (service + refresh) ---------------------------------
  createProject: (input: StoreCreateProjectInput) => Promise<Project | null>;
  updateProject: (id: string, patch: UpdateProjectPatch) => Promise<Project | null>;
  deleteProject: (id: string) => Promise<ProjectDeleteSummary | null>;
  archiveProject: (id: string) => Promise<Project | null>;
  restoreProject: (id: string) => Promise<Project | null>;
  reorderProjects: (orderedIds: string[]) => Promise<void>;
  duplicateProject: (id: string, options?: DuplicateProjectOptions) => Promise<Project | null>;
  touchProjectActivity: (id: string) => Promise<void>;
  /** Clear the transient error banner. */
  clearError: () => void;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export const useProjectsStore = create<ProjectsState>()(
  persist(
    (set, get) => ({
      projects: [],
      activeProjectId: null,
      sidebarCollapsed: false,
      historyDrawerOpen: false,
      sortMode: "manual",
      isLoading: false,
      error: null,

      refresh: async () => {
        const userId = useAuthStore.getState().user?.id;
        if (!userId) return; // nobody signed in yet — keep the last-known list
        set({ isLoading: true });
        try {
          const projects = await projectService.listProjects(userId);
          set({ projects, isLoading: false, error: null });
        } catch (err) {
          set({ isLoading: false, error: errorMessage(err) });
        }
      },

      openProject: (id) => set({ activeProjectId: id }),
      closeProject: () => set({ activeProjectId: null }),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setHistoryDrawerOpen: (open) => set({ historyDrawerOpen: open }),
      setSortMode: (mode) => set({ sortMode: mode }),

      createProject: async (input) => {
        try {
          const userId = input.user_id ?? useAuthStore.getState().user?.id;
          if (!userId) throw new Error("You must be signed in to create a project.");
          const project = await projectService.createProject({ ...input, user_id: userId });
          await get().refresh();
          return project;
        } catch (err) {
          set({ error: errorMessage(err) });
          return null;
        }
      },

      updateProject: async (id, patch) => {
        try {
          const updated = await projectService.updateProject(id, patch);
          await get().refresh();
          return updated;
        } catch (err) {
          set({ error: errorMessage(err) });
          return null;
        }
      },

      deleteProject: async (id) => {
        try {
          const summary = await projectService.deleteProject(id);
          // The deleted project can no longer be the active workspace.
          if (get().activeProjectId === id) set({ activeProjectId: null });
          await get().refresh();
          return summary;
        } catch (err) {
          set({ error: errorMessage(err) });
          return null;
        }
      },

      archiveProject: async (id) => {
        try {
          const archived = await projectService.archiveProject(id);
          await get().refresh();
          return archived;
        } catch (err) {
          set({ error: errorMessage(err) });
          return null;
        }
      },

      restoreProject: async (id) => {
        try {
          const restored = await projectService.restoreProject(id);
          await get().refresh();
          return restored;
        } catch (err) {
          set({ error: errorMessage(err) });
          return null;
        }
      },

      reorderProjects: async (orderedIds) => {
        try {
          await projectService.reorderProjects(orderedIds);
          await get().refresh();
        } catch (err) {
          set({ error: errorMessage(err) });
        }
      },

      duplicateProject: async (id, options) => {
        try {
          const copy = await projectService.duplicateProject(id, options);
          await get().refresh();
          return copy;
        } catch (err) {
          set({ error: errorMessage(err) });
          return null;
        }
      },

      touchProjectActivity: async (id) => {
        try {
          await projectService.touchProjectActivity(id);
          await get().refresh();
        } catch {
          // Activity bumps are best-effort — never surface an error.
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: "onyx-projects-store",
      // Persist the durable UI/data state; transient flags stay in memory.
      partialize: (state) => ({
        projects: state.projects,
        activeProjectId: state.activeProjectId,
        sidebarCollapsed: state.sidebarCollapsed,
        historyDrawerOpen: state.historyDrawerOpen,
        sortMode: state.sortMode,
      }),
    },
  ),
);

// ---------------------------------------------------------------------------
// Derived selectors (pure — exported for tests + direct consumption)
// ---------------------------------------------------------------------------

/**
 * The visible project list: pinned FIRST, archived projects excluded unless
 * `includeArchived`, ordered by the sort mode:
 *   - manual: sort_order asc (unset last), then created_at
 *   - recent: last_activity_at ?? updated_at ?? created_at desc
 *   - alphabetical: name
 */
export function selectVisibleProjects(
  projects: Project[],
  mode: ProjectSortMode,
  opts: { includeArchived?: boolean } = {},
): Project[] {
  const pool = opts.includeArchived ? projects : projects.filter((p) => p.status === "active");
  const byMode = (a: Project, b: Project): number => {
    switch (mode) {
      case "recent": {
        const ra = a.last_activity_at ?? a.updated_at ?? a.created_at;
        const rb = b.last_activity_at ?? b.updated_at ?? b.created_at;
        return rb.localeCompare(ra);
      }
      case "alphabetical":
        return a.name.localeCompare(b.name);
      case "manual":
      default: {
        const oa = a.sort_order ?? Number.MAX_SAFE_INTEGER;
        const ob = b.sort_order ?? Number.MAX_SAFE_INTEGER;
        if (oa !== ob) return oa - ob;
        return a.created_at.localeCompare(b.created_at);
      }
    }
  };
  return [...pool].sort((a, b) => {
    const pa = a.pinned ? 1 : 0;
    const pb = b.pinned ? 1 : 0;
    if (pb !== pa) return pb - pa; // pinned first
    return byMode(a, b);
  });
}

// ---------------------------------------------------------------------------
// Memo-safe hooks (selectors that COMPUTE must not run inline inside
// useProjectsStore(selectors) — new arrays break useSyncExternalStore).
// ---------------------------------------------------------------------------

/** Sorted, pinned-first, archived-excluded project list (memoized). */
export function useVisibleProjects(
  opts: { includeArchived?: boolean } = {},
): Project[] {
  const projects = useProjectsStore((s) => s.projects);
  const sortMode = useProjectsStore((s) => s.sortMode);
  const includeArchived = opts.includeArchived === true;
  return useMemo(
    () => selectVisibleProjects(projects, sortMode, { includeArchived }),
    [projects, sortMode, includeArchived],
  );
}

/** The currently open project, or null in general-chat mode. */
export function useActiveProject(): Project | null {
  const projects = useProjectsStore((s) => s.projects);
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  return useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );
}
