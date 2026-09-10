"use client";

import { CloudCog } from "lucide-react";

import { SectionCard } from "@/components/settings/settings-section";
import { SectionCloudWorkspace } from "@/components/settings/section-cloud-workspace";

/**
 * Cloud Workspace settings route (PRD §5/§34) — OnyxBase KV credentials for
 * the persistent workspace (push_workspace / retrieve_workspace).
 *
 * The OnyxBase `kv_live_…` key is vault-encrypted at rest and NEVER reaches
 * the LLM, the system prompt, tool arguments, or the E2B sandbox.
 */
export default function CloudWorkspaceSettingsPage() {
  return (
    <div className="space-y-6">
      <SectionCard
        title="Cloud Workspace"
        description="Persistent workspace sync via OnyxBase KV — E2B is the temporary execution environment, the cloud is the permanent state."
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
