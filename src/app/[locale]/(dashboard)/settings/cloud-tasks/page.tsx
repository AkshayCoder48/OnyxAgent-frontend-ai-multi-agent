"use client";

import { SectionTriggerCloud } from "@/components/settings/section-trigger-cloud";

/**
 * Cloud Tasks settings route (Background Task Execution Framework) — the
 * Trigger.dev Cloud panel: paste an environment secret key and every
 * background task (chat agent runs, sub-agents, schedules, businesses) runs
 * durably on the operator's own cloud project. Zero setup, cloud-only —
 * no self-hosting, no local driver.
 */
export default function CloudTasksSettingsPage() {
  return <SectionTriggerCloud />;
}
