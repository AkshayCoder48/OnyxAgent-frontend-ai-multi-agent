/**
 * Projects data layer types (PRD §3–§9, §14 — Projects Workspace System).
 *
 * These are the CANONICAL wire/row shapes shared by:
 *   - the Dexie v4 schema (`src/lib/db/index.ts` — `projects`,
 *     `project_memories`, `approval_requests`, `message_search_index`),
 *   - the projects service layer (`src/lib/projects/*`),
 *   - the execution layer's permission/approval gates (Task 2-d),
 *   - the Projects UI (Task 1-b).
 *
 * Naming follows the app's snake_case persistence convention (see
 * `src/types/conversation.ts`) so rows serialize 1:1 into Dexie.
 */

/** Categories of resources a project rule can point at. */
export type ProjectResourceType =
  | "tool"
  | "mcp_server"
  | "mcp_tool"
  | "skill"
  | "directory"
  | "terminal"
  | "browser"
  | "connector";

/** The three explicit permission states (PRD §8.2). */
export type ResourcePermission = "allowed" | "approval_required" | "denied";

/** One resource-access rule inline on the project row (atomic reads at
 *  execution time — no join needed when the dispatch site checks perms). */
export interface ProjectResourceRule {
  resource_type: ProjectResourceType;
  /** tool name | mcp server id | "serverId:toolName" | skill id | dir path */
  resource_id: string;
  permission: ResourcePermission;
  updated_at: string;
}

/** How the agent may use previous project conversations (PRD §4.5, §7). */
export interface ProjectMemorySettings {
  /** Project memory on/off. */
  enabled: boolean;
  /** Retrieve from other project chats. */
  cross_chat_retrieval: boolean;
  /** Agent may write memories. */
  automatic_updates: boolean;
  /** Retrieval budget, default 4000. */
  context_budget_chars: number;
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  description?: string | null;
  goal: string;
  instructions: string;
  /** Key into the fixed icon set the UI offers. */
  icon?: string | null;
  /** Hex. */
  accent_color?: string | null;
  status: "active" | "archived";
  pinned?: boolean;
  sort_order?: number;
  memory_settings: ProjectMemorySettings;
  model_preferences?: { preferred_model?: string | null };
  /** Inline on the row (atomic reads at execution time). */
  resources: ProjectResourceRule[];
  /** Cap 20 (see service.INSTRUCTIONS_HISTORY_CAP). */
  instructions_history: Array<{ content: string; saved_at: string }>;
  created_at: string;
  updated_at: string;
  last_activity_at?: string | null;
}

export interface ProjectMemoryItem {
  id: string;
  project_id: string;
  category:
    | "overview"
    | "decision"
    | "preference"
    | "constraint"
    | "task"
    | "reference"
    | "bug"
    | "file_ref";
  content: string;
  source_conversation_ids: string[];
  /** 0..1 */
  confidence?: number;
  pinned?: boolean;
  /** Newer item that replaced this one (dedupe/supersede chain). */
  superseded_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalRequest {
  id: string;
  project_id: string | null;
  conversation_id: string;
  /** Human label, e.g. "Run terminal command". */
  operation_type: string;
  tool_name: string;
  operation_parameters: Record<string, unknown>;
  /** sha256 hex of canonical JSON — approval binds to EXACT params. */
  params_hash: string;
  status:
    | "pending"
    | "approved"
    | "rejected"
    | "cancelled"
    | "expired"
    | "completed"
    | "failed";
  risk_note?: string | null;
  result_summary?: string | null;
  created_at: string;
  /** Default +15min for pending. */
  expires_at?: string | null;
  resolved_at?: string | null;
}

/** One row of the per-message search index consumed by the semantic-search
 *  engine (Task 2-b) and cross-chat project retrieval (Task 2-d). */
export interface MessageSearchRow {
  /** Primary key. */
  message_id: string;
  conversation_id: string;
  project_id: string | null;
  role: "user" | "assistant" | "system";
  /** Markdown-stripped plain text, cap 4000 chars. */
  text: string;
  /** Conversation title at index time. */
  title_cache: string;
  token_count: number;
  embedding?: number[] | null;
  embed_model?: string | null;
  embed_state: "none" | "pending" | "ready" | "failed";
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Derived convenience unions (kept in sync with the interfaces above).
// ---------------------------------------------------------------------------

export type ProjectStatus = Project["status"];
export type ProjectMemoryCategory = ProjectMemoryItem["category"];
export type ApprovalStatus = ApprovalRequest["status"];
