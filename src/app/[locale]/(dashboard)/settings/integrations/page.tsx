"use client";

/**
 * Settings → Integrations route — external services the agent can talk to.
 *
 * Currently hosts the Composio section (platform catalog + OAuth connections
 * + session management, see section-integrations-composio.tsx). Future
 * integrations mount as additional sections below.
 */

import { SectionIntegrationsComposio } from "@/components/settings/section-integrations-composio";

export default function IntegrationsSettingsPage() {
  return (
    <div className="space-y-6">
      <SectionIntegrationsComposio />
    </div>
  );
}
