"use client";

/**
 * Projects service (PRD §3–§9, §14) — Dexie CRUD over the v4 `projects`
 * table plus the cascade behaviors the UI depends on:
 *
 *   - create with validation (name + goal required),
 *   - update with instructions-version history (cap 20 entries),
 *   - delete with a FULL cascade across every table the project's
 *     conversations touch (messages, tool_calls, ratings, charts, shares,
 *     todos, memories, approvals, search index) and an accounting summary,
 *   - archive / restore,
 *   - manual reorder (persists sort_order),
 *   - duplicate (config-only copy — never memories or chats),
 *   - activity clock (touchProjectActivity).
 *
 * All writes stamp `updated_at`. Errors are typed (`ProjectServiceError`)
 * so callers can branch on `code` instead of parsing messages.
 */

import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import type {
  Project,
  ProjectMemorySettings,
  ProjectResourceRule,
} from "@/types";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ProjectServiceErrorCode =
  | "invalid_name"
  | "invalid_goal"
  | "not_found"
  | "invalid_input";

/** Typed service error — `code` is machine-readable for UI branching. */
export class ProjectServiceError extends Error {
  readonly code: ProjectServiceErrorCode;

  constructor(code: ProjectServiceErrorCode, message: string) {
    super(message);
    this.name = "ProjectServiceError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Inputs / patches
// ---------------------------------------------------------------------------

export interface CreateProjectInput {
  user_id: string;
  name: string;
  description?: string | null;
  goal: string;
  /** Defaults to "". */
  instructions?: string;
  icon?: string | null;
  accent_color?: string | null;
  /** Partially merged over DEFAULT_MEMORY_SETTINGS. */
  memory_settings?: Partial<ProjectMemorySettings>;
  model_preferences?: { preferred_model?: string | null };
  resources?: ProjectResourceRule[];
  pinned?: boolean;
  sort_order?: number;
}

/** Updatable fields. `id`, `user_id` and `created_at` are immutable. */
export type UpdateProjectPatch = Partial<
  Omit<Project, "id" | "user_id" | "created_at" | "instructions_history">
>;

export interface DuplicateProjectOptions {
  /** Copy the instructions text (default true). */
  includeInstructions?: boolean;
  /** Copy icon + accent color (default true). */
  includeAppearance?: boolean;
  /** Copy the resource-access rules (default true). Secrets are never
   *  stored on a project row, so no credential can leak into the copy. */
  includeResources?: boolean;
  /** Copy the memory settings (default true; memory ITEMS are never copied). */
  includeMemorySettings?: boolean;
  /** Override the default "<name> (copy)" name. */
  nameOverride?: string;
}

/** Row counts removed by deleteProject — the confirmation dialog and the
 *  E2E verification both consume these numbers. */
export interface ProjectDeleteSummary {
  projects: number;
  conversations: number;
  messages: number;
  tool_calls: number;
  message_ratings: number;
  chart_specs: number;
  conversation_shares: number;
  todo_lists: number;
  project_memories: number;
  approval_requests: number;
  message_search_index: number;
}

// ---------------------------------------------------------------------------
// Defaults + pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export const DEFAULT_MEMORY_SETTINGS: ProjectMemorySettings = {
  enabled: true,
  cross_chat_retrieval: true,
  automatic_updates: true,
  context_budget_chars: 4000,
};

export const INSTRUCTIONS_HISTORY_CAP = 20;

export interface InstructionsHistoryEntry {
  content: string;
  saved_at: string;
}

/**
 * Pure history upsert: append `next` unless it duplicates the newest entry,
 * keeping at most `cap` entries (the most recent ones win).
 */
export function capInstructionsHistory(
  history: InstructionsHistoryEntry[],
  next: InstructionsHistoryEntry,
  cap: number = INSTRUCTIONS_HISTORY_CAP,
): InstructionsHistoryEntry[] {
  // Re-saving the current content is a no-op (no duplicate version).
  const newest = history[history.length - 1];
  if (newest && newest.content === next.content) {
    return history;
  }
  const appended = [...history, next];
  return appended.length > cap ? appended.slice(appended.length - cap) : appended;
}

function nowISO(): string {
  return new Date().toISOString();
}

function requireNonEmptyTrimmed(
  value: string | undefined | null,
  code: "invalid_name" | "invalid_goal",
  label: string,
): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    throw new ProjectServiceError(code, `Project ${label} must not be empty.`);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** All projects for the user (archived included), deterministic order:
 *  `sort_order` ascending (unset last), then `created_at`. */
export async function listProjects(userId: string): Promise<Project[]> {
  const rows = await db.projects.where("user_id").equals(userId).toArray();
  rows.sort((a, b) => {
    const sa = a.sort_order ?? Number.MAX_SAFE_INTEGER;
    const sb = b.sort_order ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return (a.created_at ?? "").localeCompare(b.created_at ?? "");
  });
  return rows;
}

export async function getProject(id: string): Promise<Project | null> {
  const row = await db.projects.get(id);
  return row ?? null;
}

/** Next free manual-order slot for a user (max existing + 1). */
async function nextSortOrder(userId: string): Promise<number> {
  const rows = await db.projects.where("user_id").equals(userId).toArray();
  return rows.reduce((max, p) => Math.max(max, p.sort_order ?? 0), 0) + 1;
}

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

export async function createProject(input: CreateProjectInput): Promise<Project> {
  if (!input?.user_id) {
    throw new ProjectServiceError("invalid_input", "A user id is required to create a project.");
  }
  const name = requireNonEmptyTrimmed(input.name, "invalid_name", "name");
  const goal = requireNonEmptyTrimmed(input.goal, "invalid_goal", "goal");

  const ts = nowISO();
  const instructions = input.instructions ?? "";
  const project: Project = {
    id: nanoid(),
    user_id: input.user_id,
    name,
    description: input.description ?? null,
    goal,
    instructions,
    icon: input.icon ?? null,
    accent_color: input.accent_color ?? null,
    status: "active",
    pinned: input.pinned ?? false,
    sort_order: input.sort_order ?? (await nextSortOrder(input.user_id)),
    memory_settings: { ...DEFAULT_MEMORY_SETTINGS, ...(input.memory_settings ?? {}) },
    model_preferences: input.model_preferences ?? { preferred_model: null },
    resources: input.resources ?? [],
    // Version history starts at v1 with the initial instructions.
    instructions_history: instructions.trim()
      ? [{ content: instructions, saved_at: ts }]
      : [],
    created_at: ts,
    updated_at: ts,
    last_activity_at: null,
  };
  await db.projects.add(project);
  return project;
}

export async function updateProject(id: string, patch: UpdateProjectPatch): Promise<Project> {
  const current = await db.projects.get(id);
  if (!current) {
    throw new ProjectServiceError("not_found", `Project ${id} does not exist.`);
  }

  const ts = nowISO();
  const update: Partial<Project> = { updated_at: ts };

  if (patch.name !== undefined) {
    update.name = requireNonEmptyTrimmed(patch.name, "invalid_name", "name");
  }
  if (patch.goal !== undefined) {
    update.goal = requireNonEmptyTrimmed(patch.goal, "invalid_goal", "goal");
  }
  if (patch.description !== undefined) update.description = patch.description ?? null;
  if (patch.instructions !== undefined) update.instructions = patch.instructions;
  if (patch.icon !== undefined) update.icon = patch.icon ?? null;
  if (patch.accent_color !== undefined) update.accent_color = patch.accent_color ?? null;
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.pinned !== undefined) update.pinned = patch.pinned;
  if (patch.sort_order !== undefined) update.sort_order = patch.sort_order;
  if (patch.resources !== undefined) update.resources = patch.resources;
  if (patch.model_preferences !== undefined) update.model_preferences = patch.model_preferences;
  if (patch.memory_settings !== undefined) {
    update.memory_settings = { ...current.memory_settings, ...patch.memory_settings };
  }

  // Instructions version history: append a snapshot whenever the content
  // actually changes (identical re-saves don't create versions), capped at 20.
  if (
    patch.instructions !== undefined &&
    patch.instructions !== current.instructions
  ) {
    update.instructions_history = capInstructionsHistory(
      current.instructions_history ?? [],
      { content: patch.instructions, saved_at: ts },
    );
  }

  await db.projects.update(id, update);
  const updated = await db.projects.get(id);
  if (!updated) {
    throw new ProjectServiceError("not_found", `Project ${id} disappeared during update.`);
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Delete (full cascade + accounting)
// ---------------------------------------------------------------------------

/**
 * Delete a project AND every row owned by it or its conversations.
 * Unrelated general conversations are never touched (PRD §3.2).
 * Returns the per-table removal counts.
 */
export async function deleteProject(id: string): Promise<ProjectDeleteSummary> {
  const project = await db.projects.get(id);
  if (!project) {
    throw new ProjectServiceError("not_found", `Project ${id} does not exist.`);
  }

  const summary: ProjectDeleteSummary = {
    projects: 0,
    conversations: 0,
    messages: 0,
    tool_calls: 0,
    message_ratings: 0,
    chart_specs: 0,
    conversation_shares: 0,
    todo_lists: 0,
    project_memories: 0,
    approval_requests: 0,
    message_search_index: 0,
  };

  // 1. The project's conversations.
  const conversationIds = (await db.conversations
    .where("project_id")
    .equals(id)
    .primaryKeys()) as string[];
  summary.conversations = conversationIds.length;

  if (conversationIds.length > 0) {
    // 2. Messages of those conversations, then their per-message children.
    const messageIds = (await db.messages
      .where("conversation_id")
      .anyOf(conversationIds)
      .primaryKeys()) as string[];
    summary.messages = messageIds.length;
    if (messageIds.length > 0) {
      summary.tool_calls = await db.tool_calls.where("message_id").anyOf(messageIds).delete();
      summary.message_ratings = await db.message_ratings.where("message_id").anyOf(messageIds).delete();
      summary.chart_specs = await db.chart_specs.where("message_id").anyOf(messageIds).delete();
    }
    await db.messages.where("conversation_id").anyOf(conversationIds).delete();
    // 3. Conversation-scoped rows.
    summary.conversation_shares = await db.conversation_shares
      .where("conversation_id")
      .anyOf(conversationIds)
      .delete();
    summary.todo_lists = await db.todo_lists
      .where("conversation_id")
      .anyOf(conversationIds)
      .delete();
    // 4. Search index rows for those conversations.
    summary.message_search_index += await db.message_search_index
      .where("conversation_id")
      .anyOf(conversationIds)
      .delete();
    // 4b. The conversations themselves — last, once every child row keyed
    // by conversation_id is gone (no orphans left behind).
    await db.conversations.bulkDelete(conversationIds);
  }

  // 5. Memories + approvals + remaining search rows keyed by project_id.
  summary.project_memories = await db.project_memories.where("project_id").equals(id).delete();
  const approvalsByConversation =
    conversationIds.length > 0
      ? await db.approval_requests.where("conversation_id").anyOf(conversationIds).delete()
      : 0;
  const approvalsByProject = await db.approval_requests.where("project_id").equals(id).delete();
  // (A row indexed under BOTH project_id and its conversation's id can only be
  //  counted once — Dexie delete() returns the rows actually removed, so the
  //  second call's count already excludes the first call's removals.)
  summary.approval_requests = approvalsByConversation + approvalsByProject;
  summary.message_search_index += await db.message_search_index
    .where("project_id")
    .equals(id)
    .delete();

  // 6. The project row itself.
  await db.projects.delete(id);
  summary.projects = 1;

  return summary;
}

// ---------------------------------------------------------------------------
// Archive / restore
// ---------------------------------------------------------------------------

export async function archiveProject(id: string): Promise<Project> {
  return updateProject(id, { status: "archived" });
}

export async function restoreProject(id: string): Promise<Project> {
  return updateProject(id, { status: "active" });
}

// ---------------------------------------------------------------------------
// Manual reorder
// ---------------------------------------------------------------------------

/**
 * Persist a manual ordering: `orderedIds[i]` receives `sort_order = i + 1`.
 * Ids that don't exist are ignored; projects not in the list keep their
 * current sort_order. Returns the number of rows actually written.
 */
export async function reorderProjects(orderedIds: string[]): Promise<number> {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return 0;
  const rows = await db.projects.bulkGet(orderedIds);
  const ts = nowISO();
  const updates: Project[] = [];
  for (let i = 0; i < orderedIds.length; i++) {
    const row = rows[i];
    if (row && row.sort_order !== i + 1) {
      updates.push({ ...row, sort_order: i + 1, updated_at: ts });
    }
  }
  if (updates.length > 0) {
    await db.projects.bulkPut(updates);
  }
  return updates.length;
}

// ---------------------------------------------------------------------------
// Duplicate (config-only)
// ---------------------------------------------------------------------------

/**
 * Duplicate a project's CONFIGURATION into a fresh, empty workspace:
 * fresh id, name "<name> (copy)", no memories, no conversations, not
 * pinned. Secrets never live on the project row, so nothing sensitive
 * can be copied. Conversation history is never duplicated.
 */
export async function duplicateProject(
  id: string,
  options: DuplicateProjectOptions = {},
): Promise<Project> {
  const {
    includeInstructions = true,
    includeAppearance = true,
    includeResources = true,
    includeMemorySettings = true,
    nameOverride,
  } = options;

  const source = await db.projects.get(id);
  if (!source) {
    throw new ProjectServiceError("not_found", `Project ${id} does not exist.`);
  }

  const ts = nowISO();
  const instructions = includeInstructions ? source.instructions : "";
  const copy: Project = {
    ...source,
    id: nanoid(),
    name: (nameOverride ?? `${source.name} (copy)`).trim() || `${source.name} (copy)`,
    description: source.description ?? null,
    instructions,
    icon: includeAppearance ? source.icon ?? null : null,
    accent_color: includeAppearance ? source.accent_color ?? null : null,
    status: "active",
    pinned: false,
    sort_order: await nextSortOrder(source.user_id),
    memory_settings: includeMemorySettings
      ? source.memory_settings
      : { ...DEFAULT_MEMORY_SETTINGS },
    model_preferences: source.model_preferences ?? { preferred_model: null },
    resources: includeResources ? source.resources : [],
    instructions_history: instructions.trim() ? [{ content: instructions, saved_at: ts }] : [],
    created_at: ts,
    updated_at: ts,
    last_activity_at: null,
  };
  await db.projects.add(copy);
  return copy;
}

// ---------------------------------------------------------------------------
// Activity clock
// ---------------------------------------------------------------------------

/**
 * Bump a project's `last_activity_at` (and `updated_at`). No-op when the
 * project doesn't exist — callers use this opportunistically (e.g. every
 * new project conversation) and must not fail their own flow if the
 * project was deleted concurrently.
 */
export async function touchProjectActivity(id: string): Promise<void> {
  const project = await db.projects.get(id);
  if (!project) return;
  const ts = nowISO();
  await db.projects.update(id, { last_activity_at: ts, updated_at: ts });
}
