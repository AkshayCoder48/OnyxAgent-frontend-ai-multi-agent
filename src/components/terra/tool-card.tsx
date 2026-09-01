"use client";

import { useState } from "react";
import { Check, ChevronDown, Globe, Loader2, Search, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolCallData, ToolIconKind } from "./types";

const TOOL_ICONS: Record<ToolIconKind, typeof Globe> = {
  globe: Globe,
  wrench: Wrench,
  search: Search,
};

export function ToolCard({ tool }: { tool: ToolCallData }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[tool.icon];
  const running = tool.status === "running";

  return (
    <div className="rounded-xl border border-hairline bg-paper text-left">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`tool-card-${tool.name}`}
        className="flex w-full min-h-11 items-center gap-3 rounded-xl px-3.5 py-2.5 text-left"
      >
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-terra-soft-border bg-terra-soft"
          aria-hidden
        >
          <Icon className="h-3.5 w-3.5 text-terra" />
        </span>
        <span className="shrink-0 font-mono text-xs text-ink-soft">{tool.name}</span>
        <span className="hidden min-w-0 truncate text-xs text-ink-muted sm:block">
          — {tool.subtitle}
        </span>
        <span
          className={cn(
            "ml-auto flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
            running ? "bg-background text-ink-soft" : "bg-terra-soft text-terra-deep",
          )}
        >
          {running ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          ) : (
            <Check className="h-3 w-3" aria-hidden />
          )}
          {running ? "Running" : "Completed"}
        </span>
        <ChevronDown
          className={cn("h-4 w-4 shrink-0 text-ink-muted transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>

      {open && (
        <div className="space-y-3 px-3.5 pb-3.5">
          <div>
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted">
              Arguments
            </p>
            <pre className="terra-scroll overflow-x-auto rounded-lg border border-hairline/60 bg-background p-3 font-mono text-xs leading-relaxed text-ink-soft">
              {tool.args}
            </pre>
          </div>
          <div>
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted">
              Result
            </p>
            <p className="whitespace-pre-line rounded-lg border border-hairline/60 bg-background p-3 text-[13px] leading-relaxed text-ink-soft">
              {tool.result}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
