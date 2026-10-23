// ============================================================================
// Business Mode — shared contract types (PRD: upload/Pasted Content_*.txt)
//
// Single source of truth for every Business Mode row shape, enum, and the
// pinned public APIs implemented in data.ts / orchestrator.ts / llm.ts.
// ALL Business Mode code must import types from here — never redeclare.
// ============================================================================

// ---------------------------------------------------------------------------
// Enums / unions
// ---------------------------------------------------------------------------

export type BusinessStatus = "setup" | "active" | "archived";

export type AgentStatus =
  | "idle"
  | "planning"
  | "working"
  | "researching"
  | "collaborating"
  | "waiting_input"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "paused"
  | "disabled";

export type BusinessTaskStatus =
  | "backlog"
  | "ready"
  | "running"
  | "blocked"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type TaskPriority = "low" | "medium" | "high" | "urgent";

export type DraftStatus =
  | "generating"
  | "draft"
  | "in_review"
  | "changes_requested"
  | "approved"
  | "rejected"
  | "scheduled"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled";

export type ApprovalDecision =
  | "pending"
  | "approved"
  | "rejected"
  | "changes_requested";

export type BusinessEventType =
  | "business.created"
  | "business.updated"
  | "agent.created"
  | "agent.updated"
  | "agent.status_changed"
  | "agent.deleted"
  | "task.created"
  | "task.started"
  | "task.progress"
  | "task.blocked"
  | "task.awaiting_approval"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.retried"
  | "agent.message"
  | "draft.created"
  | "draft.updated"
  | "approval.requested"
  | "approval.completed"
  | "decision.completed"
  | "browser.activity"
  | "chat.message"
  | "turn.started"
  | "turn.completed"
  | "turn.cancelled"
  | "memory.updated"
  | "notification";

export type AgentMessageType =
  | "task_assignment"
  | "information_request"
  | "research_result"
  | "clarification"
  | "review_request"
  | "review_feedback"
  | "task_completion"
  | "blocker_report"
  | "escalation"
  | "cancellation";

export type MemoryCategory =
  | "profile"
  | "goal"
  | "preference"
  | "decision"
  | "research"
  | "procedure"
  | "product"
  | "brand"
  | "market"
  | "outcome";

export type VerificationStatus = "verified" | "assumption" | "unverified";

export type BusinessChatRole = "user" | "main" | "agent" | "activity";

export type AutomationLevel = "suggest" | "balanced" | "autonomous";

// ---------------------------------------------------------------------------
// Rows (persisted in Dexie v6 — see src/lib/db/index.ts)
// ---------------------------------------------------------------------------

export interface BusinessGoal {
  id: string;
  title: string;
  description?: string;
  status: "proposed" | "active" | "completed";
  created_at?: string;
}

export interface BusinessConfiguration {
  /** Main Agent provider override (ai_providers.id) */
  mainProviderId?: string;
  mainModel?: string;
  mainTemperature?: number;
  automationLevel: AutomationLevel;
  workingStyle?: string;
  maxConcurrentTasks: number;
  collaborationDepth: number;
  perTaskTimeoutMs: number;
  /** Require explicit user approval before drafts are marked approved/executed */
  requireDraftApproval: boolean;
  notifyOn: string[];
}

export interface BusinessRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  industry?: string;
  business_model?: string;
  target_customers?: string;
  geography?: string;
  /** Markdown business profile produced by discovery (editable) */
  business_profile: string;
  goals: BusinessGoal[];
  configuration: BusinessConfiguration;
  status: BusinessStatus;
  /** Template key used to seed the business, if any */
  template?: string;
  created_at: string;
  updated_at: string;
}

export interface BusinessAgentPromptConfig {
  system_instructions: string;
  role_definition: string;
  goals: string[];
  behavioral_rules: string[];
  output_format: string;
  escalation_rules: string;
  /** Prompt version — bumped on every edit; history keeps prior versions */
  version: number;
  history: { version: number; system_instructions: string; saved_at: string }[];
}

export interface BusinessAgentPermissions {
  web_search: boolean;
  create_drafts: boolean;
  read_memory: boolean;
  write_memory: boolean;
}

export interface BusinessAgentMetrics {
  tasks_completed: number;
  tasks_failed: number;
  total_duration_ms: number;
  model_calls: number;
}

export interface BusinessAgentRow {
  id: string;
  business_id: string;
  name: string;
  description: string;
  /** free-form role key, e.g. research | strategy | marketing | content | finance | operations | developer | quality | coordinator */
  role: string;
  /** key into AGENT_LOGOS registry (src/components/business/agent-logos.tsx) */
  svg_logo: string;
  prompt_config: BusinessAgentPromptConfig;
  provider_id?: string;
  model_id?: string;
  permissions: BusinessAgentPermissions;
  /** skill ids (Dexie skills table) assigned to this agent */
  skills: string[];
  status: AgentStatus;
  current_task_id?: string;
  paused: boolean;
  metrics: BusinessAgentMetrics;
  last_activity?: string;
  created_at: string;
  updated_at: string;
}

export interface BusinessTaskRow {
  id: string;
  business_id: string;
  parent_task_id?: string;
  assigned_agent_id?: string;
  title: string;
  description: string;
  status: BusinessTaskStatus;
  priority: TaskPriority;
  /** task ids this task depends on */
  dependencies: string[];
  input_artifacts?: Record<string, unknown>;
  output_artifacts?: {
    summary?: string;
    content?: string;
    draft_id?: string;
    sources?: { title: string; url: string }[];
  };
  retry_count: number;
  error?: string;
  /** turn correlation id */
  correlation_id?: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
}

export interface BusinessChatMessageMetadata {
  taskId?: string;
  eventType?: BusinessEventType;
  streaming?: boolean;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  draftId?: string;
  /** agent ids @mentioned in a user message */
  mentions?: string[];
  sources?: { title: string; url: string }[];
  turnId?: string;
  cancelled?: boolean;
  agentNames?: string[];
}

export interface BusinessChatMessageRow {
  id: string;
  business_id: string;
  role: BusinessChatRole;
  /** agent id for role === "agent" | "activity" (main agent messages have no agent_id) */
  agent_id?: string;
  content: string;
  metadata?: BusinessChatMessageMetadata;
  created_at: string;
  updated_at: string;
}

export interface BusinessDraftRow {
  id: string;
  business_id: string;
  task_id?: string;
  created_by_agent_id?: string;
  title: string;
  content: string;
  draft_type: string;
  version: number;
  status: DraftStatus;
  /** e.g. ["user_approval"] */
  approval_requirements: string[];
  comments?: string;
  sources?: { title: string; url: string }[];
  /** version that received the latest approval (approval is version-scoped) */
  approved_version?: number;
  /** superseded draft_id when a new version was created from this one */
  superseded_by?: string;
  created_at: string;
  updated_at: string;
}

export interface BusinessApprovalRow {
  id: string;
  business_id: string;
  draft_id: string;
  draft_version: number;
  requested_action: string;
  decision: ApprovalDecision;
  reviewer_id?: string;
  comments?: string;
  created_at: string;
}

export interface BusinessMemoryRow {
  id: string;
  business_id: string;
  memory_type: MemoryCategory;
  content: string;
  source: string;
  verification_status: VerificationStatus;
  metadata?: Record<string, unknown>;
  pinned?: boolean;
  created_at: string;
  updated_at: string;
}

export interface AgentMessageRow {
  id: string;
  business_id: string;
  task_id?: string;
  sender_agent_id?: string;
  recipient_agent_id?: string;
  message_type: AgentMessageType;
  content: string;
  correlation_id?: string;
  created_at: string;
}

export interface BusinessEventRow {
  id: string;
  business_id: string;
  task_id?: string;
  agent_id?: string;
  event_type: BusinessEventType;
  payload: Record<string, unknown>;
  correlation_id?: string;
  created_at: string;
}

export interface DecisionRecordRow {
  id: string;
  business_id: string;
  task_id?: string;
  decision_type: string;
  input_summary: string;
  provider: string;
  result?: string;
  confidence?: number;
  fallback_used: boolean;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Discovery / blueprint (wizard + orchestrator contract)
// ---------------------------------------------------------------------------

export interface BusinessDiscoveryInput {
  name: string;
  idea: string;
  industry?: string;
  businessModel?: string;
  targetCustomers?: string;
  objectives?: string;
  geography?: string;
  budget?: string;
  references?: string;
  workingStyle?: string;
  automation?: string;
  /** one-shot natural language prompt (fills the structured fields via LLM when absent) */
  rawPrompt?: string;
}

export interface BlueprintResearchFinding {
  finding: string;
  source?: string;
  /** true only when actually retrieved via a real tool (web search) */
  verified: boolean;
}

export interface BlueprintProposedAgent {
  name: string;
  role: string;
  description: string;
  logo: string;
  system_instructions: string;
}

export interface BusinessBlueprint {
  overview: string;
  customer_profile: string;
  market_research: string;
  competitor_analysis: string;
  revenue_model: string;
  operational_workflow: string;
  risks: string;
  proposed_goals: string[];
  recommended_skills: string[];
  recommended_connectors: string[];
  proposed_agents: BlueprintProposedAgent[];
  initial_task_backlog: { title: string; description: string; agent_role: string }[];
  assumptions: string[];
  research_findings: BlueprintResearchFinding[];
}

export interface TurnTaskPlan {
  agent: string;
  title: string;
  description: string;
  depends_on: string[];
  produces_draft: boolean;
  draft_type: string;
  search_queries: string[];
}

export interface TurnPlan {
  direct: boolean;
  response: string;
  tasks: TurnTaskPlan[];
  notes: string;
}

// ---------------------------------------------------------------------------
// Pinned data-service signatures (implemented in src/lib/business/data.ts — Task 2-a)
// ---------------------------------------------------------------------------

export interface BusinessCreateInput {
  name: string;
  description: string;
  industry?: string;
  business_model?: string;
  target_customers?: string;
  geography?: string;
  business_profile?: string;
  goals?: BusinessGoal[];
  configuration?: Partial<BusinessConfiguration>;
  status?: BusinessStatus;
  template?: string;
}

export interface BusinessAgentCreateInput {
  name: string;
  description: string;
  role: string;
  svg_logo?: string;
  prompt_config?: Partial<BusinessAgentPromptConfig>;
  provider_id?: string;
  model_id?: string;
  permissions?: Partial<BusinessAgentPermissions>;
  skills?: string[];
}

export interface BusinessTaskCreateInput {
  title: string;
  description: string;
  assigned_agent_id?: string;
  status?: BusinessTaskStatus;
  priority?: TaskPriority;
  dependencies?: string[];
  parent_task_id?: string;
  correlation_id?: string;
  input_artifacts?: Record<string, unknown>;
}

export interface BusinessMemoryCreateInput {
  memory_type: MemoryCategory;
  content: string;
  source: string;
  verification_status?: VerificationStatus;
  metadata?: Record<string, unknown>;
}

export interface BusinessDraftCreateInput {
  title: string;
  content: string;
  draft_type?: string;
  task_id?: string;
  created_by_agent_id?: string;
  approval_requirements?: string[];
  sources?: { title: string; url: string }[];
}

/**
 * data.ts exports (BINDING contract):
 *
 * export const businessService: {
 *   list(userId: string): Promise<BusinessRow[]>;
 *   get(id: string): Promise<BusinessRow | undefined>;
 *   create(userId: string, input: BusinessCreateInput): Promise<BusinessRow>;
 *   update(id: string, patch: Partial<Omit<BusinessRow, "id" | "owner_id">>): Promise<void>;
 *   remove(id: string): Promise<void>; // cascades every child table
 * };
 *
 * export const businessAgentService: {
 *   list(businessId: string): Promise<BusinessAgentRow[]>;
 *   get(id: string): Promise<BusinessAgentRow | undefined>;
 *   create(businessId: string, input: BusinessAgentCreateInput): Promise<BusinessAgentRow>;
 *   update(id: string, patch: Partial<Omit<BusinessAgentRow, "id" | "business_id">>): Promise<void>;
 *   remove(id: string): Promise<void>;
 *   duplicate(id: string): Promise<BusinessAgentRow | undefined>;
 * };
 *
 * export const businessTaskService: {
 *   list(businessId: string): Promise<BusinessTaskRow[]>;
 *   get(id: string): Promise<BusinessTaskRow | undefined>;
 *   create(businessId: string, input: BusinessTaskCreateInput): Promise<BusinessTaskRow>;
 *   update(id: string, patch: Partial<Omit<BusinessTaskRow, "id" | "business_id">>): Promise<void>;
 *   remove(id: string): Promise<void>;
 *   /** mark running/blocked tasks as interrupted (stale recovery on load) *\n
 *   markStaleInterrupted(businessId: string): Promise<BusinessTaskRow[]>;
 * };
 *
 * export const businessChatService: {
 *   list(businessId: string, limit?: number): Promise<BusinessChatMessageRow[]>;
 *   append(businessId: string, msg: Omit<BusinessChatMessageRow, "id" | "business_id" | "created_at" | "updated_at">): Promise<BusinessChatMessageRow>;
 *   update(id: string, patch: Partial<Omit<BusinessChatMessageRow, "id">>): Promise<void>;
 *   remove(id: string): Promise<void>;
 *   clear(businessId: string): Promise<void>;
 * };
 *
 * export const businessDraftService: {
 *   list(businessId: string): Promise<BusinessDraftRow[]>;
 *   get(id: string): Promise<BusinessDraftRow | undefined>;
 *   create(businessId: string, input: BusinessDraftCreateInput): Promise<BusinessDraftRow>;
 *   update(id: string, patch: Partial<Omit<BusinessDraftRow, "id" | "business_id">>): Promise<void>;
 * };
 *
 * export const businessApprovalService: {
 *   listForBusiness(businessId: string): Promise<BusinessApprovalRow[]>;
 *   listForDraft(draftId: string): Promise<BusinessApprovalRow[]>;
 *   record(businessId: string, input: Omit<BusinessApprovalRow, "id" | "business_id" | "created_at">): Promise<BusinessApprovalRow>;
 * };
 *
 * export const businessMemoryService: {
 *   list(businessId: string): Promise<BusinessMemoryRow[]>;
 *   create(businessId: string, input: BusinessMemoryCreateInput): Promise<BusinessMemoryRow>;
 *   update(id: string, patch: Partial<Omit<BusinessMemoryRow, "id" | "business_id">>): Promise<void>;
 *   remove(id: string): Promise<void>;
 *   /** budgeted keyword retrieval over memory content *\n
 *   retrieve(businessId: string, query: string, budgetChars?: number): Promise<BusinessMemoryRow[]>;
 * };
 *
 * export const businessEventService: {
 *   list(businessId: string, limit?: number): Promise<BusinessEventRow[]>;
 *   append(evt: Omit<BusinessEventRow, "id" | "created_at">): Promise<BusinessEventRow>;
 * };
 *
 * export const agentMessageService: {
 *   list(businessId: string, taskId?: string): Promise<AgentMessageRow[]>;
 *   append(msg: Omit<AgentMessageRow, "id" | "created_at">): Promise<AgentMessageRow>;
 * };
 *
 * export const decisionRecordService: {
 *   append(rec: Omit<DecisionRecordRow, "id" | "created_at">): Promise<DecisionRecordRow>;
 *   list(businessId: string): Promise<DecisionRecordRow[]>;
 * };
 */
