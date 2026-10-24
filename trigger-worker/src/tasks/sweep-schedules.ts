// ============================================================================
// Trigger.dev task: sweep-schedules — the scheduled-task heartbeat.
//
// Runs every minute and asks the OnyxAgent app to fire due TaskSchedule rows
// (FR-2.1/FR-2.2). The app-side sweep is idempotent (atomic nextRunAt claim
// guards double-fire across processes AND against this worker's ticks). Fired
// runs land in the queue and are picked up by poll-claims.
//
// NOTE: the app runs its own 60s local sweep loop when NOT in Trigger.dev
// mode; once TRIGGER_DEV_URL/TRIGGER_DEV_TOKEN are set the local loop only
// ARMS schedules and this task becomes the firing authority.
// ============================================================================

import { task } from "@trigger.dev/sdk/v3";
import { sweepSchedules } from "../app-client.js";
import { errorMessage, requireEnv } from "../env.js";

export const sweepSchedulesTask = task({
  id: "sweep-schedules",
  cron: { pattern: "* * * * *" },
  maxDuration: 60,
  queue: { concurrencyLimit: 1 },
  run: async () => {
    const appUrl = requireEnv("APP_URL");
    const token = requireEnv("WORKER_TOKEN");

    try {
      const fired = await sweepSchedules(appUrl, token);
      return { fired };
    } catch (err) {
      // The app may not be in Trigger.dev mode yet (sweep answers fired:0) —
      // a 503 here means WORKER_TOKEN mismatch; surface it, don't crash loop.
      console.error(`[sweep-schedules] sweep failed: ${errorMessage(err)}`);
      return { fired: 0, error: errorMessage(err) };
    }
  },
});
