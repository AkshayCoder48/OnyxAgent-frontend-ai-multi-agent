// ============================================================================
// Trigger.dev v4 project config — OnyxAgent cloud worker.
//
// Runs the app's background agent execution (chat agent runs, sub-agent
// chains, project/business tasks, terminal commands) DIRECTLY on
// trigger.dev Cloud. Deployed automatically by the app at key-connect time
// (Settings → Cloud) using the operator's own environment secret key —
// `npx trigger.dev@latest deploy --authorization <key>` from the app
// server, or manually from this directory:
//
//   TRIGGER_PROJECT_REF=<project externalRef> \
//   npx trigger.dev@latest deploy --env prod --authorization <tr_…_sk_…>
//
// The project ref is the dashboard project's externalRef (proj_…), resolved
// by the app from `GET /api/v1/whoami` at connect time.
// ============================================================================

import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_hrhpqztgulssacmpehmg",
  runtime: "node-24",
  dirs: ["./src/tasks"],
  maxDuration: 3600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 2,
      factor: 2,
      minTimeoutInMs: 10_000,
      maxTimeoutInMs: 60_000,
      randomize: true,
    },
  },
});
