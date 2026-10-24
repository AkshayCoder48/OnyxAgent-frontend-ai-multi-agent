// ============================================================================
// Background Task Execution Framework — POST /api/tasks/trigger (FR-1.2).
//
// Entry point of every background task: validate the client's
// TaskTriggerRequest against the protocol budgets, persist the TaskRun (task
// token stored ONLY as sha256), stash the run's secrets in the in-memory
// keyring (PRD §4.2), then dispatch — in-process local driver by default,
// kicked straight to Trigger.dev Cloud when a cloud key is connected
// (Settings → Cloud Tasks), or left queued for a self-hosted Trigger.dev
// worker when that mode is configured.
//
// Body-logging discipline mirrors /api/chat-proxy: request payloads (which
// carry keys + tokens) are NEVER logged.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/tasks/prisma";
import { keyring, sha256Hex } from "@/lib/tasks/keyring";
import { startLocalRun, clampTimeoutMs } from "@/lib/tasks/local-driver";
import { startSchedulerLoop, touch } from "@/lib/tasks/cron-scheduler";
import { getOrchestrationMode } from "@/lib/tasks/orchestration-mode";
import { kickCloudRun } from "@/lib/tasks/trigger-cloud";
import {
  BACKGROUND_TASK_TYPES,
  TASK_PAYLOAD_BUDGET,
  type BackgroundTaskType,
  type TaskPayload,
  type TaskRunConfig,
  type TaskTriggerRequest,
  type TaskTriggerResponse,
} from "@/lib/tasks/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** uuid-ish client-minted task id (uuid v4, nanoid, or similar slug). */
const TASK_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
/** Client-minted task token: 32–128 hex chars. */
const TASK_TOKEN_RE = /^[0-9a-f]{32,128}$/i;

interface NormalizedTrigger {
  req: TaskTriggerRequest;
  keyPool: string[];
  config: TaskRunConfig;
  payload: TaskPayload;
}

function bad(detail: string): NextResponse {
  return NextResponse.json({ ok: false, error: detail }, { status: 400 });
}

/** Validate + normalize the trigger body. Returns a 400 detail on failure. */
function validate(body: unknown): { error: string } | { value: NormalizedTrigger } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "body must be a JSON object" };
  }
  const b = body as Partial<TaskTriggerRequest>;

  if (typeof b.taskId !== "string" || !TASK_ID_RE.test(b.taskId)) {
    return { error: "taskId must be a 6–64 char uuid-like string" };
  }
  if (typeof b.taskToken !== "string" || !TASK_TOKEN_RE.test(b.taskToken)) {
    return { error: "taskToken must be 32–128 hex characters" };
  }
  if (typeof b.type !== "string" || !(BACKGROUND_TASK_TYPES as readonly string[]).includes(b.type)) {
    return { error: `type must be one of ${BACKGROUND_TASK_TYPES.join(", ")}` };
  }
  if (typeof b.prompt !== "string" || !b.prompt.trim()) {
    return { error: "prompt must be a non-empty string" };
  }
  if (b.prompt.length > TASK_PAYLOAD_BUDGET.maxPromptChars) {
    return { error: `prompt exceeds ${TASK_PAYLOAD_BUDGET.maxPromptChars} chars` };
  }
  if (typeof b.userId !== "string" || !b.userId.trim()) {
    return { error: "userId is required" };
  }

  // ── config ──
  const rawConfig = (b.config ?? {}) as TaskRunConfig;
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    return { error: "config must be an object" };
  }
  const config: TaskRunConfig = { ...rawConfig };
  if (typeof rawConfig.timeoutMs === "number" && Number.isFinite(rawConfig.timeoutMs)) {
    config.timeoutMs = clampTimeoutMs(rawConfig.timeoutMs);
  }
  if (b.type === "terminal_command" && (typeof config.command !== "string" || !config.command.trim())) {
    return { error: "terminal_command requires config.command" };
  }

  // ── payload (FR-1.1 budgets) ──
  const rawPayload = b.payload;
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return { error: "payload must be an object" };
  }
  const files = Array.isArray(rawPayload.files) ? rawPayload.files : [];
  if (files.length > TASK_PAYLOAD_BUDGET.maxFiles) {
    return { error: `payload exceeds ${TASK_PAYLOAD_BUDGET.maxFiles} files` };
  }
  let totalFileBytes = 0;
  for (const f of files) {
    if (!f || typeof f !== "object") return { error: "payload.files entries must be objects" };
    if (typeof f.path !== "string" || !f.path.trim()) return { error: "payload file path missing" };
    if (typeof f.content !== "string") return { error: `payload file ${f.path} has no content` };
    if (f.encoding !== "utf8" && f.encoding !== "base64") {
      return { error: `payload file ${f.path} encoding must be utf8|base64` };
    }
    const size = typeof f.size === "number" && Number.isFinite(f.size) ? f.size : f.content.length;
    if (size > TASK_PAYLOAD_BUDGET.maxFileBytes) {
      return { error: `payload file ${f.path} exceeds ${TASK_PAYLOAD_BUDGET.maxFileBytes} bytes` };
    }
    totalFileBytes += size;
  }
  if (totalFileBytes > TASK_PAYLOAD_BUDGET.maxTotalFileBytes) {
    return { error: `payload files exceed ${TASK_PAYLOAD_BUDGET.maxTotalFileBytes} bytes total` };
  }
  const messages = Array.isArray(rawPayload.conversation?.messages)
    ? rawPayload.conversation.messages
    : [];
  // Re-cap the seed defensively (the client already sliced).
  const cappedMessages = messages.slice(-TASK_PAYLOAD_BUDGET.maxSeedMessages);
  const payload: TaskPayload = {
    version: 1,
    conversation: {
      id: rawPayload.conversation?.id ?? null,
      title: rawPayload.conversation?.title ?? null,
      messages: cappedMessages,
    },
    files,
  };
  if (JSON.stringify(payload).length > TASK_PAYLOAD_BUDGET.maxBytes) {
    return { error: `payload exceeds ${TASK_PAYLOAD_BUDGET.maxBytes} bytes serialized` };
  }

  // ── key pool (FR-1.3) ──
  const rawPool = Array.isArray(b.keyPool) ? b.keyPool : [];
  if (rawPool.length > TASK_PAYLOAD_BUDGET.maxKeyPool) {
    return { error: `keyPool exceeds ${TASK_PAYLOAD_BUDGET.maxKeyPool} keys` };
  }
  const keyPool = rawPool.filter((k): k is string => typeof k === "string" && k.trim().length > 0);

  return {
    value: {
      req: {
        taskId: b.taskId,
        taskToken: b.taskToken,
        type: b.type as BackgroundTaskType,
        prompt: b.prompt,
        config,
        payload,
        keyPool,
        e2bApiKey: typeof b.e2bApiKey === "string" ? b.e2bApiKey : undefined,
        userId: b.userId,
        conversationId: typeof b.conversationId === "string" ? b.conversationId : undefined,
        scheduleId: typeof b.scheduleId === "string" ? b.scheduleId : undefined,
        title: typeof b.title === "string" ? b.title : undefined,
      },
      keyPool,
      config,
      payload,
    },
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("invalid JSON body");
  }

  const checked = validate(body);
  if ("error" in checked) return bad(checked.error);
  const { req, keyPool, config, payload } = checked.value;

  try {
    const mode = await getOrchestrationMode();
    const tokenHash = sha256Hex(req.taskToken);
    const run = await prisma.taskRun.create({
      data: {
        taskId: req.taskId,
        userId: req.userId,
        type: req.type,
        status: "queued",
        phase: "claim",
        orchestrator: mode === "cloud" ? "cloud" : mode === "selfhosted" ? "triggerdev" : "local",
        title: req.title ? req.title.slice(0, 200) : null,
        prompt: req.prompt,
        config: JSON.stringify(config),
        payload: JSON.stringify(payload),
        taskTokenHash: tokenHash,
        conversationId: req.conversationId ?? null,
        scheduleId: req.scheduleId ?? null,
      },
    });

    // Keyring BEFORE dispatch — the driver reads it on the first tick. The
    // plaintext token/keys live in memory only (PRD §4.2).
    keyring.set(run.id, {
      taskToken: req.taskToken,
      keyPool,
      chatUrl: config.chatUrl,
      model: config.model,
      e2bApiKey: req.e2bApiKey,
      appUrl: new URL(request.url).origin,
      createdAt: Date.now(),
    });

    // Sweep-on-read: fire due schedules opportunistically (throttled), then
    // dispatch the run itself.
    touch();

    if (mode === "selfhosted") {
      // Self-hosted worker owns execution — leave the row queued; the loop
      // only arms.
      startSchedulerLoop();
      const res: TaskTriggerResponse = { ok: true, runId: run.id, orchestrator: "triggerdev" };
      return NextResponse.json(res);
    }

    if (mode === "cloud") {
      // Trigger.dev CLOUD — kick the deployed agent-run task directly over
      // the cloud REST API (zero queue latency). On failure kickCloudRun
      // releases the claim and the row stays queued for the deployed
      // worker's poll-claims cron (backstop dispatcher).
      startSchedulerLoop();
      const fallbackAppUrl = new URL(request.url).origin;
      const kick = await kickCloudRun(run.id, fallbackAppUrl).catch((err) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }));
      if (!kick.ok) {
        console.warn(
          `[tasks] run ${run.id} left queued — cloud kick failed: ${kick.error.slice(0, 200)}`,
        );
      }
      const res: TaskTriggerResponse = { ok: true, runId: run.id, orchestrator: "triggerdev" };
      return NextResponse.json(res);
    }

    startLocalRun(run.id);
    startSchedulerLoop();
    const res: TaskTriggerResponse = { ok: true, runId: run.id, orchestrator: "local" };
    return NextResponse.json(res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[tasks] trigger failed to create a run: ${message.slice(0, 200)}`);
    return NextResponse.json({ ok: false, error: "failed to create the run" }, { status: 500 });
  }
}
