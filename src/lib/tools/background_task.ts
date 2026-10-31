"use client";

import { registerTool } from "./registry";
import {
  cancelTask,
  listTaskRuns,
  pollTaskStatus,
  triggerBackgroundTask,
} from "@/lib/tasks/client";
import type { BackgroundTaskType, TaskStatusRun } from "@/lib/tasks/protocol";

/**
 * `background_task` — the Epic 3 entry point for durable background work.
 *
 * Runs work as a background task inside an isolated E2B sandbox managed by
 * the task orchestrator (local in-process driver, or the Trigger.dev worker
 * when deployed): it survives tab close, streams chunked progress, and syncs
 * its artifacts back into the linked conversation on completion. This is the
 * tool to reach for when a job would blow the 60-120s local tool budget.
 *
 * Actions:
 *   · create — start a task (agent_run prompt loop OR one terminal command).
 *   · status — poll one run (phase/round/stage/current tool/artifact count).
 *   · list   — the user's 10 most recent runs.
 *   · cancel — stop a live run (needs this browser's task token).
 *
 * BYOK (user directive 2026-10-31): agent_run tasks are created with the
 * user's CURRENT chat provider pinned (gateway + key + model) — background
 * runs execute on the user's own credentials, never the app's built-in
 * model (the keyless bridge was removed). terminal_command tasks need no
 * LLM credentials.
 *
 * NOTE on `requires_approval`: the registry flag is static (per tool, not per
 * action) — it is set because `create` is the only resource-consuming action
 * (a fresh sandbox + up to 30 minutes of execution); status/list/cancel are
 * read-only/lightweight. The runtime's argument-aware approval gate
 * (lib/agent/approval-gate.ts → defaultPermissionFor) governs the actual
 * HITL prompting and is configured separately.
 */

function excerpt(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Resolve the user's CURRENT chat provider as a BYOK pin for a background
 * agent task (gateway URL + model + decrypted key). Null when no usable
 * provider exists — the task is then refused with instructions (it would
 * otherwise run on the app's own model, which is never a fallback). */
async function resolveTurnProviderPin(userId: string): Promise<{
  chatUrl: string;
  model: string;
  apiKey: string;
  providerId: string | null;
} | null> {
  try {
    const { useChatStore } = await import("@/stores/chat-store");
    const { aiProviderService } = await import("@/lib/services");
    const {
      chatCompletionsUrl,
      listUsableProviders,
      resolveProviderForModel,
    } = await import("@/lib/agent/provider-resolution");

    const store = useChatStore.getState();
    const providers = await listUsableProviders(userId);
    const selected =
      resolveProviderForModel(providers, store.selectedModel) ??
      (store.selectedProviderId
        ? providers.find((p) => p.id === store.selectedProviderId)
        : undefined) ??
      providers.find((p) => p.is_active) ??
      providers[0];
    if (!selected || !selected.base_url?.trim()) return null;

    let apiKey = "";
    try {
      apiKey = await aiProviderService.getDecryptedApiKey(selected.id);
    } catch {
      apiKey = ""; // vault locked — the pinned gateway may still be keyless
    }
    const model =
      store.selectedModel && (selected.models ?? []).includes(store.selectedModel)
        ? store.selectedModel
        : (selected.models?.[0] ?? "");
    return {
      chatUrl: chatCompletionsUrl(
        selected.base_url,
        (selected as { no_prefix?: boolean }).no_prefix ?? false,
      ),
      model,
      apiKey,
      providerId: selected.id,
    };
  } catch {
    return null;
  }
}

function runSummary(run: TaskStatusRun) {
  return {
    run_id: run.runId,
    type: run.type,
    status: run.status,
    title: run.title?.trim() || excerpt(run.prompt, 60),
    updated_at: run.updatedAt,
  };
}

registerTool(
  "background_task",
  "Run work as a durable background task inside an isolated E2B sandbox — survives tab close, up to 30 minutes. Use for long research/report/terminal jobs; poll with action status.",
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "status", "list", "cancel"],
        description:
          "create: start a background task (returns run_id). status: poll a run's progress. list: the 10 most recent runs. cancel: stop a live run.",
      },
      task_type: {
        type: "string",
        enum: ["agent_run", "terminal_command"],
        description:
          "create only — agent_run executes the prompt as a full agent loop (with tools); terminal_command runs a single shell command to completion.",
      },
      prompt: {
        type: "string",
        description:
          "create + agent_run: the complete instructions for the background agent (it will not see this conversation — include all context it needs).",
      },
      command: {
        type: "string",
        description: "create + terminal_command: the shell command to run.",
      },
      include_workspace: {
        type: "boolean",
        default: true,
        description:
          "create: mount the current workspace files into the task sandbox (default true).",
      },
      require_approval: {
        type: "boolean",
        default: false,
        description:
          "create: human-in-the-loop — suspend the cloud run on a Trigger.dev waitpoint and wait for the user's Approve/Deny in the web UI before executing. Destructive terminal commands gate automatically even when false.",
      },
      run_id: {
        type: "string",
        description: "status/cancel: the run_id returned by create.",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const action = args.action as string;

    try {
      switch (action) {
        // ── create ─────────────────────────────────────────────────────────
        case "create": {
          if (!ctx.userId) {
            return { error: "No user context — cannot start a background task." };
          }
          const taskType: BackgroundTaskType =
            args.task_type === "terminal_command" ? "terminal_command" : "agent_run";
          const prompt = typeof args.prompt === "string" ? args.prompt : "";
          const command = typeof args.command === "string" ? args.command : "";
          if (taskType === "agent_run" && !prompt.trim()) {
            return {
              error: "agent_run background tasks need a prompt describing the work.",
            };
          }
          if (taskType === "terminal_command" && !command.trim()) {
            return { error: "terminal_command background tasks need a command to run." };
          }
          const includeWorkspace = args.include_workspace !== false;
          const requireApproval = args.require_approval === true;

          // ── BYOK PIN (user directive 2026-10-31) ────────────────────────
          // agent_run tasks carry the USER'S OWN provider (the one selected
          // in chat): its gateway is pinned into the run config and its key
          // leads the pool. Without a usable provider the task is REFUSED —
          // background work never runs on the app's built-in model.
          if (taskType === "agent_run") {
            const pin = await resolveTurnProviderPin(ctx.userId);
            if (!pin) {
              return {
                error:
                  "No AI provider of your own is configured — background agent tasks execute with the user's own provider and key (never the app's built-in model). Ask the user to add one in Settings → Agent Settings → AI Providers, then retry.",
              };
            }
            const res = await triggerBackgroundTask({
              userId: ctx.userId,
              conversationId: ctx.conversationId ?? null,
              type: taskType,
              prompt,
              title: excerpt(prompt, 60),
              config: {
                chatUrl: pin.chatUrl,
                ...(pin.model ? { model: pin.model } : {}),
                ...(requireApproval ? { requireApproval } : {}),
              },
              includeWorkspace,
              preferredProviderId: pin.providerId ?? undefined,
              ...(pin.apiKey ? { pinnedApiKey: pin.apiKey } : {}),
              sandboxApiKey: ctx.e2bApiKey ?? ctx.sandboxApiKey,
            });
            return {
              run_id: res.runId,
              orchestrator: res.orchestrator,
              status: "queued",
              note: "Poll with action status.",
            };
          }

          const res = await triggerBackgroundTask({
            userId: ctx.userId,
            conversationId: ctx.conversationId ?? null,
            type: taskType,
            prompt:
              taskType === "terminal_command" && !prompt.trim()
                ? `Terminal: ${command.slice(0, 200)}`
                : prompt,
            title:
              taskType === "terminal_command"
                ? `Terminal: ${command.slice(0, 60)}`
                : excerpt(prompt, 60),
            ...(taskType === "terminal_command"
              ? { config: { command, ...(requireApproval ? { requireApproval } : {}) } }
              : requireApproval
                ? { config: { requireApproval } }
                : {}),
            includeWorkspace,
            sandboxApiKey: ctx.e2bApiKey ?? ctx.sandboxApiKey,
          });
          return {
            run_id: res.runId,
            orchestrator: res.orchestrator,
            status: "queued",
            note: "Poll with action status.",
          };
        }

        // ── status ─────────────────────────────────────────────────────────
        case "status": {
          const runId = args.run_id as string;
          if (!runId) return { error: "status needs a run_id." };
          const run = await pollTaskStatus(runId, -1);
          if (!run) {
            return {
              error:
                "Run not found — it may have been cleaned up on the server, or the run_id is wrong.",
            };
          }
          return {
            run_id: run.runId,
            status: run.status,
            phase: run.phase,
            round: run.progress?.round ?? 0,
            total_rounds: run.progress?.totalRounds ?? 0,
            stage: run.progress?.stage ?? null,
            current_tool: run.progress?.currentTool ?? null,
            artifacts: run.artifacts?.length ?? 0,
            error: run.error,
          };
        }

        // ── list ───────────────────────────────────────────────────────────
        case "list": {
          if (!ctx.userId) return { error: "No user context — cannot list background tasks." };
          const runs = await listTaskRuns(ctx.userId);
          const recent = [...runs]
            .sort(
              (a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""),
            )
            .slice(0, 10);
          return { runs: recent.map(runSummary) };
        }

        // ── cancel ─────────────────────────────────────────────────────────
        case "cancel": {
          const runId = args.run_id as string;
          if (!runId) return { error: "cancel needs a run_id." };
          await cancelTask(runId);
          return { cancelled: true, run_id: runId };
        }

        default:
          return {
            error: `Unknown action "${String(action)}" — use create, status, list or cancel.`,
          };
      }
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
  true, // requires_approval — see the file header note (create is the resource-consuming action)
  "orchestration",
);
