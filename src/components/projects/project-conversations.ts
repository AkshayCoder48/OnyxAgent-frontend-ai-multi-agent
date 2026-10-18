"use client";

/**
 * Project ↔ conversation plumbing (Task 1-b — Projects UI, PRD §6.4/§14).
 *
 * The conversation-selection machinery (use-conversations / use-chat /
 * chat-container) is shared by general and project chats alike, so the small
 * amount of project-specific glue lives HERE instead of being smeared across
 * files other tasks own:
 *
 *   - `resetToNewChatState()` — the atomic "nothing selected" reset used when
 *     ENTERING a project workspace (unlike the sidebar's `startNewChat`, it
 *     never reuses an empty-but-selected conversation, which would keep a
 *     GENERAL chat selected inside a project context).
 *   - `claimConversationForProject()` — when the first message is sent from a
 *     project's empty state, the runtime creates the conversation itself
 *     (`conversationService.create(userId, "")` in use-chat — it has no
 *     project notion). This claims that fresh row for the active project by
 *     writing `project_id` directly in Dexie (the service's update() patch
 *     type deliberately does not include project_id), then bumps the
 *     project's activity clock and re-notifies every conversations listener.
 *   - `useProjectSelectionSync()` — the two-way invariant (PRD §6.4):
 *     selecting a PROJECT conversation opens its project; selecting a GENERAL
 *     conversation leaves project context; a null selection (a project's
 *     empty state / "New chat") keeps the current context. Runs on every
 *     selection change incl. the post-refresh restore.
 *   - `useProjectConversations(projectId)` — the project-scoped conversation
 *     list (drawer + activity dot), refreshed on mount, on the window
 *     conversations-changed event, and whenever the drawer opens.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { db } from "@/lib/db";
import { setUrlParam } from "@/lib/utils";
import { touchProjectActivity } from "@/lib/projects/service";
import { notifyConversationsChanged, CONVERSATIONS_CHANGED_EVENT } from "@/lib/scheduler/chat-sync";
import { useAuthStore, useChatStore, useConversationStore } from "@/stores";
import { useConversations } from "@/hooks";
import type { Conversation } from "@/types";
import { useProjectsStore } from "@/lib/projects/store";
import { setLastProjectConversation } from "./project-identity";

// ---------------------------------------------------------------------------
// resetToNewChatState
// ---------------------------------------------------------------------------

/**
 * Atomically reset the chat surface to "nothing selected" (id → null, chat
 * store cleared, ?id= stripped). This is the FULL reset path of the sidebar's
 * `startNewChat` — deliberately without its "reuse the current conversation
 * when it has no messages" shortcut, because entering a project workspace
 * with a selected-but-empty GENERAL conversation would otherwise keep that
 * general chat selected under the project chrome.
 */
export function resetToNewChatState(): void {
  useChatStore.getState().clearMessages();
  useConversationStore.getState().selectConversation(null, { loading: false });
  setUrlParam("id", null);
}

// ---------------------------------------------------------------------------
// claimConversationForProject
// ---------------------------------------------------------------------------

/**
 * Assign a freshly runtime-created conversation to a project. Only claims
 * rows that do not already belong to a project (never re-associates), stamps
 * the project's activity clock, and fires the conversations-changed event so
 * every list (shared cache, general list, project drawer) converges on the
 * claimed row. Best-effort: a failure is logged, never thrown — the user's
 * message is already streaming at this point.
 */
export async function claimConversationForProject(
  conversationId: string,
  projectId: string,
): Promise<void> {
  try {
    const row = await db.conversations.get(conversationId);
    if (!row || row.project_id) return; // gone, or already claimed
    await db.conversations.update(conversationId, {
      project_id: projectId,
      updated_at: new Date().toISOString(),
    });
    try {
      await touchProjectActivity(projectId);
    } catch {
      // opportunistic — ignore
    }
    setLastProjectConversation(projectId, conversationId);
    notifyConversationsChanged();
  } catch (err) {
    console.warn("[projects] failed to claim conversation for project:", err);
  }
}

// ---------------------------------------------------------------------------
// useProjectSelectionSync — the selection ↔ project-context invariant
// ---------------------------------------------------------------------------

/**
 * Keep `useProjectsStore.activeProjectId` in lockstep with the selected
 * conversation (PRD §6.4):
 *
 *   - selection = project conversation → that project becomes active AND is
 *     remembered as the project's last-open chat (sidebar restore);
 *   - selection = general conversation → project context is cleared (the
 *     project chrome/drawer disappears, general surfaces return);
 *   - selection = null → the current context is left untouched (a project's
 *     empty state and the general "New chat" state both use null).
 *
 * Mounted once (by ChatWorkspace). Reads the conversation row straight from
 * Dexie — the shared React-Query list is paged and may not contain project
 * conversations.
 */
export function useProjectSelectionSync(): void {
  const currentConversationId = useConversationStore((s) => s.currentConversationId);
  // Per-conversation dedupe: the DB read only needs to happen once per id
  // (selection re-renders, sibling store updates, etc. must not re-query).
  const resolvedRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (resolvedRef.current === currentConversationId) return;
    resolvedRef.current = currentConversationId;

    if (currentConversationId === null) {
      return; // null selection never changes the project context
    }

    let alive = true;
    void (async () => {
      try {
        const row = await db.conversations.get(currentConversationId);
        if (!alive) return;
        const store = useProjectsStore.getState();
        if (row?.project_id) {
          setLastProjectConversation(row.project_id, row.id);
          if (store.activeProjectId !== row.project_id) {
            store.openProject(row.project_id);
          }
        } else {
          // A general conversation can never be open under project context.
          if (store.activeProjectId !== null) {
            store.closeProject();
          }
        }
      } catch {
        // Non-fatal — the next selection change retries.
      }
    })();
    return () => {
      alive = false;
    };
  }, [currentConversationId]);

  // Hygiene: a persisted activeProjectId that no longer exists (deleted in
  // another surface, wiped) is cleared once the project list has loaded.
  const projectsLoaded = useProjectsStore((s) => s.projects.length > 0 || s.isLoading);
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const projects = useProjectsStore((s) => s.projects);
  useEffect(() => {
    if (!projectsLoaded || !activeProjectId) return;
    if (!projects.some((p) => p.id === activeProjectId)) {
      useProjectsStore.getState().closeProject();
    }
  }, [projectsLoaded, activeProjectId, projects]);
}

// ---------------------------------------------------------------------------
// useProjectConversations — the project-scoped list
// ---------------------------------------------------------------------------

/**
 * Conversations belonging to ONE project (archived included — the drawer
 * decides what to show), newest-first by updated_at. Refreshed on mount, on
 * the window conversations-changed event, and on demand via `reload()`
 * (used when the drawer opens). Loading is true only until the first fetch
 * lands (null = never fetched, so callers can skeleton the first paint).
 */
export function useProjectConversations(
  projectId: string | null,
  opts: { includeArchived?: boolean } = {},
): {
  conversations: Conversation[];
  isLoading: boolean;
  reload: () => void;
} {
  const includeArchived = opts.includeArchived !== false;
  const { fetchConversations } = useConversations();
  const userId = useAuthStore((s) => s.user?.id);
  const [rows, setRows] = useState<Conversation[] | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!projectId || !userId) return;
    let alive = true;
    const load = () => {
      fetchConversations({ projectId })
        .then((list) => {
          if (alive) setRows(list);
        })
        .catch(() => {
          // Keep the last-known list — the drawer stays usable.
        });
    };
    load();
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, load);
    };
  }, [projectId, userId, tick, fetchConversations]);

  return useMemo(
    () => ({
      conversations: (rows ?? []).filter((c) => includeArchived || !c.is_archived),
      isLoading: rows === null,
      reload,
    }),
    [rows, includeArchived, reload],
  );
}
