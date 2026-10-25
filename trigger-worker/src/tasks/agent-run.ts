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
//   init → create-sandbox → mount → verify → start → monitor (5s poll) →
//   collect-artifacts → output.
// ============================================================================

import { task, metadata, logger } from "@trigger.dev/sdk";
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

export const agentRun = task({
  id: "agent-run",
  maxDuration: 2100, // 35 min — the 30-min sandbox window + finalize headroom
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

      // ---- Phase: create sandbox (PRD §4.2 — bounded window) --------------
      setStage("init", "creating-sandbox");
      const box = await createTaskSandbox(run, credentials.e2bApiKey);
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
 * Zero-setup execution: complete the turn IN-TASK through the resolved LLM
 * endpoint (pinned provider gateway or the app's keyless bridge), tools-off.
 * The seed history + system prompt travel in the payload; the answer becomes
 * one `message` artifact the app syncs back into the conversation exactly
 * like a sandbox run's response. Key-pool rotation on 401/429 mirrors the
 * sandbox runner's discipline. Progress streams through the same metadata
 * blob (round/stage/chunks) the app already polls.
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
        logger.warn(`[agent-run ${runId}] native attempt ${attempt + 1}: ${lastError} — rotating`);
        await sleepMs(1200 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        lastError = `LLM endpoint responded ${res.status}: ${(await res.text()).slice(0, 200)}`;
        await sleepMs(1000);
        continue;
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      if (!content.trim()) {
        lastError = "LLM endpoint returned an empty completion";
        await sleepMs(800);
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
      await sleepMs(1500);
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
