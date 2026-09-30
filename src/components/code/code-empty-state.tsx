"use client";

import { Feather } from "lucide-react";
import { CreationPrompt } from "./creation-prompt";

/**
 * Code Mode's empty state — the large "What do you want to create?" surface.
 * Replaces the normal empty state AND the bottom prompt box (per PRD §4.2).
 */
export function CodeEmptyState({ workspaceId }: { workspaceId?: string }) {
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col items-center justify-center gap-7 px-4 py-12 text-center sm:px-6">
      <span
        className="flex h-14 w-14 items-center justify-center rounded-full border border-terra-soft-border bg-terra-soft"
        aria-hidden
      >
        <Feather className="h-6 w-6 text-terra" />
      </span>
      <div className="space-y-2">
        <h2 className="font-serif text-[28px] font-semibold text-ink sm:text-[32px]">
          What do you want to create?
        </h2>
        <p className="mx-auto max-w-md text-[14px] leading-relaxed text-ink-muted">
          Describe an app — OnyxCode scaffolds the project, starts a live preview you can
          watch, tests it in a real headless browser and keeps project data in the Database tab.
        </p>
      </div>
      <div className="w-full">
        <CreationPrompt workspaceId={workspaceId} />
      </div>
    </div>
  );
}
