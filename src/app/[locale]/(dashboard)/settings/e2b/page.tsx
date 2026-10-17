"use client";

import { Cloud } from "lucide-react";

import { SectionCard } from "@/components/settings/settings-section";
import { SectionE2B } from "@/components/settings/section-e2b";

/**
 * E2B sandbox settings route — the E2B API key (vault-encrypted at rest)
 * plus the workspace lifecycle panel: pause / resume persistency for the
 * sandbox VMs (full state — filesystem + RAM — frozen on pause, restored
 * in place on the next connect), the state of every sandbox on the
 * account, and the app's auto-pause-on-exit behavior.
 */
export default function E2BSettingsPage() {
  return (
    <div className="space-y-6">
      <SectionCard
        title="Sandbox (E2B)"
        description="Remote code execution sandboxes — your key, the workspace lifecycle (pause/resume persistency), and live sandbox states."
        action={
          <span className="border-border text-muted-foreground inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
            <Cloud className="size-3.5" />
            E2B
          </span>
        }
      >
        <SectionE2B />
      </SectionCard>
    </div>
  );
}
