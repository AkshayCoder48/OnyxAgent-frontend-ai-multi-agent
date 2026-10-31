// ============================================================================
// Trigger.dev v4 task: agent-run — the DIRECT durable background-task driver.
//
// Everything the run needs arrives in the payload (app POSTs it to
// POST /api/v1/tasks/agent-run/trigger): the run spec, the E2B key, the
// resolved LLM endpoint + rotational key pool. The task never calls back to
// the app — progress streams into run METADATA (the app polls
// GET /api/v3/runs/:id and reads the `onyx` blob) and the final result is
// the run OUTPUT (status, error, artifacts) which the app reads when the
// cloud run reaches a terminal state.
//
// Execution map (mirrors the app's local driver):
//   [BYOK gate] → [HITL gate] → init → create-sandbox → mount → verify →
//   start → monitor (5s poll) → collect-artifacts → output.
//
// Trigger.dev v4 PRD compliance:
//   §3.2 resilience — LLM calls retry with exponential backoff + full jitter
//     (retry.fetch discipline) on 401/429/5xx, rotating the BYOK key pool.
//   §3.3 HITL — sensitive runs SUSPEND on a waitpoint token (needsApproval)
//     and wait indefinitely (7d ceiling) for the web UI's Approve/Deny; the
//     run's state checkpoints survive the suspension by construction.
//   §3.4 timeout freedom — hour-scale maxDuration instead of HTTP seconds.
//   §4  concurrency — a per-user queue key (concurrencyKey = userId, passed
//     by the app at trigger time) caps each user at 2 concurrent runs so one
//     user can never exhaust the operator's cloud allocation.
//
// BYOK POLICY (user directive 2026-10-31): every LLM call goes through the
// USER's own pinned provider gateway (credentials.chatUrl + key pool). The
// app's keyless LLM bridge was REMOVED — this worker never calls back into
// the app for completions, and an agent run without user credentials fails
// fast with instructions instead of silently burning the operator's model
// budget.
// ============================================================================

import { task, metadata, logger, wait } from "@trigger.dev/sdk";
import type {
  AgentRunOutput,
  AgentRunPayload,
  CloudArtifact,
  RunMetadataState,
  TaskStatusChunk,
} from "../protocol.js";
import { TASK_PAYLOAD_BUDGET } from "../protocol.js";
import { Sandbox } from "@e2b/code-interpreter";
import {
  collectArtifacts,
  createTaskSandbox,
  killQuiet,
  mountPayload,
  readAgentHistory,
  readAgentStatus,
  readLogTail,
  readTerminalStatus,
  startAgentRunner,
  startTerminalCommand,
  verifyMount,
} from "../e2b-driver.js";
import {
  clampMaxRounds,
  errorMessage,
  startedAtMs,
} from "../util.js";

/** Payload shape — see protocol.ts AgentRunPayload. */
export type AgentRunPayloadType = AgentRunPayload;

/** Monitor poll cadence. */
const POLL_INTERVAL_MS = 5_000;
/** Boot grace before a missing status file counts as failure. */
const BOOT_GRACE_MS = 90_000;
/** Stall guard — no status progress for this long = failed. */
const STALL_LIMIT_MS = 10 * 60 * 1000;
/** Chunk ring size (newest kept in metadata; the app drains every poll). */
const CHUNK_RING_SIZE = 30;
/** Per-chunk content cap for the metadata ring (keeps the blob small). */
const RING_CHUNK_MAX_CHARS = 1_500;
/** HITL waitpoint ceiling — PRD §3.3 says "wait indefinitely"; 7 days is
 *  the practical durable decision window (the run parks PAUSED on the
 *  cloud consuming no worker capacity while it waits). */
const APPROVAL_TIMEOUT = "7d";

// ---------------------------------------------------------------------------
// Resilience + HITL helpers (Trigger.dev PRD §3.2 / §3.3)
// ---------------------------------------------------------------------------

/** Exponential backoff with full jitter — the PRD §3.2 retry.fetch
 *  discipline for upstream LLM failures (rate limits, drops, 5xx). */
function backoffDelayMs(attempt: number, baseMs = 1_000, capMs = 30_000): number {
  const exp = Math.min(baseMs * 2 ** attempt, capMs);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

/** Destructive terminal commands auto-gate on human approval even without
 *  config.requireApproval (PRD §3.3: "deploying code or processing a
 *  charge"-class sensitive actions must suspend, not run blind). */
const DESTRUCTIVE_PATTERN =
  /(?:rm\s+(?:-[a-z]*f[a-z]*|-[a-z]*r[a-z]*)|mkfs|dd\s+if=|shutdown|reboot|:\(\)\s*\{|drop\s+(?:table|database)|truncate\s+table|git\s+push\s+(?:--force\b|-f\b)|npm\s+publish|curl[^|;]*\|\s*(?:ba)?sh|wget[^|;]*\|\s*(?:ba)?sh|chmod\s+-R\s+777\s+\/|kill\s+-9\s+1\b)/i;

function requiresHumanApproval(run: AgentRunPayload["run"]): boolean {
  if (run.config.requireApproval === true) return true;
  if (run.type === "terminal_command" && typeof run.config.command === "string") {
    return DESTRUCTIVE_PATTERN.test(run.config.command);
  }
  return false;
}

type ApprovalOutcome = { kind: "approved" } | { kind: "denied" } | { kind: "skipped" };

// ---------------------------------------------------------------------------
// BYOK credential gate (user directive 2026-10-31)
// ---------------------------------------------------------------------------

/** Actionable failure when an agent run carries no provider gateway of its
 *  own — the user must add THEIR provider; the app's own model is never a
 *  fallback for background work. */
const NO_PROVIDER_CREDENTIALS_ERROR =
  "This background run has no AI provider of its own — add your provider and API key in Settings → Agent Settings → AI Providers, then retry. Background runs always execute with YOUR credentials; the app's built-in model is never used as a fallback. (code: byok_no_gateway)";

/** Absolute http(s) check — the only gateways a cloud runner can reach. */
function isAbsoluteHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/** True when a URL points at the app's own (removed) LLM-bridge route —
 *  payloads minted before the BYOK policy are refused instead of spending
 *  the operator's credentials. */
function isAppBridgeUrl(url: string): boolean {
  if (!isAbsoluteHttpUrl(url)) return false;
  try {
    return new URL(url.trim()).pathname.replace(/\/+$/, "") === "/api/tasks/llm";
  } catch {
    return false;
  }
}

/** Gate ONE payload's LLM credentials: null when the run may execute, or
 *  the honest error string when it must not. terminal_command runs never
 *  need an LLM leg. */
function gateLlmCredentials(payload: AgentRunPayload): string | null {
  if (payload.run.type === "terminal_command") return null;
  const chatUrl = (payload.credentials.chatUrl ?? "").trim();
  if (!isAbsoluteHttpUrl(chatUrl) || isAppBridgeUrl(chatUrl)) {
    return NO_PROVIDER_CREDENTIALS_ERROR;
  }
  return null;
}

/**
 * HUMAN-IN-THE-LOOP GATE (PRD §3.3): mint a Trigger.dev waitpoint token,
 * publish it through run metadata (the app's status poll renders the
 * Approve/Deny banner from it), then SUSPEND this run by waiting on the
 * token. The run parks PAUSED on the cloud — no worker slot, no HTTP
 * timeout — until the app completes the token with { approved } (POST
 * /api/v1/waitpoints/tokens/:id/complete, called by /api/tasks/approval).
 * Everything accumulated so far IS the checkpoint: it lives in run
 * metadata, and v4 resumes this exact execution after the decision.
 */
async function maybeSuspendForApproval(
  payload: AgentRunPayload,
  state: RunMetadataState,
  pushChunk: (chunk: Omit<TaskStatusChunk, "seq">) => void,
  flush: () => void,
): Promise<ApprovalOutcome> {
  const { run } = payload;
  if (!requiresHumanApproval(run)) return { kind: "skipped" };

  const reason =
    run.type === "terminal_command"
      ? `Destructive terminal command needs approval before it runs in the sandbox: ${String(run.config.command ?? "").slice(0, 240)}`
      : "This run was flagged for human approval (requireApproval) before executing.";

  state.phase = "init";
  state.progress.stage = "awaiting-approval";
  state.progress.lastUpdate = Date.now();
  pushChunk({ kind: "log", content: `Approval required — ${reason}`, ts: Date.now() });

  const token = await wait.createToken({
    timeout: APPROVAL_TIMEOUT,
    tags: ["onyx-approval", `run:${run.runId}`],
  });

  // Publish the approval request BEFORE suspending — this metadata write is
  // the only channel the app has to see it (pull-only protocol).
  state.approval = { token: token.id, reason, createdAt: Date.now() };
  flush();
  logger.info(`[agent-run ${run.runId}] suspended awaiting human approval (waitpoint ${token.id}, ${APPROVAL_TIMEOUT} ceiling)`);

  // SUSPEND — returns only when the token is completed (or times out).
  const decision = (await wait.forToken<{ approved?: boolean }>(token.id)) as {
    ok: boolean;
    output?: { approved?: boolean };
    error?: unknown;
  };

  delete state.approval;
  state.progress.stage = "approved";
  state.progress.lastUpdate = Date.now();
  flush();

  if (!decision.ok) {
    throw new Error(
      `human approval was not given within the ${APPROVAL_TIMEOUT} window — the run was abandoned without executing`,
    );
  }
  return decision.output?.approved === true ? { kind: "approved" } : { kind: "denied" };
}

export const agentRun = task({
  id: "agent-run",
  // PRD §4 timeout freedom: hour-scale durable execution (was 35 min).
  maxDuration: 3600,
  // PRD §4 concurrency controls: one queue, keyed per user — the app passes
  // concurrencyKey = userId at trigger time, so each user is capped at 2
  // concurrent runs and can never exhaust the operator's allocation.
  queue: { name: "agent-runs" },
  concurrency: { perKey: 2 },
  retry: { maxAttempts: 2 },
  run: async (payload: AgentRunPayload): Promise<AgentRunOutput> => {
    const { run, credentials } = payload;
    const runId = run.runId;
    const deadline = startedAtMs(run.startedAt) + (run.timeoutMs || 30 * 60 * 1000);

    let sandbox: Sandbox | null = null;

    /** Progress state flushed to run metadata (polled by the app). */
    const state: RunMetadataState = {
      phase: "init",
      progress: {
        round: 0,
        totalRounds: 0,
        stage: "claimed",
        currentTool: null,
        lastUpdate: Date.now(),
      },
      chunkSeq: 0,
      chunks: [],
      updatedAt: Date.now(),
    };

    const flush = () => {
      state.updatedAt = Date.now();
      try {
        metadata.set("onyx", JSON.parse(JSON.stringify(state)) as never);
      } catch (err) {
        // Metadata write failures must never kill the run — progress
        // polling degrades gracefully to the run status alone.
        logger.warn(`[agent-run ${runId}] metadata flush failed: ${errorMessage(err)}`);
      }
    };

    const pushChunk = (chunk: Omit<TaskStatusChunk, "seq">) => {
      state.chunkSeq += 1;
      state.chunks.push({
        ...chunk,
        seq: state.chunkSeq,
        content: String(chunk.content ?? "").slice(0, RING_CHUNK_MAX_CHARS),
      });
      if (state.chunks.length > CHUNK_RING_SIZE) {
        state.chunks = state.chunks.slice(-CHUNK_RING_SIZE);
      }
    };

    const setStage = (phase: RunMetadataState["phase"], stage: string) => {
      state.phase = phase;
      state.progress.stage = stage;
      state.progress.lastUpdate = Date.now();
      flush();
    };

    try {
      // ---- HITL approval gate (PRD §3.3) — both lanes ---------------------
      const approval = await maybeSuspendForApproval(payload, state, pushChunk, flush);
      if (approval.kind === "denied") {
        state.phase = "done";
        state.progress.stage = "denied";
        state.progress.lastUpdate = Date.now();
        pushChunk({
          kind: "error",
          content: "Human approval was DENIED — the run was cancelled without executing.",
          ts: Date.now(),
        });
        flush();
        logger.info(`[agent-run ${runId}] denied by human approval — cancelling`);
        return {
          runId,
          status: "cancelled",
          error: "Denied by human approval.",
          artifacts: [],
        };
      }

      // ---- BYOK credential gate (user directive 2026-10-31) ---------------
      // Agent runs execute ONLY on the user's own pinned gateway; there is
      // no app-bridge fallback. A permanent misconfiguration returns a
      // FAILED OUTPUT (no Trigger.dev retry — retrying cannot add
      // credentials), and the error names exactly what the user must add.
      const credentialError = gateLlmCredentials(payload);
      if (credentialError) {
        state.phase = "done";
        state.progress.stage = "failed";
        state.progress.lastUpdate = Date.now();
        pushChunk({ kind: "error", content: credentialError.slice(0, RING_CHUNK_MAX_CHARS), ts: Date.now() });
        flush();
        logger.error(`[agent-run ${runId}] refused: no user provider credentials`);
        return {
          runId,
          status: "failed",
          error: credentialError,
          artifacts: [],
        };
      }

      // ---- NATIVE MODE (no E2B key — the zero-setup lane) ────────────────
      // Trigger.dev Cloud itself is the compute: the agent loop runs
      // IN-TASK with NO sandbox and a tools-off surface (text + seed
      // context only). This keeps chat handoffs executing durably for
      // operators who connected ONLY a trigger.dev key — no second setup
      // step. Terminal commands still require a real sandbox (they ARE
      // shell commands) and fail honestly.
      if (!credentials.e2bApiKey.trim()) {
        if (run.type === "terminal_command") {
          throw new Error(
            "No E2B sandbox key available for this run — terminal commands need one (add it in Settings → Sandboxes or set E2B_API_KEY on the app server) and retry.",
          );
        }
        return await runNativeAgentRun(payload, state, pushChunk, setStage, flush);
      }

      // ---- Phase: create sandbox (PRD §4.2 — bounded window, with
      // exponential-backoff retries on transient E2B failures) ------------
      setStage("init", "creating-sandbox");
      let box: Awaited<ReturnType<typeof createTaskSandbox>> | null = null;
      let lastCreateError = "";
      for (let attempt = 0; attempt < 3 && !box; attempt++) {
        try {
          box = await createTaskSandbox(run, credentials.e2bApiKey);
        } catch (err) {
          lastCreateError = errorMessage(err);
          // A missing key is permanent — don't burn retries on it.
          if (lastCreateError.includes("No E2B sandbox key")) break;
          logger.warn(
            `[agent-run ${runId}] sandbox create attempt ${attempt + 1} failed: ${lastCreateError.slice(0, 160)}`,
          );
          if (attempt < 2) await sleepMs(backoffDelayMs(attempt));
        }
      }
      if (!box) {
        throw new Error(`sandbox creation failed after retries: ${lastCreateError.slice(0, 300)}`);
      }
      sandbox = box;
      state.progress.stage = "sandbox-ready";
      flush();
      logger.info(`[agent-run ${runId}] sandbox ${box.sandboxId} created`);

      // ---- Phase: mount client workspace (FR-1.1 / FR-4.1) ----------------
      setStage("mount", "files-mounting");
      const manifest = await mountPayload(box, run);

      // ---- Phase: verify manifest (FR-4.1) ---------------------------------
      const mountReport = await verifyMount(box, manifest);
      state.progress.mountReport = mountReport;
      setStage("verify", "mount-verified");
      logger.info(
        `[agent-run ${runId}] mount verified ${mountReport.filesVerified}/${mountReport.filesListed}` +
          (mountReport.missing.length ? ` (missing: ${mountReport.missing.length})` : ""),
      );

      // ---- Phase: start (agent runner OR terminal command) -----------------
      setStage("start", "launching");
      if (run.type === "terminal_command") {
        await startTerminalCommand(box, run);
      } else {
        await startAgentRunner(box, run, credentials);
      }
      setStage("monitor", "launched");

      // ---- Phase: monitor — file-protocol poll + chunk translation ---------
      const terminal = await monitorLoop(box, run, deadline, state, pushChunk, flush);

      // ---- Phase: collect artifacts (FR-2.3 / FR-4.2) ----------------------
      setStage("finalize", "artifacts-collecting");
      const collected = await collectArtifacts(box, run, manifest);
      const artifacts = clampOutputArtifacts(collected);

      // ---- Done -------------------------------------------------------------
      const failed = terminal.kind === "failed";
      state.phase = "done";
      state.progress.stage = failed ? "failed" : "completed";
      state.progress.lastUpdate = Date.now();
      if (failed) {
        pushChunk({ kind: "error", content: terminal.error.slice(0, RING_CHUNK_MAX_CHARS), ts: Date.now() });
      }
      flush();

      const output: AgentRunOutput = {
        runId,
        status: failed ? "failed" : "completed",
        ...(failed ? { error: terminal.error.slice(0, 2000) } : {}),
        sandboxId: box.sandboxId,
        artifacts,
      };
      logger.info(
        `[agent-run ${runId}] ${output.status} — ${artifacts.length} artifact(s)`,
      );
      await killQuiet(sandbox);
      return output;
    } catch (err) {
      const message = errorMessage(err);
      logger.error(`[agent-run ${runId}] driver failed: ${message}`);
      state.phase = "done";
      state.progress.stage = "failed";
      state.progress.lastUpdate = Date.now();
      pushChunk({ kind: "error", content: message.slice(0, RING_CHUNK_MAX_CHARS), ts: Date.now() });
      flush();
      await killQuiet(sandbox);
      // Re-throw so Trigger.dev retry semantics apply — the next attempt
      // starts a fresh sandbox and replays the whole run idempotently.
      throw err;
    }
  },
});

// ---------------------------------------------------------------------------
// NATIVE agent loop — no sandbox, no tools; Trigger.dev is the compute.
// ---------------------------------------------------------------------------

/** Sleep helper shared with the monitor loop. */
const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Zero-setup execution: complete the turn IN-TASK through the USER'S OWN
 * pinned provider gateway (credentials.chatUrl + key pool — BYOK, never
 * the app's own model), tools-off. The seed history + system prompt travel
 * in the payload; the answer becomes one `message` artifact the app syncs
 * back into the conversation exactly like a sandbox run's response.
 * Key-pool rotation on 401/429 mirrors the sandbox runner's discipline.
 * Progress streams through the same metadata blob (round/stage/chunks) the
 * app already polls. A missing gateway never reaches here — the BYOK gate
 * above fails the run with instructions first.
 */
async function runNativeAgentRun(
  payload: AgentRunPayload,
  state: RunMetadataState,
  pushChunk: (chunk: Omit<TaskStatusChunk, "seq">) => void,
  setStage: (phase: RunMetadataState["phase"], stage: string) => void,
  flush: () => void,
): Promise<AgentRunOutput> {
  const { run, credentials } = payload;
  const runId = run.runId;
  const deadline = startedAtMs(run.startedAt) + (run.timeoutMs || 30 * 60 * 1000);

  setStage("monitor", "running");

  // Messages: config.systemPrompt first (unless the seed already opens with
  // a system row — buildTaskPayload keeps a persisted system row in place).
  const seed = run.payload.conversation.messages ?? [];
  const hasSystemRow = seed.length > 0 && seed[0]?.role === "system";
  const messages: Array<{ role: string; content: string }> = [
    ...(run.config.systemPrompt?.trim() && !hasSystemRow
      ? [{ role: "system", content: run.config.systemPrompt }]
      : []),
    ...seed.map((m) => ({ role: String(m.role), content: String(m.content ?? "") })),
  ].filter((m) => m.content.trim().length > 0 || m.role === "system");

  const pool = credentials.keyPool.length > 0 ? credentials.keyPool : [credentials.chatToken];
  let lastError = "unknown error";

  for (let attempt = 0; attempt < Math.max(2, pool.length * 2) && Date.now() < deadline; attempt++) {
    const key = pool[attempt % pool.length] || credentials.chatToken;
    try {
      const res = await fetch(credentials.chatUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          "x-task-run-id": runId,
        },
        body: JSON.stringify({
          ...(run.config.model ? { model: run.config.model } : {}),
          messages,
          stream: false,
          ...(typeof run.config.temperature === "number"
            ? { temperature: run.config.temperature }
            : {}),
        }),
      });

      if (res.status === 401 || res.status === 429 || res.status >= 500) {
        lastError = `LLM endpoint responded ${res.status}`;
        logger.warn(`[agent-run ${runId}] native attempt ${attempt + 1}: ${lastError} — rotating key, backing off`);
        // PRD §3.2: exponential backoff + full jitter between rotated retries.
        await sleepMs(backoffDelayMs(attempt));
        continue;
      }
      if (!res.ok) {
        lastError = `LLM endpoint responded ${res.status}: ${(await res.text()).slice(0, 200)}`;
        await sleepMs(backoffDelayMs(attempt));
        continue;
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      if (!content.trim()) {
        lastError = "LLM endpoint returned an empty completion";
        await sleepMs(backoffDelayMs(attempt, 800, 10_000));
        continue;
      }

      // Success — stream the answer as a text chunk + terminal metadata.
      pushChunk({ kind: "text", round: 1, content: content.slice(0, RING_CHUNK_MAX_CHARS), ts: Date.now() });
      state.progress.round = 1;
      state.progress.totalRounds = 1;
      state.progress.stage = "completed";
      state.progress.lastUpdate = Date.now();
      state.phase = "done";
      flush();
      logger.info(`[agent-run ${runId}] native run completed (${content.length} chars)`);

      return {
        runId,
        status: "completed",
        artifacts: [
          {
            kind: "message",
            name: "response.md",
            mimeType: "text/markdown",
            content,
            encoding: "utf8",
          },
        ],
      };
    } catch (err) {
      lastError = errorMessage(err);
      await sleepMs(backoffDelayMs(attempt));
    }
  }

  // Terminal failure — mirror the sandbox path's honest reporting + retry
  // semantics (Trigger.dev replays the whole native run idempotently).
  state.phase = "done";
  state.progress.stage = "failed";
  state.progress.lastUpdate = Date.now();
  pushChunk({ kind: "error", content: lastError.slice(0, RING_CHUNK_MAX_CHARS), ts: Date.now() });
  flush();
  throw new Error(`native agent-run failed: ${lastError}`);
}

// ---------------------------------------------------------------------------
// Monitor loop — 5s polls of the sandbox file protocol.
// ---------------------------------------------------------------------------

type TerminalState =
  | { kind: "completed" }
  | { kind: "failed"; error: string };

async function monitorLoop(
  sandbox: Sandbox,
  run: AgentRunPayload["run"],
  deadline: number,
  state: RunMetadataState,
  pushChunk: (chunk: Omit<TaskStatusChunk, "seq">) => void,
  flush: () => void,
): Promise<TerminalState> {
  const startedAt = Date.now();
  let lastProgressAt = Date.now();
  let lastHistoryCount = run.payload.conversation.messages.length;
  let lastRound = 0;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  while (true) {
    const now = Date.now();
    if (now > deadline) {
      return { kind: "failed", error: "execution window exceeded (PRD §4.2 30-minute cap)" };
    }

    if (run.type === "terminal_command") {
      const status = await readTerminalStatus(sandbox);
      if (status.exited) {
        return status.exitCode === 0
          ? { kind: "completed" }
          : { kind: "failed", error: `command exited with code ${status.exitCode}` };
      }
      state.progress.stage = "running";
      state.progress.currentTool = "terminal";
      state.progress.logTail = status.output.slice(-4000);
      state.progress.lastUpdate = now;
      flush();
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Agent runs — file-protocol status + chunk translation.
    const status = await readAgentStatus(sandbox);
    if (status) {
      lastProgressAt = now;
      const round = status.round ?? 0;
      if (round > lastRound) {
        pushChunk({ kind: "round", round, content: `round ${round}`, ts: now });
        lastRound = round;
      }
      // New history entries → text / tool chunks (FR-3.2 chunked blocks).
      const history = await readAgentHistory(sandbox);
      if (history && history.length > lastHistoryCount) {
        for (const entry of history.slice(lastHistoryCount)) {
          if (entry.tool_calls?.length) {
            for (const tc of entry.tool_calls) {
              pushChunk({
                kind: "tool_call",
                round,
                name: tc.name ?? "tool",
                content: JSON.stringify(tc.args ?? {}).slice(0, RING_CHUNK_MAX_CHARS),
                ts: now,
              });
              if (tc.result !== undefined) {
                pushChunk({
                  kind: "tool_result",
                  round,
                  name: tc.name ?? "tool",
                  content: String(JSON.stringify(tc.result ?? "")).slice(0, RING_CHUNK_MAX_CHARS),
                  ts: now,
                });
              }
            }
          } else if (entry.role === "assistant" && entry.content) {
            pushChunk({
              kind: "text",
              round,
              content: entry.content.slice(0, RING_CHUNK_MAX_CHARS),
              ts: now,
            });
          }
        }
        lastHistoryCount = history.length;
      }

      state.progress.round = round;
      state.progress.totalRounds = status.total_rounds ?? 0;
      state.progress.stage = status.stage ?? "running";
      state.progress.currentTool = status.current_tool ?? null;
      state.progress.logTail = (await readLogTail(sandbox)).slice(-4000);
      state.progress.lastUpdate = now;
      flush();

      if (status.status === "completed") return { kind: "completed" };
      if (status.status === "failed" || status.status === "stopped") {
        return { kind: "failed", error: status.error ?? `runner ${status.status}` };
      }
    } else if (now - startedAt > BOOT_GRACE_MS) {
      // Status file missing well past boot grace — the runner never wrote
      // anything. Treat as failed (retry replays the launch phase).
      return { kind: "failed", error: "runner status file missing after boot grace" };
    }

    if (now - lastProgressAt > STALL_LIMIT_MS) {
      return { kind: "failed", error: "runner stalled for 10 minutes" };
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Output clamping — keep the run OUTPUT well under the cloud payload ceiling
// ---------------------------------------------------------------------------

/**
 * Clamp collected artifacts to TASK_PAYLOAD_BUDGET.maxOutputArtifactBytes of
 * total content: message/report kinds always win (they are small and drive
 * the chat sync-back), then files smallest-first until the budget is spent.
 * Dropped/oversize files degrade to name-only entries (truncated, empty
 * content) so the inventory stays honest.
 */
function clampOutputArtifacts(artifacts: CloudArtifact[]): CloudArtifact[] {
  const keep: CloudArtifact[] = [];
  let total = 0;

  const isTextual = (a: CloudArtifact) => a.kind === "message" || a.kind === "report";

  // 1) messages + reports first (bounded, chat-critical).
  for (const a of artifacts) {
    if (!isTextual(a)) continue;
    keep.push(a);
    total += a.content.length;
  }
  // 2) files smallest-first.
  const files = artifacts
    .filter((a) => !isTextual(a))
    .sort((x, y) => x.content.length - y.content.length);
  for (const f of files) {
    if (total + f.content.length <= TASK_PAYLOAD_BUDGET.maxOutputArtifactBytes) {
      keep.push(f);
      total += f.content.length;
    } else {
      keep.push({
        ...f,
        content: "",
        encoding: f.encoding ?? "base64",
        truncated: true,
      });
    }
  }
  return keep;
}
