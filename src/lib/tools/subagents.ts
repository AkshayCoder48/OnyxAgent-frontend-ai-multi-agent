"use client";

import { registerTool } from "./registry";
import { nanoid } from "nanoid";
import { useSubagentStore, type SubagentConfig } from "@/stores/subagent-store";
import { bumpWorkspaceVersion } from "./workspace-snapshot";

/**
 * Subagent orchestration tools — lets the main AI act as an orchestrator that
 * spawns, monitors, steers, and cancels "subagent" tasks. Each task is a
 * logical unit of background work (e.g. "research X", "write code for Y",
 * "analyze file Z") that the orchestrator delegates.
 *
 * API-ONLY SUBAGENTS (2026-11-25): there is NO sub-agent chat UI anymore.
 * The AI interacts with subagents exclusively through these tools, and every
 * tool call + result surfaces in the MAIN workspace chat through the normal
 * tool-call rendering. Subagent execution is real — each query_subagent /
 * spawn delivers into a subagent chat session (subagent-runtime streams the
 * subagent LLM into it), and read_chat can snapshot the live session.
 */

interface SubagentTask {
  task_id: string;
  subagent_name: string;
  subagent_id?: string;
  description: string;
  status: "pending" | "running" | "waiting_for_answer" | "completed" | "failed" | "cancelled" | "retrying" | "disposed";
  error: string | null;
  created_at: string;
  messages: Array<{ type: string; text: string; timestamp: string }>;
  /** Whether this task's agent should auto-dispose on completion. */
  disposable: boolean;
  /** Specialization role (e.g. "Frontend Engineer"). */
  role?: string;
  /** Parent task that spawned this one (for nested orchestration). */
  parent_task?: string;
  /** The chat session query_subagent delivered the task message into —
   *  poll_subagent reads the LIVE assistant output from it. */
  chat_session_id?: string;
  /** The streaming assistant message carrying the reply (delivery receipt's
   *  assistantMessageId) — poll_subagent's partial-output reader. */
  reply_message_id?: string;
  /** Epoch ms of the last poll_subagent observation — lets the orchestrator
   *  distinguish "making progress between polls" from "output frozen". */
  last_poll_at?: number;
  /** Output length observed by the last poll_subagent call — the next poll
   *  compares against it for the \`grew\` flag + stall detection. */
  last_poll_output_len?: number;
}

// In-memory task store (shared across all tool invocations in the session).
const taskStore = new Map<string, SubagentTask>();

/**
 * Coerce a model-supplied "boolean" into a real boolean. Models routinely
 * send strings ("True", "false", "yes") for declared boolean fields; a plain
 * truthiness check would treat "false" as TRUE (e.g. wrongly disposing an
 * agent). Only unambiguous truthy spellings count as true.
 */
function coerceBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["true", "yes", "1"].includes(v.trim().toLowerCase());
  return Boolean(v);
}

/**
 * Pick the first non-empty string from a list of candidate argument keys.
 * Models mix up argument names (task vs description, role vs subagent_name —
 * user report 2026-11-25: spawn_subagent got {role, task, disposable:"True"}
 * and crashed on subagentName.toLowerCase()); aliases keep those calls
 * working instead of dying on undefined.
 */
function pickStr(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

// === Tool: spawn_subagent ===
// Creates a new subagent task with a name, description, and task type.
registerTool(
  "spawn_subagent",
  `Spawn a new subagent task to delegate work as an orchestrator. Use this to break complex tasks into parallel or sequential sub-tasks. Each subagent runs independently and reports status back. You can then steer, query, or cancel them. Returns the task_id.

When to use:
- Breaking a complex request into smaller pieces (e.g. "research A", "write B", "test C")
- Running background work while you continue helping the user
- Delegating specialized work to named subagents

Task types:
- "research": gather information, search, read files
- "code": write/modify code files
- "analysis": analyze data, files, or results
- "writing": draft text, docs, summaries
- "general": any other task

Disposal:
- disposable: true → agent auto-disposes (status="disposed", enabled=false, no longer callable) once complete_subagent is called. Use for one-off tasks.
- disposable: false (default) → agent stays callable for follow-up work.

Role:
- A specialization label (e.g. "Frontend Engineer", "Database Engineer", "Planner", "Security Reviewer"). Drives the orchestration pipeline's role assignment. Suggested roles:
  Planner, Frontend Engineer, Backend Engineer, Database Engineer, Testing Engineer,
  Documentation Writer, API Specialist, Performance Optimizer, Security Reviewer,
  Refactoring Specialist, Deployment Engineer`,
  {
    type: "object",
    properties: {
      subagent_name: {
        type: "string",
        description: "A short name for the subagent (e.g. 'Researcher', 'CodeWriter', 'Analyzer'). Shown in the UI. REQUIRED — do not substitute role or other keys.",
      },
      description: {
        type: "string",
        description: "What the subagent should do — a clear task description. REQUIRED (a bare 'task' key is accepted as an alias, but prefer 'description').",
      },
      task_type: {
        type: "string",
        enum: ["research", "code", "analysis", "writing", "general"],
        description: "Category of work the subagent will perform.",
        default: "general",
      },
      disposable: {
        type: "boolean",
        description: "If true, the agent auto-disposes after its task completes (enabled=false, no longer callable). Use for one-off tasks. Default false. Must be a real boolean (true/false), NOT a string.",
        default: false,
      },
      role: {
        type: "string",
        description: "Specialization role (e.g. 'Frontend Engineer', 'Database Engineer'). Drives orchestration pipeline role assignment.",
      },
      parent_task_id: {
        type: "string",
        description: "Optional: the task_id of a parent subagent that spawned this one (for nested orchestration).",
      },
    },
    // Nothing is hard-required: the handler normalizes alias payloads
    // ({role, task, disposable:"True"} — user report 2026-11-25) with
    // fallbacks, so a schema-required list here would block exactly the
    // payloads the normalization exists to rescue.
    required: [],
    additionalProperties: false,
  },
  async (args) => {
    const taskId = `subagent_${nanoid(12)}`;
    // ARGUMENT NORMALIZATION (user report 2026-11-25): the model sent
    // {role, task, disposable:"True"} — no subagent_name/description — and
    // the handler died on subagentName.toLowerCase(). Accept the common
    // aliases (task→description; subagent_name←name←role as the label),
    // coerce string booleans, and fall back to a role-derived name.
    const role = pickStr(args, "role");
    const description =
      pickStr(args, "description", "task", "task_description") ?? "No description provided.";
    const subagentName =
      pickStr(args, "subagent_name", "name", "agent_name") ?? role ?? `Subagent-${nanoid(4)}`;
    const taskTypeRaw = pickStr(args, "task_type", "specialty", "type") ?? "general";
    const taskType = (["research", "code", "analysis", "writing", "general"] as const).includes(
      taskTypeRaw as "research" | "code" | "analysis" | "writing" | "general",
    )
      ? (taskTypeRaw as "research" | "code" | "analysis" | "writing" | "general")
      : "general";
    const disposable = coerceBool(args.disposable ?? args.dispose);
    const parentTaskId = pickStr(args, "parent_task_id");

    // CRITICAL: Also create a SubagentConfig in the zustand store so:
    // 1. query_subagent can find it (was returning "unavailable" because
    //    the store was empty — only the in-memory taskStore had the task)
    // 2. read_chat can snapshot its sessions (reads from store.sessions)
    // 3. It persists to localStorage and survives page refresh
    const store = useSubagentStore.getState();
    // Check if a subagent with this name already exists (avoid duplicates).
    const nameLc = subagentName.toLowerCase();
    let subagentConfig = store.subagents.find(
      (s) => s.name.toLowerCase() === nameLc && s.enabled,
    );
    if (!subagentConfig) {
      subagentConfig = store.createSubagent({
        name: subagentName,
        description,
        specialty: taskType as SubagentConfig["specialty"],
        enabled: true,
        disposable,
        role,
        parent_task: parentTaskId,
        lifecycle_status: "idle",
        systemPrompt: `You are ${subagentName}${role ? `, a ${role}` : ""}, a specialized subagent. Task: ${description}. Use the available tools to complete your task. Report results clearly.`,
      });
    } else {
      // Already exists — update lifecycle/disposable/role fields so the
      // UI reflects the new spawn (e.g. re-using a persistent agent).
      store.updateSubagent(subagentConfig.id, {
        disposable,
        role: role ?? subagentConfig.role,
        parent_task: parentTaskId ?? subagentConfig.parent_task,
        lifecycle_status: "idle",
        last_activity: new Date().toISOString(),
      });
    }

    const task: SubagentTask = {
      task_id: taskId,
      subagent_name: subagentName,
      subagent_id: subagentConfig.id,
      description,
      status: "pending",
      error: null,
      created_at: new Date().toISOString(),
      messages: [],
      disposable,
      role,
      parent_task: parentTaskId,
    };
    taskStore.set(taskId, task);
    // Local agent-visible state changed — refresh analyze_workspace's
    // cached subagent list (PRD §22; scope "local" keeps key-file reuse).
    bumpWorkspaceVersion("local");

    // NO initial message — the AI can only interact with the subagent via
    // query_subagent. The user requested no auto-message on spawn.
    // Use set_subagent_config to assign an AI provider, then query_subagent.

    return {
      task_id: taskId,
      subagent_id: subagentConfig.id,
      subagent_name: task.subagent_name,
      status: "pending",
      disposable,
      role,
      message: `Subagent spawned${role ? ` (role: ${role})` : ""}${disposable ? " [DISPOSABLE — will auto-dispose on completion]" : ""}. Use set_subagent_config to assign an AI provider/model (or it inherits the main agent's). Then use query_subagent with the task_id to deliver its task (fire-and-forget — it returns on delivery), poll_subagent with the task_id to check progress + fetch its output non-blockingly, and read_chat for a raw full snapshot.`,
    };
  },
  false,
  "orchestration",
);

// === Tool: list_subagents ===
registerTool(
  "list_subagents",
  "List all active subagent tasks (pending, running, waiting_for_answer, retrying). Completed/failed/cancelled tasks are excluded unless you pass include_all=true. Returns each task's id, name, description, and status.",
  {
    type: "object",
    properties: {
      include_all: {
        type: "boolean",
        description: "If true, include completed/failed/cancelled tasks too.",
        default: false,
      },
    },
    additionalProperties: false,
  },
  async (args) => {
    const includeAll = args.include_all as boolean;
    const activeStatuses = new Set(["pending", "running", "waiting_for_answer", "retrying"]);
    const tasks = Array.from(taskStore.values())
      .filter((t) => includeAll || activeStatuses.has(t.status))
      .map((t) => ({
        task_id: t.task_id,
        subagent_name: t.subagent_name,
        subagent_id: t.subagent_id,
        description: t.description,
        status: t.status,
        error: t.error,
        disposable: t.disposable,
        role: t.role,
        parent_task: t.parent_task,
        message_count: t.messages.length,
        created_at: t.created_at,
      }));
    return { tasks, count: tasks.length };
  },
  false,
  "orchestration",
);

// === Tool: set_subagent_config ===
// Lets the main agent assign an AI provider/model to a subagent, or set a
// custom AI config (base_url, api_key, model_id). The main agent can see
// all available providers and models from the user's settings.
registerTool(
  "set_subagent_config",
  `Configure a subagent's AI provider and model. You can either:
1. Assign an existing provider from the user's configured providers (pass provider_id + model)
2. Set a custom AI config (pass custom_base_url, custom_model, custom_api_key — api_key is optional)

First, call list_ai_providers=true to see what's available. Then assign one with provider_id + model, OR set a custom config.

The subagent will use this config for all its LLM calls. If not set, the subagent inherits the main agent's active provider.`,
  {
    type: "object",
    properties: {
      subagent_name: {
        type: "string",
        description: "The name of the subagent to configure.",
      },
      list_ai_providers: {
        type: "boolean",
        description: "If true, return the list of available AI providers and their models (don't update anything).",
        default: false,
      },
      provider_id: {
        type: "string",
        description: "ID of an existing provider to assign (from the list).",
      },
      model: {
        type: "string",
        description: "Model ID to use (must be in the provider's models list).",
      },
      custom_base_url: {
        type: "string",
        description: "Custom base URL for a custom AI provider (e.g. https://api.openai.com/v1).",
      },
      custom_model: {
        type: "string",
        description: "Model ID for the custom provider.",
      },
      custom_api_key: {
        type: "string",
        description: "API key for the custom provider. OPTIONAL — if not set, the subagent will use the main agent's key.",
      },
    },
    required: ["subagent_name"],
    additionalProperties: false,
  },
  async (args) => {
    // Guarded lookup (crash family 2026-11-25): models sometimes omit
    // subagent_name entirely — die with an actionable error, not undefined.
    const subagentName = pickStr(args, "subagent_name", "name", "agent_name");
    if (!subagentName) {
      return {
        error: "subagent_name is required.",
        fix: "Pass the subagent's name, e.g. {\"subagent_name\": \"Researcher\"}. Use list_ai_providers to see available providers.",
      };
    }
    const store = useSubagentStore.getState();

    // Find the subagent config.
    const nameLc = subagentName.toLowerCase();
    const config = store.subagents.find(
      (s) => s.name.toLowerCase() === nameLc,
    );

    // If list_ai_providers is true, return the available providers.
    if (args.list_ai_providers) {
      try {
        // Shared guard (endpoint-migration PRD §2): stale text.pollinations.ai
        // (Classic) rows self-heal and are never listed — the agent can only
        // assign gateways that actually serve gen-catalog models.
        const { listUsableProviders } = await import("@/lib/agent/provider-resolution");
        const { useAuthStore } = await import("@/stores");
        const userId = useAuthStore.getState().user?.id;
        if (!userId) return { error: "No authenticated user." };
        const providers = await listUsableProviders(userId);
        return {
          providers: providers.map((p) => ({
            id: p.id,
            name: p.name,
            base_url: p.base_url,
            models: p.models,
            is_active: p.is_active,
          })),
          message: "These are the available AI providers. Use provider_id + model to assign one to the subagent.",
        };
      } catch (e) {
        return { error: `Failed to list providers: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    if (!config) {
      return { error: `Subagent "${subagentName}" not found. Spawn it first with spawn_subagent.` };
    }

    // Assign existing provider.
    if (args.provider_id) {
      const updates: Partial<SubagentConfig> = {
        providerId: args.provider_id as string,
        model: (args.model as string) ?? null,
        baseUrl: null,  // Clear custom config.
        apiKey: null,
      };
      store.updateSubagent(config.id, updates);
      return {
        success: true,
        subagent_name: subagentName,
        provider_id: args.provider_id,
        model: args.model,
        message: `Subagent "${subagentName}" is now using provider ${args.provider_id}${args.model ? ` (model: ${args.model})` : ""}.`,
      };
    }

    // Set custom AI config.
    if (args.custom_base_url || args.custom_model) {
      const updates: Partial<SubagentConfig> = {
        baseUrl: (args.custom_base_url as string) ?? null,
        model: (args.custom_model as string) ?? null,
        apiKey: (args.custom_api_key as string) ?? null,  // Optional.
        providerId: null,  // Clear provider assignment.
      };
      store.updateSubagent(config.id, updates);
      return {
        success: true,
        subagent_name: subagentName,
        custom_base_url: args.custom_base_url,
        custom_model: args.custom_model,
        api_key_set: !!args.custom_api_key,
        message: `Subagent "${subagentName}" is now using a custom AI config. Base URL: ${args.custom_base_url}, Model: ${args.custom_model}. API key: ${args.custom_api_key ? "set" : "not set (will use main agent's key)"}.`,
      };
    }

    return { error: "Pass list_ai_providers=true to see providers, or provider_id+model to assign, or custom_base_url+custom_model for custom AI." };
  },
  false,
  "orchestration",
);

// === Tool: query_subagent ===
// ASYNC SUBAGENT MESSAGING ("delivery is not generation completion"): the
// tool completes the moment the message is DELIVERED to the target
// subagent's chat session — it never waits for the target AI's thinking,
// tool calls, streaming or completion. The target keeps generating
// independently (its own runtime lifecycle); the orchestrator inspects its
// output at any time with read_chat — including partially streamed content.
registerTool(
  "query_subagent",
  `Send a message to a subagent — FIRE-AND-FORGET. The tool returns the INSTANT the message is delivered to the subagent's chat session; the subagent then processes it independently (it may think, call tools and stream a response on its own, in parallel with your own work). Use this to:

1. Kick off work in a subagent (e.g. "research X", "write code for Y") and keep going with your own turn
2. Send follow-up instructions without blocking
3. Message several subagents back-to-back — they run CONCURRENTLY
4. task_id with NO message = a STATUS CHECK — returns the task's current state, last event and output-so-far (no message is delivered)

The result does NOT contain the subagent's reply — only the delivery receipt (target_chat_id, message_id, target_agent_id). To see what a subagent has generated so far — including output it is STILL STREAMING — call read_chat with the returned target_chat_id; repeat read_chat later for progressively more content.

Delivery fails fast only when the message cannot be accepted (unknown target, runtime unavailable). A later generation failure belongs to the target run and never retroactively fails a delivered message.

If no task_id is provided, a message is REQUIRED (it starts a new task). If a name is provided but no existing subagent matches, a new subagent is spawned with that name.`,
  {
    type: "object",
    properties: {
      task_id: {
        type: "string",
        description: "The subagent task ID to message or check. If omitted, a new task is created (message then required).",
      },
      subagent_name: {
        type: "string",
        description: "Name for a new subagent (used when task_id is omitted).",
      },
      message: {
        type: "string",
        description: "The message to deliver to the subagent. REQUIRED with task_id absent (new task). With task_id present but no message, the call becomes a status check instead.",
      },
      description: {
        type: "string",
        description: "Description of the subagent's task (for new subagents).",
      },
      specialty: {
        type: "string",
        enum: ["research", "code", "analysis", "writing", "general"],
        description: "Specialty for a new subagent.",
        default: "general",
      },
    },
    required: ["message"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    // Alias-aware read (crash family 2026-11-25): models send `task` or
    // `instructions` where the schema says `message`.
    const message = (pickStr(args, "message", "task", "instruction", "instructions") ?? "").trim();
    const taskId = args.task_id as string | undefined;
    const subagentName = pickStr(args, "subagent_name", "name", "agent_name");
    const description = pickStr(args, "description");
    const specialtyRaw = (pickStr(args, "specialty") ?? "general") as string;
    const specialty = (["research", "code", "analysis", "writing", "general"] as const).includes(
      specialtyRaw as "research" | "code" | "analysis" | "writing" | "general",
    )
      ? specialtyRaw
      : "general";

    // STATUS-CHECK MODE (user crash report 2026-11-25): the model calling
    // query_subagent with ONLY a task_id is polling the task — but the old
    // code fell through to delivery with message=undefined and died inside
    // startSubagentTurn (`undefined.slice` → DELIVERY_FAILED). A bare task_id
    // is now a first-class STATUS query: return the live state instead of
    // attempting an empty delivery.
    if (taskId && !message) {
      const task = taskStore.get(taskId);
      if (!task) {
        return { error: `Task ${taskId} not found.` };
      }
      const last = task.messages[task.messages.length - 1];
      return {
        status_check: true,
        task_id: taskId,
        subagent_name: task.subagent_name,
        task_status: task.status,
        description: task.description,
        last_event: last ? { type: last.type, text: last.text, timestamp: last.timestamp } : null,
        note:
          "No message was delivered (status check). To message the subagent, call again with a message; to read its generated output, use read_chat with its chat session.",
      };
    }
    // New-task mode (no task_id): the message IS the task — required.
    if (!taskId && !message) {
      return {
        error: "message is required when task_id is omitted (it starts a new task).",
        fix: "Either pass a message (and optionally subagent_name), or pass task_id alone for a status check.",
      };
    }

    // Dynamically import to avoid circular deps.
    const { useSubagentStore } = await import("@/stores/subagent-store");
    const store = useSubagentStore.getState();

    let subagentId: string;
    let task: SubagentTask | undefined;

    if (taskId) {
      // Existing task — find the subagent.
      const existingTask = taskStore.get(taskId);
      if (!existingTask) {
        return { error: `Task ${taskId} not found.` };
      }
      task = existingTask;
      // Use subagent_id if available (most reliable), else find by name.
      let existing: SubagentConfig | undefined;
      if (existingTask.subagent_id) {
        existing = store.getSubagent(existingTask.subagent_id);
      }
      if (!existing) {
        existing = store.subagents.find((s) => s.name === existingTask.subagent_name);
      }
      if (!existing) {
        return { error: `Subagent "${existingTask.subagent_name}" no longer exists. It may have been deleted. Spawn a new one with spawn_subagent.` };
      }
      // Allow messaging disposed agents — re-enable them so they can be
      // used again. The user should be able to message a subagent even
      // after it was disposed.
      if (existing.lifecycle_status === "disposed" || !existing.enabled) {
        store.updateSubagent(existing.id, {
          enabled: true,
          lifecycle_status: "idle",
        });
        existing = store.getSubagent(existing.id)!;
      }
      subagentId = existing.id;
    } else {
      // New task — create or find a subagent by name. (name defaults safely;
      // message is guaranteed non-empty by the status-check guard above.)
      const name = subagentName || "Assistant";
      let existing = store.subagents.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (!existing) {
        // Auto-spawn a new subagent.
        existing = store.createSubagent({
          name,
          description: description || `Auto-spawned ${specialty} subagent`,
          specialty: specialty as "research" | "code" | "analysis" | "writing" | "general",
          systemPrompt: `You are ${name}, a ${specialty} subagent. ${description || ""}`,
          lifecycle_status: "idle",
        });
      }
      subagentId = existing.id;

      // Create a task entry for tracking.
      const newTask: SubagentTask = {
        task_id: `subagent_${nanoid(12)}`,
        subagent_name: name,
        subagent_id: existing.id,
        description: description || message.slice(0, 80),
        status: "running",
        error: null,
        created_at: new Date().toISOString(),
        messages: [],
        disposable: existing.disposable ?? false,
        role: existing.role,
      };
      taskStore.set(newTask.task_id, newTask);
      task = newTask;
    }

    // Task + lifecycle bookkeeping — this agent is now actively working.
    if (task) {
      task.status = "running";
    }
    try {
      store.updateLifecycleStatus(subagentId, "working");
    } catch {
      // best-effort
    }

    // ── DELIVERY (fire-and-forget boundary) ─────────────────────────────
    // startSubagentTurn returns SYNCHRONOUSLY once the message is persisted
    // into the target subagent's chat session (delivery confirmed); the
    // generation loop runs DETACHED and writes its stream/tools/result into
    // that session on its own. The ONLY failure that fails this tool is a
    // delivery failure — the message could not be accepted at all.
    let delivery;
    try {
      const { startSubagentTurn } = await import("@/lib/agent/subagent-runtime");
      // MAIN-AGENT PARITY: carry the originating main-chat conversation so
      // the subagent's permission gates resolve the SAME project rules the
      // main agent has (project-granted tools are granted to its subagents).
      delivery = startSubagentTurn(
        subagentId,
        message,
        undefined,
        undefined,
        ctx?.conversationId ?? null,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (task) {
        task.status = "failed";
        task.error = errMsg;
      }
      try {
        useSubagentStore.getState().updateLifecycleStatus(subagentId, "idle");
      } catch {
        // best-effort
      }
      return { error: `DELIVERY_FAILED: ${errMsg}` };
    }

    // Record the receipt on the task — poll_subagent reads the live reply
    // from this exact session/message pair without any extra lookup.
    if (task) {
      task.chat_session_id = delivery.sessionId;
      task.reply_message_id = delivery.assistantMessageId;
    }

    // Detached settle bookkeeping. This NEVER blocks the tool result; the
    // target's own outcome (reply or error text) lands in its session,
    // visible via read_chat.
    void delivery.completion.then((reply) => {
      if (task) {
        task.status = "completed";
      }
      try {
        useSubagentStore.getState().updateLifecycleStatus(subagentId, "completed");
      } catch {
        // best-effort
      }
    });

    const agentName = useSubagentStore.getState().getSubagent(subagentId)?.name ?? "subagent";
    return {
      status: "sent",
      task_id: task?.task_id,
      subagent_name: agentName,
      target_agent_id: subagentId,
      target_chat_id: delivery.sessionId,
      message_id: delivery.userMessageId,
      message:
        `Message sent successfully. ${agentName} is continuing independently — its reply is NOT included here. ` +
        `Call poll_subagent with this task_id to check progress and fetch its output (returns immediately with status + output-so-far; keep polling until done=true). ` +
        `For a raw live snapshot at any moment, read_chat with chat_id "${delivery.sessionId}" also works.`,
    };
  },
  false,
  "orchestration",
);

// === Tool: poll_subagent ===
// The POLL half of the non-blocking orchestration contract: query_subagent
// DELIVERS fire-and-forget, poll_subagent CHECKS non-blockingly. One call
// returns everything the orchestrator needs to decide what to do next:
//   done (bool) — is the turn settled (completed / failed / cancelled)?
//   status      — task + generation state, incl. retrying (transient net)
//   output      — the reply text so far (PARTIAL while streaming, full when
//                 done) with its char count and grew-since-last-poll flag
//   tools       — tool calls the subagent made so far (name + status + brief
//                 result), so progress is visible even before text streams
//   stall       — warning when output hasn't grown across consecutive polls
//                 for a while (background tab throttling, stuck stream)
// It NEVER waits for the target: the snapshot is read synchronously from the
// session store (the detached generation loop keeps writing into it).
registerTool(
  "poll_subagent",
  `Poll a subagent's progress — NON-BLOCKING. Returns IMMEDIATELY with the task's current state, its output so far (partial while streaming), and the tool calls it has made. query_subagent is fire-and-forget (it returns on DELIVERY, never waits for the reply) — THIS tool is how you check on the subagent afterwards.

The poll workflow:
1. query_subagent (or spawn_subagent + query_subagent) → delivery receipt
2. Do your own work, or poll right away
3. poll_subagent {task_id} → look at \`done\`:
   - done=false → the subagent is still working (see status / tools / output so far). Poll again after a few seconds, or continue other work meanwhile.
   - done=true → \`output\` is the final reply. Task finished (check status: "completed" ok; "failed" has \`error\`).
4. Repeat — each call also tells you whether the output GREW since your last poll (\`grew\`) and warns on stalls.

Parameters:
- task_id (required): the task to poll — from spawn_subagent / query_subagent.
- chat_id (optional): poll a subagent chat session DIRECTLY (from read_chat / manage_subagent_chat / target_chat_id) when you don't have the task_id — same output for that session's latest turn.
- tail (optional, default 4000): max chars of the output text returned. Long replies are truncated to the LAST tail chars (a note says so) — the full text stays in the session (read_chat).

You may poll MANY subagents round-robin while they run concurrently. Polling never interrupts or delays the subagent. For a raw full snapshot (all messages incl. reasoning) use read_chat with the chat_id.`,
  {
    type: "object",
    properties: {
      task_id: {
        type: "string",
        description: "The subagent task ID to poll (from spawn_subagent / query_subagent).",
      },
      chat_id: {
        type: "string",
        description: "Alternative: poll a subagent chat session directly by its session id (target_chat_id), polling its latest turn.",
      },
      tail: {
        type: "number",
        description: "Max chars of output text to return (default 4000; long output is truncated to the last N chars).",
        default: 4000,
      },
    },
    // Neither task_id nor chat_id is schema-required (exactly one is needed —
    // the handler validates and returns an actionable error, same contract
    // as spawn_subagent's alias-tolerant normalization).
    required: [],
    additionalProperties: false,
  },
  async (args) => {
    const taskId = pickStr(args, "task_id", "id");
    const chatId = pickStr(args, "chat_id", "session_id", "target_chat_id");
    const tailRaw = typeof args.tail === "number" ? args.tail : Number(args.tail);
    const tail =
      Number.isFinite(tailRaw) && tailRaw > 0 ? Math.min(Math.floor(tailRaw), 200_000) : 4000;

    if (!taskId && !chatId) {
      return {
        error: "task_id is required (or chat_id to poll a subagent chat session directly).",
        fix: "Pass the task_id from spawn_subagent / query_subagent, or a chat session id as chat_id.",
      };
    }

    const now = Date.now();
    let session;
    let sessionId: string | undefined;
    let task: SubagentTask | undefined;

    if (taskId) {
      task = taskStore.get(taskId);
      if (!task) {
        // A completed non-disposable task is auto-removed after 30s, and a
        // disposable one immediately on completion — the poll after that
        // window must not look like a crash. Point at the session instead.
        return {
          error: `Task ${taskId} not found.`,
          fix:
            "The task may have finished and been cleaned up (completed tasks are auto-removed ~30s after completion; disposable ones immediately). " +
            "Poll its chat session instead: pass chat_id (the target_chat_id from the original query_subagent receipt) or use read_chat with it.",
        };
      }
      sessionId = task.chat_session_id;
    }

    const { useSubagentStore } = await import("@/stores/subagent-store");
    const store = useSubagentStore.getState();

    // Resolve the session: the task's recorded delivery target, or the
    // explicit chat_id (direct-session polling without a task).
    if (chatId || sessionId) {
      session = store.sessions.find((s) => s.id === (chatId || sessionId));
    }
    if (!session && task?.subagent_id) {
      // No recorded/known session (task spawned but never messaged, or the
      // session was deleted) — fall back to the subagent's latest session.
      const bySub = store.sessions
        .filter((s) => s.subagentId === task!.subagent_id)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      session = bySub[0];
    }

    // ── Task-level state (the orchestration bookkeeping) ────────────────
    const taskStatus = task?.status ?? "unknown";

    // ── Generation-level state (the live session content) ───────────────
    // The LAST assistant message of the session is the current/latest turn's
    // reply carrier (query_subagent mounts a streaming placeholder per turn).
    // The MESSAGE is the source of truth for the live generation: the
    // detached loop writes isStreaming/content/toolCalls into it as it runs,
    // and task bookkeeping may fire much earlier or later than the actual
    // stream settles (e.g. an instant provider error writes
    // "Error: …" + isStreaming:false before the first poll).
    let replyMsg = undefined;
    let output = "";
    let generationState: "idle" | "pending" | "streaming" | "settled" | "error" = "idle";
    if (session) {
      replyMsg = [...session.messages].reverse().find((m) => m.role === "assistant");
      if (replyMsg) {
        output = replyMsg.content ?? "";
        if (replyMsg.isStreaming) {
          generationState = "streaming";
        } else if (/(^|\n---\n)Error: /.test(output)) {
          // The runtime's catch APPENDS "Error: <msg>" into the carrier on a
          // failed generation (below any text the turn already produced) —
          // that IS the settled (failed) final state.
          generationState = "error";
        } else if (output) {
          generationState = "settled";
        } else {
          // Empty, not streaming: the turn's carrier exists but nothing has
          // been written yet — PENDING, not done.
          generationState = "pending";
        }
      }
    }

    // Tool calls made by the subagent so far (from the reply message).
    const toolCalls = (replyMsg?.toolCalls ?? []).map((c) => ({
      name: c.name,
      status: c.status,
      startedAt: c.startedAt,
      endedAt: c.endedAt,
      result:
        c.result === undefined
          ? undefined
          : (() => {
              try {
                const s = typeof c.result === "string" ? c.result : JSON.stringify(c.result);
                return s.length > 300 ? `${s.slice(0, 300)}…` : s;
              } catch {
                return "[unserializable]";
              }
            })(),
    }));

    // ── done: the turn is settled — message-driven. The live message state
    // is authoritative: a streaming/pending carrier ALWAYS means not-done
    // even if the task bookkeeping raced ahead; anything else (settled,
    // error, or no session at all — never messaged / session cleaned) means
    // nothing more will arrive, so polling again is pointless.
    const liveWorking = generationState === "streaming" || generationState === "pending";
    const done = !liveWorking;

    // ── grew + stall detection (progress between polls) ──────────────────
    const outputLen = output.length;
    const prevLen = task?.last_poll_output_len;
    const grew = typeof prevLen === "number" ? outputLen > prevLen : undefined;
    const prevAt = task?.last_poll_at;
    let stall: string | undefined;
    if (!done && typeof prevLen === "number" && outputLen === prevLen && typeof prevAt === "number") {
      const silentMs = now - prevAt;
      const hasRunningTools = toolCalls.some((c) => c.status === "running" || c.status === "pending");
      if (silentMs > 20_000 && !hasRunningTools) {
        stall =
          `Output has not grown for ${Math.round(silentMs / 1000)}s across your last polls and no tool call is running. ` +
          `The subagent may be stuck (or its tab is background-throttled). Consider steer_subagent, poll once more, or cancel_subagent.`;
      } else if (silentMs > 20_000 && hasRunningTools) {
        stall = `Output has not grown for ${Math.round(silentMs / 1000)}s, but a tool call is still running (${toolCalls
          .filter((c) => c.status === "running" || c.status === "pending")
          .map((c) => c.name)
          .join(", ")}) — likely busy inside that tool. Keep polling.`;
      }
    }

    // Record this observation for the NEXT poll's grew/stall math.
    if (task) {
      task.last_poll_at = now;
      task.last_poll_output_len = outputLen;
    }

    // ── Output tailing ──────────────────────────────────────────────────
    let outputText: string | undefined;
    let truncated = false;
    if (output) {
      truncated = output.length > tail;
      outputText = truncated ? `…${output.slice(-tail)}` : output;
    }

    return {
      task_id: task?.task_id ?? null,
      subagent_name: task?.subagent_name ?? session?.title ?? "subagent",
      chat_id: session?.id ?? null,
      done,
      status: {
        task: taskStatus,
        generation: generationState,
        retrying: taskStatus === "retrying",
      },
      grew,
      output: outputText,
      output_chars: outputLen,
      output_truncated: truncated,
      tools: toolCalls.length
        ? toolCalls
        : done && !output
          ? []
          : undefined,
      error: task?.error ?? (generationState === "error" ? output.split("\n---\nError: ")[1] ?? output : undefined),
      stall,
      hint: !done
        ? "Still working — poll again in a few seconds, or continue other work and poll later."
        : generationState === "error"
          ? "Generation failed — the output carries the error text. Re-send the task with query_subagent, fix config with set_subagent_config, or cancel."
          : generationState === "idle" || !session
            ? "No active generation for this task (it was never messaged, or its session is gone). Deliver work with query_subagent."
            : taskStatus === "failed"
              ? "Task failed — see error. You can re-send the task with query_subagent."
              : "Task settled — output above is the final reply. Full transcript in its chat session (read_chat).",
    };
  },
  false,
  "orchestration",
);
registerTool(
  "steer_subagent",
  `Send a steering message to a subagent — guidance, a course correction, or additional instructions. The subagent receives the message and continues its work with the new context. Use this when you want to redirect a subagent without canceling it.

Examples:
- "Focus only on Python files"
- "Also check the test coverage"
- "Stop researching and start writing the summary"`,
  {
    type: "object",
    properties: {
      task_id: { type: "string", description: "The subagent task ID to steer." },
      message: { type: "string", description: "The steering message / guidance to send." },
    },
    required: ["task_id", "message"],
    additionalProperties: false,
  },
  async (args) => {
    const taskId = args.task_id as string;
    const message = (typeof args.message === "string" ? args.message : "").trim();
    if (!taskId) {
      return { error: "task_id is required." };
    }
    if (!message) {
      return {
        error: "message is required — a steering message needs guidance text.",
        fix: "Pass the guidance in `message`, e.g. 'Focus only on the Python files'.",
      };
    }
    const task = taskStore.get(taskId);
    if (!task) {
      return { error: `Subagent ${taskId} not found.` };
    }
    task.messages.push({ type: "steering", text: message, timestamp: new Date().toISOString() });
    return {
      task_id: taskId,
      delivered: true,
      message: `Steering message delivered to "${task.subagent_name}".`,
    };
  },
  false,
  "orchestration",
);

// === Tool: complete_subagent ===
registerTool(
  "complete_subagent",
  `Mark a subagent task as completed with a final result message. Use this when the subagent has finished its work and you want to record the outcome. The task moves to 'completed' status.

DISPOSABLE AGENTS: If the subagent was spawned with disposable=true, it is automatically disposed:
- lifecycle_status → "disposed"
- enabled → false (no longer callable)
- status → "disposed"
- Removed from taskStore immediately
- Its chat session stays readable via read_chat until the store is cleared

NON-DISPOSABLE AGENTS: Stay callable (enabled=true) for follow-up work. The task is auto-removed from the active list after 30 seconds (but the SubagentConfig persists).`,
  {
    type: "object",
    properties: {
      task_id: { type: "string", description: "The subagent task ID to complete." },
      result: { type: "string", description: "The final result / summary from the subagent." },
    },
    required: ["task_id", "result"],
    additionalProperties: false,
  },
  async (args) => {
    const taskId = args.task_id as string;
    const result = args.result as string;
    const task = taskStore.get(taskId);
    if (!task) {
      return { error: `Subagent ${taskId} not found.` };
    }

    // Pull the live disposable flag — check both the task and the store
    // (the store is the source of truth for persisted agents).
    let disposable = task.disposable;
    try {
      const { useSubagentStore } = await import("@/stores/subagent-store");
      const store = useSubagentStore.getState();
      if (task.subagent_id) {
        const cfg = store.getSubagent(task.subagent_id);
        if (cfg) {
          // Prefer the persisted flag (it may have been updated since spawn).
          disposable = cfg.disposable ?? disposable;
          // Update lifecycle to "completed" for both disposable + persistent
          // agents — only the dispose step below differs.
          store.updateLifecycleStatus(cfg.id, "completed");
        }
      }
    } catch {
      // store unavailable — fall back to task-level disposable flag
    }

    if (disposable) {
      // Auto-dispose: mark disposed, disable the config (no longer
      // callable), and remove from the in-memory taskStore immediately.
      task.status = "disposed";
      task.error = null;
      task.messages.push({ type: "result", text: result, timestamp: new Date().toISOString() });
      task.messages.push({
        type: "info",
        text: "Agent auto-disposed after completion (disposable=true).",
        timestamp: new Date().toISOString(),
      });

      try {
        const { useSubagentStore } = await import("@/stores/subagent-store");
        if (task.subagent_id) {
          useSubagentStore.getState().disposeAgent(task.subagent_id);
        }
      } catch {
        // best-effort
      }

      // Remove from taskStore right away — the agent is gone.
      taskStore.delete(taskId);
      bumpWorkspaceVersion("local"); // subagent list changed

      return {
        task_id: taskId,
        status: "disposed",
        disposable: true,
        result,
        message: "Disposable agent completed and auto-disposed (no longer callable).",
      };
    }

    // Non-disposable — keep the agent around for follow-up work.
    task.status = "completed";
    task.error = null;
    task.messages.push({ type: "result", text: result, timestamp: new Date().toISOString() });
    bumpWorkspaceVersion("local"); // lifecycle status changed

    // Auto-remove from the store after 30 seconds (keep the data a bit
    // longer than the task list does so query_subagent still works shortly
    // after completion).
    setTimeout(() => taskStore.delete(taskId), 30_000);

    return {
      task_id: taskId,
      status: "completed",
      disposable: false,
      result,
      message: "Task completed. Agent remains available for follow-up work.",
    };
  },
  false,
  "orchestration",
);

// === Tool: cancel_subagent ===
registerTool(
  "cancel_subagent",
  "Cancel a subagent task. The task moves to 'cancelled' status and stops running. Use this when the subagent's work is no longer needed or is going in the wrong direction and steering won't help.",
  {
    type: "object",
    properties: {
      task_id: { type: "string", description: "The subagent task ID to cancel." },
      reason: { type: "string", description: "Optional reason for cancellation.", default: "" },
    },
    required: ["task_id"],
    additionalProperties: false,
  },
  async (args) => {
    const taskId = args.task_id as string;
    const reason = (args.reason as string) ?? "";
    const task = taskStore.get(taskId);
    if (!task) {
      return { error: `Subagent ${taskId} not found.` };
    }
    task.status = "cancelled";
    task.messages.push({ type: "info", text: `Cancelled: ${reason}`, timestamp: new Date().toISOString() });

    setTimeout(() => taskStore.delete(taskId), 30_000);

    return { task_id: taskId, status: "cancelled" };
  },
  false,
  "orchestration",
);

// === Tool: create_custom_tool ===
// Lets the AI create a custom tool for a specific subagent. The AI defines
// the tool's name, description, parameters (JSON schema), and implementation
// (a JavaScript function body that receives `args` and `ctx`). The tool is
// registered dynamically and becomes available to the specified subagent.
registerTool(
  "create_custom_tool",
  `Create a custom tool for a subagent. Use this when a subagent needs a specialized capability that doesn't exist in the built-in tools (e.g. a meme generator, a sentiment analyzer, a custom API caller).

The tool is defined by:
- name: unique tool name (e.g. "generate_meme", "analyze_sentiment")
- description: what the tool does (shown to the subagent)
- parameters: JSON schema for the tool's arguments
- implementation: a JavaScript function body (string) that receives \`args\` and returns a result. The function runs in the sandbox.

Example implementation for a meme generator:
"return { meme_url: \`https://meme-api.com/gimme/\${args.topic}\`, caption: args.topic }"

The tool is immediately available to the specified subagent (or all subagents if no subagent_id is given).`,
  {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Unique tool name (snake_case, e.g. 'generate_meme')",
      },
      description: {
        type: "string",
        description: "What the tool does — shown to the subagent so it knows when to call it.",
      },
      parameters: {
        type: "object",
        description: "JSON Schema for the tool's arguments (same format as OpenAI function parameters).",
      },
      implementation: {
        type: "string",
        description: "JavaScript function body (string). Receives `args` (the parsed arguments) and `ctx` (tool context). Must return a value. Example: 'return { result: args.text.toUpperCase() }'",
      },
      subagent_id: {
        type: "string",
        description: "Optional: only assign this tool to this subagent. If omitted, available to all subagents.",
      },
    },
    required: ["name", "description", "parameters", "implementation"],
    additionalProperties: false,
  },
  async (args) => {
    const toolName = args.name as string;
    const description = args.description as string;
    const parameters = args.parameters as Record<string, unknown>;
    const implementation = args.implementation as string;
    const subagentId = args.subagent_id as string | undefined;

    // Dynamically import the registry to register the new tool.
    const { registerTool } = await import("./registry");

    // Build the tool handler from the implementation string.
    // The implementation is a function body that receives `args` + `ctx`.
    // We wrap it in a Function constructor for isolation.
    let handler: ((args: Record<string, unknown>, ctx: unknown) => Promise<unknown> | unknown) | undefined;
    try {
      handler = new Function("args", "ctx", `"use strict"; ${implementation}`) as (
        args: Record<string, unknown>,
        ctx: unknown,
      ) => Promise<unknown> | unknown;

      // Wrap in an async function so the runtime can await it.
      const wrappedHandler = async (toolArgs: Record<string, unknown>, toolCtx: unknown) => {
        try {
          return await handler!(toolArgs, toolCtx);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      };

      // Register the tool. If a tool with this name already exists, the
      // registry silently ignores it (idempotent) — so we use a namespaced
      // name to avoid collisions: custom_<subagentId>_<toolName>.
      const fullToolName = subagentId ? `custom_${subagentId}_${toolName}` : `custom_${toolName}`;

      registerTool(
        fullToolName,
        `${description} (Custom tool${subagentId ? ` for subagent ${subagentId}` : ""})`,
        parameters,
        wrappedHandler,
        false,
        "custom",
      );

      return {
        success: true,
        tool_name: fullToolName,
        message: `Custom tool "${fullToolName}" created and registered. It's now available to ${subagentId ? `subagent ${subagentId}` : "all subagents"}.`,
      };
    } catch (err) {
      return {
        error: `Failed to create custom tool: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  false,
  "orchestration",
);

// === Tool: manage_subagent_chat ===
// MERGE NOTE (tool-count cap): the four former subagent-chat session tools
// (create_subagent_chat / delete_subagent_chat / edit_subagent_chat_title /
// pin_subagent_chat) were merged into this single multi-function tool with an
// `action` parameter. Each action preserves the EXACT result shape of the
// tool it replaced.
registerTool(
  "manage_subagent_chat",
  `Manage chat SESSIONS with subagents — one tool for all session operations. Sessions persist across page refreshes. Pass \`action\` plus the fields that action needs:

- action "create": create a new chat session with a subagent (auto-creates the subagent if it doesn't exist). Requires \`subagent_name\`; optional \`title\`, \`description\` + \`specialty\` + \`system_prompt\` (for auto-created subagents). Returns the session_id — deliver messages via query_subagent and inspect replies via read_chat.
- action "delete": delete a session permanently (history is removed). Requires \`session_id\`.
- action "edit_title": rename a session. Requires \`session_id\` + \`title\`.
- action "pin": pin (or unpin) a session — pinned chats appear at the top of the list. Requires \`session_id\`; optional \`pinned\` (default true).`,
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "delete", "edit_title", "pin"],
        description: "Which session operation to perform.",
      },
      subagent_name: {
        type: "string",
        description: "Name of the subagent to chat with (action 'create'). Auto-created if missing.",
      },
      title: {
        type: "string",
        description: "Session title (create, or the new title for edit_title).",
      },
      description: {
        type: "string",
        description: "Description for a new subagent (action 'create').",
      },
      specialty: {
        type: "string",
        enum: ["research", "code", "analysis", "writing", "general"],
        description: "Specialty for a new subagent (action 'create').",
        default: "general",
      },
      system_prompt: {
        type: "string",
        description: "System prompt for a new subagent (action 'create').",
      },
      session_id: {
        type: "string",
        description: "The chat session id (actions 'delete', 'edit_title', 'pin').",
      },
      pinned: {
        type: "boolean",
        description: "True to pin, false to unpin (action 'pin', default true).",
        default: true,
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args) => {
    const action = String(args.action ?? "");

    // ---- action: create (was create_subagent_chat) ----
    if (action === "create") {
      const name = args.subagent_name as string | undefined;
      if (!name) return { error: "subagent_name is required for action 'create'" };
      const { useSubagentStore } = await import("@/stores/subagent-store");
      const store = useSubagentStore.getState();
      const title = args.title as string | undefined;
      const description = args.description as string | undefined;
      const specialty = (args.specialty as string | undefined) ?? "general";
      const systemPrompt = args.system_prompt as string | undefined;

      // Find or create the subagent.
      let subagent = store.subagents.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (!subagent) {
        subagent = store.createSubagent({
          name,
          description: description || `Auto-spawned ${specialty} subagent`,
          specialty: specialty as "research" | "code" | "analysis" | "writing" | "general",
          systemPrompt: systemPrompt || `You are ${name}, a ${specialty} subagent. ${description || ""}`,
        });
      }

      // Create a new session.
      const session = store.createSession(subagent.id, title || `Chat with ${name}`);
      return {
        session_id: session.id,
        subagent_id: subagent.id,
        subagent_name: subagent.name,
        title: session.title,
        message: `New chat session created with ${subagent.name}. Deliver messages via query_subagent (fire-and-forget) and inspect its output via read_chat with chat_id "${session.id}".`,
      };
    }

    // ---- action: delete (was delete_subagent_chat) ----
    if (action === "delete") {
      const sessionId = args.session_id as string | undefined;
      if (!sessionId) return { error: "session_id is required for action 'delete'" };
      const { useSubagentStore } = await import("@/stores/subagent-store");
      const store = useSubagentStore.getState();
      const session = store.sessions.find((s) => s.id === sessionId);
      if (!session) {
        return { error: `Session ${sessionId} not found.` };
      }
      store.deleteSession(sessionId);
      return { success: true, deleted: sessionId };
    }

    // ---- action: edit_title (was edit_subagent_chat_title) ----
    if (action === "edit_title") {
      const sessionId = args.session_id as string | undefined;
      const title = args.title as string | undefined;
      if (!sessionId || !title) return { error: "session_id and title are required for action 'edit_title'" };
      const { useSubagentStore } = await import("@/stores/subagent-store");
      const store = useSubagentStore.getState();
      const session = store.sessions.find((s) => s.id === sessionId);
      if (!session) {
        return { error: `Session ${sessionId} not found.` };
      }
      store.updateSessionTitle(sessionId, title);
      return { success: true, session_id: sessionId, title };
    }

    // ---- action: pin (was pin_subagent_chat) ----
    if (action === "pin") {
      const sessionId = args.session_id as string | undefined;
      if (!sessionId) return { error: "session_id is required for action 'pin'" };
      const { useSubagentStore } = await import("@/stores/subagent-store");
      const store = useSubagentStore.getState();
      const pinned = (args.pinned as boolean) ?? true;
      const session = store.sessions.find((s) => s.id === sessionId);
      if (!session) {
        return { error: `Session ${sessionId} not found.` };
      }
      store.pinSession(sessionId, pinned);
      return { success: true, session_id: sessionId, pinned };
    }

    return { error: `Unknown action: ${action}` };
  },
  false,
  "orchestration",
);
