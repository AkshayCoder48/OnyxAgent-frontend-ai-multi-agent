"use client";

import { Plug } from "lucide-react";

import { SectionCard } from "@/components/settings/settings-section";

/**
 * Settings → Integrations route — external services the agent can talk to.
 *
 * A clean placeholder for now: the integrations catalog will live here as
 * new providers are wired in.
 */
export default function IntegrationsSettingsPage() {
  return (
    <div className="space-y-6">
      <SectionCard
        title="Integrations"
        description="Connect external services the agent can use."
        action={
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
            <Plug className="size-3.5" />
            Integrations
          </span>
        }
      >
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center">
          <span
            aria-hidden
            className="flex h-10 w-10 items-center justify-center rounded-full bg-muted"
          >
            <Plug className="size-5 text-muted-foreground" />
          </span>
          <p className="text-sm font-medium text-foreground">No integrations configured</p>
          <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
            Integrations with external services will appear here once connected.
          </p>
        </div>
      </SectionCard>
    </div>
  );
}
