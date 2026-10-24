// ============================================================================
// Trigger.dev task: poll-claims — the pull-based dispatcher.
//
// Runs every minute on the self-hosted instance (cron). Claims queued
// background-task runs from the OnyxAgent app and dispatches each one to the
// durable agent-run task. Concurrency 1 keeps claim ticks from stampeding;
// the per-minute cadence bounds queue latency.
// ============================================================================

import { task, tasks } from "@trigger.dev/sdk/v3";
import { claimRuns } from "../app-client.js";
import { errorMessage, requireEnv } from "../env.js";
import type { WorkerClaimedRun } from "../protocol.js";

export const pollClaims = task({
  id: "poll-claims",
  cron: { pattern: "* * * * *" },
  maxDuration: 60,
  queue: { concurrencyLimit: 1 },
  run: async () => {
    const appUrl = requireEnv("APP_URL");
    const token = requireEnv("WORKER_TOKEN");

    const runs = await claimRuns(appUrl, token, 3);
    const dispatched: string[] = [];

    for (const run of runs) {
      try {
        await tasks.trigger("agent-run", { payload: { run } });
        dispatched.push(run.runId);
      } catch (err) {
        // Dispatch failure is fatal for THIS run only — the app's claim lock
        // has a 60s staleness fence, so the next tick re-claims it.
        console.error(
          `[poll-claims] failed to dispatch run ${run.runId}: ${errorMessage(err)}`,
        );
      }
    }

    return { dispatched: dispatched.length, runIds: dispatched };
  },
});

export type { WorkerClaimedRun };
