// ============================================================================
// Trigger.dev v3 project config — OnyxAgent background-task durable driver.
//
// Deployed against a self-hosted Trigger.dev instance (see
// ../deploy/trigger-dev/) or trigger.dev Cloud. The CLI reads
// TRIGGER_DEPLOYMENT_URL + TRIGGER_ACCESS_TOKEN from the environment (or
// `trigger dev`/`trigger deploy` flags) — see .env.example.
//
// NOTE (v3 API): the project-level retry shape is
// `retries: { enabledInDev, default: RetryOptions }` where RetryOptions uses
// `maxAttempts` (NOT `limit`). Task-level `retry` options override `default`.
// ============================================================================

import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "onyxagent-background-tasks",
  triggerDirectories: ["./src/tasks"],
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 10_000,
      maxTimeoutInMs: 60_000,
    },
  },
});
