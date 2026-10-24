// ============================================================================
// Background Task Execution Framework — orchestration mode switch.
//
// Lives in its own module (not cron-scheduler / local-driver) because BOTH
// need it and they import each other — a shared definition there would be a
// dependency cycle.
//
// When BOTH TRIGGER_DEV_URL and TRIGGER_DEV_TOKEN are configured, execution
// is delegated to the deployed Trigger.dev worker:
//   · the trigger route leaves runs "queued" (orchestrator: "triggerdev"),
//   · the local scheduler loop only ARMS nextRunAt — it never fires,
//   · the worker polls POST /api/tasks/worker {action:"claim"|"sweep"}.
// ============================================================================

/** True when the durable Trigger.dev worker owns execution. */
export function isTriggerDevMode(): boolean {
  return Boolean(
    process.env.TRIGGER_DEV_URL?.trim() && process.env.TRIGGER_DEV_TOKEN?.trim(),
  );
}
