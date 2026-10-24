// ============================================================================
// Background Task Execution Framework — runner config builder.
//
// buildRunnerConfig mirrors DetachedRunConfig (src/lib/agent/detached-run.ts)
// — the exact JSON the sandbox-resident headless runner reads from
// /home/user/.onyx/agent/run.json — with two task-framework additions:
//
//   · chat_url defaults to the app's own keyless LLM bridge
//     (/api/tasks/llm) with the task token as the bearer credential, so a
//     background task works with ZERO provider keys (PRD keyless bridge).
//   · api_key_pool carries the FR-1.3 rotational key pool; runner v2
//     rotates through it on 429/401 instead of failing the run.
//
// Row JSON parsing lives in run-store.ts (single source of truth).
// ============================================================================

import type { TaskRun } from "@prisma/client";
import {
  TASK_DEFAULT_MAX_ROUNDS,
  TASK_HARD_MAX_ROUNDS,
} from "./protocol";
import type { KeyringEntry } from "./keyring";
import { parseConfig, parsePayload } from "./run-store";

/**
 * Build the /home/user/.onyx/agent/run.json payload for a run (same shape as
 * DetachedRunConfig, plus api_key_pool for runner v2). NEVER log the result —
 * it carries the bridge token / provider keys.
 */
export function buildRunnerConfig(
  run: TaskRun,
  entry: KeyringEntry,
): Record<string, unknown> {
  const config = parseConfig(run.config);
  const payload = parsePayload(run.payload);

  // Keyless bridge by default; a user provider chatUrl wins when present.
  const usingBridge = !entry.chatUrl;
  const chatUrl =
    entry.chatUrl || `${entry.appUrl.replace(/\/+$/, "")}/api/tasks/llm`;
  // Bridge auth = the task token (the bridge authorizes against the
  // keyring/hash). User gateway auth = the first key of the pool.
  const apiKey = usingBridge ? entry.taskToken : entry.keyPool[0] || entry.taskToken;

  // Seed = the payload's budget-capped conversation (client already sliced
  // to maxSeedMessages; re-cap defensively).
  const seedMessages = (payload.conversation?.messages ?? []).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const maxRounds = Math.min(
    config.maxRounds ?? TASK_DEFAULT_MAX_ROUNDS,
    TASK_HARD_MAX_ROUNDS,
  );

  const out: Record<string, unknown> = {
    run_id: run.id,
    conversation_id: run.conversationId ?? "",
    prompt: run.prompt,
    chat_url: chatUrl,
    api_key: apiKey,
    model: entry.model ?? config.model ?? "",
    system_prompt: config.systemPrompt ?? "",
    seed_messages: seedMessages,
    temperature: typeof config.temperature === "number" ? config.temperature : null,
    max_rounds: Math.max(1, maxRounds),
  };

  // FR-1.3 rotational pool — only present when the client sent keys (the
  // detached-run flow omits it entirely and keeps its single-key behavior).
  if (entry.keyPool.length > 0) {
    out.api_key_pool = entry.keyPool;
  }

  return out;
}
