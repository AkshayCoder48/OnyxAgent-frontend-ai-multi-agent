"use client";

/**
 * Business Mode data services (Task 2-a) — thin async wrappers over the
 * Dexie v6 business tables.
 *
 * The exact service/method signatures are PINNED in the doc-comment at the
 * bottom of `src/lib/business/types.ts` (the binding contract consumed by
 * the orchestrator, wizard and workspace components) — do not rename
 * anything here without updating that contract.
 *
 * Conventions (mirrored from `src/lib/services/index.ts` + `src/lib/projects/memory.ts`):
 *   - ids via `nanoid()`, timestamps via `nowISO()` (ISO strings).
 *   - every create/append returns the full persisted row.
 *   - `updated_at` is always refreshed on updates.
 *   - data.ts NEVER imports UI stores. Instead, `businessEventService.append`
 *     notifies a listener registered via `setBusinessEventListener` (the
 *     zustand store registers on creation) — no circular imports.
 */

import { nanoid } from "nanoid";
import type { Table } from "dexie";
import { db } from "@/lib/db";
import type {
  AgentMessageRow,
  BusinessAgentCreateInput,
  BusinessAgentPermissions,
  BusinessAgentPromptConfig,
  BusinessAgentRow,
  BusinessApprovalRow,
  BusinessChatMessageRow,
  BusinessConfiguration,
  BusinessCreateInput,
  BusinessDraftCreateInput,
  BusinessDraftRow,
  BusinessEventRow,
  BusinessMemoryCreateInput,
  BusinessMemoryRow,
  BusinessRow,
  BusinessTaskCreateInput,
  BusinessTaskRow,
  BusinessTaskStatus,
  DecisionRecordRow,
} from "@/lib/business/types";

// ---------------------------------------------------------------------------
// Local helpers (same style as services/index.ts).
// ---------------------------------------------------------------------------

function nowISO(): string {
  return new Date().toISOString();
}

/** `where("business_id").equals(businessId)` → primaryKeys → `bulkDelete` —
 *  the shared cascade pattern (generic inference keeps the row type exact). */
async function bulkDeleteForBusiness<TRow extends { business_id: string }>(
  table: Table<TRow, string>,
  businessId: string,
): Promise<void> {
  const keys = (await table.where("business_id").equals(businessId).primaryKeys()) as string[];
  if (keys.length > 0) await table.bulkDelete(keys);
}

/** Safely drop `undefined` entries from a Partial before merging over
 *  defaults (an explicitly-undefined prop must never clobber a default).
 *  Values are copied verbatim — `Object.entries` only loses the compile-time
 *  key/value linkage, which every caller immediately restores via Partial<T>. */
function definedProps<T extends object>(input: T | undefined): Partial<T> {
  if (!input) return {};
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      (out as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Event listener registry — the ONLY coupling point between the data layer
// and the UI. The zustand store (src/stores/business-store.ts) registers a
// listener on creation so appended events flow into the active workspace
// without data.ts importing the store (no circular import).
// ---------------------------------------------------------------------------

type BusinessEventListener = (evt: BusinessEventRow) => void;

let businessEventListener: BusinessEventListener | null = null;

/** Register (or clear, with `undefined`) the listener notified after every
 *  successful `businessEventService.append`. Returns the previous listener. */
export function setBusinessEventListener(
  fn: BusinessEventListener | undefined,
): BusinessEventListener | null {
  const prev = businessEventListener;
  businessEventListener = fn ?? null;
  return prev;
}

// ---------------------------------------------------------------------------
// Defaults (Business Mode).
// ---------------------------------------------------------------------------

const DEFAULT_BUSINESS_CONFIGURATION: BusinessConfiguration = {
  automationLevel: "balanced",
  maxConcurrentTasks: 3,
  collaborationDepth: 2,
  perTaskTimeoutMs: 180000,
  requireDraftApproval: true,
  notifyOn: ["draftReady", "needsInput", "taskFailed", "milestone"],
};

const DEFAULT_PROMPT_CONFIG: BusinessAgentPromptConfig = {
  system_instructions:
    "You are a specialist agent on a small business team. Follow the task instructions precisely, use only the tools and permissions you have been granted, and keep your output concise, factual and actionable.",
  role_definition:
    "A specialist agent contributing its expertise toward the business goals.",
  goals: [],
  behavioral_rules: [],
  output_format:
    "Clear, structured markdown. Lead with the result, then supporting details.",
  escalation_rules:
    "If the task cannot be completed with the available tools or information, report the blocker clearly instead of guessing.",
  version: 1,
  history: [],
};

const DEFAULT_PERMISSIONS: BusinessAgentPermissions = {
  web_search: true,
  create_drafts: true,
  read_memory: true,
  write_memory: true,
};

const ZERO_METRICS = {
  tasks_completed: 0,
  tasks_failed: 0,
  total_duration_ms: 0,
  model_calls: 0,
} as const;

/** Task statuses that imply in-flight work — reset to "interrupted" when a
 *  business is re-opened after a reload (stale recovery). */
const STALE_TASK_STATUSES: readonly BusinessTaskStatus[] = [
  "running",
  "blocked",
  "awaiting_approval",
];

// ---------------------------------------------------------------------------
// businessService
// ---------------------------------------------------------------------------

export const businessService = {
  /** All businesses of a user, most recently updated first. */
  async list(userId: string): Promise<BusinessRow[]> {
    const rows = await db.businesses.where("owner_id").equals(userId).toArray();
    rows.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    return rows;
  },

  async get(id: string): Promise<BusinessRow | undefined> {
    return db.businesses.get(id);
  },

  async create(userId: string, input: BusinessCreateInput): Promise<BusinessRow> {
    const ts = nowISO();
    const row: BusinessRow = {
      id: nanoid(),
      owner_id: userId,
      name: input.name,
      description: input.description,
      industry: input.industry,
      business_model: input.business_model,
      target_customers: input.target_customers,
      geography: input.geography,
      business_profile: input.business_profile ?? "",
      goals: input.goals ?? [],
      configuration: {
        ...DEFAULT_BUSINESS_CONFIGURATION,
        ...definedProps(input.configuration),
      },
      status: input.status ?? "setup",
      template: input.template,
      created_at: ts,
      updated_at: ts,
    };
    await db.businesses.add(row);
    return row;
  },

  async update(
    id: string,
    patch: Partial<Omit<BusinessRow, "id" | "owner_id">>,
  ): Promise<void> {
    await db.businesses.update(id, { ...definedProps(patch), updated_at: nowISO() });
  },

  /** Delete a business + cascade every child row (all nine child tables). */
  async remove(id: string): Promise<void> {
    const d = db;
    await Promise.all([
      bulkDeleteForBusiness(d.business_agents, id),
      bulkDeleteForBusiness(d.business_tasks, id),
      bulkDeleteForBusiness(d.business_chat_messages, id),
      bulkDeleteForBusiness(d.business_drafts, id),
      bulkDeleteForBusiness(d.business_approvals, id),
      bulkDeleteForBusiness(d.business_memory, id),
      bulkDeleteForBusiness(d.agent_messages, id),
      bulkDeleteForBusiness(d.business_events, id),
      bulkDeleteForBusiness(d.decision_records, id),
    ]);
    await d.businesses.delete(id);
  },
};

// ---------------------------------------------------------------------------
// businessAgentService
// ---------------------------------------------------------------------------

export const businessAgentService = {
  /** Agents of a business, oldest first (stable roster order). */
  async list(businessId: string): Promise<BusinessAgentRow[]> {
    const rows = await db.business_agents.where("business_id").equals(businessId).toArray();
    rows.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
    return rows;
  },

  async get(id: string): Promise<BusinessAgentRow | undefined> {
    return db.business_agents.get(id);
  },

  async create(
    businessId: string,
    input: BusinessAgentCreateInput,
  ): Promise<BusinessAgentRow> {
    const ts = nowISO();
    const row: BusinessAgentRow = {
      id: nanoid(),
      business_id: businessId,
      name: input.name,
      description: input.description,
      role: input.role,
      // "orb" is always a valid registry key (main-agent mark, safe fallback).
      svg_logo: input.svg_logo ?? "orb",
      prompt_config: {
        ...DEFAULT_PROMPT_CONFIG,
        ...definedProps(input.prompt_config),
      },
      provider_id: input.provider_id,
      model_id: input.model_id,
      permissions: {
        ...DEFAULT_PERMISSIONS,
        ...definedProps(input.permissions),
      },
      skills: input.skills ?? [],
      status: "idle",
      paused: false,
      metrics: { ...ZERO_METRICS },
      created_at: ts,
      updated_at: ts,
    };
    await db.business_agents.add(row);
    return row;
  },

  async update(
    id: string,
    patch: Partial<Omit<BusinessAgentRow, "id" | "business_id">>,
  ): Promise<void> {
    await db.business_agents.update(id, { ...definedProps(patch), updated_at: nowISO() });
  },

  async remove(id: string): Promise<void> {
    await db.business_agents.delete(id);
  },

  /** Copy an agent under the same business with a fresh id, zeroed metrics
   *  and idle state. Returns undefined when the source id is unknown. */
  async duplicate(id: string): Promise<BusinessAgentRow | undefined> {
    const source = await db.business_agents.get(id);
    if (!source) return undefined;
    const ts = nowISO();
    const copy: BusinessAgentRow = {
      ...source,
      id: nanoid(),
      name: `${source.name} (copy)`,
      prompt_config: {
        ...source.prompt_config,
        goals: [...source.prompt_config.goals],
        behavioral_rules: [...source.prompt_config.behavioral_rules],
        history: source.prompt_config.history.map((h) => ({ ...h })),
      },
      skills: [...source.skills],
      status: "idle",
      paused: false,
      current_task_id: undefined,
      metrics: { ...ZERO_METRICS },
      created_at: ts,
      updated_at: ts,
    };
    await db.business_agents.add(copy);
    return copy;
  },
};

// ---------------------------------------------------------------------------
// businessTaskService
// ---------------------------------------------------------------------------

export const businessTaskService = {
  /** Tasks of a business, newest first. */
  async list(businessId: string): Promise<BusinessTaskRow[]> {
    const rows = await db.business_tasks.where("business_id").equals(businessId).toArray();
    rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    return rows;
  },

  async get(id: string): Promise<BusinessTaskRow | undefined> {
    return db.business_tasks.get(id);
  },

  async create(
    businessId: string,
    input: BusinessTaskCreateInput,
  ): Promise<BusinessTaskRow> {
    const ts = nowISO();
    const row: BusinessTaskRow = {
      id: nanoid(),
      business_id: businessId,
      parent_task_id: input.parent_task_id,
      assigned_agent_id: input.assigned_agent_id,
      title: input.title,
      description: input.description,
      status: input.status ?? "backlog",
      priority: input.priority ?? "medium",
      dependencies: input.dependencies ?? [],
      input_artifacts: input.input_artifacts,
      retry_count: 0,
      correlation_id: input.correlation_id,
      created_at: ts,
      updated_at: ts,
    };
    await db.business_tasks.add(row);
    return row;
  },

  async update(
    id: string,
    patch: Partial<Omit<BusinessTaskRow, "id" | "business_id">>,
  ): Promise<void> {
    await db.business_tasks.update(id, { ...definedProps(patch), updated_at: nowISO() });
  },

  async remove(id: string): Promise<void> {
    await db.business_tasks.delete(id);
  },

  /** Stale recovery on business open: every task still in a work-in-flight
   *  status ("running" | "blocked" | "awaiting_approval") is marked
   *  "interrupted" with an explanatory error. Returns the updated rows. */
  async markStaleInterrupted(businessId: string): Promise<BusinessTaskRow[]> {
    const stale = await db.business_tasks
      .where("business_id")
      .equals(businessId)
      .filter((task) => STALE_TASK_STATUSES.includes(task.status))
      .toArray();
    if (stale.length === 0) return [];
    const ts = nowISO();
    const updated = stale.map<BusinessTaskRow>((task) => ({
      ...task,
      status: "interrupted",
      error: "Interrupted by reload",
      updated_at: ts,
    }));
    await db.business_tasks.bulkPut(updated);
    return updated;
  },
};

// ---------------------------------------------------------------------------
// businessChatService
// ---------------------------------------------------------------------------

export const businessChatService = {
  /** Chat messages of a business in CHRONOLOGICAL (ascending) order; when
   *  `limit` is given only the LAST `limit` messages are returned. */
  async list(businessId: string, limit?: number): Promise<BusinessChatMessageRow[]> {
    const rows = await db.business_chat_messages
      .where("business_id")
      .equals(businessId)
      .sortBy("created_at");
    return typeof limit === "number" && limit > 0 ? rows.slice(-limit) : rows;
  },

  async append(
    businessId: string,
    msg: Omit<BusinessChatMessageRow, "id" | "business_id" | "created_at" | "updated_at">,
  ): Promise<BusinessChatMessageRow> {
    const ts = nowISO();
    const row: BusinessChatMessageRow = {
      ...msg,
      id: nanoid(),
      business_id: businessId,
      created_at: ts,
      updated_at: ts,
    };
    await db.business_chat_messages.add(row);
    return row;
  },

  async update(id: string, patch: Partial<Omit<BusinessChatMessageRow, "id">>): Promise<void> {
    await db.business_chat_messages.update(id, {
      ...definedProps(patch),
      updated_at: nowISO(),
    });
  },

  async remove(id: string): Promise<void> {
    await db.business_chat_messages.delete(id);
  },

  async clear(businessId: string): Promise<void> {
    await bulkDeleteForBusiness(db.business_chat_messages, businessId);
  },
};

// ---------------------------------------------------------------------------
// businessDraftService
// ---------------------------------------------------------------------------

export const businessDraftService = {
  /** Drafts of a business, most recently updated first. */
  async list(businessId: string): Promise<BusinessDraftRow[]> {
    const rows = await db.business_drafts.where("business_id").equals(businessId).toArray();
    rows.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    return rows;
  },

  async get(id: string): Promise<BusinessDraftRow | undefined> {
    return db.business_drafts.get(id);
  },

  async create(
    businessId: string,
    input: BusinessDraftCreateInput,
  ): Promise<BusinessDraftRow> {
    const ts = nowISO();
    const row: BusinessDraftRow = {
      id: nanoid(),
      business_id: businessId,
      task_id: input.task_id,
      created_by_agent_id: input.created_by_agent_id,
      title: input.title,
      content: input.content,
      draft_type: input.draft_type ?? "document",
      version: 1,
      status: "draft",
      approval_requirements: input.approval_requirements ?? [],
      sources: input.sources,
      created_at: ts,
      updated_at: ts,
    };
    await db.business_drafts.add(row);
    return row;
  },

  async update(
    id: string,
    patch: Partial<Omit<BusinessDraftRow, "id" | "business_id">>,
  ): Promise<void> {
    await db.business_drafts.update(id, { ...definedProps(patch), updated_at: nowISO() });
  },
};

// ---------------------------------------------------------------------------
// businessApprovalService
// ---------------------------------------------------------------------------

export const businessApprovalService = {
  /** Approval records of a business, oldest first (chronological audit). */
  async listForBusiness(businessId: string): Promise<BusinessApprovalRow[]> {
    const rows = await db.business_approvals.where("business_id").equals(businessId).toArray();
    rows.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
    return rows;
  },

  /** Approval history of one draft, oldest first. */
  async listForDraft(draftId: string): Promise<BusinessApprovalRow[]> {
    const rows = await db.business_approvals.where("draft_id").equals(draftId).toArray();
    rows.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
    return rows;
  },

  async record(
    businessId: string,
    input: Omit<BusinessApprovalRow, "id" | "business_id" | "created_at">,
  ): Promise<BusinessApprovalRow> {
    const row: BusinessApprovalRow = {
      ...input,
      id: nanoid(),
      business_id: businessId,
      created_at: nowISO(),
    };
    await db.business_approvals.add(row);
    return row;
  },
};

// ---------------------------------------------------------------------------
// businessMemoryService
// ---------------------------------------------------------------------------

/** Lowercase alphanumeric word tokens — the shared tokenizer for retrieval
 *  scoring (same style as `src/lib/projects/memory.ts` `tokenizeContent`). */
function tokenizeContent(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of (text ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length > 0) out.add(token);
  }
  return out;
}

/** Keyword-overlap score: matched query tokens / total query tokens. */
function scoreMemoryRow(row: BusinessMemoryRow, queryTokens: ReadonlySet<string>): number {
  if (queryTokens.size === 0) return 0;
  const contentTokens = tokenizeContent(row.content);
  let matched = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) matched++;
  }
  return matched / queryTokens.size;
}

/**
 * Budgeted selection (mirrors the projects-memory precedent, scoped to
 * business memory): pinned rows always rank first and are ALWAYS included
 * (even when they alone exceed the budget); the rest are ranked by keyword
 * overlap, then recency, and the walk stops at the first row that no longer
 * fits `budgetChars`.
 */
function selectMemoriesWithinBudget(
  rows: BusinessMemoryRow[],
  query: string,
  budgetChars: number,
): BusinessMemoryRow[] {
  const queryTokens = tokenizeContent(query);
  const ranked = [...rows].sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return a.pinned ? -1 : 1;
    const scoreA = scoreMemoryRow(a, queryTokens);
    const scoreB = scoreMemoryRow(b, queryTokens);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  });
  const selected: BusinessMemoryRow[] = [];
  let used = 0;
  for (const row of ranked) {
    const length = row.content.length;
    if (row.pinned) {
      selected.push(row);
      used += length;
      continue;
    }
    if (used + length > budgetChars) break;
    selected.push(row);
    used += length;
  }
  return selected;
}

export const businessMemoryService = {
  /** All memories of a business — pinned first, then most recently updated. */
  async list(businessId: string): Promise<BusinessMemoryRow[]> {
    const rows = await db.business_memory.where("business_id").equals(businessId).toArray();
    rows.sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return a.pinned ? -1 : 1;
      return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
    });
    return rows;
  },

  async create(
    businessId: string,
    input: BusinessMemoryCreateInput,
  ): Promise<BusinessMemoryRow> {
    const ts = nowISO();
    const row: BusinessMemoryRow = {
      id: nanoid(),
      business_id: businessId,
      memory_type: input.memory_type,
      content: input.content,
      source: input.source,
      verification_status: input.verification_status ?? "unverified",
      metadata: input.metadata,
      pinned: false,
      created_at: ts,
      updated_at: ts,
    };
    await db.business_memory.add(row);
    return row;
  },

  async update(
    id: string,
    patch: Partial<Omit<BusinessMemoryRow, "id" | "business_id">>,
  ): Promise<void> {
    await db.business_memory.update(id, { ...definedProps(patch), updated_at: nowISO() });
  },

  async remove(id: string): Promise<void> {
    await db.business_memory.delete(id);
  },

  /** Budgeted keyword retrieval: rank (pinned → overlap score → recency) and
   *  accumulate content until `budgetChars` (default 3000) is reached. */
  async retrieve(
    businessId: string,
    query: string,
    budgetChars: number = 3000,
  ): Promise<BusinessMemoryRow[]> {
    const rows = await db.business_memory.where("business_id").equals(businessId).toArray();
    return selectMemoriesWithinBudget(rows, query, budgetChars);
  },
};

// ---------------------------------------------------------------------------
// businessEventService
// ---------------------------------------------------------------------------

export const businessEventService = {
  /** Events of a business in CHRONOLOGICAL (ascending) order; when `limit`
   *  is given only the LAST (most recent) `limit` events are returned. */
  async list(businessId: string, limit?: number): Promise<BusinessEventRow[]> {
    const rows = await db.business_events
      .where("business_id")
      .equals(businessId)
      .sortBy("created_at");
    return typeof limit === "number" && limit > 0 ? rows.slice(-limit) : rows;
  },

  /** Persist an event and notify the registered listener (the zustand store
   *  pushes it into the active workspace's event feed). Listener errors are
   *  swallowed — a UI bug must never break persistence. */
  async append(evt: Omit<BusinessEventRow, "id" | "created_at">): Promise<BusinessEventRow> {
    const row: BusinessEventRow = {
      ...evt,
      id: nanoid(),
      created_at: nowISO(),
    };
    await db.business_events.add(row);
    if (businessEventListener) {
      try {
        businessEventListener(row);
      } catch {
        // Listener failures never break the write path.
      }
    }
    return row;
  },
};

// ---------------------------------------------------------------------------
// agentMessageService (agent-to-agent messages)
// ---------------------------------------------------------------------------

export const agentMessageService = {
  /** Agent-to-agent messages of a business (chronological); when `taskId` is
   *  given, only that task's messages are returned. */
  async list(businessId: string, taskId?: string): Promise<AgentMessageRow[]> {
    if (taskId) {
      const rows = await db.agent_messages
        .where("business_id")
        .equals(businessId)
        .filter((msg) => msg.task_id === taskId)
        .toArray();
      rows.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
      return rows;
    }
    return db.agent_messages.where("business_id").equals(businessId).sortBy("created_at");
  },

  async append(msg: Omit<AgentMessageRow, "id" | "created_at">): Promise<AgentMessageRow> {
    const row: AgentMessageRow = {
      ...msg,
      id: nanoid(),
      created_at: nowISO(),
    };
    await db.agent_messages.add(row);
    return row;
  },
};

// ---------------------------------------------------------------------------
// decisionRecordService (JEV routing decisions + fallbacks)
// ---------------------------------------------------------------------------

export const decisionRecordService = {
  async append(rec: Omit<DecisionRecordRow, "id" | "created_at">): Promise<DecisionRecordRow> {
    const row: DecisionRecordRow = {
      ...rec,
      id: nanoid(),
      created_at: nowISO(),
    };
    await db.decision_records.add(row);
    return row;
  },

  /** Decision records of a business, oldest first. */
  async list(businessId: string): Promise<DecisionRecordRow[]> {
    return db.decision_records.where("business_id").equals(businessId).sortBy("created_at");
  },
};
