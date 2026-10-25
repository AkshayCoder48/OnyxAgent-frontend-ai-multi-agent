"use client";

// ============================================================================
// manage_business — the agent's REAL Business Mode surface (Task 2-d / PRD
// §6): businesses with specialist agent teams the user opens at
// /business/{id}. Registered once here; normal chat, project chat and the
// orchestrator share ONE runtime, so this single registration covers all
// three contexts.
//
//   - create               → a REAL business via createBusinessFromSpec (the
//                            no-LLM canonical persistBusiness path: business
//                            row + agents + backlog tasks + events + live
//                            store refresh). The calling agent composes the
//                            spec (2-5 specialist agents) from the request.
//   - create_from_template → createBusinessFromTemplate (8 canned team
//                            blueprints, src/lib/business/templates.ts).
//   - list / get / status  → honest reads over the client-side Dexie
//                            services (src/lib/business/data.ts).
//   - update               → snake_case row patch; goals merge; operating
//                            instructions appended to the business profile.
//   - manage_agents        → add/update/remove a business's specialist
//                            agents (prompt_config edits version-bump exactly
//                            like the workspace's agent sheet does).
//   - delete               → cascade remove (+ live store refresh).
//
// EVERY action calls the actual services — nothing simulated, nothing
// UI-only. Every business_id operation verifies the row belongs to the
// CURRENT user (owner check), so one user can never read or mutate
// another's business. Service errors are caught and returned as
// { error } — success is NEVER claimed when a call failed.
//
// NOTE on `requires_approval`: the registry flag is static (per tool), so it
// is false here — read/create/update actions should stay frictionless. The
// destructive verbs (action "delete", manage_agents agent_action "remove")
// are gated by the ARGUMENT-AWARE approval defaults
// (SENSITIVE_TOOL_DEFAULTS in src/lib/projects/permissions.ts), the same
// mechanism manage_env_var uses.
// ============================================================================

import { nanoid } from "nanoid";
import { registerTool } from "./registry";
import {
  businessAgentService,
  businessEventService,
  businessService,
  businessTaskService,
} from "@/lib/business/data";
import type {
  BusinessAgentRow,
  BusinessRow,
  BusinessStatus,
} from "@/lib/business/types";

/** The 8 template keys accepted by create_from_template. */
const TEMPLATE_KEYS: readonly string[] = [
  "online-store",
  "content-agency",
  "software-startup",
  "freelance-service",
  "local-service",
  "digital-products",
  "marketing-agency",
  "research-workspace",
];

/** Valid business statuses (update action). */
const BUSINESS_STATUSES: readonly BusinessStatus[] = ["setup", "active", "archived"];

/** Task statuses that mean finished work (status action's "open" count). */
const DONE_TASK_STATUSES: readonly string[] = ["completed", "failed", "cancelled"];

/** list action caps total agent-count work at the 20 most recent businesses. */
const MAX_LIST_BUSINESSES = 20;
/** Description preview length in list results. */
const LIST_DESC_CHARS = 120;

// ---------------------------------------------------------------------------
// Arg coercion helpers (args arrive as unknown JSON).
// ---------------------------------------------------------------------------

/** Trimmed non-empty string, or undefined. */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Non-empty trimmed string array, or undefined. */
function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim());
  return out.length > 0 ? out : undefined;
}

/** One-line excerpt (whitespace collapsed, capped with an ellipsis). */
function clip(text: string, max: number): string {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The spec agents the LLM composed (create action) — name required, role
 *  falls back to the name; junk entries are dropped, never fabricated. */
function parseSpecAgents(v: unknown): { name: string; role: string; description?: string; instructions?: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { name: string; role: string; description?: string; instructions?: string }[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) continue;
    const a = item as Record<string, unknown>;
    const name = str(a.name);
    if (!name) continue;
    const role = str(a.role) ?? name;
    out.push({
      name,
      role,
      description: str(a.description),
      instructions: str(a.instructions),
    });
  }
  return out;
}

/** Initial backlog tasks (create action) — title required. */
function parseInitialTasks(
  v: unknown,
): { title: string; description?: string; agent_role?: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { title: string; description?: string; agent_role?: string }[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) continue;
    const t = item as Record<string, unknown>;
    const title = str(t.title);
    if (!title) continue;
    out.push({
      title,
      description: str(t.description),
      agent_role: str(t.agent_role),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared resolution + store refresh helpers.
// ---------------------------------------------------------------------------

/** Resolve a business AND verify it belongs to the current user — a foreign
 *  id is "not found" from this caller's point of view (same strict-scoping
 *  precedent as project_memory's same-project check). */
async function resolveOwnedBusiness(
  businessId: string,
  userId: string,
): Promise<BusinessRow | null> {
  const row = await businessService.get(businessId).catch(() => undefined);
  return row && row.owner_id === userId ? row : null;
}

/** Refresh the live business list (+ the workspace's active row when the
 *  touched business is open). Uses the store's existing actions only. */
async function refreshBusinessStore(businessId?: string): Promise<void> {
  const { useBusinessStore } = await import("@/stores/business-store");
  const store = useBusinessStore.getState();
  await store.loadBusinesses();
  if (businessId && store.activeBusinessId === businessId) {
    const fresh = await businessService.get(businessId).catch(() => undefined);
    if (fresh) store.setBusiness(fresh);
  }
}

/** Task status counts (get + status actions). */
function countByStatus(tasks: { status: string }[]): Record<string, number> {
  const byStatus: Record<string, number> = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  return byStatus;
}

// ---------------------------------------------------------------------------
// The tool.
// ---------------------------------------------------------------------------

registerTool(
  "manage_business",
  "Create and manage Business Mode workspaces — businesses with specialist agent teams the user can open at /business. Actions: create (from a structured spec), create_from_template, list, get, update, manage_agents, status, delete.",
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "create_from_template", "list", "get", "update", "manage_agents", "status", "delete"],
        description:
          "create: new business from a structured spec (compose 2-5 agents from the request). create_from_template: new business from a canned team blueprint. list: the user's businesses. get: one business's details. update: change business fields. manage_agents: add/update/remove a specialist agent. status: compact operational summary. delete: remove a business and all its data.",
      },
      name: {
        type: "string",
        description: "create/create_from_template/update — the business name (required for create*).",
      },
      description: {
        type: "string",
        description: "create/update — what the business does (one or two sentences).",
      },
      instructions: {
        type: "string",
        description: "create/update — operating instructions / mission for the business (how the team should work).",
      },
      industry: { type: "string", description: "create/update — the industry, e.g. e-commerce, content." },
      business_model: { type: "string", description: "create/update — how it makes money." },
      target_customers: { type: "string", description: "create/update — who it serves." },
      geography: { type: "string", description: "create/update — where it operates." },
      goals: {
        type: "array",
        items: { type: "string" },
        description: "create/update — business goals (short, measurable statements).",
      },
      template: {
        type: "string",
        enum: TEMPLATE_KEYS,
        description: "create_from_template — the team blueprint to instantiate.",
      },
      idea: {
        type: "string",
        description: "create_from_template — the user's idea/description for the business.",
      },
      agents: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Agent display name." },
            role: { type: "string", description: "Role key, e.g. research | marketing | content | operations | finance | developer." },
            description: { type: "string", description: "What this specialist covers." },
            instructions: { type: "string", description: "Operating instructions (system prompt) for the agent." },
          },
          required: ["name", "role"],
          additionalProperties: false,
        },
        description: "create — the specialist team (compose 2-5 agents that cover the request; each needs name + role).",
      },
      initial_tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Task title." },
            description: { type: "string", description: "What the task involves." },
            agent_role: { type: "string", description: "Role (or name) of the agent that should own it." },
          },
          required: ["title"],
          additionalProperties: false,
        },
        description: "create — initial backlog tasks for the team.",
      },
      status: {
        type: "string",
        enum: BUSINESS_STATUSES,
        description: "update — the business status.",
      },
      business_id: {
        type: "string",
        description: "get/update/manage_agents/status/delete — the target business id.",
      },
      agent_action: {
        type: "string",
        enum: ["add", "update", "remove"],
        description: "manage_agents — the agent operation.",
      },
      agent: {
        type: "object",
        properties: {
          id: { type: "string", description: "Agent id (required for update/remove; omit for add)." },
          name: { type: "string", description: "Agent display name." },
          role: { type: "string", description: "Role key." },
          description: { type: "string", description: "What this specialist covers." },
          instructions: { type: "string", description: "Operating instructions (system prompt)." },
          paused: { type: "boolean", description: "Pause / resume the agent (update)." },
        },
        additionalProperties: false,
        description: "manage_agents — the agent to add/update/remove (add omits id; update/remove require id).",
      },
      include_agents: {
        type: "boolean",
        default: true,
        description: "get — include the agent roster (default true).",
      },
      include_tasks: {
        type: "boolean",
        default: true,
        description: "get — include task status counts (default true).",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const action = String(args.action ?? "");

    try {
      switch (action) {
        // ── create — structured spec, no discovery LLM ─────────────────────
        case "create": {
          const name = str(args.name);
          if (!name) return { error: "name is required for action 'create'" };
          const description = str(args.description);
          const instructions = str(args.instructions);
          const agents = parseSpecAgents(args.agents);
          const initialTasks = parseInitialTasks(args.initial_tasks);
          // 0 agents is allowed (noted in the result — the business then has
          // only its Main Agent until agents are added); createBusinessFromSpec
          // itself throws on an empty NAME only.
          // Lazy import keeps the registry-side module graph lean (the
          // orchestrator pulls the whole business LLM stack; it is only
          // needed on the create paths — same pattern as permissions.ts).
          const { createBusinessFromSpec } = await import("@/lib/business/orchestrator");
          const businessId = await createBusinessFromSpec({
            name,
            description,
            idea: description,
            industry: str(args.industry),
            businessModel: str(args.business_model),
            targetCustomers: str(args.target_customers),
            geography: str(args.geography),
            instructions,
            goals: strArray(args.goals),
            agents,
            initialTasks,
          });
          // persistBusiness already refreshed the store — report the REAL
          // roster it created (not the spec we passed in).
          const created = await businessAgentService.list(businessId);
          return {
            ok: true,
            business_id: businessId,
            url: `/business/${businessId}`,
            name,
            agents: created.map((a) => a.name),
            note:
              agents.length === 0
                ? "Business created with NO specialist agents — the user can chat with its Main Agent at /business/{id}; suggest adding agents via manage_agents action add."
                : "Business created — the user can open it at /business/{id} and chat with its Main Agent.",
          };
        }

        // ── create_from_template — canned team blueprint ───────────────────
        case "create_from_template": {
          const name = str(args.name);
          if (!name) return { error: "name is required for action 'create_from_template'" };
          const template = str(args.template);
          if (!template) {
            return { error: `template is required for action 'create_from_template' (one of: ${TEMPLATE_KEYS.join(", ")})` };
          }
          if (!TEMPLATE_KEYS.includes(template)) {
            return { error: `Unknown template "${template}" — valid keys: ${TEMPLATE_KEYS.join(", ")}` };
          }
          const idea = str(args.idea) ?? str(args.description) ?? "";
          try {
            const { createBusinessFromTemplate } = await import("@/lib/business/orchestrator");
            const businessId = await createBusinessFromTemplate(template, { name, idea });
            const created = await businessAgentService.list(businessId);
            return {
              ok: true,
              business_id: businessId,
              url: `/business/${businessId}`,
              name,
              agents: created.map((a) => a.name),
              note: "Business created — the user can open it at /business/{id} and chat with its Main Agent.",
            };
          } catch (err) {
            // createBusinessFromTemplate throws "Unknown template" for bad
            // keys — surface the real error.
            return { error: err instanceof Error ? err.message : String(err) };
          }
        }

        // ── list — the user's businesses ───────────────────────────────────
        case "list": {
          if (!ctx.userId) return { error: "No user context — cannot list businesses." };
          const rows = await businessService.list(ctx.userId);
          const capped = rows.slice(0, MAX_LIST_BUSINESSES);
          const businesses = await Promise.all(
            capped.map(async (b) => {
              const agents = await businessAgentService.list(b.id).catch(() => [] as BusinessAgentRow[]);
              return {
                business_id: b.id,
                name: b.name,
                description: clip(b.description, LIST_DESC_CHARS),
                status: b.status,
                agents: agents.length,
                url: `/business/${b.id}`,
              };
            }),
          );
          return {
            ok: true,
            total: rows.length,
            businesses,
            note: rows.length > capped.length
              ? `Showing the ${capped.length} most recent businesses of ${rows.length}.`
              : undefined,
          };
        }

        // ── get — one business's details ───────────────────────────────────
        case "get": {
          const businessId = str(args.business_id);
          if (!businessId) return { error: "business_id is required for this action" };
          const business = await resolveOwnedBusiness(businessId, ctx.userId);
          if (!business) return { error: `No such business for this user: ${businessId}` };
          const includeAgents = args.include_agents !== false;
          const includeTasks = args.include_tasks !== false;
          const [agents, tasks] = await Promise.all([
            includeAgents ? businessAgentService.list(businessId) : Promise.resolve([]),
            includeTasks ? businessTaskService.list(businessId) : Promise.resolve([]),
          ]);
          return {
            ok: true,
            business_id: business.id,
            name: business.name,
            description: business.description,
            status: business.status,
            industry: business.industry ?? null,
            business_model: business.business_model ?? null,
            target_customers: business.target_customers ?? null,
            geography: business.geography ?? null,
            template: business.template ?? null,
            goals: business.goals.map((g) => ({ title: g.title, status: g.status })),
            profile_chars: (business.business_profile ?? "").length,
            ...(includeAgents
              ? {
                  agents: agents.map((a) => ({
                    agent_id: a.id,
                    name: a.name,
                    role: a.role,
                    status: a.status,
                    paused: a.paused,
                  })),
                }
              : {}),
            ...(includeTasks
              ? { tasks: { total: tasks.length, by_status: countByStatus(tasks) } }
              : {}),
            created_at: business.created_at,
            updated_at: business.updated_at,
            url: `/business/${business.id}`,
          };
        }

        // ── update — patch business fields ─────────────────────────────────
        case "update": {
          const businessId = str(args.business_id);
          if (!businessId) return { error: "business_id is required for this action" };
          const business = await resolveOwnedBusiness(businessId, ctx.userId);
          if (!business) return { error: `No such business for this user: ${businessId}` };

          // camelCase tool args → the row's snake_case fields (BusinessRow).
          const patch: Partial<Omit<BusinessRow, "id" | "owner_id">> = {};
          const updatedFields: string[] = [];
          const name = str(args.name);
          if (name) {
            patch.name = name;
            updatedFields.push("name");
          }
          const description = str(args.description);
          if (description) {
            patch.description = description;
            updatedFields.push("description");
          }
          const instructions = str(args.instructions);
          if (instructions) {
            // Append (or replace) an "Operating instructions" section on the
            // editable markdown profile — same section title
            // createBusinessFromSpec writes, so the two paths agree.
            const stripOld = (business.business_profile ?? "").replace(
              /##\s*Operating instructions[\s\S]*?(?=\n##\s|$)/,
              "",
            );
            const base = stripOld.trim();
            patch.business_profile = `${base}${base ? "\n\n" : ""}## Operating instructions\n\n${instructions}`;
            updatedFields.push("instructions");
          }
          const industry = str(args.industry);
          if (industry) {
            patch.industry = industry;
            updatedFields.push("industry");
          }
          const businessModel = str(args.business_model);
          if (businessModel) {
            patch.business_model = businessModel;
            updatedFields.push("business_model");
          }
          const targetCustomers = str(args.target_customers);
          if (targetCustomers) {
            patch.target_customers = targetCustomers;
            updatedFields.push("target_customers");
          }
          const geography = str(args.geography);
          if (geography) {
            patch.geography = geography;
            updatedFields.push("geography");
          }
          const status = str(args.status) as BusinessStatus | undefined;
          if (status) {
            if (!BUSINESS_STATUSES.includes(status)) {
              return { error: `Invalid status "${status}" — use one of: ${BUSINESS_STATUSES.join(", ")}` };
            }
            patch.status = status;
            updatedFields.push("status");
          }
          const goals = strArray(args.goals);
          if (goals) {
            // Merge: append goals not already present (by title) as
            // "proposed" — an update never silently discards existing goals.
            const existing = business.goals ?? [];
            const titles = new Set(existing.map((g) => g.title.trim().toLowerCase()));
            const additions = goals
              .filter((t) => !titles.has(t.toLowerCase()))
              .map((t) => ({ id: nanoid(), title: t, status: "proposed" as const }));
            patch.goals = [...existing, ...additions];
            updatedFields.push(`goals(+${additions.length})`);
          }
          if (updatedFields.length === 0) {
            return { error: "Nothing to update — pass at least one of name, description, instructions, industry, business_model, target_customers, geography, status, goals." };
          }

          await businessService.update(businessId, patch);
          await businessEventService.append({
            business_id: businessId,
            event_type: "business.updated",
            payload: { fields: updatedFields },
          });
          await refreshBusinessStore(businessId);
          return { ok: true, business_id: businessId, updated_fields: updatedFields, url: `/business/${businessId}` };
        }

        // ── manage_agents — roster add/update/remove ───────────────────────
        case "manage_agents": {
          const businessId = str(args.business_id);
          if (!businessId) return { error: "business_id is required for this action" };
          const business = await resolveOwnedBusiness(businessId, ctx.userId);
          if (!business) return { error: `No such business for this user: ${businessId}` };
          const agentAction = str(args.agent_action);
          if (!agentAction || !["add", "update", "remove"].includes(agentAction)) {
            return { error: "agent_action is required for action 'manage_agents' (add, update or remove)" };
          }
          const rawAgent = args.agent;
          if (typeof rawAgent !== "object" || rawAgent === null) {
            return { error: "agent is required for action 'manage_agents'" };
          }
          const a = rawAgent as Record<string, unknown>;

          // ---- add ----
          if (agentAction === "add") {
            const name = str(a.name);
            if (!name) return { error: "agent.name is required for agent_action 'add'" };
            const role = str(a.role) ?? name;
            const description =
              str(a.description) ?? `${role} specialist on the ${business.name} team.`;
            const instructions =
              str(a.instructions) ?? `You are ${name}, the ${role} of ${business.name}.`;
            const row = await businessAgentService.create(businessId, {
              name,
              description,
              role,
              prompt_config: {
                system_instructions: instructions,
                role_definition: description,
              },
            });
            await businessEventService.append({
              business_id: businessId,
              agent_id: row.id,
              event_type: "agent.created",
              payload: { name: row.name, role: row.role },
            });
            await refreshRoster(businessId, row);
            return { ok: true, agent_id: row.id, action: "add", name: row.name, role: row.role, business_id: businessId };
          }

          // update/remove both target one existing agent id.
          const agentId = str(a.id);
          if (!agentId) return { error: `agent.id is required for agent_action '${agentAction}'` };
          const existing = await businessAgentService.get(agentId).catch(() => undefined);
          if (!existing || existing.business_id !== businessId) {
            return { error: `No such agent in this business: ${agentId}` };
          }

          // ---- update ----
          if (agentAction === "update") {
            const patch: Partial<Omit<BusinessAgentRow, "id" | "business_id">> = {};
            const name = str(a.name);
            if (name) patch.name = name;
            const description = str(a.description);
            if (description) patch.description = description;
            const role = str(a.role);
            if (role) patch.role = role;
            if (typeof a.paused === "boolean") {
              // Same status pairing the workspace's pause toggle uses.
              patch.paused = a.paused;
              patch.status = a.paused ? "paused" : "idle";
            }
            const instructions = str(a.instructions);
            if (instructions) {
              // prompt_config patches are SHALLOW (Dexie update) — rebuild the
              // full config and version-bump it exactly like the agent sheet.
              const pc = existing.prompt_config;
              patch.prompt_config = {
                ...pc,
                system_instructions: instructions,
                role_definition: description ?? pc.role_definition,
                version: pc.version + 1,
                history: [
                  { version: pc.version, system_instructions: pc.system_instructions, saved_at: existing.updated_at },
                  ...pc.history,
                ].slice(0, 20),
              };
            }
            if (Object.keys(patch).length === 0) {
              return { error: "Nothing to update — pass agent name, role, description, instructions or paused." };
            }
            await businessAgentService.update(agentId, patch);
            const fresh = (await businessAgentService.get(agentId)) ?? undefined;
            await businessEventService.append({
              business_id: businessId,
              agent_id: agentId,
              event_type: "agent.updated",
              payload: { name: fresh?.name ?? existing.name },
            });
            if (fresh) await refreshRoster(businessId, fresh);
            return { ok: true, agent_id: agentId, action: "update", business_id: businessId };
          }

          // ---- remove ----
          await businessAgentService.remove(agentId);
          await businessEventService.append({
            business_id: businessId,
            agent_id: agentId,
            event_type: "agent.deleted",
            payload: { name: existing.name, role: existing.role },
          });
          await refreshRoster(businessId, null, agentId);
          return { ok: true, agent_id: agentId, action: "remove", business_id: businessId };
        }

        // ── status — compact operational summary ───────────────────────────
        case "status": {
          const businessId = str(args.business_id);
          if (!businessId) return { error: "business_id is required for this action" };
          const business = await resolveOwnedBusiness(businessId, ctx.userId);
          if (!business) return { error: `No such business for this user: ${businessId}` };
          const [agents, tasks] = await Promise.all([
            businessAgentService.list(businessId),
            businessTaskService.list(businessId),
          ]);
          const byStatus = countByStatus(tasks);
          const open = tasks.filter((t) => !DONE_TASK_STATUSES.includes(t.status)).length;
          return {
            ok: true,
            business_id: businessId,
            name: business.name,
            status: business.status,
            automation: business.configuration.automationLevel,
            agents: agents.map((a) => ({
              name: a.name,
              role: a.role,
              status: a.status,
              paused: a.paused,
            })),
            tasks: { total: tasks.length, open, by_status: byStatus },
            updated_at: business.updated_at,
            url: `/business/${businessId}`,
          };
        }

        // ── delete — cascade remove (approval-gated by SENSITIVE_TOOL_DEFAULTS)
        case "delete": {
          const businessId = str(args.business_id);
          if (!businessId) return { error: "business_id is required for this action" };
          const business = await resolveOwnedBusiness(businessId, ctx.userId);
          if (!business) return { error: `No such business for this user: ${businessId}` };
          await businessService.remove(businessId);
          const { useBusinessStore } = await import("@/stores/business-store");
          const store = useBusinessStore.getState();
          await store.loadBusinesses();
          // If the deleted business was open in the workspace, clear the
          // active pointer so the workspace never shows deleted data.
          if (store.activeBusinessId === businessId) {
            await store.openBusiness(null);
          }
          return { ok: true, deleted: businessId };
        }

        default:
          return {
            error: `Unknown action "${action}" — use create, create_from_template, list, get, update, manage_agents, status or delete.`,
          };
      }
    } catch (err) {
      // NEVER claim success when a call failed — surface the real error.
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
  false,
  "business",
);

/** Sync the touched agent into the live workspace roster — upsertAgent /
 *  removeAgent are the store's precise per-agent refresh actions (used only
 *  when the target business is the active one). */
async function refreshRoster(
  businessId: string,
  upsert?: BusinessAgentRow | null,
  removeId?: string,
): Promise<void> {
  const { useBusinessStore } = await import("@/stores/business-store");
  const store = useBusinessStore.getState();
  if (store.activeBusinessId !== businessId) return;
  if (upsert) store.upsertAgent(upsert);
  if (removeId) store.removeAgent(removeId);
}
