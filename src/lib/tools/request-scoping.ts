/**
 * REQUEST-SCOPED TOOL EXPOSURE — intent-based tool routing.
 *
 * WHY (tool-reliability PRD Part B / "the model never calls tools" audit,
 * 2026-10): the registry holds 64 built-in tools whose wire definitions
 * weigh ~70KB (~20k tokens). Every round of every turn shipped ALL of them,
 * so on the app's typical providers (unknown model ids on community
 * gateways → the context resolver's 32K safe-fallback) the FIXED payload
 * (tools + ~24KB system prompt) alone blew the input budget, and tool-
 * selection accuracy on small/quantized models collapses far past the
 * ~10-20 definition sweet spot anyway.
 *
 * POLICY (mirrors how the audit ranked the failure):
 *   1. DYNAMIC tools (custom tools, MCP meta-tools — anything NOT in the
 *      built-in digest) are ALWAYS included: they are few and explicitly
 *      user-configured, so hiding one is a capability regression.
 *   2. A CORE surface ships on every normal turn (context ≥128K models):
 *      the general-assistant toolset — web/research, code/exec, file
 *      authoring, todos, workspace, chats, uploads, memory, media,
 *      subagents and scheduled-task creation.
 *   3. Small-context models (<128K, incl. the 32K safe-fallback) get the
 *      tighter ESSENTIAL surface instead — the same core minus the
 *      long-tail extras (image/video search, file-management verbs,
 *      preview/ocr, chat management, the full subagent suite) which stay
 *      reachable through intent matching.
 *   4. SITUATIONAL tools (composio suite, scheduled-task MANAGEMENT,
 *      env vars, skills, MCP config, security audit, workflow,
 *      counterfactual, custom-tool management, subagent config) ride in
 *      ONLY when the user's intent mentions them — keyword rules below —
 *      or when they were already used earlier in the conversation.
 *   5. Tools used earlier in THIS turn (the runtime latches live tool
 *      calls into usedToolNames) are never scoped out mid-turn.
 *
 * The registry remains the single source of truth: this filter only shapes
 * WHICH definitions ride a given request. The system prompt's tool list is
 * built from the SAME scoped snapshot by the runtime, so the prompt and
 * the tools array can never disagree.
 */

import type { ToolDefinition } from "./registry";
import { ONYX_MD_DIGEST_TOOLS } from "@/lib/agent/onyx-md-digest";

// ---------------------------------------------------------------------------
// Scope input.
// ---------------------------------------------------------------------------

export interface RequestToolScope {
  /** The current turn's user message (the intent signal). Optional — when
   * absent the filter degrades to the CORE surface (no intent matching). */
  lastUserText?: string | null;
  /** Tool names already used earlier in this conversation/turn. Optional. */
  usedToolNames?: Iterable<string>;
  /** Resolved context window (tokens) of the serving model. Models below
   * SMALL_MODEL_WINDOW get the tighter ESSENTIAL surface. Optional — absent
   * means "normal" (CORE). */
  modelContextWindow?: number | null;
  /** PERMISSION FILTER (Task 2-d / PRD §8.2): tool names whose effective
   *  permission is DENIED for this conversation (global policy + project
   *  rules). They are dropped from the scope ENTIRELY — denied tools must
   *  never execute, so they are not offered to the model either. Optional —
   *  absent = no permission filtering (the enforcement gate still applies
   *  at execution time for every dispatch site). */
  deniedTools?: ReadonlySet<string>;
}

/** Below this resolved window the request carries ESSENTIAL (+ intent
 * matches) instead of the full CORE surface. 128K comfortably absorbs the
 * ~20k-token full toolset; 32K-64K models cannot. */
const SMALL_MODEL_WINDOW = 128_000;

// ---------------------------------------------------------------------------
// Tool surfaces.
// ---------------------------------------------------------------------------

/** DISCOVERY surface (user report 2026-10-21: "the AI never uses skills /
 * MCPs / Composio / connectors unless told") — the capability-discovery
 * meta-tools ride on EVERY turn (both surfaces). They are tiny (~7
 * definitions) and they are HOW the agent learns what integrations exist:
 * without them in the request the model cannot even look for connected
 * capabilities, which is exactly "needs to be told to use them". The
 * search-first pattern keeps the payload bounded no matter how many
 * servers/actions are actually connected. */
export const DISCOVERY_TOOLS: ReadonlySet<string> = new Set([
  // NOTE: mcp_search_tools / mcp_call_tool are intentionally NOT here —
  // they are not digest-listed built-ins, so the filter's rule 1 (anything
  // outside the built-in digest always ships) already guarantees they ride
  // on EVERY request regardless of surface or intent.
  "composio_search_tools", // discover connected Composio actions
  "composio_execute_tool", // execute a discovered Composio action
  "composio_connect_platform", // hand the user an OAuth link
  "manage_skill", // list/read installed + library skills
  "manage_mcp", // MCP server configuration (list/market)
]);

/** The every-turn surface — what a small-context model always
 * sees: answer, research, browse, code, author files, todos, workspace,
 * uploads, memory, media + the capability-DISCOVERY meta-tools.
 * (Exported for tests + diagnostics.) */
export const ESSENTIAL_TOOLS: ReadonlySet<string> = new Set([
  // Conversation & time
  "ask_user", "current_datetime",
  // Web / research
  "web_search", "web_fetch", "use_browser",
  // Code & execution
  "run_python", "run_terminal", "create_chart",
  // File authoring (the incremental-writing policy surface)
  "read_file", "create_file", "write_file", "edit_file", "list_folder",
  "verify_path", "create_file_chunk", "read_file_section", "search_documents",
  // Todos & workspace
  "manage_todo", "show_todo", "analyze_workspace",
  // Chats & uploads
  "read_chat", "list_uploaded_files", "read_uploaded_file",
  // Memory & knowledge
  "manage_memory", "knowledge_base",
  // Media generation (Pollinations)
  "media_generation",
  // Capability discovery (always on — see DISCOVERY_TOOLS)
  ...DISCOVERY_TOOLS,
]);

/** CORE extras — shipped on normal-context turns, intent-matched on small
 * ones (20 tools). (Exported for tests + diagnostics.) */
export const CORE_EXTRA_TOOLS: ReadonlySet<string> = new Set([
  "image_search", "video_search",
  "delete_file", "delete_folder", "create_folder", "move_file",
  "send_file", "send_folder",
  "preview_image", "ocr_document",
  "manage_chats",
  "spawn_subagent", "list_subagents", "query_subagent", "steer_subagent",
  "complete_subagent", "cancel_subagent", "manage_subagent_chat",
  "create_scheduled_task", "list_scheduled_tasks",
]);

/** The full CORE surface (ESSENTIAL + extras). (Exported for tests +
 * diagnostics.) */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  ...ESSENTIAL_TOOLS,
  ...CORE_EXTRA_TOOLS,
]);

/**
 * Intent rules — situational (and small-model-excluded) tools that ride in
 * when the user's message matches. Patterns are deliberately GENEROUS:
 * a false positive only costs payload bytes, while a false negative is a
 * missing capability. Everything not named here that isn't CORE is
 * situational (never shipped without intent/history/dynamic).
 */
const INTENT_RULES: ReadonlyArray<{ re: RegExp; tools: readonly string[] }> = [
  {
    // Scheduled tasks / automation (incl. the management suite).
    re: /schedul|cron\b|recurring|every\s+(day|week|month|morning|night|hour|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|weekly|monthly|hourly|tomorrow|remind|\btask\b|automation/i,
    tools: [
      "create_scheduled_task", "list_scheduled_tasks", "update_scheduled_task",
      "delete_scheduled_task", "pause_scheduled_task", "resume_scheduled_task",
      "run_scheduled_task_now", "get_scheduled_task_history",
    ],
  },
  {
    // Composio external integrations.
    re: /composio|integrat(e|ion|ions)|gmail|google\s+(sheets?|drive|calendar)|slack\b|notion|linear\b|trello|asana|hubspot|salesforce|zendesk|jira|airtable|discord|telegram|whatsapp|intercom|shopify|stripe|twitter|sendgrid| calendly|zoom\b|dropbox|box\.com/i,
    tools: ["composio_search_tools", "composio_connect_platform", "composio_execute_tool"],
  },
  {
    // MCP configuration.
    re: /\bmcp\b|model context protocol|tool server/i,
    tools: ["manage_mcp"],
  },
  {
    // Environment variables / secrets.
    re: /env(ironment)?\.?\s*var|api\s*key|secret|credential|\btokens?\b/i,
    tools: ["manage_env_var"],
  },
  {
    // Skills.
    re: /\bskills?\b/i,
    tools: ["manage_skill"],
  },
  {
    // Security review.
    re: /security|vulnerab|pen[- ]?test|owasp|exploit|malware|encrypt(ion|ed)/i,
    tools: ["security_audit"],
  },
  {
    // Workflows / pipelines.
    re: /workflow|pipeline|automat(e|ion|ed|ic)/i,
    tools: ["workflow"],
  },
  {
    // Custom tool authoring.
    re: /custom\s*tool/i,
    tools: ["manage_custom_tool", "create_custom_tool"],
  },
  {
    // Counterfactual analysis.
    re: /counterfactual|what\s*-?\s*if|alternate scenario|hypothetical/i,
    tools: ["counterfactual"],
  },
  {
    // Sub-agent orchestration (essential on small models via this rule).
    re: /sub[- ]?agent|delegate|delegation|orchestrat|specialist|worker agent|spawn/i,
    tools: [
      "spawn_subagent", "list_subagents", "query_subagent", "steer_subagent",
      "complete_subagent", "cancel_subagent", "manage_subagent_chat",
      "set_subagent_config",
    ],
  },
  {
    // Media search.
    re: /image search|images? of|photos? of|pictures? of|find (a |some )?(picture|photo|image)/i,
    tools: ["image_search"],
  },
  {
    re: /video search|videos? of|find (a |some )?video|youtube search/i,
    tools: ["video_search"],
  },
  {
    // Image understanding.
    re: /\bocr\b|handwrit|extract text|scan(ned)? (doc|image|pdf|text)|read (the |this )?(image|screenshot)/i,
    tools: ["ocr_document", "preview_image"],
  },
  {
    // File management verbs.
    re: /\bdelete\b|\bremove\b|\brename\b|move (a |the |my )?(file|folder)|clean up|organize|tidy/i,
    tools: ["delete_file", "delete_folder", "move_file", "create_folder"],
  },
  {
    // Sending/sharing files.
    re: /\bsend\b|\bshare\b|\bexport\b/i,
    tools: ["send_file", "send_folder"],
  },
  {
    // Chat management.
    re: /list (my )?chats|other (chat|conversation)s?|new chat|open (a |the )?chat|conversations? list/i,
    tools: ["manage_chats"],
  },
];

// ---------------------------------------------------------------------------
// Filter.
// ---------------------------------------------------------------------------

/** Built-in names — anything registered OUTSIDE this set is dynamic
 * (custom tool / MCP meta-tool) and always ships. */
const BUILTIN_NAMES: ReadonlySet<string> = new Set(ONYX_MD_DIGEST_TOOLS);

/** Split a tool name into significant words (≥4 chars, snake_case aware). */
function toolNameWords(name: string): string[] {
  return name.split("_").filter((w) => w.length >= 4);
}

export function filterToolsForRequest(
  tools: ToolDefinition[],
  scope?: RequestToolScope,
): ToolDefinition[] {
  if (!scope) return tools; // No scope → pass-through (back-compat call sites).

  const lastUserText = typeof scope.lastUserText === "string" ? scope.lastUserText : "";
  const smallModel =
    typeof scope.modelContextWindow === "number" &&
    scope.modelContextWindow > 0 &&
    scope.modelContextWindow < SMALL_MODEL_WINDOW;
  const base = smallModel ? ESSENTIAL_TOOLS : CORE_TOOLS;

  const latched = new Set<string>();
  if (scope.usedToolNames) {
    for (const n of scope.usedToolNames) {
      if (typeof n === "string" && n) latched.add(n);
    }
  }

  // Intent-matched names from the keyword rules.
  const intentMatched = new Set<string>();
  if (lastUserText.trim()) {
    for (const rule of INTENT_RULES) {
      if (rule.re.test(lastUserText)) {
        for (const n of rule.tools) intentMatched.add(n);
      }
    }
  }

  // Generic net: a tool whose name-words appear verbatim in the user text.
  const textLower = ` ${lastUserText.toLowerCase().replace(/[^a-z0-9_]+/g, " ")} `;
  const nameWordMatched = (name: string): boolean => {
    if (!lastUserText.trim()) return false;
    for (const w of toolNameWords(name)) {
      if (textLower.includes(` ${w} `) || textLower.includes(` ${w}s `)) return true;
    }
    return false;
  };

  return tools.filter((t) => {
    if (!t) return false;
    // 0. PERMISSION FILTER (Task 2-d): denied tools are never offered —
    //    takes precedence over every other rule (a denied dynamic tool is
    //    still denied).
    if (scope.deniedTools?.has(t.name)) return false;
    // 1. Dynamic tools (custom/MCP) always ship.
    if (!BUILTIN_NAMES.has(t.name)) return true;
    // 2. History/turn latch — never scope out a tool already in use.
    if (latched.has(t.name)) return true;
    // 3. Base surface.
    if (base.has(t.name)) return true;
    // 4. Intent matches (keyword rules or name-word hit).
    if (intentMatched.has(t.name)) return true;
    return nameWordMatched(t.name);
  });
}

/** Collect the tool names used in a conversation's message history —
 * accepts the Dexie message rows' `tool_calls` arrays. */
export function usedToolNamesFromHistory(
  messages: Array<{ tool_calls?: Array<{ tool_name?: string; name?: string }> | null }>,
): Set<string> {
  const names = new Set<string>();
  for (const m of messages) {
    if (!m.tool_calls || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      const n = tc?.tool_name ?? tc?.name;
      if (typeof n === "string" && n) names.add(n);
    }
  }
  return names;
}

/** Render the compact prior-turn tool-use annotation (H4): a one-line
 * `[Used tools: a, b]` suffix appended to prior ASSISTANT messages so the
 * model can see its own successful tool usage across turns (the wire replay
 * otherwise drops tool_calls entirely for pair-safety). Pure — no trailing
 * newline when names is empty. */
export function priorToolUseAnnotation(
  names: ReadonlyArray<string | undefined | null>,
): string {
  const unique = Array.from(new Set(names.filter((n): n is string => typeof n === "string" && !!n)));
  if (unique.length === 0) return "";
  return `[Used tools: ${unique.join(", ")}]`;
}
