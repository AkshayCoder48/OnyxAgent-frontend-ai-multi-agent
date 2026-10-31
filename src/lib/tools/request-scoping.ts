/**
 * REQUEST-SCOPED TOOL EXPOSURE — intent-based tool routing.
 *
 * WHY (tool-reliability PRD Part B / "the model never calls tools" audit,
 * 2026-10): the registry held 64 granular tools whose wire definitions
 * weighed ~70KB (~20k tokens). Every round of every turn shipped ALL of
 * them, so on the app's typical providers (unknown model ids on community
 * gateways → the context resolver's 32K safe-fallback) the FIXED payload
 * (tools + ~24KB system prompt) alone blew the input budget, and tool-
 * selection accuracy on small/quantized models collapses far past the
 * ~10-20 definition sweet spot anyway.
 *
 * UPDATE (umbrella consolidation): the granular tools are now folded into
 * 12 action-based UMBRELLA tools (files / web / code_exec / subagents /
 * schedule / integrations / chats / memory / todos / media / workspace /
 * custom_tools) + 9 keepers — 21 model-visible built-ins total. The
 * surfaces and intent rules below speak UMBRELLA names; the granular tools
 * are hidden from listTools() entirely (src/lib/tools/consolidated.ts).
 *
 * POLICY (mirrors how the audit ranked the failure):
 *   1. DYNAMIC tools (custom tools, per-server MCP tools — anything NOT in
 *      the built-in digest) are ALWAYS included: they are few and
 *      explicitly user-configured, so hiding one is a capability regression.
 *   2. A CORE surface ships on every normal turn (context ≥128K models):
 *      the general-assistant toolset — web/research, code/exec, files,
 *      todos, memory, knowledge, media, chats, schedules, subagents and
 *      workspace ops, PLUS the CORE extras (custom-tool authoring,
 *      counterfactual, workflow).
 *   3. Small-context models (<128K, incl. the 32K safe-fallback) get the
 *      tighter ESSENTIAL surface instead — the same core minus the
 *      long-tail extras which stay reachable through intent matching.
 *   4. The CORE extras (custom-tool authoring, counterfactual, workflow,
 *      …) are intent-matched on small models and latched when already used.
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
  // NOTE: the `integrations` umbrella (which absorbed mcp_search_tools /
  // mcp_call_tool / the composio suite) is digest-listed, so it rides the
  // normal surface rules — it is ALSO here so it ships on EVERY turn
  // (both surfaces): it is HOW the agent discovers connected capabilities.
  "integrations", // MCP servers + Composio (250+ platforms)
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
  // Web / research (umbrella: web_search / image_search / video_search / web_fetch)
  "web", "use_browser",
  // Code & execution (umbrella: run_python / run_terminal / background_task)
  "code_exec",
  // Files & uploads (umbrella: all file verbs + search_documents + ocr_document)
  "files",
  // Todos & memory (umbrellas)
  "todos", "memory",
  // Knowledge
  "knowledge_base",
  // Media (umbrella: media_generation / create_chart / preview_image)
  "media",
  // Workspace ops (umbrella: analyze_workspace / security_audit / manage_env_var)
  // — analyze_workspace is the "run FIRST on every task" meta-tool.
  "workspace",
  // Structured decision engine (JEV systemone) — a first-class capability
  "decision",
  // Capability discovery (always on — see DISCOVERY_TOOLS)
  ...DISCOVERY_TOOLS,
]);

/** CORE extras — shipped on normal-context turns, intent-matched on small
 * ones. (Exported for tests + diagnostics.) */
export const CORE_EXTRA_TOOLS: ReadonlySet<string> = new Set([
  "chats", // past-conversation recall (read_chat / manage_chats)
  "schedule", // sandbox cron (schedule/list/remove)
  "subagents", // full subagent orchestration suite
  "custom_tools", // custom-tool authoring
  "counterfactual", // structured "what if" analysis
  "workflow", // multi-step pipelines
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
    // Composio external integrations.
    re: /composio|integrat(e|ion|ions)|gmail|google\s+(sheets?|drive|calendar)|slack\b|notion|linear\b|trello|asana|hubspot|salesforce|zendesk|jira|airtable|discord|telegram|whatsapp|intercom|shopify|stripe|twitter|sendgrid| calendly|zoom\b|dropbox|box\.com/i,
    tools: ["integrations"],
  },
  {
    // MCP configuration.
    re: /\bmcp\b|model context protocol|tool server/i,
    tools: ["manage_mcp", "integrations"],
  },
  {
    // Environment variables / secrets.
    re: /env(ironment)?\.?\s*var|api\s*key|secret|credential|\btokens?\b/i,
    tools: ["workspace"],
  },
  {
    // Skills.
    re: /\bskills?\b/i,
    tools: ["manage_skill"],
  },
  {
    // Security review.
    re: /security|vulnerab|pen[- ]?test|owasp|exploit|malware|encrypt(ion|ed)/i,
    tools: ["workspace"],
  },
  {
    // Workflows / pipelines.
    re: /workflow|pipeline|automat(e|ion|ed|ic)/i,
    tools: ["workflow"],
  },
  {
    // Custom tool authoring.
    re: /custom\s*tool/i,
    tools: ["custom_tools"],
  },
  {
    // Counterfactual analysis.
    re: /counterfactual|what\s*-?\s*if|alternate scenario|hypothetical/i,
    tools: ["counterfactual"],
  },
  {
    // Sub-agent orchestration (essential on small models via this rule).
    re: /sub[- ]?agent|delegate|delegation|orchestrat|specialist|worker agent|spawn/i,
    tools: ["subagents"],
  },
  {
    // Media search.
    re: /image search|images? of|photos? of|pictures? of|find (a |some )?(picture|photo|image)/i,
    tools: ["web"],
  },
  {
    re: /video search|videos? of|find (a |some )?video|youtube search/i,
    tools: ["web"],
  },
  {
    // Image understanding.
    re: /\bocr\b|handwrit|extract text|scan(ned)? (doc|image|pdf|text)|read (the |this )?(image|screenshot)/i,
    tools: ["files", "media"],
  },
  {
    // File management verbs.
    re: /\bdelete\b|\bremove\b|\brename\b|move (a |the |my )?(file|folder)|clean up|organize|tidy/i,
    tools: ["files"],
  },
  {
    // Sending/sharing files.
    re: /\bsend\b|\bshare\b|\bexport\b/i,
    tools: ["files"],
  },
  {
    // Chat management.
    re: /list (my )?chats|other (chat|conversation)s?|new chat|open (a |the )?chat|conversations? list/i,
    tools: ["chats"],
  },
  {
    // Scheduled tasks (sandbox cron).
    re: /\bschedul(e|ed|ing)\b|\bcron\b|recurring|run (it |this )?(later|tonight|overnight|every)|(nightly|hourly|daily|weekly|monthly)\b|every (day|hour|minute|week|morning|evening|night)|at midnight|in the (morning|evening)|background job/i,
    tools: ["schedule"],
  },
  {
    // Decision/judgment requests — surface the decision engine.
    re: /decide|decision|should we|is this good|rate this|which option|worth it|verdict/i,
    tools: ["decision"],
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
