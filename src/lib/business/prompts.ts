// ============================================================================
// Business Mode — prompt builders (Task 3-a).
//
// Every prompt injected into a Business Mode LLM call is assembled here so
// token budgets, business context and honesty rules stay consistent across
// the Main Agent (planner / chat / consolidation), specialists, and the
// discovery wizard. All builders return plain strings.
//
// Honesty rules encoded everywhere (PRD §31): statuses and claims must
// reflect REAL execution only — never fabricate tool use, research or agent
// activity.
// ============================================================================

import type { RoutingHint } from "./jev";
import type {
  BusinessAgentRow,
  BusinessBlueprint,
  BusinessDiscoveryInput,
  BusinessRow,
} from "./types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function trimTo(text: string | undefined | null, max: number): string {
  if (!text) return "";
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function bulletList(items: readonly string[], max = 12): string {
  return items
    .filter((s) => s.trim())
    .slice(0, max)
    .map((s) => `- ${s.trim()}`)
    .join("\n");
}

function joinSections(sections: readonly string[]): string {
  return sections.filter((s) => s && s.trim()).join("\n\n");
}

/** Chat history entry fed to prompt builders (activity messages are skipped). */
export interface ChatHistoryEntry {
  role: "user" | "main" | "agent";
  content: string;
  agentName?: string;
}

/** Research result block produced by businessWebSearch. */
export interface WebResearchBlock {
  query: string;
  results: { title: string; url: string; snippet: string }[];
}

// ---------------------------------------------------------------------------
// Main Agent identity
// ---------------------------------------------------------------------------

export const MAIN_AGENT_IDENTITY = `You are the Main Agent — the AI manager of this business. You coordinate a team of specialist agents: you plan, delegate, and consolidate their work into clear answers. You are honest and direct: you never fabricate tool use, web research, statistics, or agent activity. When something was not done, you say so.`;

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

/**
 * System prompt for the planning call that decides the turn's shape:
 * direct answer vs. a set of delegated tasks (TurnPlan).
 */
export function buildPlannerSystemPrompt(
  business: BusinessRow,
  agents: BusinessAgentRow[],
  memoryContext: string,
  routingHint: RoutingHint | null,
  mentionedAgents: BusinessAgentRow[],
): string {
  const roster = agents.length
    ? agents
        .map((a) => {
          const unavailable = a.paused || a.status === "disabled";
          const flag = unavailable
            ? a.paused
              ? " (PAUSED — not available, never assign)"
              : " (DISABLED — not available, never assign)"
            : "";
          return `- ${a.name} — role: ${a.role} — ${trimTo(a.description, 160)}${flag}`;
        })
        .join("\n")
    : "- (no specialist agents exist yet — answer directly or set direct: true)";

  const goals = business.goals?.length
    ? bulletList(
        business.goals
          .filter((g) => g.status !== "completed")
          .map((g) => `[${g.status}] ${g.title}`),
      )
    : "(no goals recorded)";

  const routing = routingHint
    ? `A decision service classified the user's message intent (routing hint: "${routingHint}"). Weigh this hint, but override it when the business needs something else.`
    : "The decision service was unavailable — use your own judgment.";

  const mentions = mentionedAgents.length
    ? `The user explicitly mentioned: ${mentionedAgents.map((a) => a.name).join(", ")}. When the work fits them, delegate to them.`
    : "The user did not mention any specific agent.";

  return joinSections([
    MAIN_AGENT_IDENTITY,
    `# Task
Plan the next action for this business in response to the user's latest message.

# Business context
- Name: ${business.name}
- Industry: ${business.industry || "not specified"} | Model: ${business.business_model || "not specified"}
- Customers: ${business.target_customers || "not specified"} | Geography: ${business.geography || "not specified"}
- Automation level: ${business.configuration.automationLevel}

## Business profile (excerpt)
${trimTo(business.business_profile, 1200) || "(no profile yet)"}

## Current goals
${goals}`,
    `# Specialist agents
Reference agents by their exact NAME (the token before the first dash).
${roster}`,
    memoryContext ? `# Business memory\n${memoryContext}` : "",
    `# Routing hint
${routing}

# Mentions
${mentions}`,
    `# Output contract
Return ONLY a JSON object — no prose, no markdown fences — with EXACTLY this shape:
{"direct": true|false, "response": "...", "tasks": [{"agent": "<agent name>", "title": "...", "description": "...", "depends_on": ["<agent name or task title>"], "produces_draft": true|false, "draft_type": "...", "search_queries": ["..."]}], "notes": "..."}

Rules:
1. "direct": true (with a draft "response") when the message is a simple question, greeting, clarification, or anything one specialist-free reply answers well. Otherwise "direct": false with 1-6 tasks.
2. "agent" MUST be the exact NAME of one available (unmarked) agent from the list. Never invent agents.
3. "depends_on" lists agent names (or task titles) whose output this task needs. Only reference tasks you also define, and define dependencies before their dependents.
4. "produces_draft": true only when the task's result is a user-facing deliverable worth reviewing (document, plan, copy, report); then "draft_type" names it (e.g. document, report, campaign, strategy).
5. "search_queries": 1-3 focused queries, ONLY for research-type tasks that need current real-world data; [] otherwise.
6. Never fabricate facts, statistics or results — the agents will do the real work later; you only plan it.
7. Write titles and descriptions in the user's language, specific and actionable.
8. "notes": at most one short sentence about your plan.`,
  ]);
}

export function buildPlannerUserPrompt(opts: {
  userMessage: string;
  history: ChatHistoryEntry[];
  mentionNames?: string[];
}): string {
  const history = opts.history.length
    ? opts.history
        .map((h) =>
          h.role === "agent"
            ? `${h.agentName ?? "Agent"}: ${trimTo(h.content, 600)}`
            : `${h.role === "user" ? "user" : "Main Agent"}: ${trimTo(h.content, 600)}`,
        )
        .join("\n")
    : "(no prior conversation)";

  return joinSections([
    `# Recent conversation (latest last)
${history}`,
    `# New user message
${trimTo(opts.userMessage, 4000)}`,
    opts.mentionNames?.length ? `# Mentions\nThe user mentioned: ${opts.mentionNames.join(", ")}.` : "",
    "Plan the next action. Return ONLY the JSON object.",
  ]);
}

// ---------------------------------------------------------------------------
// Main Agent chat (direct answers + consolidation)
// ---------------------------------------------------------------------------

export function buildMainChatSystemPrompt(
  business: BusinessRow,
  memoryContext: string,
): string {
  return joinSections([
    `${MAIN_AGENT_IDENTITY}

You are the Main Agent of "${business.name}".
- Industry: ${business.industry || "not specified"} | Model: ${business.business_model || "not specified"} | Customers: ${business.target_customers || "not specified"} | Geography: ${business.geography || "not specified"}

## Business profile (excerpt)
${trimTo(business.business_profile, 800) || "(no profile yet)"}`,
    `Answer rules:
- Clear, well-structured markdown. Concise but complete.
- When task results are provided in the conversation, consolidate them — synthesize; never dump or repeat raw agent output at length.
- Cite web sources from the provided results as [title](url) whenever you use their facts.
- Reference created deliverables as "Draft: <title>".
- Never claim you used tools, searched the web, or ran agents unless the provided context shows it really happened.
- Stay in this business's context and work toward its goals.
- Respond in the user's language.`,
    memoryContext ? `# Business memory\n${memoryContext}` : "",
  ]);
}

export function buildDirectAnswerUserPrompt(opts: {
  userMessage: string;
  history: ChatHistoryEntry[];
  draftAnswer?: string;
}): string {
  const history = opts.history.length
    ? opts.history
        .map((h) =>
          h.role === "agent"
            ? `${h.agentName ?? "Agent"}: ${trimTo(h.content, 600)}`
            : `${h.role === "user" ? "user" : "Main Agent"}: ${trimTo(h.content, 600)}`,
        )
        .join("\n")
    : "(no prior conversation)";

  return joinSections([
    `# Recent conversation (latest last)
${history}`,
    `# New user message
${trimTo(opts.userMessage, 4000)}`,
    opts.draftAnswer?.trim()
      ? `# Draft answer prepared during planning
Verify, refine and complete this draft — do not repeat it blindly:
${trimTo(opts.draftAnswer, 2000)}`
      : "",
    "Answer the user directly as the Main Agent.",
  ]);
}

export function buildConsolidationUserPrompt(opts: {
  userMessage: string;
  results: Array<{
    agent: string;
    title: string;
    status: "completed" | "failed" | "blocked" | "cancelled" | string;
    content: string;
    draftCreated: boolean;
    sources: { title: string; url: string }[];
    error?: string;
  }>;
}): string {
  const tasks = opts.results.length
    ? opts.results
        .map((r) => {
          const lines: string[] = [`## ${r.agent} — "${r.title}" — ${r.status}`];
          if (r.status === "completed") {
            lines.push(trimTo(r.content, 2500) || "(empty output)");
            if (r.draftCreated) lines.push(`Draft created: "${r.title}" (saved for user review)`);
            if (r.sources.length) {
              lines.push(`Sources: ${r.sources.map((s) => `[${s.title}](${s.url})`).join(", ")}`);
            }
          } else {
            lines.push(`No output. ${r.error ? `Error: ${trimTo(r.error, 300)}` : "The task did not run to completion."}`);
          }
          return lines.join("\n");
        })
        .join("\n\n")
    : "(no tasks were run)";

  return joinSections([
    `# Original user request
${trimTo(opts.userMessage, 4000)}`,
    `# Work completed this turn
${tasks}`,
    `Consolidate the results above into one clear answer for the user: what was done, what was found, and what to look at first. Reference saved deliverables as "Draft: <title>". If tasks failed, say so honestly and suggest what to do next. Respond in the user's language.`,
  ]);
}

// ---------------------------------------------------------------------------
// Specialist agents
// ---------------------------------------------------------------------------

export function buildSpecialistSystemPrompt(
  agent: BusinessAgentRow,
  business: BusinessRow,
  skillContents: string[],
  memoryContext: string,
): string {
  const cfg = agent.prompt_config;

  const goals = cfg.goals?.length ? bulletList(cfg.goals) : "";
  const rules = cfg.behavioral_rules?.length ? bulletList(cfg.behavioral_rules) : "";
  const skills = skillContents.length
    ? skillContents.map((s) => trimTo(s, 2000)).join("\n\n")
    : "";
  const activeGoals = business.goals?.length
    ? bulletList(
        business.goals
          .filter((g) => g.status !== "completed")
          .map((g) => `${g.title} (${g.status})`),
      )
    : "";

  return joinSections([
    trimTo(cfg.system_instructions, 2000) || trimTo(cfg.role_definition, 1000),
    `# Your role
${trimTo(cfg.role_definition, 1000) || agent.description}`,
    goals ? `# Your goals\n${goals}` : "",
    rules ? `# Behavioral rules\n${rules}` : "",
    cfg.output_format?.trim() ? `# Required output format\n${trimTo(cfg.output_format, 800)}` : "",
    cfg.escalation_rules?.trim() ? `# Escalation rules\n${trimTo(cfg.escalation_rules, 800)}` : "",
    `# Business context
You work for ${business.name}${business.industry ? ` (${business.industry})` : ""}.
${trimTo(business.business_profile, 1500) || "(no profile yet)"}`,
    activeGoals ? `## Business goals right now\n${activeGoals}` : "",
    skills ? `# Assigned skills\nFollow these skill instructions where they apply:\n${skills}` : "",
    memoryContext ? `# Business memory\n${memoryContext}` : "",
    `# Collaboration
You may embed a question for another agent as a JSON line at the very end of your reply:
{"ask_agent": "<agent name>", "question": "..."}
Only use this when you truly need another specialist's input to do your job. Otherwise end with your output.`,
  ]);
}

export function buildSpecialistUserPrompt(opts: {
  taskTitle: string;
  taskDescription: string;
  upstreamContext?: string;
  collaborationQuestions?: { from: string; question: string }[];
  /** Research queries the planner suggested — the specialist runs them
   *  ITSELF through its real web tool (no pre-fetched duplication). */
  suggestedQueries?: string[];
}): string {
  const suggestions = opts.suggestedQueries?.length
    ? opts.suggestedQueries.map((q) => `- ${q}`).join("\n")
    : "";

  return joinSections([
    `# Task
**${opts.taskTitle}**
${trimTo(opts.taskDescription, 3000)}`,
    opts.upstreamContext?.trim()
      ? `# Upstream context — results from earlier tasks this turn
${trimTo(opts.upstreamContext, 6000)}`
      : "",
    opts.collaborationQuestions?.length
      ? `# Questions from other agents
${opts.collaborationQuestions.map((q) => `- From ${q.from}: ${trimTo(q.question, 400)}`).join("\n")}`
      : "",
    suggestions
      ? `# Suggested research queries (run them with your web tool, then verify by READING key sources)
${suggestions}`
      : "",
    "Produce your best complete output for this task. Use your tools whenever real information or files would make the result better — never fabricate sources, data or tool activity.",
  ]);
}

// ---------------------------------------------------------------------------
// Discovery (wizard)
// ---------------------------------------------------------------------------

export function buildDiscoverySystemPrompt(): string {
  return `You are the Main Agent of Onyx Agent in discovery mode — a rigorous, honest business architect. Given a business idea and (when available) REAL web research results, you produce a complete business blueprint.

Return ONLY a JSON object — no prose, no markdown fences — with EXACTLY these keys:
{
  "overview": string,
  "customer_profile": string,
  "market_research": string,
  "competitor_analysis": string,
  "revenue_model": string,
  "operational_workflow": string,
  "risks": string,
  "proposed_goals": string[],
  "recommended_skills": string[],
  "recommended_connectors": string[],
  "proposed_agents": [{ "name": string, "role": string, "description": string, "logo": string, "system_instructions": string }],
  "initial_task_backlog": [{ "title": string, "description": string, "agent_role": string }],
  "assumptions": string[],
  "research_findings": [{ "finding": string, "source": string, "verified": boolean }]
}

Rules:
- overview: 1-2 paragraphs on what the business is and why it can win. customer_profile: who buys, their needs, willingness to pay. market_research: market size and trends — grounded in the WEB SEARCH RESULTS where available. competitor_analysis: named competitors (from search when available) and positioning gaps. revenue_model: pricing, revenue streams, unit economics. operational_workflow: how the business runs day-to-day, end to end. risks: key risks and dependencies with mitigations.
- proposed_goals: 3-6 concrete first goals.
- proposed_agents: 2-6 agents this business genuinely needs. "role" AND "logo" must each be ONE word from this palette: research, strategy, marketing, content, finance, operations, developer, quality, support, legal, sales, data, creative, growth. "name" is human-style (e.g. "Research Agent", "Finance Agent"). "system_instructions": 2-4 sentences of high-quality, role-specific instructions for that agent.
- initial_task_backlog: 3-8 concrete first tasks; "agent_role" must match a role used in proposed_agents.
- research_findings: "verified": true ONLY for facts taken from the WEB SEARCH RESULTS in the user message — then "source" is the result URL. Every claim you reason out yourself gets "verified": false and an empty "source". NEVER invent statistics.
- assumptions: every assumption you made about the business, explicit.
- Ground sections in the search results where they exist; mark the rest as your own reasoning.
- Write all content in the user's language.`;
}

export function buildDiscoveryUserPrompt(
  input: BusinessDiscoveryInput,
  research?: WebResearchBlock[],
): string {
  const field = (label: string, value?: string): string =>
    value?.trim() ? `- ${label}: ${trimTo(value, 800)}` : "";

  const web = research?.length
    ? research
        .map(
          (w) =>
            `## Query: "${w.query}"\n${w.results
              .map((r) => `- [${r.title}](${r.url})\n  ${trimTo(r.snippet, 350)}`)
              .join("\n")}`,
        )
        .join("\n\n")
    : "No web results were available — rely on your own analysis and mark every research finding verified: false.";

  return joinSections([
    `# Business input
${[
      field("Name", input.name),
      field("Idea", input.idea),
      field("Industry", input.industry),
      field("Business model", input.businessModel),
      field("Target customers", input.targetCustomers),
      field("Objectives", input.objectives),
      field("Geography", input.geography),
      field("Budget", input.budget),
      field("References", input.references),
      field("Working style", input.workingStyle),
      field("Automation level", input.automation),
      input.rawPrompt?.trim() ? field("Original prompt", input.rawPrompt) : "",
    ]
      .filter(Boolean)
      .join("\n") || "- (no structured input provided)"}`,
    `# WEB SEARCH RESULTS (real, retrieved just now)
${web}`,
    "Produce the business blueprint now. Return ONLY the JSON object.",
  ]);
}

// ---------------------------------------------------------------------------
// Blueprint section regeneration (wizard)
// ---------------------------------------------------------------------------

const SECTION_SHAPES: Record<string, string> = {
  overview: "a plain string with the new section text",
  customer_profile: "a plain string with the new section text",
  market_research: "a plain string with the new section text",
  competitor_analysis: "a plain string with the new section text",
  revenue_model: "a plain string with the new section text",
  operational_workflow: "a plain string with the new section text",
  risks: "a plain string with the new section text",
  proposed_goals: "a JSON array of strings (the new goals)",
  recommended_skills: "a JSON array of strings",
  recommended_connectors: "a JSON array of strings",
  assumptions: "a JSON array of strings",
  proposed_agents:
    'a JSON array of objects with the same shape as the current section: { "name", "role", "description", "logo", "system_instructions" } — role and logo are single words from the palette: research, strategy, marketing, content, finance, operations, developer, quality, support, legal, sales, data, creative, growth',
  initial_task_backlog:
    'a JSON array of objects with the same shape as the current section: { "title", "description", "agent_role" }',
  research_findings:
    'a JSON array of objects with the same shape as the current section: { "finding", "source", "verified" }',
};

/**
 * Regenerate ONE blueprint section. Use as the `userPrompt` of a
 * businessLlmComplete call (jsonMode: true) together with
 * buildDiscoverySystemPrompt() as the system prompt.
 */
export function buildBlueprintSectionRegeneratePrompt(
  section: string,
  currentBlueprint: BusinessBlueprint,
  input: BusinessDiscoveryInput,
): string {
  const shape = SECTION_SHAPES[section] ?? "a plain string with the new section text";
  let blueprintJson = "";
  try {
    blueprintJson = JSON.stringify(currentBlueprint, null, 1);
  } catch {
    blueprintJson = "(blueprint could not be serialized)";
  }

  const field = (label: string, value?: string): string => (value?.trim() ? `- ${label}: ${trimTo(value, 400)}` : "");

  return joinSections([
    `# Task
Regenerate ONE section of the business blueprint below — improve it with fresh, high-quality thinking while staying consistent with the rest of the blueprint.`,
    `# Business input
${[
      field("Name", input.name),
      field("Idea", input.idea),
      field("Industry", input.industry),
      field("Target customers", input.targetCustomers),
      field("Objectives", input.objectives),
    ]
      .filter(Boolean)
      .join("\n") || "(no structured input)"}`,
    `# Current blueprint (for context only — do NOT return it)
${trimTo(blueprintJson, 6000)}`,
    `# Section to regenerate: "${section}"
The "section" value in your reply must be ${shape}.

Return ONLY a JSON object: {"section": <new content>}
No prose outside the JSON, no markdown fences.`,
  ]);
}
