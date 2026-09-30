"use client";

import { Boxes, Database, Globe, Rocket, Sparkles, TerminalSquare } from "lucide-react";

import { CreationPrompt } from "./creation-prompt";
import type { ChatMessageFile } from "@/types";

/**
 * OnyxCode empty state (OnyxCode PRD §4.2 + extension PRD §3.2) — replaces
 * the normal ChatEmptyState while a Code Mode conversation is empty. A large
 * centred creation surface: "What do you want to create?" heading, the big
 * CreationPrompt (files, model selector, Create CTA, quick-start chips), and
 * capability badges. The bottom composer is hidden by ChatContainer while
 * this is shown — the creation surface IS the input for the first message.
 */

const CAPABILITIES = [
  { icon: Boxes, label: "6 scaffolds" },
  { icon: Globe, label: "Live preview" },
  { icon: Database, label: "OnyxBase database" },
  { icon: TerminalSquare, label: "Full agent tools" },
  { icon: Sparkles, label: "Skip-wait builds" },
];

interface CodeEmptyStateProps {
  onSend: (content: string, fileIds?: string[], files?: ChatMessageFile[]) => void;
  disabled?: boolean;
}

export function CodeEmptyState({ onSend, disabled }: CodeEmptyStateProps) {
  return (
    /* Scroller + auto-margin centering (same pattern as ChatEmptyState —
       centers when it fits, scrolls from the top when it doesn't). */
    <div className="mx-auto h-full w-full max-w-3xl overflow-y-auto scrollbar-thin px-3 py-4 sm:px-6 sm:py-10">
      <div className="m-auto flex w-full flex-col items-center">
        {/* OnyxCode wordmark + Beta badge (same treatment as the header). */}
        <div className="flex items-center gap-2">
          <span className="onyx-logo-text text-2xl sm:text-3xl">
            <span className="onyx-logo-o">O</span>nyx
            <span className="onyx-logo-agent">Code</span>
          </span>
          <span className="rounded bg-black px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white dark:bg-white dark:text-black">
            Beta
          </span>
        </div>

        <h2 className="title-reveal mt-4 text-center text-2xl font-bold tracking-tight sm:text-3xl">
          What do you want to create?
        </h2>
        <p className="text-muted-foreground mt-2 max-w-lg text-center text-xs leading-relaxed sm:text-sm">
          Describe an app — OnyxCode scaffolds it in the sandbox, starts a live
          preview, and can store data in your OnyxBase database. Every agent
          capability (files, web, tools, skills, sub-agents) is available.
        </p>

        {/* Capability badges */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">
          {CAPABILITIES.map((c) => (
            <div
              key={c.label}
              className="flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[10px] font-medium text-muted-foreground sm:px-3 sm:py-0.5 sm:text-xs"
            >
              <c.icon className="h-3 w-3" />
              {c.label}
            </div>
          ))}
        </div>

        {/* The big creation prompt */}
        <div className="stagger-in mt-5 w-full sm:mt-7">
          <CreationPrompt onSend={onSend} disabled={disabled} />
        </div>

        {/* Footer */}
        <div className="text-muted-foreground mt-4 flex items-center justify-center gap-2 text-[11px]">
          <Rocket className="h-3 w-3" aria-hidden />
          <span>Scaffolds served live from your E2B sandbox</span>
        </div>
      </div>
    </div>
  );
}
