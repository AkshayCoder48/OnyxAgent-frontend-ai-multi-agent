"use client";

import { CloudCog } from "lucide-react";

import { SectionCard } from "@/components/settings/settings-section";
import { SectionCloudWorkspace } from "@/components/settings/section-cloud-workspace";

/**
 * Cloud settings route — the OnyxBase API key for the OnyxBase-backed
 * cloud features: skills cloud backup (Settings → Skills) and the
 * server-side workspace sync for scheduled tasks.
 *
 * The OnyxBase `kv_live_…` key is vault-encrypted at rest and NEVER reaches
 * the LLM, the system prompt, tool arguments, or the E2B sandbox.
 */
export default function CloudWorkspaceSettingsPage() {
  return (
    <div className="space-y-6">
      <SectionCard
        title="Cloud"
        description="OnyxBase cloud backup — your API key powers skill backups and keeps scheduled-task workspaces persistent across runs."
        action={
          <span className="border-border text-muted-foreground inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
            <CloudCog className="size-3.5" />
            OnyxBase KV
          </span>
        }
      >
        <SectionCloudWorkspace />
      </SectionCard>
    </div>
  );
}
