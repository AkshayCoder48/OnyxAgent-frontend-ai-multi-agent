"use client";

/**
 * Tool index — side-effect imports that register every tool with the
 * central registry. Imported once at app boot (e.g. from the chat
 * container's `useEffect`) so the agent runtime sees the full toolset.
 *
 * Split into its own file so `registry.ts` (which the tool files import
 * `registerTool` from) doesn't form a circular dependency with them.
 *
 * ORDER MATTERS at the tail:
 *   - "./consolidated" registers the 12 UMBRELLA tools and hides the ~55
 *     granular tools they absorb — it MUST come after every granular
 *     registration above so the umbrellas can dispatch to them.
 *
 * NOTE: MCP tools are registered per-turn by `loadMCPTools()` (called from
 * `runtime.ts` before each agent turn) — they're NOT side-effect-imported
 * here because the set of active MCP servers is user-specific. Their
 * meta-tools (mcp_search_tools / mcp_call_tool) are hidden by name under
 * the `integrations` umbrella regardless of when they register.
 */

import "./datetime";
import "./chart";
import "./ask_user";
import "./e2b_files";
import "./e2b_exec";
import "./e2b_rag";
import "./file_writer";
import "./local_chats";
import "./todos";
import "./dynamic_tools";
import "./mcp_tools";
import "./env_vars";
import "./skill_tools";
import "./mcp_management";
import "./ddg_search";
import "./web_fetch";
import "./security_audit";
import "./workflow";
import "./memory";
import "./project_memory";
import "./knowledge_base";
import "./use_browser";
import "./counterfactual";
import "./subagents";
import "./chat_inspect";
import "./workspace_analysis";
import "./image_preview";
import "./ocr";
import "./composio_tools";
import "./uploaded_files";
import "./media_generation";
import "./sandbox_schedule";
import "./background_task";
// decision (JEV systemone) — a standalone keeper, NOT absorbed by any
// umbrella: it's a first-class ESSENTIAL capability (see ESSENTIAL_TOOLS).
// Must register before ./consolidated (which only hides the granular tools
// it absorbs — decision isn't one of them, but the ordering rule stands).
import "./decision";
import "./consolidated";

export {};
