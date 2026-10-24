"use client";

import { SectionSchedules } from "@/components/settings/section-schedules";

/**
 * Schedules settings route (Background Task Execution Framework FR-2.1) —
 * cron-driven background tasks: create/edit/pause/delete schedules, next-run
 * previews, and recent firing history. Runs fire durably on the operator's
 * Trigger.dev Cloud project once a key is connected (Settings → Cloud Tasks).
 *
 * SectionSchedules carries its own SettingsSection card + header (unlike
 * section-e2b, which is headerless), so this route renders it bare.
 */
export default function SchedulesSettingsPage() {
  return <SectionSchedules />;
}
