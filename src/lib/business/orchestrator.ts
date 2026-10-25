// ============================================================================
// Business Mode — Main Agent orchestrator (PRD §4, §7, §8, §16).
//
// The turn pipeline: user message → JEV intent classification → Main Agent
// planning (JSON) → task graph persistence → concurrent specialist execution
// (with real web research) → consolidation (streamed) → memory capture.
//
// Every status change maps to a real execution event — nothing simulated.
// Turns live in a module-level registry so route changes never abort them;
// only cancelBusinessTurn() or the Stop button do.
// ============================================================================

import { nanoid } from "nanoid";
import { useAuthStore } from "@/stores/auth-store";
import { useBusinessStore } from "@/stores/business-store";
import { bt } from "./ui-text";
import {
  agentMessageService,
  businessAgentService,
  businessChatService,
  businessDraftService,
  businessEventService,
  businessMemoryService,
  businessService,
  businessTaskService,
} from "./data";
import {
  resolveBusinessLlmConfig,
  businessLlmComplete,
  businessLlmStream,
  businessWebSearch,
  type BusinessLlmConfig,
  type BusinessWebSearchResult,
} from "./llm";
import {
  buildConsolidationUserPrompt,
  buildDirectAnswerUserPrompt,
  buildDiscoverySystemPrompt,
  buildDiscoveryUserPrompt,
  buildMainChatSystemPrompt,
  buildPlannerSystemPrompt,
  buildPlannerUserPrompt,
  buildSpecialistSystemPrompt,
  buildSpecialistUserPrompt,
  type ChatHistoryEntry,
  type WebResearchBlock,
} from "./prompts";
import { classifyMessageIntent, type RoutingHint } from "./jev";
import { randomLogoForRole, AGENT_LOGO_KEYS } from "@/components/business/agent-logos";
import {
  registerBusinessTurnHandoff,
  unregisterBusinessTurnHandoff,
  readBusinessCloudHandoffMeta,
  type BusinessTurnSnapshot,
} from "@/lib/agent/turn-cloud-handoff";
import type {
  AgentMessageRow,
  BusinessAgentRow,
  BusinessBlueprint,
  BusinessChatMessageRow,
  BusinessDiscoveryInput,
  BusinessEventRow,
  BusinessRow,
  BusinessTaskRow,
  TurnPlan,
  TurnTaskPlan,
} from "./types";

// ---------------------------------------------------------------------------
// Turn registry (survives route changes)
// ---------------------------------------------------------------------------

interface TurnHandle {
  turnId: string;
  controller: AbortController;
  startedAt: number;
}

const turnRegistry = new Map<string, TurnHandle>();

export function isBusinessTurnRunning(businessId: string): boolean {
  return turnRegistry.has(businessId);
}

function store() {
  return useBusinessStore.getState();
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function nowISO(): string {
  return new Date().toISOString();
}

function humanizeDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${m}m ${rest < 10 ? "0" : ""}${rest}s`;
}

function trimTo(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function userId(): string {
  return useAuthStore.getState().user?.id ?? "local-user";
}

/** Extract the first balanced JSON object from LLM output (strips code fences). */
function extractJsonObject(text: string): unknown | null {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) t = fence[1].trim();
  const start = t.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Validate a parsed plan object into a TurnPlan. */
function safeParsePlan(text: string): TurnPlan | null {
  const raw = extractJsonObject(text);
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const rawTasks = Array.isArray(obj.tasks) ? obj.tasks : [];
  const tasks: TurnTaskPlan[] = [];
  for (const t of rawTasks) {
    if (!t || typeof t !== "object") continue;
    const task = t as Record<string, unknown>;
    const agent = asString(task.agent).trim();
    const title = asString(task.title).trim();
    if (!agent || !title) continue;
    tasks.push({
      agent,
      title,
      description: asString(task.description, title),
      depends_on: asStringArray(task.depends_on),
      produces_draft: task.produces_draft === true,
      draft_type: asString(task.draft_type, "document") || "document",
      search_queries: asStringArray(task.search_queries).slice(0, 3),
    });
  }
  return {
    direct: obj.direct === true || tasks.length === 0,
    response: asString(obj.response),
    tasks: tasks.slice(0, 6),
    notes: asString(obj.notes),
  };
}

/** Parse @mentions (supports "@Research Agent" and "@Research"). */
function parseMentions(content: string, agents: BusinessAgentRow[]): string[] {
  const found = new Set<string>();
  // Longest names first so "@Research Agent" wins over "@Research".
  const sorted = [...agents].sort((a, b) => b.name.length - a.name.length);
  for (const agent of sorted) {
    const escaped = agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`@${escaped}(?![\\w-])`, "i");
    if (re.test(content)) found.add(agent.id);
  }
  return [...found];
}

function resolveAgentByName(name: string, agents: BusinessAgentRow[]): BusinessAgentRow | undefined {
  const target = name.trim().toLowerCase();
  return (
    agents.find((a) => a.name.toLowerCase() === target) ??
    agents.find((a) => a.name.toLowerCase().includes(target) || target.includes(a.name.toLowerCase()))
  );
}

async function emitEvent(evt: Omit<BusinessEventRow, "id" | "created_at">): Promise<void> {
  await businessEventService.append(evt);
}

/** Append an activity chat message + mirror into the live store. */
async function appendActivity(
  businessId: string,
  content: string,
  opts?: { agentId?: string; metadata?: BusinessChatMessageRow["metadata"] },
): Promise<void> {
  const row = await businessChatService.append(businessId, {
    role: "activity",
    agent_id: opts?.agentId,
    content,
    metadata: opts?.metadata,
  });
  store().appendChatMessage(row);
}

async function updateTaskAndMirror(taskId: string, patch: Partial<BusinessTaskRow>): Promise<BusinessTaskRow | undefined> {
  await businessTaskService.update(taskId, patch);
  const row = await businessTaskService.get(taskId);
  if (row) store().upsertTask(row);
  return row;
}

async function updateAgentAndMirror(agentId: string, patch: Partial<BusinessAgentRow>): Promise<BusinessAgentRow | undefined> {
  await businessAgentService.update(agentId, patch);
  const row = await businessAgentService.get(agentId);
  if (row) store().upsertAgent(row);
  return row;
}

async function loadSkillContents(agent: BusinessAgentRow): Promise<string[]> {
  if (!agent.skills.length) return [];
  const { skillService } = await import("@/lib/services");
  const { readTextFile } = await import("@/lib/storage/opfs");
  const all = await skillService.list(userId()).catch(() => []);
  const contents: string[] = [];
  for (const id of agent.skills) {
    const skill = all.find((s) => s.id === id);
    if (!skill?.dir_path) continue;
    try {
      const content = await readTextFile(`${skill.dir_path}/SKILL.md`);
      if (content?.trim()) contents.push(`# Skill: ${skill.name}\n${trimTo(content, 2000)}`);
    } catch {
      // skill directory missing — skip honestly
    }
  }
  return contents;
}

function memoryContextText(rows: Awaited<ReturnType<typeof businessMemoryService.retrieve>>): string {
  if (!rows.length) return "";
  return rows
    .map((m) => `- [${m.memory_type}${m.pinned ? " · pinned" : ""} · ${m.verification_status}] ${trimTo(m.content, 300)}`)
    .join("\n");
}

async function chatHistory(businessId: string, limit = 12): Promise<ChatHistoryEntry[]> {
  const rows = await businessChatService.list(businessId, 60);
  const relevant = rows.filter((m) => m.role !== "activity").slice(-limit);
  const agents = store().agents;
  return relevant.map((m) => ({
    role: m.role === "user" ? "user" : m.role === "agent" ? "agent" : "main",
    content: m.content,
    agentName: m.agent_id ? agents.find((a) => a.id === m.agent_id)?.name : undefined,
  }));
}

/** Extract an optional trailing {"ask_agent": "...", "question": "..."} line. */
function extractAgentQuestion(output: string): { agent: string; question: string } | null {
  const match = output.match(/\{\s*"ask_agent"\s*:\s*"([^"]+)"\s*,\s*"question"\s*:\s*"([^"]+)"\s*\}\s*$/);
  if (!match?.[1] || !match[2]) return null;
  return { agent: match[1], question: match[2] };
}

// ---------------------------------------------------------------------------
// Discovery (creation wizard)
// ---------------------------------------------------------------------------

/** Live discovery phases, surfaced verbatim to the wizard's monitor UI. */
export type DiscoveryPhase =
  | "config"   // resolving provider + model
  | "enrich"   // expanding a raw prompt into structured fields
  | "research" // real web searches (one event per query)
  | "draft"    // streaming the blueprint JSON
  | "repair"   // re-asking after an invalid JSON reply
  | "validate"; // parsing + validating the blueprint

/**
 * Real-time progress event emitted by runBusinessDiscovery. Nothing here is
 * simulated — every event maps to an actual execution step (PRD §31), which
 * is exactly what the wizard's live monitor renders.
 */
export interface DiscoveryProgressEvent {
  phase: DiscoveryPhase;
  status: "start" | "done" | "skip";
  /** config: resolved provider + model actually used for this run. */
  provider?: string;
  model?: string;
  /** research: the query currently being searched. */
  query?: string;
  /** research done: how many real results came back. */
  resultCount?: number;
  /** research done: top result titles (display only). */
  topResults?: string[];
  /** enrich/draft/repair: streamed model output chunk ("what the AI writes"). */
  delta?: string;
  /** enrich/draft/repair: total characters streamed for the current generation. */
  chars?: number;
}

export interface DiscoveryRunOptions {
  /** Cancels the whole run (web searches + LLM streams). */
  signal?: AbortSignal;
  /** Live progress sink — called on every real execution event. */
  onEvent?: (event: DiscoveryProgressEvent) => void;
}

/**
 * STREAMING discovery run.
 *
 * Why streaming (not businessLlmComplete): the blueprint is a long JSON
 * generation. Non-streaming requests sit idle on the wire until the whole
 * completion is ready — providers with gateway inactivity limits (e.g.
 * Pollinations' "Inactivity Timeout" 504 HTML page) kill exactly those.
 * Streaming keeps bytes flowing for the entire generation — the same wire
 * path normal chat uses — while giving the wizard a live view of what the
 * Main Agent is writing.
 */
export async function runBusinessDiscovery(
  input: BusinessDiscoveryInput,
  opts: DiscoveryRunOptions = {},
): Promise<BusinessBlueprint> {
  const { signal, onEvent } = opts;
  const emit = (event: DiscoveryProgressEvent) => onEvent?.(event);

  emit({ phase: "config", status: "start" });
  const cfg = await resolveBusinessLlmConfig();
  emit({
    phase: "config",
    status: "done",
    provider: cfg.providerName,
    model: cfg.model,
  });

  // Expand a raw prompt into structured fields when the form is thin.
  let enriched: BusinessDiscoveryInput = { ...input };
  const rawPrompt = input.rawPrompt?.trim() ? input.rawPrompt : "";
  const needsEnrichment =
    !!rawPrompt && (!input.idea?.trim() || input.idea.trim().length < 40);
  if (!needsEnrichment) {
    emit({ phase: "enrich", status: "skip" });
  } else {
    emit({ phase: "enrich", status: "start" });
    let enrichChars = 0;
    try {
      const res = await businessLlmStream(cfg, {
        systemPrompt:
          "You extract structured business facts from a natural-language prompt. Return ONLY a JSON object with keys: name, idea, industry, businessModel, targetCustomers, objectives, geography, budget. Fill what the prompt states; use \"\" for the rest. Never invent specifics.",
        userPrompt: rawPrompt.slice(0, 4000),
        signal,
        onDelta: (delta) => {
          enrichChars += delta.length;
          emit({ phase: "enrich", status: "start", delta, chars: enrichChars });
        },
      });
      const parsed = extractJsonObject(res.text);
      if (parsed && typeof parsed === "object") {
        const o = parsed as Record<string, unknown>;
        enriched = {
          name: input.name?.trim() || asString(o.name, "My Business"),
          idea: input.idea?.trim() || asString(o.idea, input.rawPrompt),
          industry: input.industry || asString(o.industry) || undefined,
          businessModel: input.businessModel || asString(o.businessModel) || undefined,
          targetCustomers: input.targetCustomers || asString(o.targetCustomers) || undefined,
          objectives: input.objectives || asString(o.objectives) || undefined,
          geography: input.geography || asString(o.geography) || undefined,
          budget: input.budget || asString(o.budget) || undefined,
          references: input.references,
          workingStyle: input.workingStyle,
          automation: input.automation,
          rawPrompt: input.rawPrompt,
        };
      }
      emit({ phase: "enrich", status: "done" });
    } catch (err) {
      if (signal?.aborted) throw err;
      // enrichment is best-effort — raw prompt is passed through below
      emit({ phase: "enrich", status: "done" });
    }
  }

  // Real web research: findings retrieved here are the only "verified" ones.
  const research: WebResearchBlock[] = [];
  const baseQueries = [
    `${enriched.industry || enriched.idea.slice(0, 60)} market size and trends ${enriched.geography || ""}`.trim(),
    `${enriched.idea.slice(0, 60)} top competitors`,
    `${enriched.targetCustomers || enriched.industry || "customers"} buying behavior ${enriched.geography || ""}`.trim(),
  ];
  for (const q of baseQueries.slice(0, 3)) {
    emit({ phase: "research", status: "start", query: q });
    const res = await businessWebSearch(q, signal);
    if (res.results.length) research.push({ query: q, results: res.results });
    emit({
      phase: "research",
      status: "done",
      query: q,
      resultCount: res.results.length,
      topResults: res.results.slice(0, 3).map((r) => r.title),
    });
    if (signal?.aborted) throw new Error("The request was cancelled.");
  }

  // Draft the blueprint — STREAMED (fixes provider inactivity 504s and
  // feeds the wizard's live "what the AI is writing" monitor).
  emit({ phase: "draft", status: "start" });
  let draftText = "";
  const res = await businessLlmStream(cfg, {
    systemPrompt: buildDiscoverySystemPrompt(),
    userPrompt: buildDiscoveryUserPrompt(enriched, research),
    signal,
    onDelta: (delta) => {
      draftText += delta;
      emit({ phase: "draft", status: "start", delta, chars: draftText.length });
    },
  });
  let text = res.text;
  if (!text.trim()) text = draftText; // paranoid: keep what we saw streamed
  emit({ phase: "draft", status: "done", chars: text.length });

  emit({ phase: "validate", status: "start" });
  let parsed = extractJsonObject(text) as Record<string, unknown> | null;
  if (!parsed) {
    // one streamed repair retry
    emit({ phase: "repair", status: "start" });
    let repairText = "";
    const repair = await businessLlmStream(cfg, {
      systemPrompt: buildDiscoverySystemPrompt(),
      userPrompt: `${buildDiscoveryUserPrompt(enriched, research)}\n\nIMPORTANT: your previous reply was not valid JSON. Return ONLY the JSON object.`,
      signal,
      onDelta: (delta) => {
        repairText += delta;
        emit({ phase: "repair", status: "start", delta, chars: repairText.length });
      },
    });
    parsed = extractJsonObject(repair.text || repairText) as Record<string, unknown> | null;
    emit({ phase: "repair", status: "done" });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Discovery returned an unreadable blueprint — try again, or continue with a template team.");
  }

  const rawAgents = Array.isArray(parsed.proposed_agents) ? parsed.proposed_agents : [];
  const proposed_agents = rawAgents
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a) => ({
      name: asString(a.name, "Specialist"),
      role: asString(a.role, "generic"),
      description: asString(a.description),
      logo: AGENT_LOGO_KEYS.includes(asString(a.logo)) ? asString(a.logo) : randomLogoForRole(asString(a.role, "generic")),
      system_instructions: asString(a.system_instructions),
    }))
    .slice(0, 6);

  const rawBacklog = Array.isArray(parsed.initial_task_backlog) ? parsed.initial_task_backlog : [];
  const initial_task_backlog = rawBacklog
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({
      title: asString(t.title, "Task"),
      description: asString(t.description),
      agent_role: asString(t.agent_role, asString(t.agent, "research")),
    }))
    .slice(0, 8);

  // Verified findings are ONLY those actually matched against real search results.
  const verifiedSet = new Set(
    research.flatMap((r) => r.results.map((x) => x.url)).slice(0, 40),
  );
  const rawFindings = Array.isArray(parsed.research_findings) ? parsed.research_findings : [];
  const research_findings = rawFindings
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f) => {
      const source = asString(f.source);
      const claimed = f.verified === true;
      return {
        finding: asString(f.finding),
        source: source || undefined,
        verified: claimed && (!!source && verifiedSet.has(source)),
      };
    })
    .slice(0, 12);

  emit({ phase: "validate", status: "done" });

  return {
    overview: asString(parsed.overview),
    customer_profile: asString(parsed.customer_profile),
    market_research: asString(parsed.market_research),
    competitor_analysis: asString(parsed.competitor_analysis),
    revenue_model: asString(parsed.revenue_model),
    operational_workflow: asString(parsed.operational_workflow),
    risks: asString(parsed.risks),
    proposed_goals: asStringArray(parsed.proposed_goals).slice(0, 6),
    recommended_skills: asStringArray(parsed.recommended_skills),
    recommended_connectors: asStringArray(parsed.recommended_connectors),
    proposed_agents: proposed_agents.length ? proposed_agents : fallbackTeam(enriched),
    initial_task_backlog,
    assumptions: asStringArray(parsed.assumptions),
    research_findings,
  };
}

function fallbackTeam(input: BusinessDiscoveryInput): BusinessBlueprint["proposed_agents"] {
  return [
    {
      name: "Research Agent",
      role: "research",
      description: "Market and competitor research with real web sources.",
      logo: "research",
      system_instructions: `You research markets, competitors and customers for ${input.name || "this business"}. Always distinguish verified facts (from provided web results) from estimates. Cite sources as markdown links.`,
    },
    {
      name: "Strategy Agent",
      role: "strategy",
      description: "Business planning, positioning and prioritization.",
      logo: "strategy",
      system_instructions: `You turn research into actionable plans for ${input.name || "this business"}: positioning, priorities, measurable goals. Be concrete and honest about trade-offs.`,
    },
    {
      name: "Operations Agent",
      role: "operations",
      description: "Processes, checklists and execution tracking.",
      logo: "operations",
      system_instructions: `You design simple, executable processes and checklists for ${input.name || "this business"}. Surface blockers and dependencies explicitly.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Business creation
// ---------------------------------------------------------------------------

function blueprintProfileMarkdown(blueprint: BusinessBlueprint): string {
  const sections: string[] = [];
  const add = (title: string, body: string) => {
    if (body?.trim()) sections.push(`## ${title}\n\n${body.trim()}`);
  };
  add("Overview", blueprint.overview);
  add("Customer profile", blueprint.customer_profile);
  add("Market research", blueprint.market_research);
  add("Competitor analysis", blueprint.competitor_analysis);
  add("Revenue model", blueprint.revenue_model);
  add("Operational workflow", blueprint.operational_workflow);
  add("Risks & dependencies", blueprint.risks);
  if (blueprint.assumptions.length) {
    add("Assumptions", blueprint.assumptions.map((a) => `- ${a}`).join("\n"));
  }
  if (blueprint.research_findings.length) {
    add(
      "Research findings",
      blueprint.research_findings
        .map((f) => `- ${f.verified ? "✅ verified" : "⚠️ estimate"} — ${f.finding}${f.source ? ` ([source](${f.source}))` : ""}`)
        .join("\n"),
    );
  }
  return sections.join("\n\n");
}

async function persistBusiness(
  input: BusinessDiscoveryInput,
  profileMarkdown: string,
  goals: string[],
  agents: { name: string; role: string; description: string; logo?: string; system_instructions: string }[],
  tasks: { title: string; description: string; agent_role: string }[],
  template?: string,
): Promise<string> {
  const uid = userId();
  const business = await businessService.create(uid, {
    name: input.name || "My Business",
    description: (input.idea || "").slice(0, 500),
    industry: input.industry,
    business_model: input.businessModel,
    target_customers: input.targetCustomers,
    geography: input.geography,
    business_profile: profileMarkdown || input.idea || "",
    goals: goals.map((g) => ({ id: nanoid(), title: g, status: "proposed" as const })),
    status: "active",
    template,
  });

  await emitEvent({
    business_id: business.id,
    event_type: "business.created",
    payload: { name: business.name },
  });

  const created: BusinessAgentRow[] = [];
  for (const a of agents) {
    const row = await businessAgentService.create(business.id, {
      name: a.name,
      description: a.description,
      role: a.role,
      svg_logo: a.logo && AGENT_LOGO_KEYS.includes(a.logo) ? a.logo : randomLogoForRole(a.role),
      prompt_config: {
        system_instructions: a.system_instructions,
        role_definition: a.description,
      },
    });
    created.push(row);
    await emitEvent({
      business_id: business.id,
      agent_id: row.id,
      event_type: "agent.created",
      payload: { name: row.name, role: row.role },
    });
  }

  for (const t of tasks) {
    const agent = created.find((a) => a.role === t.agent_role || a.name.toLowerCase().includes(t.agent_role.toLowerCase()));
    await businessTaskService.create(business.id, {
      title: t.title,
      description: t.description,
      assigned_agent_id: agent?.id,
      status: "backlog",
      priority: "medium",
    });
  }

  await store().loadBusinesses();
  return business.id;
}

export async function createBusinessFromBlueprint(
  input: BusinessDiscoveryInput,
  blueprint: BusinessBlueprint,
): Promise<string> {
  return persistBusiness(
    input,
    blueprintProfileMarkdown(blueprint),
    blueprint.proposed_goals,
    blueprint.proposed_agents.map((a) => ({ ...a })),
    blueprint.initial_task_backlog,
    input.references,
  );
}

export async function createBusinessFromTemplate(
  templateKey: string,
  input: BusinessDiscoveryInput,
): Promise<string> {
  const { getBusinessTemplate } = await import("./templates");
  const template = getBusinessTemplate(templateKey);
  if (!template) throw new Error("Unknown template");
  return persistBusiness(
    input,
    `Created from the **${bt(`template.${template.key}`)}** template.\n\n${input.idea || ""}`,
    [],
    template.roles.map((r) => ({ ...r })),
    template.initialTasks.map((t) => ({ ...t, agent_role: t.agentRole })),
    templateKey,
  );
}

// ---------------------------------------------------------------------------
// Direct creation (no LLM) — the manage_business tool's spec-driven path.
// ---------------------------------------------------------------------------

/** One specialist agent in a business spec (the calling LLM composes these
 *  from the user's natural-language request). */
export interface BusinessSpecAgent {
  name: string;
  role: string;
  description?: string;
  /** Operating instructions (system prompt) for the agent. */
  instructions?: string;
  logo?: string;
  permissions?: {
    web_search?: boolean;
    create_drafts?: boolean;
    read_memory?: boolean;
    write_memory?: boolean;
  };
}

export interface BusinessSpec {
  name: string;
  description?: string;
  idea?: string;
  industry?: string;
  businessModel?: string;
  targetCustomers?: string;
  geography?: string;
  /** Operating instructions / mission for the whole business. */
  instructions?: string;
  goals?: string[];
  agents?: BusinessSpecAgent[];
  /** Initial backlog tasks; agent_role matches an agent's name or role. */
  initialTasks?: { title: string; description?: string; agent_role?: string }[];
  template?: string;
}

/**
 * Create a real, persistent business from a structured spec (NO discovery
 * LLM call — the agent invoking the tool already did the reasoning). Reuses
 * the canonical persistBusiness path: business row + created events + agent
 * rows + backlog tasks + live store refresh. Returns the business id.
 */
export async function createBusinessFromSpec(spec: BusinessSpec): Promise<string> {
  if (!spec.name?.trim()) throw new Error("Business name is required");

  const agents: BusinessSpecAgent[] = (spec.agents ?? []).filter((a) => a?.name?.trim());
  const profileMarkdown = [
    `# ${spec.name.trim()}`,
    "",
    spec.description?.trim() || spec.idea?.trim() || "",
    "",
    spec.instructions?.trim() ? `## Operating instructions\n\n${spec.instructions.trim()}` : "",
    spec.industry?.trim() ? `**Industry:** ${spec.industry.trim()}` : "",
    spec.businessModel?.trim() ? `**Business model:** ${spec.businessModel.trim()}` : "",
    spec.targetCustomers?.trim() ? `**Target customers:** ${spec.targetCustomers.trim()}` : "",
    spec.geography?.trim() ? `**Geography:** ${spec.geography.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return persistBusiness(
    {
      name: spec.name.trim(),
      idea: spec.description?.trim() || spec.idea?.trim() || "",
      industry: spec.industry?.trim() || undefined,
      businessModel: spec.businessModel?.trim() || undefined,
      targetCustomers: spec.targetCustomers?.trim() || undefined,
      geography: spec.geography?.trim() || undefined,
    },
    profileMarkdown || spec.description || "",
    spec.goals?.filter((g) => g?.trim()).map((g) => g.trim()) ?? [],
    agents.map((a) => ({
      name: a.name.trim(),
      role: a.role?.trim() || a.name.trim(),
      description: a.description?.trim() || `${a.role?.trim() || a.name.trim()} for ${spec.name.trim()}.`,
      logo: a.logo,
      system_instructions:
        a.instructions?.trim() ||
        `You are ${a.name.trim()}, the ${a.role?.trim() || "specialist"} of ${spec.name.trim()}. ${
          spec.instructions?.trim() ?? spec.description?.trim() ?? ""
        } Deliver complete, concrete work products.`.trim(),
    })),
    (spec.initialTasks ?? [])
      .filter((t) => t?.title?.trim())
      .map((t) => ({
        title: t.title.trim(),
        description: t.description?.trim() || t.title.trim(),
        agent_role: t.agent_role?.trim() || "",
      })),
    spec.template?.trim() || undefined,
  );
}

// ---------------------------------------------------------------------------
// Specialist execution (shared by delegation loop, retry, test)
// ---------------------------------------------------------------------------

interface SpecialistOutcome {
  ok: boolean;
  output: string;
  sources: { title: string; url: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: string;
}

interface SpecialistOptions {
  business: BusinessRow;
  agent: BusinessAgentRow | null; // null → Main Agent runs it
  taskTitle: string;
  taskDescription: string;
  upstreamContext?: string;
  collaborationQuestions?: { from: string; question: string }[];
  searchQueries?: string[];
  signal?: AbortSignal;
  mainCfg?: BusinessLlmConfig;
  timeoutMs?: number;
  /** emit real execution events (false for runAgentTest) */
  recordEvents: boolean;
  businessId: string;
  taskId?: string;
  turnId?: string;
}

async function runSpecialist(opts: SpecialistOptions): Promise<SpecialistOutcome> {
  const { business, agent, businessId, taskId, turnId, recordEvents } = opts;
  const sources: { title: string; url: string }[] = [];

  const cfg = agent?.provider_id
    ? await resolveBusinessLlmConfig({ providerId: agent.provider_id, model: agent.model_id })
    : opts.mainCfg ?? (await resolveBusinessLlmConfig());

  const skillContents = agent ? await loadSkillContents(agent) : [];
  const memoryContext =
    agent?.permissions.read_memory !== false
      ? memoryContextText(await businessMemoryService.retrieve(businessId, opts.taskDescription, 2000))
      : "";

  // Real web research (only when permitted and requested).
  let webBlocks: WebResearchBlock[] | undefined;
  const queries = (opts.searchQueries ?? []).slice(0, 2);
  if (agent?.permissions.web_search !== false && queries.length) {
    webBlocks = [];
    for (const query of queries) {
      if (opts.signal?.aborted) break;
      const res = await businessWebSearch(query, opts.signal);
      if (res.results.length) {
        webBlocks.push({ query, results: res.results });
        sources.push(...res.results.map((r) => ({ title: r.title, url: r.url })));
      }
      if (recordEvents) {
        await emitEvent({
          business_id: businessId,
          task_id: taskId,
          agent_id: agent?.id,
          event_type: "browser.activity",
          payload: {
            kind: "web_search",
            query,
            resultCount: res.results.length,
            topUrls: res.results.slice(0, 3).map((r) => r.url),
          },
          correlation_id: turnId,
        });
        await appendActivity(businessId, bt("chat.activityResearching", { agent: agent?.name ?? "Main Agent", query }), {
          agentId: agent?.id,
          metadata: { taskId, turnId },
        });
      }
    }
  }

  const systemPrompt = agent
    ? buildSpecialistSystemPrompt(agent, business, skillContents, memoryContext)
    : `${buildMainChatSystemPrompt(business, memoryContext)}\n\nYou are executing one specialist task yourself. Produce the complete deliverable.`;

  const userPrompt = buildSpecialistUserPrompt({
    taskTitle: opts.taskTitle,
    taskDescription: opts.taskDescription,
    upstreamContext: opts.upstreamContext,
    collaborationQuestions: opts.collaborationQuestions,
    webResults: webBlocks,
  });

  const attempt = async (): Promise<SpecialistOutcome> => {
    const res = await businessLlmComplete(cfg, {
      systemPrompt,
      userPrompt,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? business.configuration.perTaskTimeoutMs,
    });
    return { ok: true, output: res.text, sources, usage: res.usage };
  };

  try {
    return await attempt();
  } catch (err) {
    if (opts.signal?.aborted) {
      return { ok: false, output: "", sources, error: "cancelled" };
    }
    // One retry (transient provider errors are common).
    try {
      return await attempt();
    } catch (err2) {
      const message = err2 instanceof Error ? err2.message : String(err2);
      return { ok: false, output: "", sources, error: trimTo(message, 300) };
    }
  }
}

async function collaborationQuestionsFor(
  businessId: string,
  agentId: string | undefined,
  agents: BusinessAgentRow[],
): Promise<{ from: string; question: string }[]> {
  if (!agentId) return [];
  const rows = await agentMessageService.list(businessId);
  const relevant = rows.filter(
    (m) => m.message_type === "information_request" && m.recipient_agent_id === agentId,
  );
  const fromNames = new Map(agents.map((a) => [a.id, a.name]));
  return relevant.slice(-3).map((m) => ({
    from: m.sender_agent_id ? fromNames.get(m.sender_agent_id) ?? "an agent" : "Main Agent",
    question: trimTo(m.content, 400),
  }));
}

function upstreamContextFor(task: BusinessTaskRow, allTasks: BusinessTaskRow[]): string {
  const parts: string[] = [];
  for (const depId of task.dependencies) {
    const dep = allTasks.find((t) => t.id === depId);
    const content = dep?.output_artifacts?.content;
    if (dep && content) {
      parts.push(`### From ${dep.title} (completed)\n${trimTo(content, 3000)}`);
    }
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// THE MAIN PIPELINE
// ---------------------------------------------------------------------------

export async function sendBusinessMessage(businessId: string, content: string): Promise<void> {
  if (turnRegistry.has(businessId)) {
    throw new Error(bt("toast.turnAlreadyRunning"));
  }
  // One durable lane at a time: a live Trigger.dev Cloud handoff from a
  // previous session owns this business's turn — its result lands in the
  // chat automatically; a new turn would race it.
  if (readBusinessCloudHandoffMeta(businessId)) {
    throw new Error(bt("toast.bgTurnActive"));
  }

  const turnId = nanoid();
  const controller = new AbortController();
  const signal = controller.signal;
  turnRegistry.set(businessId, { turnId, controller, startedAt: Date.now() });
  const startedAt = Date.now();

  try {
    const business = await businessService.get(businessId);
    if (!business) throw new Error("Business not found");
    const agents = await businessAgentService.list(businessId);

    // 1. User message (+ mention parsing)
    const mentions = parseMentions(content, agents);
    const userRow = await businessChatService.append(businessId, {
      role: "user",
      content,
      metadata: { mentions, turnId },
    });
    store().appendChatMessage(userRow);

    // 2. Turn start
    store().setTurnRunning(true);
    await emitEvent({
      business_id: businessId,
      event_type: "turn.started",
      payload: { turnId, message: trimTo(content, 200) },
      correlation_id: turnId,
    });
    await appendActivity(businessId, bt("chat.activityPlanning"), { metadata: { turnId } });

    // 3. Mention availability check
    for (const agentId of mentions) {
      const agent = agents.find((a) => a.id === agentId);
      if (agent && (agent.paused || agent.status === "disabled")) {
        await appendActivity(
          businessId,
          bt("chat.mentionUnavailable", { name: agent.name, status: agent.paused ? bt("status.paused") : bt("status.disabled") }),
          { agentId, metadata: { turnId } },
        );
      }
    }

    // 4. Memory + JEV decision
    const memory = memoryContextText(await businessMemoryService.retrieve(businessId, content, 2500));
    const decision = await classifyMessageIntent({ businessId, message: content, signal });
    await appendActivity(
      businessId,
      decision.result.fallbackUsed
        ? bt("chat.decisionFallback")
        : bt("chat.decisionUsed", {
            label: decision.result.label ?? "",
            confidence: Math.round((decision.result.confidence ?? 0) * 100),
          }),
      { metadata: { turnId } },
    );
    const routingHint: RoutingHint | null = decision.hint;

    // 5. Main Agent model
    const mainCfg = await resolveBusinessLlmConfig(
      business.configuration.mainProviderId
        ? { providerId: business.configuration.mainProviderId, model: business.configuration.mainModel }
        : undefined,
    );

    // 6. Planning call
    const history = await chatHistory(businessId);

    // ── DURABILITY REGISTRATION (Trigger.dev Cloud) ──────────────────────
    // If the app closes while this turn runs, the pagehide handler
    // dispatches it to the operator's trigger.dev Cloud project as a
    // durable agent_run — the work survives reload/close (the browser
    // lifecycle never owns it). Unregistered when the turn settles.
    const cloudBase = (mainCfg.baseUrl || "").replace(/\/+$/, "");
    const cloudChatUrl = !cloudBase
      ? ""
      : mainCfg.noPrefix
        ? cloudBase
        : `${cloudBase}/chat/completions`;
    const cloudSnapshot: BusinessTurnSnapshot = {
      businessId,
      businessName: business.name,
      userId: userId(),
      prompt: content,
      systemPrompt: buildMainChatSystemPrompt(business, memory),
      // history INCLUDES this turn's user message (appended at step 1) —
      // the cloud lane takes the prompt separately, so drop the last row.
      history: history.slice(0, -1).map((h) => ({
        role: (h.role === "user" ? "user" : "assistant") as "user" | "assistant",
        content: h.role !== "user" && h.agentName ? `[${h.agentName}]\n${h.content}` : h.content,
      })),
      chatUrl: cloudChatUrl,
      apiKey: mainCfg.apiKey,
      model: mainCfg.model,
      temperature: business.configuration.mainTemperature ?? null,
      startedAt: Date.now(),
    };
    registerBusinessTurnHandoff(cloudSnapshot);

    const mentionedAgents = agents.filter((a) => mentions.includes(a.id));
    let plan: TurnPlan | null = null;
    try {
      const res = await businessLlmComplete(mainCfg, {
        systemPrompt: buildPlannerSystemPrompt(business, agents, memory, routingHint, mentionedAgents),
        userPrompt: buildPlannerUserPrompt({
          userMessage: content,
          history: history.slice(0, -1),
          mentionNames: mentionedAgents.map((a) => a.name),
        }),
        jsonMode: true,
        temperature: business.configuration.mainTemperature,
        signal,
        timeoutMs: 120_000,
      });
      plan = safeParsePlan(res.text);
      if (!plan) {
        const repair = await businessLlmComplete(mainCfg, {
          systemPrompt: buildPlannerSystemPrompt(business, agents, memory, routingHint, mentionedAgents),
          userPrompt: `${buildPlannerUserPrompt({ userMessage: content, history: history.slice(0, -1), mentionNames: mentionedAgents.map((a) => a.name) })}\n\nIMPORTANT: your previous reply was not valid JSON. Return ONLY the JSON plan object.`,
          jsonMode: true,
          signal,
          timeoutMs: 120_000,
        });
        plan = safeParsePlan(repair.text);
      }
    } catch (err) {
      if (signal.aborted) throw err;
      plan = null;
    }
    if (!plan) plan = { direct: true, response: "", tasks: [], notes: "" };

    // 7. Direct answer path
    if (plan.direct) {
      await appendActivity(businessId, bt("chat.activityDirect"), { metadata: { turnId } });
      await streamMainMessage(businessId, {
        systemPrompt: buildMainChatSystemPrompt(business, memory),
        userPrompt: buildDirectAnswerUserPrompt({ userMessage: content, history: history.slice(0, -1), draftAnswer: plan.response || undefined }),
        cfg: mainCfg,
        temperature: business.configuration.mainTemperature,
        signal,
        turnId,
      });
      await finishTurn(businessId, turnId, startedAt);
      return;
    }

    // 8. Delegation path — create task graph
    const planAgents = plan.tasks.map((t) => resolveAgentByName(t.agent, agents) ?? null);
    const taskRows: BusinessTaskRow[] = [];
    const agentTaskIds = new Map<string, string[]>(); // agentName → task ids
    for (let i = 0; i < plan.tasks.length; i++) {
      const t = plan.tasks[i];
      if (!t) continue;
      const agent = planAgents[i] ?? null;
      const deps: string[] = [];
      for (const depRef of t.depends_on) {
        const depAgent = resolveAgentByName(depRef, agents);
        const depIds = depAgent ? agentTaskIds.get(depAgent.name) : agentTaskIds.get(depRef);
        const latest = depIds?.length ? depIds[depIds.length - 1] : undefined;
        if (latest) deps.push(latest); // latest task of that agent
      }
      const row = await businessTaskService.create(businessId, {
        title: t.title,
        description: t.description,
        assigned_agent_id: agent?.id,
        dependencies: [...new Set(deps)],
        status: deps.length ? "backlog" : "ready",
        priority: "medium",
        correlation_id: turnId,
      });
      taskRows.push(row);
      store().upsertTask(row);
      if (agent) {
        const list = agentTaskIds.get(agent.name) ?? [];
        list.push(row.id);
        agentTaskIds.set(agent.name, list);
      }
      await emitEvent({
        business_id: businessId,
        task_id: row.id,
        agent_id: agent?.id,
        event_type: "task.created",
        payload: { title: row.title, agent: agent?.name ?? "Main Agent", dependencies: row.dependencies.length },
        correlation_id: turnId,
      });
    }

    const participatingAgents = [...new Set(planAgents.filter(Boolean).map((a) => a!.name))];
    await appendActivity(
      businessId,
      bt("chat.activityDelegating", { count: String(taskRows.length), agents: participatingAgents.join(", ") }),
      { metadata: { turnId } },
    );

    // 9. Execution loop (scheduler with dependency resolution + concurrency cap)
    const results: Array<{
      agent: string;
      title: string;
      status: string;
      content: string;
      draftCreated: boolean;
      sources: { title: string; url: string }[];
      error?: string;
    }> = [];
    let refreshedTasks = [...taskRows];

    const isTerminal = (t: BusinessTaskRow) =>
      t.status === "completed" || t.status === "failed" || t.status === "cancelled";

    while (refreshedTasks.some((t) => !isTerminal(t))) {
      if (signal.aborted) break;

      const running = refreshedTasks.filter((t) => t.status === "running");
      const ready = refreshedTasks.filter((t) => {
        if (t.status !== "ready" && t.status !== "backlog") return false;
        const deps = t.dependencies.map((d) => refreshedTasks.find((x) => x.id === d));
        return deps.every((d) => !d || d.status === "completed");
      });
      const capacity = Math.max(0, business.configuration.maxConcurrentTasks - running.length);
      const launch = ready.slice(0, capacity);

      if (launch.length === 0 && running.length === 0) {
        // Blocked: no progress possible — report honestly and stop.
        const stuck = refreshedTasks.filter((t) => !isTerminal(t));
        await emitEvent({
          business_id: businessId,
          event_type: "notification",
          payload: { kind: "blocked", tasks: stuck.map((t) => t.title) },
          correlation_id: turnId,
        });
        for (const t of stuck) {
          const updated = await updateTaskAndMirror(t.id, { status: "blocked" });
          if (updated) {
            const idx = refreshedTasks.findIndex((x) => x.id === t.id);
            if (idx >= 0) refreshedTasks[idx] = updated;
            await appendActivity(businessId, bt("chat.activityTaskBlocked", { task: t.title }), { metadata: { taskId: t.id, turnId } });
          }
        }
        break;
      }

      if (launch.length === 0) {
        // Tasks running — wait for one to settle (poll task rows).
        await new Promise((r) => setTimeout(r, 400));
        refreshedTasks = await businessTaskService.list(businessId);
        refreshedTasks = refreshedTasks.filter((t) => t.correlation_id === turnId);
        continue;
      }

      await Promise.allSettled(
        launch.map(async (task) => {
          const planIdx = taskRows.findIndex((t) => t.id === task.id);
          const planTask = plan.tasks[planIdx];
          const agent = planAgents[planIdx] ?? null;
          const agentName = agent?.name ?? "Main Agent";

          await updateTaskAndMirror(task.id, { status: "running", started_at: nowISO(), error: undefined });
          const idxLocal = refreshedTasks.findIndex((x) => x.id === task.id);
          if (idxLocal >= 0 && refreshedTasks[idxLocal]) {
            refreshedTasks[idxLocal] = { ...refreshedTasks[idxLocal], status: "running" };
          }

          await emitEvent({
            business_id: businessId,
            task_id: task.id,
            agent_id: agent?.id,
            event_type: "task.started",
            payload: { title: task.title },
            correlation_id: turnId,
          });
          await appendActivity(businessId, bt("chat.activityTaskStarted", { agent: agentName, task: task.title }), {
            agentId: agent?.id,
            metadata: { taskId: task.id, turnId },
          });
          if (agent) {
            const isResearch = /research|data/i.test(agent.role);
            await updateAgentAndMirror(agent.id, {
              status: isResearch ? "researching" : "working",
              current_task_id: task.id,
              last_activity: nowISO(),
            });
            await emitEvent({
              business_id: businessId,
              task_id: task.id,
              agent_id: agent.id,
              event_type: "agent.status_changed",
              payload: { status: isResearch ? "researching" : "working", task: task.title },
              correlation_id: turnId,
            });
          }

          const taskStart = Date.now();
          let outcome = await runSpecialist({
            business,
            agent,
            businessId,
            taskId: task.id,
            turnId,
            recordEvents: true,
            signal,
            mainCfg,
            taskTitle: task.title,
            taskDescription: task.description,
            upstreamContext: upstreamContextFor(task, refreshedTasks),
            collaborationQuestions: agent
              ? await collaborationQuestionsFor(businessId, agent.id, agents)
              : [],
            searchQueries: planTask?.search_queries ?? [],
          });

          // One task-level retry when the specialist call failed (not on abort).
          if (!outcome.ok && outcome.error !== "cancelled") {
            await updateTaskAndMirror(task.id, { retry_count: task.retry_count + 1 });
            await emitEvent({
              business_id: businessId,
              task_id: task.id,
              agent_id: agent?.id,
              event_type: "task.retried",
              payload: { title: task.title, retry_count: task.retry_count + 1 },
              correlation_id: turnId,
            });
            outcome = await runSpecialist({
              business,
              agent,
              businessId,
              taskId: task.id,
              turnId,
              recordEvents: false, // avoid duplicate browser.activity events
              signal,
              mainCfg,
              taskTitle: task.title,
              taskDescription: task.description,
              upstreamContext: upstreamContextFor(task, refreshedTasks),
              collaborationQuestions: agent ? await collaborationQuestionsFor(businessId, agent.id, agents) : [],
              searchQueries: planTask?.search_queries ?? [],
            });
          }

          const durationMs = Date.now() - taskStart;

          if (outcome.ok) {
            const question = extractAgentQuestion(outcome.output);
            const cleanOutput = question
              ? outcome.output.replace(/\{\s*"ask_agent"[\s\S]*?\}\s*$/, "").trim()
              : outcome.output;

            await updateTaskAndMirror(task.id, {
              status: "completed",
              completed_at: nowISO(),
              output_artifacts: {
                content: cleanOutput,
                summary: trimTo(cleanOutput, 300),
                sources: outcome.sources.slice(0, 8),
              },
              error: undefined,
            });
            await emitEvent({
              business_id: businessId,
              task_id: task.id,
              agent_id: agent?.id,
              event_type: "task.completed",
              payload: { title: task.title, durationMs },
              correlation_id: turnId,
            });
            await appendActivity(businessId, bt("chat.activityTaskCompleted", { agent: agentName, task: task.title }), {
              agentId: agent?.id,
              metadata: { taskId: task.id, turnId },
            });

            if (agent) {
              const m = agent.metrics;
              await updateAgentAndMirror(agent.id, {
                status: "idle",
                current_task_id: undefined,
                last_activity: nowISO(),
                metrics: {
                  tasks_completed: m.tasks_completed + 1,
                  tasks_failed: m.tasks_failed,
                  total_duration_ms: m.total_duration_ms + durationMs,
                  model_calls: m.model_calls + 1,
                },
              });
              await emitEvent({
                business_id: businessId,
                agent_id: agent.id,
                task_id: task.id,
                event_type: "agent.status_changed",
                payload: { status: "idle" },
                correlation_id: turnId,
              });
              await agentMessageService.append({
                business_id: businessId,
                task_id: task.id,
                sender_agent_id: agent.id,
                message_type: "task_completion",
                content: trimTo(cleanOutput, 500),
                correlation_id: turnId,
              });
              if (question) {
                const target = resolveAgentByName(question.agent, agents);
                if (target) {
                  await agentMessageService.append({
                    business_id: businessId,
                    task_id: task.id,
                    sender_agent_id: agent.id,
                    recipient_agent_id: target.id,
                    message_type: "information_request",
                    content: question.question,
                    correlation_id: turnId,
                  });
                }
              }
            }

            // Draft creation (permission + plan gated)
            let draftCreated = false;
            if (planTask?.produces_draft && (!agent || agent.permissions.create_drafts)) {
              const draft = await businessDraftService.create(businessId, {
                title: task.title,
                content: cleanOutput,
                draft_type: planTask.draft_type || "document",
                task_id: task.id,
                created_by_agent_id: agent?.id,
                approval_requirements: business.configuration.requireDraftApproval ? ["user_approval"] : [],
                sources: outcome.sources.slice(0, 8),
              });
              draftCreated = true;
              store().upsertDraft(draft);
              await emitEvent({
                business_id: businessId,
                task_id: task.id,
                agent_id: agent?.id,
                event_type: "draft.created",
                payload: { draftId: draft.id, title: draft.title, version: 1 },
                correlation_id: turnId,
              });
              if (business.configuration.requireDraftApproval) {
                await emitEvent({
                  business_id: businessId,
                  task_id: task.id,
                  agent_id: agent?.id,
                  event_type: "approval.requested",
                  payload: { draftId: draft.id, title: draft.title, version: 1 },
                  correlation_id: turnId,
                });
              }
              const agentMsg = await businessChatService.append(businessId, {
                role: "agent",
                agent_id: agent?.id,
                content: cleanOutput,
                metadata: { taskId: task.id, draftId: draft.id, sources: outcome.sources.slice(0, 8), turnId },
              });
              store().appendChatMessage(agentMsg);
            } else if (agent) {
              // Non-draft specialist contribution — still visible inline.
              const agentMsg = await businessChatService.append(businessId, {
                role: "agent",
                agent_id: agent.id,
                content: cleanOutput,
                metadata: { taskId: task.id, sources: outcome.sources.slice(0, 8), turnId },
              });
              store().appendChatMessage(agentMsg);
            }

            results.push({
              agent: agentName,
              title: task.title,
              status: "completed",
              content: cleanOutput,
              draftCreated,
              sources: outcome.sources.slice(0, 8),
            });
          } else {
            await updateTaskAndMirror(task.id, { status: "failed", error: outcome.error, completed_at: nowISO() });
            await emitEvent({
              business_id: businessId,
              task_id: task.id,
              agent_id: agent?.id,
              event_type: "task.failed",
              payload: { title: task.title, error: outcome.error },
              correlation_id: turnId,
            });
            await emitEvent({
              business_id: businessId,
              event_type: "notification",
              payload: { kind: "task_failed", task: task.title, error: outcome.error },
              correlation_id: turnId,
            });
            await appendActivity(businessId, bt("chat.activityTaskFailed", { agent: agentName, task: task.title }), {
              agentId: agent?.id,
              metadata: { taskId: task.id, turnId },
            });
            if (agent) {
              const m = agent.metrics;
              await updateAgentAndMirror(agent.id, {
                status: "idle",
                current_task_id: undefined,
                last_activity: nowISO(),
                metrics: {
                  tasks_completed: m.tasks_completed,
                  tasks_failed: m.tasks_failed + 1,
                  total_duration_ms: m.total_duration_ms,
                  model_calls: m.model_calls + 1,
                },
              });
              await emitEvent({
                business_id: businessId,
                agent_id: agent.id,
                event_type: "agent.status_changed",
                payload: { status: "idle" },
                correlation_id: turnId,
              });
            }
            results.push({
              agent: agentName,
              title: task.title,
              status: "failed",
              content: "",
              draftCreated: false,
              sources: [],
              error: outcome.error,
            });
          }

          const localIdx = refreshedTasks.findIndex((x) => x.id === task.id);
          const fresh = await businessTaskService.get(task.id);
          if (localIdx >= 0 && fresh) refreshedTasks[localIdx] = fresh;
        }),
      );
    }

    // 10. Consolidation (streamed Main Agent synthesis)
    await appendActivity(businessId, bt("chat.activityConsolidating"), { metadata: { turnId } });
    await streamMainMessage(businessId, {
      systemPrompt: buildMainChatSystemPrompt(business, memory),
      userPrompt: buildConsolidationUserPrompt({ userMessage: content, results }),
      cfg: mainCfg,
      temperature: business.configuration.mainTemperature,
      signal,
      turnId,
    });

    // 11. Memory capture (verified research only, capped)
    let captured = 0;
    for (const r of results) {
      if (captured >= 3) break;
      if (r.status !== "completed" || !r.sources.length) continue;
      const agent = agents.find((a) => a.name === r.agent);
      if (agent && !agent.permissions.write_memory) continue;
      await businessMemoryService.create(businessId, {
        memory_type: "research",
        content: `${r.title}: ${trimTo(r.content, 280)}\nSources: ${r.sources.slice(0, 3).map((s) => s.url).join(", ")}`,
        source: "web research",
        verification_status: "verified",
      });
      captured++;
    }
    if (captured > 0) {
      await emitEvent({
        business_id: businessId,
        event_type: "memory.updated",
        payload: { captured },
        correlation_id: turnId,
      });
      const mem = await businessMemoryService.list(businessId);
      useBusinessStore.setState({ memory: mem });
    }

    await finishTurn(businessId, turnId, startedAt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (turnRegistry.get(businessId)?.turnId === turnId) {
      try {
        await appendActivity(businessId, `⚠️ ${trimTo(message, 300)}`, { metadata: { turnId } });
        await emitEvent({
          business_id: businessId,
          event_type: "notification",
          payload: { kind: "turn_error", error: trimTo(message, 300) },
          correlation_id: turnId,
        });
      } catch {
        // best-effort reporting
      }
      await finishTurn(businessId, turnId, startedAt);
    }
  }
}

async function streamMainMessage(
  businessId: string,
  opts: {
    systemPrompt: string;
    userPrompt: string;
    cfg: BusinessLlmConfig;
    temperature?: number;
    signal: AbortSignal;
    turnId: string;
  },
): Promise<void> {
  const placeholder = await businessChatService.append(businessId, {
    role: "main",
    content: "",
    metadata: { streaming: true, turnId: opts.turnId },
  });
  store().appendChatMessage(placeholder);

  try {
    const res = await businessLlmStream(opts.cfg, {
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
      temperature: opts.temperature,
      signal: opts.signal,
      onDelta: (text) => {
        store().updateChatMessage(placeholder.id, { content: text });
      },
    });
    const metadata = { streaming: false, turnId: opts.turnId, usage: res.usage };
    await businessChatService.update(placeholder.id, { content: res.text, metadata });
    store().updateChatMessage(placeholder.id, { content: res.text, metadata });
  } catch (err) {
    const aborted = opts.signal.aborted;
    const partial = aborted ? "…" : "";
    const message = aborted
      ? bt("chat.activityCancelled")
      : `⚠️ ${trimTo(err instanceof Error ? err.message : String(err), 300)}`;
    await businessChatService.update(placeholder.id, {
      content: partial,
      metadata: { streaming: false, cancelled: aborted, turnId: opts.turnId },
    });
    store().updateChatMessage(placeholder.id, { content: partial, metadata: { cancelled: aborted, streaming: false } });
    if (!aborted) await appendActivity(businessId, message, { metadata: { turnId: opts.turnId } });
    if (!aborted) throw err;
  }
}

async function finishTurn(businessId: string, turnId: string, startedAt: number): Promise<void> {
  const owns = turnRegistry.get(businessId)?.turnId === turnId;
  if (owns) turnRegistry.delete(businessId);
  unregisterBusinessTurnHandoff(businessId); // the turn settled — nothing to hand off
  store().setTurnRunning(false);
  await emitEvent({
    business_id: businessId,
    event_type: "turn.completed",
    payload: { turnId, durationMs: Date.now() - startedAt },
    correlation_id: turnId,
  });
  await appendActivity(businessId, bt("chat.activityTurnCompleted", { duration: humanizeDuration(Date.now() - startedAt) }), {
    metadata: { turnId },
  });
}

// ---------------------------------------------------------------------------
// Cancel / retry / test
// ---------------------------------------------------------------------------

export async function cancelBusinessTurn(businessId: string): Promise<void> {
  const handle = turnRegistry.get(businessId);
  if (!handle) return;
  handle.controller.abort();
  unregisterBusinessTurnHandoff(businessId); // explicit cancel — no cloud handoff

  const tasks = await businessTaskService.list(businessId);
  for (const task of tasks) {
    if (task.status === "running" || task.status === "blocked") {
      await updateTaskAndMirror(task.id, { status: "cancelled", error: "Cancelled by user" });
      await emitEvent({
        business_id: businessId,
        task_id: task.id,
        agent_id: task.assigned_agent_id,
        event_type: "task.cancelled",
        payload: { title: task.title },
        correlation_id: handle.turnId,
      });
    }
  }

  const agents = await businessAgentService.list(businessId);
  for (const agent of agents) {
    if (agent.current_task_id || agent.status === "working" || agent.status === "researching") {
      await updateAgentAndMirror(agent.id, { status: "idle", current_task_id: undefined });
      await emitEvent({
        business_id: businessId,
        agent_id: agent.id,
        event_type: "agent.status_changed",
        payload: { status: "idle" },
        correlation_id: handle.turnId,
      });
    }
  }

  turnRegistry.delete(businessId);
  store().setTurnRunning(false);
  await emitEvent({
    business_id: businessId,
    event_type: "turn.cancelled",
    payload: { turnId: handle.turnId },
    correlation_id: handle.turnId,
  });
  await appendActivity(businessId, bt("chat.activityCancelled"), { metadata: { turnId: handle.turnId } });
}

export async function retryBusinessTask(taskId: string): Promise<void> {
  const task = await businessTaskService.get(taskId);
  if (!task) throw new Error("Task not found");
  const business = await businessService.get(task.business_id);
  if (!business) throw new Error("Business not found");
  const agent = task.assigned_agent_id
    ? ((await businessAgentService.get(task.assigned_agent_id)) ?? null)
    : null;
  const agents = await businessAgentService.list(task.business_id);

  await updateTaskAndMirror(task.id, { status: "running", error: undefined, retry_count: task.retry_count + 1 });
  await emitEvent({
    business_id: task.business_id,
    task_id: task.id,
    agent_id: agent?.id,
    event_type: "task.retried",
    payload: { title: task.title, retry_count: task.retry_count + 1 },
  });
  await appendActivity(task.business_id, bt("chat.activityTaskStarted", { agent: agent?.name ?? "Main Agent", task: task.title }), {
    agentId: agent?.id,
    metadata: { taskId: task.id },
  });

  const allTasks = await businessTaskService.list(task.business_id);
  const outcome = await runSpecialist({
    business,
    agent,
    businessId: task.business_id,
    taskId: task.id,
    recordEvents: true,
    taskTitle: task.title,
    taskDescription: task.description,
    upstreamContext: upstreamContextFor(task, allTasks),
    collaborationQuestions: agent ? await collaborationQuestionsFor(task.business_id, agent.id, agents) : [],
    searchQueries: [],
  });

  if (outcome.ok) {
    await updateTaskAndMirror(task.id, {
      status: "completed",
      completed_at: nowISO(),
      output_artifacts: { content: outcome.output, summary: trimTo(outcome.output, 300), sources: outcome.sources.slice(0, 8) },
    });
    await emitEvent({
      business_id: task.business_id,
      task_id: task.id,
      agent_id: agent?.id,
      event_type: "task.completed",
      payload: { title: task.title, retried: true },
    });
    await appendActivity(task.business_id, bt("chat.activityTaskCompleted", { agent: agent?.name ?? "Main Agent", task: task.title }), {
      agentId: agent?.id,
      metadata: { taskId: task.id },
    });
    if (agent) {
      const msg = await businessChatService.append(task.business_id, {
        role: "agent",
        agent_id: agent.id,
        content: outcome.output,
        metadata: { taskId: task.id, sources: outcome.sources.slice(0, 8) },
      });
      store().appendChatMessage(msg);
    }
  } else {
    await updateTaskAndMirror(task.id, { status: "failed", error: outcome.error });
    await emitEvent({
      business_id: task.business_id,
      task_id: task.id,
      agent_id: agent?.id,
      event_type: "task.failed",
      payload: { title: task.title, error: outcome.error },
    });
    await appendActivity(task.business_id, bt("chat.activityTaskFailed", { agent: agent?.name ?? "Main Agent", task: task.title }), {
      agentId: agent?.id,
      metadata: { taskId: task.id },
    });
  }
}

export async function runAgentTest(
  businessId: string,
  agentId: string,
  testInput?: string,
): Promise<string> {
  const business = await businessService.get(businessId);
  const agent = await businessAgentService.get(agentId);
  if (!business || !agent) throw new Error("Agent or business not found");

  const outcome = await runSpecialist({
    business,
    agent,
    businessId,
    recordEvents: false,
    taskTitle: "Test execution",
    taskDescription:
      testInput?.trim() || "Draft a one-paragraph summary of what you do for this business and how you work with the team.",
    timeoutMs: 120_000,
  });
  if (!outcome.ok) {
    throw new Error(bt("agent.test.failed", { error: outcome.error ?? "unknown error" }));
  }
  return outcome.output;
}
