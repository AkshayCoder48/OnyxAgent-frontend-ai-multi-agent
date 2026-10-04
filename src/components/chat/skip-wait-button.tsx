"use client";

import { useState } from "react";
import { FastForward, Loader2 } from "lucide-react";

import { useExecutionFor } from "@/lib/agent/execution-hub";
import { requestSkipWait, wasSkipped } from "@/lib/agent/skip-wait";
import type { ToolCall } from "@/types";
import { cn } from "@/lib/utils";

/**
 * SkipWaitButton (extension PRD §3.6) — "Continue while this runs". Shown on
 * RUNNING tool cards in the agent chat. Clicking backgrounds the tool: the
 * agent's round continues immediately (with a placeholder tool result for
 * the API), the real handler keeps running detached, and its late result
 * lands in the same card when it completes.
 *
 * Only meaningful for FOREGROUND executions (background turns already run
 * detached inside the sandbox) and for tools where waiting is the point of
 * the card (ask_user waits for the user, not the agent).
 */
export function SkipWaitButton({
  toolCall,
  turnId,
  className,
}: {
  toolCall: ToolCall;
  /** Conversation id (the ToolCallCard's turnId). */
  turnId?: string | null;
  className?: string;
}) {
  const execution = useExecutionFor(turnId ?? null);
  const [skipped, setSkipped] = useState(() =>
    turnId ? wasSkipped(turnId, toolCall.id) : false,
  );

  if (!turnId) return null;
  if (toolCall.status !== "running" && toolCall.status !== "pending") return null;
  // Background turns already detach from the page — skip-wait is a no-op.
  if (execution && execution.mode !== "foreground") return null;
  // ask_user blocks on the USER's answer — backgrounding it is meaningless.
  if (toolCall.name === "ask_user") return null;

  if (skipped) {
    return (
      <span
        className={cn(
          "text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.05] px-2 py-0.5 text-[10px] font-medium",
          className,
        )}
        title="The tool keeps running — its result will appear here when it completes."
      >
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        Running in background
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation(); // don't toggle the card's disclosure
        requestSkipWait(turnId, toolCall.id);
        setSkipped(true);
      }}
      className={cn(
        "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
        className,
      )}
      title="Let the agent continue while this tool keeps running"
    >
      <FastForward className="h-3 w-3" aria-hidden />
      Continue while this runs
    </button>
  );
}
