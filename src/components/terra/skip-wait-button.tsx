"use client";

import { FastForward } from "lucide-react";
import { useTerra } from "@/components/terra/store";
import type { ToolCallData } from "@/components/terra/types";

/**
 * "Continue while this runs" — skip-wait control shown on running tool cards
 * (shared by the normal agent and OnyxCode). The tool keeps executing inside
 * the server-side background job; the agent immediately continues planning
 * and the result is injected when it lands.
 */
export function SkipWaitButton({ tool }: { tool: ToolCallData }) {
  const skipToolWait = useTerra((s) => s.skipToolWait);

  if (!tool.toolId || tool.backgrounded) return null;

  return (
    <button
      type="button"
      onClick={() => tool.toolId && skipToolWait(tool.toolId)}
      aria-label={`Continue while ${tool.name} runs`}
      title="The tool keeps running in the background — the agent continues now"
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-hairline bg-background px-2.5 text-[11px] font-medium text-ink-muted transition-colors hover:border-terra-soft-border hover:bg-terra-soft hover:text-terra-deep"
    >
      <FastForward className="h-3 w-3" aria-hidden />
      Skip wait
    </button>
  );
}
