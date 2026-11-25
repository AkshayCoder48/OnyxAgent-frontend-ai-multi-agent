import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/constants";

/**
 * Subagents settings route — REDIRECTED to Settings → Config (2026-11-25:
 * sub-agents are API-ONLY now — the AI orchestrator spawns/configures them
 * via the subagent tools (spawn_subagent, set_subagent_config, …) and all
 * results render in the main workspace chat, so the dedicated settings
 * page was removed). The route stays as a redirect so old links and
 * bookmarks keep working.
 */
export default function SubagentsSettingsPage() {
  redirect(ROUTES.SETTINGS_CONFIG);
}
