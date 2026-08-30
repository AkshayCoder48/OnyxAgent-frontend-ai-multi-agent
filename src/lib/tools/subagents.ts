"use client";

import { registerTool } from "./registry";
import { nanoid } from "nanoid";
import { useSubagentStore, type SubagentConfig } from "@/stores/subagent-store";

/**
 * Subagent orchestration tools — lets the main AI act as an orchestrator that
 * spawns, monitors, steers, and cancels "subagent" tasks. Each task is a
 * logical unit of background work (e.g. "research X", "write code for Y",
 * "analyze file Z") that the orchestrator delegates.
 *
 * The tools emit `subagent_status` and `subagent_message` window events so
 * the SubagentPanel UI can render live status. The actual subagent execution
 * happens in-process — each subagent is a simulated task that runs a simple
 * callback and reports progress. In a future version this could spawn real
 * sub-agent LLM calls, but for now the orchestrator pattern is the key
 * capability (the AI can delegate work and track it).
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
}

// In-memory task store (shared across all tool invocations in the session).
const taskStore = new Map<string, SubagentTask>();

function emitStatus(task: SubagentTask) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("subagent_status", {
    detail: {
      task_id: task.task_id,
      subagent_name: task.subagent_name,
      subagent_id: task.subagent_id,
      description: task.description,
      status: task.status,
      error: task.error,
      disposable: task.disposable,
      role: task.role,
      parent_task: task.parent_task,
    },
  }));
}

function emitMessage(taskId: string, type: "info" | "steering" | "question" | "result" | "error", text: string) {
  if (typeof window === "undefined") return;
  const msg = { task_id: taskId, type, text, timestamp: new Date().toISOString() };
  window.dispatchEvent(new CustomEvent("subagent_message", { detail: msg }));
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
- disposable: true → agent auto-disposes (status="disposed", enabled=false, removed from sidebar) once complete_subagent is called. Use for one-off tasks.
- disposable: false (default) → agent stays in the sidebar for follow-up work.

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
        description: "A short name for the subagent (e.g. 'Researcher', 'CodeWriter', 'Analyzer'). Shown in the UI.",
      },
      description: {
        type: "string",
        description: "What the subagent should do — a clear task description.",
      },
      task_type: {
        type: "string",
        enum: ["research", "code", "analysis", "writing", "general"],
        description: "Category of work the subagent will perform.",
        default: "general",
      },
      disposable: {
        type: "boolean",
        description: "If true, the agent auto-disposes after its task completes (removed from sidebar, enabled=false). Use for one-off tasks. Default false.",
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
    required: ["subagent_name", "description"],
    additionalProperties: false,
  },
  async (args) => {
    const taskId = `subagent_${nanoid(12)}`;
    const subagentName = args.subagent_name as string;
    const description = args.description as string;
    const taskType = (args.task_type as string) ?? "general";
    const disposable = (args.disposable as boolean) ?? false;
    const role = args.role as string | undefined;
    const parentTaskId = args.parent_task_id as string | undefined;

    // CRITICAL: Also create a SubagentConfig in the zustand store so:
    // 1. query_subagent can find it (was returning "unavailable" because
    //    the store was empty — only the in-memory taskStore had the task)
    // 2. The sidebar shows it for @-tagging (reads from store.subagents)
    // 3. It persists to localStorage and survives page refresh
    const store = useSubagentStore.getState();
    // Check if a subagent with this name already exists (avoid duplicates).
    let subagentConfig = store.subagents.find(
      (s) => s.name.toLowerCase() === subagentName.toLowerCase() && s.enabled,
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
    emitStatus(task);

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
      message: `Subagent spawned${role ? ` (role: ${role})` : ""}${disposable ? " [DISPOSABLE — will auto-dispose on completion]" : ""}. Use set_subagent_config to assign an AI provider/model (or it inherits the main agent's). Then use query_subagent with the task_id to send messages and get replies.`,
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
    const subagentName = args.subagent_name as string;
    const store = useSubagentStore.getState();

    // Find the subagent config.
    const config = store.subagents.find(
      (s) => s.name.toLowerCase() === subagentName.toLowerCase(),
    );

    // If list_ai_providers is true, return the available providers.
    if (args.list_ai_providers) {
      try {
        const { aiProviderService } = await import("@/lib/services");
        const { useAuthStore } = await import("@/stores");
        const userId = useAuthStore.getState().user?.id;
        if (!userId) return { error: "No authenticated user." };
        const providers = await aiProviderService.list(userId);
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
// This tool ACTUALLY calls the subagent's LLM and streams the response.
// The orchestrator uses this to ask the subagent to do work and get a reply.
// If the task isn't done, the orchestrator can query again.
registerTool(
  "query_subagent",
  `Send a message to a subagent and get its reply. The subagent will process your message using its configured API + model, and may call tools (same tools as the main agent — shared sandbox + file system). Use this to:

1. Ask a subagent to do work (e.g. "research X", "write code for Y")
2. Check on progress if the subagent is still working
3. Send follow-up instructions

The subagent's reply is returned. If the task isn't complete, query again with more specific instructions. The conversation history is preserved within the subagent's session.

If no task_id is provided, creates a new subagent task. If a name is provided but no existing subagent matches, a new subagent is spawned with that name.`,
  {
    type: "object",
    properties: {
      task_id: {
        type: "string",
        description: "The subagent task ID to query. If omitted, a new task is created.",
      },
      subagent_name: {
        type: "string",
        description: "Name for a new subagent (used when task_id is omitted).",
      },
      message: {
        type: "string",
        description: "The message to send to the subagent.",
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
  async (args) => {
    const message = args.message as string;
    const taskId = args.task_id as string | undefined;
    const subagentName = args.subagent_name as string | undefined;
    const description = args.description as string | undefined;
    const specialty = (args.specialty as string | undefined) ?? "general";

    // Dynamically import to avoid circular deps.
    const { useSubagentStore } = await import("@/stores/subagent-store");
    const { executeSubagentTurn } = await import("@/lib/agent/subagent-runtime");
    const store = useSubagentStore.getState();

    let subagentId: string;

    if (taskId) {
      // Existing task — find the subagent.
      const task = taskStore.get(taskId);
      if (!task) {
        return { error: `Task ${taskId} not found.` };
      }
      // Use subagent_id if available (most reliable), else find by name.
      let existing: SubagentConfig | undefined;
      if (task.subagent_id) {
        existing = store.getSubagent(task.subagent_id);
      }
      if (!existing) {
        existing = store.subagents.find((s) => s.name === task.subagent_name);
      }
      if (!existing) {
        return { error: `Subagent "${task.subagent_name}" no longer exists. It may have been deleted. Spawn a new one with spawn_subagent.` };
      }
      // Allow querying disposed agents — re-enable them so they can be used again.
      // The user should be able to message a subagent even after it was disposed.
      if (existing.lifecycle_status === "disposed" || !existing.enabled) {
        store.updateSubagent(existing.id, {
          enabled: true,
          lifecycle_status: "idle",
        });
        existing = store.getSubagent(existing.id)!;
      }
      subagentId = existing.id;
    } else {
      // New task — create or find a subagent by name.
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
      emitStatus(newTask);
    }

    // Update task status.
    const task = Array.from(taskStore.values()).find((t) => t.subagent_name === store.getSubagent(subagentId)?.name);
    if (task) {
      task.status = "running";
      emitStatus(task);
    }
    // Lifecycle: this agent is now actively working.
    try {
      store.updateLifecycleStatus(subagentId, "working");
    } catch {
      // best-effort
    }

    try {
      const reply = await executeSubagentTurn(subagentId, message);
      if (task) {
        task.status = "completed";
        emitStatus(task);
        emitMessage(task.task_id, "result", reply);
      }
      try {
        useSubagentStore.getState().updateLifecycleStatus(subagentId, "completed");
      } catch {
        // best-effort
      }
      return { subagent_name: store.getSubagent(subagentId)?.name, reply };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (task) {
        task.status = "failed";
        task.error = errMsg;
        emitStatus(task);
      }
      try {
        useSubagentStore.getState().updateLifecycleStatus(subagentId, "idle");
      } catch {
        // best-effort
      }
      return { error: errMsg };
    }
  },
  false,
  "orchestration",
);

// === Tool: steer_subagent ===
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
    const message = args.message as string;
    const task = taskStore.get(taskId);
    if (!task) {
      return { error: `Subagent ${taskId} not found.` };
    }
    emitMessage(taskId, "steering", message);
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
- enabled → false (removed from sidebar)
- status → "disposed"
- Removed from taskStore immediately
A "disposed" status event is emitted so the UI can clean up.

NON-DISPOSABLE AGENTS: Stay in the sidebar (enabled=true) for follow-up work. The task is auto-removed from the active list after 30 seconds (but the SubagentConfig persists).`,
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
      // Auto-dispose: mark disposed, disable config (removes from sidebar),
      // and remove from the in-memory taskStore immediately.
      task.status = "disposed";
      task.error = null;
      emitStatus(task);
      emitMessage(taskId, "result", result);
      emitMessage(taskId, "info", "[DISPOSABLE] Agent auto-disposed after completion.");
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

      return {
        task_id: taskId,
        status: "disposed",
        disposable: true,
        result,
        message: "Disposable agent completed and auto-disposed (removed from sidebar).",
      };
    }

    // Non-disposable — keep the agent around for follow-up work.
    task.status = "completed";
    task.error = null;
    emitStatus(task);
    emitMessage(taskId, "result", result);
    task.messages.push({ type: "result", text: result, timestamp: new Date().toISOString() });

    // Auto-remove from the store after 30 seconds (the UI panel also auto-
    // removes completed tasks after 10s, but we keep the data a bit longer
    // so query_subagent still works shortly after completion).
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
    emitStatus(task);
    emitMessage(taskId, "info", `Task cancelled${reason ? `: ${reason}` : ""}`);
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

// === Tool: create_subagent_chat ===
// Creates a new chat session with a subagent.
registerTool(
  "create_subagent_chat",
  `Create a new chat session with a subagent. Use this when you want to start a fresh conversation with a subagent (separate from existing chats). The session persists across page refreshes.

Returns the session_id which you can use with query_subagent to continue the conversation.`,
  {
    type: "object",
    properties: {
      subagent_name: {
        type: "string",
        description: "Name of the subagent to chat with. If it doesn't exist, it will be auto-created.",
      },
      title: {
        type: "string",
        description: "Optional title for the chat session.",
      },
      description: {
        type: "string",
        description: "Description for a new subagent (if auto-creating).",
      },
      specialty: {
        type: "string",
        enum: ["research", "code", "analysis", "writing", "general"],
        description: "Specialty for a new subagent.",
        default: "general",
      },
      system_prompt: {
        type: "string",
        description: "System prompt for a new subagent.",
      },
    },
    required: ["subagent_name"],
    additionalProperties: false,
  },
  async (args) => {
    const { useSubagentStore } = await import("@/stores/subagent-store");
    const store = useSubagentStore.getState();
    const name = args.subagent_name as string;
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
      message: `New chat session created with ${subagent.name}. Use query_subagent with this subagent to send messages.`,
    };
  },
  false,
  "orchestration",
);

// === Tool: delete_subagent_chat ===
registerTool(
  "delete_subagent_chat",
  "Delete a subagent chat session by its ID. The conversation history is permanently removed.",
  {
    type: "object",
    properties: {
      session_id: { type: "string", description: "The chat session ID to delete." },
    },
    required: ["session_id"],
    additionalProperties: false,
  },
  async (args) => {
    const { useSubagentStore } = await import("@/stores/subagent-store");
    const store = useSubagentStore.getState();
    const sessionId = args.session_id as string;
    const session = store.sessions.find((s) => s.id === sessionId);
    if (!session) {
      return { error: `Session ${sessionId} not found.` };
    }
    store.deleteSession(sessionId);
    return { success: true, deleted: sessionId };
  },
  false,
  "orchestration",
);

// === Tool: edit_subagent_chat_title ===
registerTool(
  "edit_subagent_chat_title",
  "Edit the title of a subagent chat session.",
  {
    type: "object",
    properties: {
      session_id: { type: "string", description: "The chat session ID." },
      title: { type: "string", description: "The new title." },
    },
    required: ["session_id", "title"],
    additionalProperties: false,
  },
  async (args) => {
    const { useSubagentStore } = await import("@/stores/subagent-store");
    const store = useSubagentStore.getState();
    const sessionId = args.session_id as string;
    const title = args.title as string;
    const session = store.sessions.find((s) => s.id === sessionId);
    if (!session) {
      return { error: `Session ${sessionId} not found.` };
    }
    store.updateSessionTitle(sessionId, title);
    return { success: true, session_id: sessionId, title };
  },
  false,
  "orchestration",
);

// === Tool: pin_subagent_chat ===
registerTool(
  "pin_subagent_chat",
  "Pin or unpin a subagent chat session. Pinned chats appear at the top of the chat list.",
  {
    type: "object",
    properties: {
      session_id: { type: "string", description: "The chat session ID." },
      pinned: { type: "boolean", description: "True to pin, false to unpin.", default: true },
    },
    required: ["session_id"],
    additionalProperties: false,
  },
  async (args) => {
    const { useSubagentStore } = await import("@/stores/subagent-store");
    const store = useSubagentStore.getState();
    const sessionId = args.session_id as string;
    const pinned = (args.pinned as boolean) ?? true;
    const session = store.sessions.find((s) => s.id === sessionId);
    if (!session) {
      return { error: `Session ${sessionId} not found.` };
    }
    store.pinSession(sessionId, pinned);
    return { success: true, session_id: sessionId, pinned };
  },
  false,
  "orchestration",
);
