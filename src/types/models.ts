// ============================================================================
// Domain model types — re-exported wire shapes used by the settings UI,
// services, and hooks. Some types here are aliases of DB row types so the
// UI components can import them from `@/types` (canonical entry point)
// without depending on `@/lib/db` (which would pull Dexie into client bundles
// that don't need it).
// ============================================================================

import type { SkillRow } from "@/lib/db";

/** Generic ID type — string alias used by hooks for entity IDs. */
export type ID = string;

/** AI model transport — matches `AIProviderRow.model_type`. */
export type AIModelType = "chat" | "responses";

/** MCP transport — matches `MCPServerRow.transport`. */
export type MCPTransport = "stdio" | "sse" | "streamable_http";

/** Custom tool implementation kind — matches `CustomToolRow.impl_kind`. */
export type CustomToolImpl = "http_webhook" | "python_snippet";

/** Tool execution result envelope returned by every tool handler. */
export interface ToolResult {
  /** Whether the tool call succeeded. */
  success: boolean;
  /** The structured result payload (or null on failure). */
  output: unknown;
  /** Error message when `success === false`. */
  error?: string;
  /** Optional metadata (e.g. elapsed time, tokens used). */
  metadata?: Record<string, unknown>;
}

/** AI provider — UI-friendly alias of `AIProviderRow` from `@/lib/db`.
 *  Re-declared here so settings components don't need to depend on Dexie. */
export interface AIProvider {
  id: string;
  user_id: string;
  name: string;
  base_url: string;
  /** Encrypted (vault) API key. */
  api_key_encrypted: string;
  models: string[];
  model_type: AIModelType;
  tools_enabled: boolean;
  /** When true, use the base URL as-is (no /chat/completions suffix). */
  no_prefix?: boolean;
  /** When true, sends `chat_template_kwargs: {"enable_thinking": true}`. */
  thinking_enabled?: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** MCP server — UI-friendly alias of `MCPServerRow`. */
export interface MCPServer {
  id: string;
  user_id: string;
  name: string;
  transport: MCPTransport;
  command?: string | null;
  args: string[];
  env: Record<string, string>;
  url?: string | null;
  headers: Record<string, string>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** Custom tool — UI-friendly alias of `CustomToolRow`. */
export interface CustomTool {
  id: string;
  user_id: string;
  name: string;
  description: string;
  parameters_schema: Record<string, unknown>;
  impl_kind: CustomToolImpl;
  http_url?: string | null;
  http_headers: Record<string, string>;
  python_source?: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** User slash command — UI-friendly alias of `UserSlashCommandRow`.
 *  `is_builtin` is set in code (catalog commands) vs. persisted (custom). */
export interface UserSlashCommand {
  id: string;
  /** Optional — backendless API client doesn't always include user_id. */
  user_id?: string;
  name: string;
  /** null for built-in overrides; non-null for user-defined custom commands. */
  prompt: string | null;
  is_enabled: boolean;
  /** True for built-in (catalog) commands; false for user-defined. */
  is_builtin?: boolean;
  created_at: string;
  updated_at: string | null;
}

/** Skill — extends `SkillRow` with display metadata (version, source). */
export interface Skill extends SkillRow {
  /** Optional version string (read from SKILL.md frontmatter). */
  version?: string | null;
  /** Where the skill came from — "catalog" (marketplace) or "local" (upload). */
  source?: "catalog" | "local" | string;
}

/** User settings — extends the persisted settings service shape with
 *  per-turn defaults (`default_model`, `default_temperature`, etc.) that
 *  the agent runtime reads to override the model config. */
export interface UserSettings {
  system_prompt: string | null;
  system_prompt_enabled: boolean;
  /** Whether an E2B sandbox API key is stored (encrypted). */
  e2b_api_key_present: boolean;
  /** Whether an E2B sandbox API key is stored (encrypted). */
  sandbox_api_key_present: boolean;
  tavily_api_key_present: boolean;
  embeddings_api_key_present: boolean;
  /** Whether a SkillsMP marketplace API key is stored (encrypted). */
  skillsmp_api_key_present: boolean;
  /** Whether a LangSearch web-search API key is stored (encrypted). */
  langsearch_api_key_present: boolean;
  /** Env vars — read shape is the metadata array; the update patch accepts
   *  a `Record<string, string>` (the service converts to the DB shape). */
  env_vars:
    | Array<{ name: string; is_secret: boolean; value_present: boolean }>
    | Record<string, string>;
  /** When true, the agent runtime skips HITL approval for tools flagged
   *  `requires_approval` (e.g. `run_terminal`). Stored under `extra`. */
  auto_approve_tools: boolean;
  /** "auto" | "local" | "hopx" — sandbox selection strategy. */
  file_system_mode?: "auto" | "local" | "hopx";
  /** Sandbox allocation strategy: "shared" or "separate". */
  sandbox_mode?: "shared" | "separate";
  /** AI framework preset — changes the system prompt to match the framework. */
  ai_framework?: string;
  /** Default model name (e.g. "gpt-4o-mini") — stored under `extra`. */
  default_model?: string | null;
  /** Default sampling temperature — stored under `extra`. */
  default_temperature?: number | null;
  /** Whether extended-thinking is enabled by default — stored under `extra`. */
  default_thinking_enabled?: boolean;
  /** Default thinking effort ("low" | "medium" | "high") — stored under `extra`. */
  default_thinking_effort?: "low" | "medium" | "high" | string | null;
}

/** Shared conversation payload — wire shape for `?share=` URL fragments.
 *  Compressed with lz-string `compressToEncodedURIComponent`. */
export interface SharedConversationPayload {
  /** Schema version (currently 1). */
  v: 1;
  /** Conversation title. */
  title: string;
  /** ISO timestamp when the share was created. */
  shared_at: string;
  /** Ordered list of messages in the shared conversation. */
  messages: Array<{
    role: string;
    content: string;
    model_name?: string | null;
    created_at: string;
  }>;
}
