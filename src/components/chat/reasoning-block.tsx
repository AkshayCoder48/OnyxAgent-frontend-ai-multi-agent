// ============================================================================
// ThinkingBlock / ReasoningBlock — collapsible reasoning display.
// Shown above the message content when the model emits reasoning_content/reasoning/thinking.
// Adapted from the original repo's message-item.tsx ThinkingBlock + ReasoningBlock.
// ============================================================================
"use client";

import * as React from "react";
import { Brain, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  content: string;
  isStreaming?: boolean;
  variant?: "thinking" | "reasoning";
}

export function ReasoningBlock({ content, isStreaming, variant = "reasoning" }: Props) {
  const [open, setOpen] = React.useState(!!isStreaming);
  const label = variant === "thinking" ? "Thinking" : "Reasoning";

  React.useEffect(() => {
    if (isStreaming) setOpen(true);
  }, [isStreaming]);

  if (!content) return null;

  return (
    <div
      className={cn(
        "mb-2 overflow-hidden rounded-md border text-xs",
        variant === "thinking" ? "border-border bg-muted/40" : "border-dashed border-primary/30 bg-muted/30",
      )}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <Brain className="h-3 w-3 text-muted-foreground" />
        <span className="font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {isStreaming && (
          <span className="ml-1 h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {content.length} chars
        </span>
        <ChevronDown
          className={cn("h-3 w-3 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <pre className="max-h-72 overflow-y-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/65">
          {content}
        </pre>
      )}
    </div>
  );
}
