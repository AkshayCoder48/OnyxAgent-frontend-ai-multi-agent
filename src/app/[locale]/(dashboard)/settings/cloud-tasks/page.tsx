"use client";

import { SectionTriggerCloud } from "@/components/settings/section-trigger-cloud";

/**
 * Cloud Tasks settings route (Background Task Execution Framework) — the
 * Trigger.dev Cloud orchestrator: connect/verify an api.trigger.dev key,
 * manage the kicked task id, wire the deployed cloud worker, and watch
 * recent cloud-orchestrated runs. The third execution mode (after the
 * in-process local driver and the optional self-hosted Trigger.dev worker).
 */
export default function CloudTasksSettingsPage() {
  return <SectionTriggerCloud />;
}
