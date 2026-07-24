"use client";

import { Activity } from "lucide-react";

import { EmptyState } from "@/components/states";

/**
 * Backendless usage timeline.
 *
 * The original component queried `/billing/me/credits/usage/timeline` on a
 * FastAPI backend. In backendless mode there is no billing/credits ledger —
 * usage tracking is not available. Instead of removing the component
 * outright (it's still exported and may be referenced by other pages), we
 * render a static empty state explaining the limitation.
 */
export function UsageTimeline() {
  return (
    <div className="border-border bg-card flex flex-col rounded-xl border p-5 lg:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-foreground/55 font-mono text-[11px] tracking-wider uppercase">
            Usage over time
          </p>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-display text-foreground text-2xl font-bold">—</span>
            <span className="text-foreground/55 text-sm">credits</span>
          </div>
        </div>
      </div>

      <div className="mt-5 h-56 w-full">
        <EmptyState
          icon={Activity}
          title="Usage tracking is not available in backendless mode"
          description="There's no billing or credit ledger in this client-only build. Your conversations and files persist locally in your browser."
          fill
        />
      </div>
    </div>
  );
}
