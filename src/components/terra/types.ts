export type MessageRole = "user" | "assistant";

export type ToolIconKind = "globe" | "wrench" | "search";

export type ToolStatus = "completed" | "running";

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

export interface Message {
  id: string;
  role: MessageRole;
  /** Plain text (user turns); assistant turns use structured parts */
  text: string;
  time: string;
  parts?: MessagePart[];
  isError?: boolean;
  feedback?: "up" | "down" | null;
}

export type DateGroup = "today" | "yesterday";

export interface Conversation {
  id: string;
  title: string;
  group: DateGroup;
  /** Label for the thread's opening date separator (e.g. "Today · 2:14 PM") */
  separator: string;
  messages: Message[];
}

export interface ModelOption {
  id: string;
  label: string;
  description: string;
}

export interface ChatHistoryMessage {
  role: MessageRole;
  content: string;
}
