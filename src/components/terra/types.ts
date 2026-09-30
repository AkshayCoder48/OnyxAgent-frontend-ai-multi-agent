export type MessageRole = "user" | "assistant";

export type ToolIconKind =
  | "globe"
  | "wrench"
  | "search"
  | "database"
  | "monitor"
  | "folder"
  | "sparkles";

export type ToolStatus = "completed" | "running";

export type RouteName = "fast" | "balanced" | "deep";

export type ModelPreferenceId = "auto" | RouteName;

/** Which app experience is active — the Terra agent or OnyxCode. */
export type AppMode = "agent" | "code";

/** OnyxCode's primary tabs. */
export type CodeTab = "chat" | "database" | "preview";

/** Rich card payload for a code-mode tool result. */
export interface ToolResultData {
  kind: "create_app" | "preview" | "preview_list" | "web_session" | "database" | "files";
  payload: Record<string, unknown>;
}

export interface ToolCallData {
  /** Raw tool identifier, rendered in mono (e.g. web_search) */
  name: string;
  icon: ToolIconKind;
  /** Human summary shown next to the name */
  subtitle: string;
  status: ToolStatus;
  /** JSON-ish argument text shown when expanded */
  args: string;
  /** Result preview shown when expanded */
  result: string;
  /** Server tool id — powers skip-wait + live result updates. */
  toolId?: string;
  /** Skip-wait: tool is running detached in the background. */
  backgrounded?: boolean;
  /** The tool finished with an error. */
  error?: boolean;
  /** Rich card payload (create_app / preview / web_session / …). */
  resultData?: ToolResultData;
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "code"; filename: string; language: string; code: string }
  | { type: "tool"; tool: ToolCallData };

/** Which execution profile the model router chose for a reply. */
export interface RouteInfo {
  route: RouteName;
  label: string;
  reason: string;
  /** Upstream model that served the reply */
  model?: string;
}

export interface Message {
  id: string;
  role: MessageRole;
  /** Plain text (user turns); assistant turns use structured parts */
  text: string;
  time: string;
  parts?: MessagePart[];
  isError?: boolean;
  feedback?: "up" | "down" | null;
  /** Private reasoning shown in the collapsible thinking block */
  reasoning?: string;
  /** Router decision for assistant replies */
  route?: RouteInfo;
  /** Live reply still streaming in */
  streaming?: boolean;
  /** Server job id — lets the client re-attach to a background turn after
   *  the tab was backgrounded, frozen, discarded or reloaded. */
  turnId?: string;
  /** Transient status note ("recovering your reply…") while streaming */
  notice?: string;
  /** Persistent inline warning (e.g. recovery failed, reply partial) */
  warn?: string;
  /** Milliseconds the thinking phase was live */
  thinkMs?: number;
}

export type DateGroup = "today" | "yesterday" | "earlier";

export interface Conversation {
  id: string;
  title: string;
  group: DateGroup;
  /** Label for the thread's opening date separator (e.g. "Today · 2:14 PM") */
  separator: string;
  messages: Message[];
  /** Epoch ms — lets groups be recomputed correctly on later loads */
  createdAt: number;
  /** Last cloud version acknowledged for this row */
  version: number;
  /** OnyxCode conversations live in their own list + workspace. */
  mode?: AppMode;
}

export interface ModelOption {
  id: ModelPreferenceId;
  label: string;
  description: string;
}

export interface ChatHistoryMessage {
  role: MessageRole;
  content: string;
}

export type SyncStatus = "booting" | "synced" | "syncing" | "offline" | "error";

export interface RouteStats {
  fast: number;
  balanced: number;
  deep: number;
}

/* ------------------------------------------------------------------ */
/* OnyxCode panels (Database / Preview tabs)                           */
/* ------------------------------------------------------------------ */

export interface CodeRecordView {
  id: string;
  key: string;
  kind: string;
  /** JSON-encoded payload */
  data: string;
  createdAt: number;
  updatedAt: number;
}

export interface PreviewSessionView {
  sessionId: string;
  name: string;
  /** Path + gateway query, relative to the app origin. */
  url: string;
  status: string;
  entry: string;
  createdAt: number;
}

export interface WorkspaceFileView {
  path: string;
  bytes: number;
}
