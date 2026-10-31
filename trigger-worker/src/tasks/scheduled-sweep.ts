// ============================================================================
// Trigger.dev v4 task: scheduled-sweep — the DURABLE CRON lane
// (Trigger.dev PRD §3.4 — Scheduled & Recurring Tasks).
//
// The app registers one IMPERATIVE Trigger.dev schedule per TaskSchedule row
// (deduplicationKey "onyx-sched-<rowId>", the row's cron + timezone) via
// POST /api/v1/schedules whenever a schedule is created/updated/deleted in
// Settings → Schedules. The cloud fires THIS task at exactly the user's cron
// times — completely independent of any browser being open, any HTTP
// request arriving, or the Next.js server being warm.
//
// On fire, the task pings the app's sweep endpoint
//   POST {APP_URL}/api/tasks/schedules/tick   (Bearer ONYX_WORKER_TOKEN)
// which atomically claims + dispatches the due TaskSchedule rows with FRESH
// BYOK credentials (the app is the credential broker — keys are never
// frozen into the schedule payload). This keeps the pull-only BYOK model
// intact while the firing itself becomes durable on the cloud.
//
// Fallbacks (unchanged): the app's in-process 60s sweep loop, and the
// throttled sweep-on-read touch() from client polls. APP_URL + the worker
// token are baked as env vars at auto-deploy time (autoDeployWorker).
// ============================================================================

import { task, logger } from "@trigger.dev/sdk";
import { normalizeOrigin, optionalEnv } from "../env.js";
import { errorMessage } from "../util.js";

/** How long a single tick call may take (the app side is a quick sweep). */
const TICK_TIMEOUT_MS = 60_000;

export const scheduledSweep = task({
  id: "scheduled-sweep",
  maxDuration: 300,
  queue: { name: "scheduled-sweeps" },
  retry: { maxAttempts: 2 },
  run: async (): Promise<{ ok: boolean; fired?: number; error?: string }> => {
    const appUrl = normalizeOrigin(optionalEnv("APP_URL"));
    const token = optionalEnv("ONYX_WORKER_TOKEN");

    if (!appUrl || !token) {
      // Honest degradation: the in-app 60s loop + poll-driven touch() keep
      // firing schedules; only the cloud-durable firing is unavailable.
      logger.warn(
        "[scheduled-sweep] APP_URL / ONYX_WORKER_TOKEN are not set on this deployment — cloud-fired cron ticks cannot reach the app. Re-deploy the worker from a connected app (Settings → Cloud → Deploy) to enable durable schedules.",
      );
      return { ok: false, error: "APP_URL / ONYX_WORKER_TOKEN not configured on the worker" };
    }

    try {
      const res = await fetch(`${appUrl}/api/tasks/schedules/tick`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: "{}",
        signal: AbortSignal.timeout(TICK_TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => ({}))) as { fired?: unknown };
      if (!res.ok) {
        logger.warn(`[scheduled-sweep] app tick responded HTTP ${res.status}`);
        return { ok: false, error: `app tick responded ${res.status}` };
      }
      const fired = typeof data.fired === "number" ? data.fired : 0;
      logger.info(`[scheduled-sweep] app tick ok — ${fired} schedule run(s) dispatched`);
      return { ok: true, fired };
    } catch (err) {
      logger.warn(`[scheduled-sweep] app tick failed: ${errorMessage(err)}`);
      return { ok: false, error: errorMessage(err) };
    }
  },
});
