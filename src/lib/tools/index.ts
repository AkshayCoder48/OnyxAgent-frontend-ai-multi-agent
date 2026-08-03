"use client";

/**
 * Tool index — side-effect imports that register every tool with the
 * central registry. Imported once at app boot (e.g. from the chat
 * container's `useEffect`) so the agent runtime sees the full toolset.
 *
 * Split into its own file so `registry.ts` (which the tool files import
 * `registerTool` from) doesn't form a circular dependency with them.
 *
 * NOTE: MCP tools are registered per-turn by `loadMCPTools()` (called from
 * `runtime.ts` before each agent turn) — they're NOT side-effect-imported
 * here because the set of active MCP servers is user-specific.
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
import "./counterfactual";
import "./subagents";
import "./workspace_analysis";
import "./image_preview";

export {};
