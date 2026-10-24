// ============================================================================
// Trigger.dev v4 task: health — bootstrap verification probe.
//
// The app triggers this right after deploying the worker (connect flow) to
// confirm end-to-end liveness: the deployment is live, the task executes,
// and the run output round-trips through the cloud REST API.
// ============================================================================

import { task, logger } from "@trigger.dev/sdk";

export interface HealthOutput {
  ok: true;
  task: "health";
  ts: string;
  version: 2;
}

export const health = task({
  id: "health",
  maxDuration: 60,
  run: async (): Promise<HealthOutput> => {
    logger.info("[health] worker alive");
    return { ok: true, task: "health", ts: new Date().toISOString(), version: 2 };
  },
});
