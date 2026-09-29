export type MessageRole = "user" | "assistant";

export type ToolIconKind = "globe" | "wrench" | "search";

export type ToolStatus = "completed" | "running";

export type RouteName = "fast" | "balanced" | "deep";

export type ModelPreferenceId = "auto" | RouteName;

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
