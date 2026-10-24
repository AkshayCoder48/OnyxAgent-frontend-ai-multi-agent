// ============================================================================
// Trigger.dev task: agent-run — the durable background-task driver.
//
// PRD §4.1 Atomic Resumption: every phase runs inside step.run() so an
// execution-limit drop / retry resumes from the exact completed block — the
// sandbox (and its runner) survives independently, so re-entry only needs to
// re-attach, never recompute. The claim lock on the app side is the
// transaction fence: a stale lock (>60s) is adopted; a fresh foreign lock
// means another worker won — exit cleanly.
//
// Phase map (mirrors the app's local-driver):
//   report-start → create-sandbox → mount → verify → start →
//   monitor (step.run poll + io.sleep loop) → collect-artifacts → finish
// ============================================================================

import { task, step, sleep } from "@trigger.dev/sdk/v3";
import { Sandbox } from "@e2b/code-interpreter";
import type {
  OnyxAgentFilesManifest,
  TaskPhase,
  TaskStatusChunk,
  WorkerArtifactInput,
  WorkerClaimedRun,
} from "../protocol.js";
import { reportRun } from "../app-client.js";
import {
  clampTimeoutMs,
  errorMessage,
  requireEnv,
  resolveLlmConfig,
  startedAtMs,
  type WorkerLlmConfig,
} from "../env.js";
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

/** Payload shape — poll-claims embeds the entire claimed run. */
export interface AgentRunPayload {
  run: WorkerClaimedRun;
}

/** Monitor poll cadence. */
const POLL_INTERVAL_MS = 5_000;
/** Boot grace before a missing status file counts as failure. */
const BOOT_GRACE_MS = 90_000;
/** Stall guard — no status progress for this long + dead runner = failed. */
const STALL_LIMIT_MS = 10 * 60 * 1000;

export const agentRun = task({
  id: "agent-run",
  maxDuration: 2100, // 35 min — the 30-min sandbox window + finalize headroom
  run: async (payload: AgentRunPayload) => {
    const appUrl = requireEnv("APP_URL");
    const token = requireEnv("WORKER_TOKEN");
    const run = payload.run;
    const runId = run.runId;
    const deadline = startedAtMs(run.startedAt) + clampTimeoutMs(run.timeoutMs);

    let sandbox: Sandbox | null = null;

    /** Best-effort progress report (never fails the task). */
    const report = (body: Parameters<typeof reportRun>[2]) =>
      reportRun(appUrl, token, { ...body, runId }).catch((err) => {
        console.error(`[agent-run ${runId}] report failed: ${errorMessage(err)}`);
      });

    try {
      // ---- Phase: claim ack ------------------------------------------------
      await step.run("report-start", async () => {
        await report({ phase: "monitor", progress: { stage: "claimed" } });
        return { started: true };
      });

      // ---- Phase: create sandbox (PRD §4.2 — bounded window) --------------
      const sandboxId = await step.run("create-sandbox", async () => {
        const box = await createTaskSandbox(run);
        await report({ sandboxId: box.sandboxId, phase: "init", progress: { stage: "sandbox-ready" } });
        return box.sandboxId;
      });
      sandbox = (await Sandbox.connect(sandboxId, {
        apiKey: process.env.E2B_API_KEY ?? "",
      })) as Sandbox;
      const activeSandbox = sandbox;

      // ---- Phase: mount client workspace (FR-1.1 / FR-4.1) ----------------
      const manifest = await step.run("mount", async () => {
        const m = await mountPayload(activeSandbox, run);
        await report({ phase: "mount", progress: { stage: "files-mounted" } });
        return m as OnyxAgentFilesManifest;
      });

      // ---- Phase: verify manifest compiled cleanly (FR-4.1) ---------------
      await step.run("verify", async () => {
        const reportResult = await verifyMount(activeSandbox, manifest);
        await report({
          phase: "verify",
          progress: { stage: "mount-verified", mountReport: reportResult },
        });
        return reportResult;
      });

      // ---- Phase: start (agent runner OR terminal command) -----------------
      const llm = resolveLlmConfig(appUrl, run);
      await step.run("start", async () => {
        if (run.type === "terminal_command") {
          await startTerminalCommand(activeSandbox, run);
        } else {
          await startAgentRunner(activeSandbox, run, llm);
        }
        await report({ phase: "start", progress: { stage: "launched" } });
        return { launched: true };
      });

      // ---- Phase: monitor — chunked progress (FR-3.2 via report chunks) ----
      const terminal = await monitorLoop(activeSandbox, run, llm, deadline, report);

      // ---- Phase: collect artifacts (FR-2.3 / FR-4.2) ----------------------
      const artifacts = await step.run("collect-artifacts", async () => {
        const collected = await collectArtifacts(activeSandbox, run, manifest);
        await report({ phase: "finalize", progress: { stage: "artifacts-collected" } });
        return collected;
      });

      // ---- Phase: finish ----------------------------------------------------
      await step.run("finish", async () => {
        const failed = terminal.kind === "failed";
        await report({
          phase: "done",
          status: failed ? "failed" : "completed",
          error: failed ? terminal.error : undefined,
          artifacts,
          progress: {
            stage: failed ? "failed" : "completed",
            lastUpdate: Date.now(),
          },
        });
        return { done: true };
      });

      await killQuiet(sandbox);
      return { runId, status: terminal.kind === "failed" ? "failed" : "completed" };
    } catch (err) {
      const message = errorMessage(err);
      console.error(`[agent-run ${runId}] driver failed: ${message}`);
      await report({
        phase: "finalize",
        status: "failed",
        error: message.slice(0, 2000),
        progress: { stage: "failed" },
      }).catch(() => undefined);
      await killQuiet(sandbox);
      // Re-throw so Trigger.dev retry semantics apply (PRD §4.1) — the next
      // attempt re-enters idempotently: claim adopts the stale lock, sandbox
      // reconnects, monitor resumes from persisted progress.
      throw err;
    }
  },
});

// ---------------------------------------------------------------------------
// Monitor loop — step.run polls + io.sleep between ticks
// ---------------------------------------------------------------------------

type TerminalState =
  | { kind: "completed" }
  | { kind: "failed"; error: string };

async function monitorLoop(
  sandbox: Sandbox,
  run: WorkerClaimedRun,
  _llm: WorkerLlmConfig,
  deadline: number,
  report: (body: Parameters<typeof reportRun>[2]) => Promise<void>,
): Promise<TerminalState> {
  const startedAt = Date.now();
  let lastProgressAt = Date.now();
  let lastHistoryCount = run.payload.conversation.messages.length;
  let lastRound = 0;

  while (true) {
    const poll = await step.run("poll", async () => {
      const now = Date.now();
      if (now > deadline) {
        return { done: true, state: { kind: "failed", error: "execution window exceeded (PRD §4.2 30-minute cap)" } as TerminalState };
      }

      if (run.type === "terminal_command") {
        const status = await readTerminalStatus(sandbox);
        if (status.exited) {
          return {
            done: true,
            state:
              status.exitCode === 0
                ? ({ kind: "completed" } as TerminalState)
                : ({ kind: "failed", error: `command exited with code ${status.exitCode}` } as TerminalState),
          };
        }
        await report({
          progress: {
            stage: "running",
            currentTool: "terminal",
            logTail: status.output.slice(-4000),
            lastUpdate: now,
          },
        });
        return { done: false, state: null };
      }

      // Agent runs — file-protocol status + chunk translation.
      const status = await readAgentStatus(sandbox);
      if (status) {
        lastProgressAt = now;
        const chunks: TaskStatusChunk[] = [];
        const round = status.round ?? 0;
        if (round > lastRound) {
          chunks.push({ seq: 0, kind: "round", round, content: `round ${round}`, ts: now });
          lastRound = round;
        }
        // New history entries → text / tool chunks (FR-3.2 chunked blocks).
        const history = await readAgentHistory(sandbox);
        if (history && history.length > lastHistoryCount) {
          for (const entry of history.slice(lastHistoryCount)) {
            if (entry.tool_calls?.length) {
              for (const tc of entry.tool_calls) {
                chunks.push({
                  seq: 0,
                  kind: "tool_call",
                  round,
                  name: tc.name ?? "tool",
                  content: JSON.stringify(tc.args ?? {}).slice(0, 2000),
                  ts: now,
                });
                if (tc.result !== undefined) {
                  chunks.push({
                    seq: 0,
                    kind: "tool_result",
                    round,
                    name: tc.name ?? "tool",
                    content: String(JSON.stringify(tc.result ?? "")).slice(0, 2000),
                    ts: now,
                  });
                }
              }
            } else if (entry.role === "assistant" && entry.content) {
              chunks.push({
                seq: 0,
                kind: "text",
                round,
                content: entry.content.slice(0, 4000),
                ts: now,
              });
            }
          }
          lastHistoryCount = history.length;
        }

        await report({
          progress: {
            round,
            totalRounds: status.total_rounds ?? 0,
            stage: status.stage ?? "running",
            currentTool: status.current_tool ?? null,
            logTail: (await readLogTail(sandbox)).slice(-4000),
            lastUpdate: now,
          },
          ...(chunks.length ? { chunks } : {}),
        });

        if (status.status === "completed") return { done: true, state: { kind: "completed" } as TerminalState };
        if (status.status === "failed" || status.status === "stopped") {
          return { done: true, state: { kind: "failed", error: status.error ?? `runner ${status.status}` } as TerminalState };
        }
      } else if (now - startedAt > BOOT_GRACE_MS) {
        // Status file missing well past boot grace — the runner never wrote
        // anything. Treat as failed (the app's agent_ensure path is local-mode
        // only; here the step retry replays the launch phase instead).
        return { done: true, state: { kind: "failed", error: "runner status file missing after boot grace" } as TerminalState };
      }

      if (now - lastProgressAt > STALL_LIMIT_MS) {
        return { done: true, state: { kind: "failed", error: "runner stalled for 10 minutes" } as TerminalState };
      }

      return { done: false, state: null };
    });

    if (poll.done && poll.state) return poll.state;
    await sleep("poll-interval", POLL_INTERVAL_MS);
  }
}
