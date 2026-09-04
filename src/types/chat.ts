import type { GenUINode } from "@/lib/genui/types";

export type MessageRole = "user" | "assistant" | "system";
/** Rating values for message feedback. */
export enum RatingValue {
  LIKE = 1,
  DISLIKE = -1,
}

export type UserRating = RatingValue.LIKE | RatingValue.DISLIKE | null;

export interface ChatMessageFile {
  id: string;
  filename: string;
  mime_type: string;
  /** "image" | "pdf" | "docx" | "text" — derived from MIME on upload. */
  file_type: string;
  /** Optional file size in bytes (not always present on legacy rows). */
  size?: number;
  /** Optional URL/path for rendering previews (image thumbnails, etc.). */
  url?: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: Date;
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
  /** Group ID for related messages in a multi-agent chain. */
  groupId?: string;
  /** IDs of attached files — kept for sending. Use ``files`` for rendering. */
  fileIds?: string[];
  /** Full file metadata for rendering attachments. */
  files?: ChatMessageFile[];
  /** Conversation ID for this message */
  conversationId?: string;
  /** True if message ID is a temporary nanoid, not yet replaced by server ID */
  isTemporaryId?: boolean;
  /** STABLE RENDER KEY (GenUI PRD §6/§14): the temporary id the message was
   *  created with. `message_saved` swaps the temp nanoid for the real DB id
   * at the end of a turn; keying the list on `renderKey ?? id` means that
   * swap no longer remounts the whole message subtree (which reloaded every
   * GenUI iframe once per turn at completion). Optional — legacy rows fall
   * back to `id`. */
  renderKey?: string;
  /** Current user's rating */
  user_rating?: UserRating;
  /** Aggregate rating counts */
  rating_count?: { likes: number; dislikes: number } | null;
  /** Reasoning trace from extended-thinking models. Rendered dimmed +
   *  collapsible above the final response. */
  thinking?: string;
  /** DeepSeek/Moonshot/g4f-style ``reasoning_content`` field. Rendered in a
   *  separate "Reasoning" block (visually similar to Thinking) so the user
   *  can distinguish OpenAI-native reasoning (``thinking``) from the
   *  non-standard ``reasoning_content`` field that some OpenAI-compatible
   *  providers stream. */
  reasoning?: string;
  /** Ordered timeline of the assistant turn: reasoning, text and tool
   *  calls in the exact order they occurred. Rendered in sequence so a
   *  multi-step turn (think → tools → text → think → tools → text) shows
   *  correctly. ``content``/``thinking``/``toolCalls`` are kept in sync as
   *  flat aggregates for copy/persist/rating. */
  parts?: MessagePart[];
  /** Parsed GenUI nodes (Generative UI) extracted from the message text.
   *  Populated by the agent runtime when the AI emits a
   *  ``<<<genui>>>...<<</genui>>>`` block. Persisted to Dexie so the rich
   *  components survive reloads. Rendered by ``GenUIBlock`` after the text. */
  genui?: GenUINode[];
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  status: "pending" | "running" | "completed" | "error";
  /**
   * Live stdout/stderr chunks streamed from the tool while it's still
   * running. Populated by `tool_output` WSEvents. The UI's
   * `RunningToolPanel` renders this in real time; once the tool completes,
   * `result` takes over (the final structured payload).
   */
  streamingOutput?: string;
  /** Live stderr chunks, streamed separately so the UI can color them. */
  streamingError?: string;
  /** Epoch ms when the call STARTED (event `ts` when available — the runner
   *  clock in background mode) — drives the live elapsed timer. */
  startedAt?: number;
  /** Epoch ms when the call SETTLED (completed/error) — drives the settled
   *  "2.4s" duration badge next to the status mark. */
  endedAt?: number;
}

export type MessagePartType = "thinking" | "text" | "tool" | "reasoning";

/** One ordered segment of an assistant turn. */
export interface MessagePart {
  id: string;
  type: MessagePartType;
  /** Text for "thinking"/"text" parts. */
  content?: string;
  /** Tool invocation for "tool" parts. */
  toolCall?: ToolCall;
  /** 1-based agent round this part belongs to (multi-round turns).
   *  Parts from different rounds NEVER merge into one reasoning panel —
   *  each round renders its own panel with its own timing. */
  round?: number;
  /** Epoch ms when the round started (stamped on the first part of a round). */
  roundStartedAt?: number;
  /** Epoch ms when the round ended (stamped when the next round starts or
   *  the turn completes). Frozen thereafter — completed round timing stays. */
  roundEndedAt?: number;
  /** Epoch ms when THIS part's thinking/reasoning stream STOPPED — stamped
   *  the moment the first text delta or tool call arrives after reasoning,
   *  or when the LLM round completes. The reasoning panel flips from
   *  "Thinking…" to "Thought for Ns" and auto-collapses IMMEDIATELY at this
   *  point — it does NOT wait for the whole round/turn to finish. */
  reasoningEndedAt?: number;
}

export interface MapMarker {
  lat: number;
  lng: number;
  label: string;
  description?: string | null;
  color?: string | null;
}

export interface MapSpec {
  kind: "map";
  title: string;
  markers: MapMarker[];
  center?: [number, number] | null;
  zoom?: number | null;
}

export type ChartType = "line" | "bar" | "pie" | "area" | "scatter";

export interface ChartSeries {
  key: string;
  label?: string | null;
  color?: string | null;
}

export interface ChartStyle {
  palette?: string[] | null;
  grid?: boolean;
  legend?: boolean;
  x_label?: string | null;
  y_label?: string | null;
  stacked?: boolean;
}

/** Structured chart payload produced by the agent's `create_chart` tool. */
export interface ChartSpec {
  kind: "chart";
  chart_type: ChartType;
  title: string;
  data: Array<Record<string, unknown>>;
  x_key: string;
  series: ChartSeries[];
  style: ChartStyle;
}

export type WSEventType =
  | "user_prompt"
  | "user_prompt_processed"
  | "model_request_start"
  | "part_start"
  | "text_delta"
  | "thinking_delta"
  | "reasoning_delta"
  | "tool_call_delta"
  | "call_tools_start"
  | "tool_call"
  | "tool_result"
  | "tool_output"
  | "final_result_start"
  | "final_result"
  | "complete"
  | "error"
  | "conversation_created"
  | "message_saved"
  | "tool_approval_required"
  | "ask_user"
  | "todo_event"
  | "subagent_status"
  | "subagent_message"
  | "context_usage"
  | "context_compacted"
  | "llm_started"
  | "llm_completed"
  | "rate_limited";

export interface WSEvent {
  type: WSEventType;
  data?: unknown;
  timestamp?: string;
}

/**
 * Extract the `generation_id` from a WSEvent's `data` payload.
 *
 * Every event emitted by `runAgentTurn` carries a `generation_id` field inside
 * its `data` object. This ID is generated ONCE at the start of a turn and
 * remains stable for the entire multi-round lifetime of that turn. Consumers
 * (use-chat.ts) use it to discard stale events from a previous generation
 * that arrive after a stop/restart — without this, a delayed `message_saved`
 * from turn N-1 could corrupt the message ID of turn N.
 *
 * Events that don't carry a generation_id (e.g. legacy events, or events
 * emitted before the runtime mints one) return `null` — callers treat null
 * as "always accept" for backward compatibility.
 */
export function getGenerationId(event: WSEvent): string | null {
  if (!event.data || typeof event.data !== "object") return null;
  const gid = (event.data as { generation_id?: unknown }).generation_id;
  return typeof gid === "string" && gid.length > 0 ? gid : null;
}

export interface TextDeltaEvent {
  type: "text_delta";
  data: {
    delta: string;
  };
}

export interface ToolCallEvent {
  type: "tool_call";
  data: {
    tool_name: string;
    args: Record<string, unknown>;
  };
}

export interface ToolResultEvent {
  type: "tool_result";
  data: {
    tool_name: string;
    result: unknown;
  };
}

export interface FinalResultEvent {
  type: "final_result";
  data: {
    output: string;
    tool_events: ToolCall[];
  };
}

export interface ChatState {
  messages: ChatMessage[];
  isConnected: boolean;
  isProcessing: boolean;
}

export interface ActionRequest {
  id: string;
  tool_name: string;
  args: Record<string, unknown>;
}

export interface ReviewConfig {
  tool_name: string;
  /** Whether to allow editing the tool arguments */
  allow_edit?: boolean;
  /** Maximum time to wait for decision (seconds) */
  timeout?: number;
}

export interface PendingApproval {
  actionRequests: ActionRequest[];
  reviewConfigs: ReviewConfig[];
}

export type DecisionType = "approve" | "edit" | "reject";

export interface Decision {
  type: DecisionType;
  editedAction?: {
    id: string;
    tool_name: string;
    args: Record<string, unknown>;
  };
}

export interface ToolApprovalRequiredEvent {
  type: "tool_approval_required";
  data: {
    action_requests: ActionRequest[];
    review_configs: ReviewConfig[];
  };
}

export interface AskUserQuestion {
  question: string;
  options: string[];
  /** Whether the user may type a free-form answer instead of picking an option. */
  allowCustom: boolean;
}

export interface AskUserAnswer {
  answer: string;
  skipped: boolean;
}

export interface AskUserEvent {
  type: "ask_user";
  data: {
    questions: { question: string; options: string[]; allow_custom: boolean }[];
  };
}

export type ResearchTodoStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface ResearchTodo {
  id: string;
  content: string;
  status: ResearchTodoStatus;
  active_form: string;
  parent_id: string | null;
  depends_on: string[];
}

export interface TodoEventFrame {
  type: "todo_event";
  data: {
    event_type: "created" | "updated" | "status_changed" | "completed" | "deleted";
    todo: ResearchTodo;
    previous: ResearchTodo | null;
    ts: string | null;
  };
}

// ---------------------------------------------------------------------------
// Agent Todo system (PRD "Agent Todo System") — stable IDs, 4 statuses,
// persisted per conversation, displayed via `show_todo` tool previews.
// ---------------------------------------------------------------------------

/** The four user-facing todo states (internal values). */
export type TodoStatus = "not_planned" | "in_progress" | "done" | "not_done";

export interface Todo {
  /** Stable short ID, e.g. `todo_8f42` — returned by creation, reused in
   *  later tool calls across rounds and refreshes. */
  id: string;
  title: string;
  description?: string;
  status: TodoStatus;
  createdAt: number;
  updatedAt: number;
}

/** Human labels for each status (never communicate status by color alone). */
export const TODO_STATUS_LABELS: Record<TodoStatus, string> = {
  not_planned: "Not planned",
  in_progress: "In progress",
  done: "Done",
  not_done: "Not done",
};

export type SubagentTaskStatus =
  "pending" | "running" | "waiting_for_answer" | "completed" | "failed" | "cancelled" | "retrying";

export interface SubagentStatus {
  task_id: string;
  subagent_name: string;
  description: string;
  status: SubagentTaskStatus;
  error: string | null;
}

export type SubagentMessageType = "info" | "steering" | "question" | "result" | "error";

export interface SubagentMessage {
  task_id: string;
  type: SubagentMessageType;
  text: string;
  timestamp: string;
}

export interface ContextUsage {
  pct: number;
  current: number;
  max: number;
}
