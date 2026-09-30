"use client";

import { DatabasePanel } from "@/components/code/database-panel";

/**
 * OnyxCode — Database tab (/code/database). A live browser over the
 * OnyxBase KV store for the current workspace (records under code:db:*),
 * shared with the agent's manage_database tool.
 */
export default function CodeDatabasePage() {
  return <DatabasePanel />;
}
