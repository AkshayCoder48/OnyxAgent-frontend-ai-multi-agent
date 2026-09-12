"use client";

import { ScheduledTasksView } from "@/components/scheduled/scheduled-tasks-view";

/**
 * Scheduled Tasks management route — /scheduled-tasks.
 *
 * Server-side persistent scheduling: tasks, run history, and Telegram
 * delivery live in the user's OnyxBase KV (the browser is only a trigger
 * source + management UI). All mutations go through /api/scheduler/* with
 * the vault-resolved OnyxBase key — never model-visible.
 */
export default function ScheduledTasksPage() {
  return (
    <div className="h-full overflow-y-auto px-3 py-4 sm:px-6 sm:py-8">
      <div className="mx-auto max-w-4xl space-y-6 pb-8">
        <ScheduledTasksView />
      </div>
    </div>
  );
}
