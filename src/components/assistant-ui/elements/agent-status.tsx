"use client";

import * as React from "react";
import { Check, Pause, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

export type AgentState = "working" | "waiting" | "done";

/**
 * AgentStatus — one pill that always answers: what is it doing, and for
 * how long. A rounded pill with a state dot, a label that crossfades when
 * it changes, an elapsed time while the agent is still going, and a
 * trailing icon (assistant-ui `elements-agent-status` recipe, Terra
 * retheme; the "working" pulse uses terracotta instead of blue).
 */
export function AgentStatus({
  state,
  label,
  elapsed,
  className,
  ...props
}: {
  state: AgentState;
  label: string;
  elapsed?: string;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "children">) {
  const done = state === "done";
  return (
    <div
      data-slot="agent-status"
      className={cn(
        "inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-sm shadow-sm",
        className,
      )}
      {...props}
    >
      {done ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-label="Done" />
      ) : (
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 animate-pulse rounded-full",
            state === "working" ? "bg-primary" : "bg-muted-foreground/50",
          )}
        />
      )}
      {/* Keyed on content so label changes crossfade (fade + de-blur). */}
      <span
        key={label}
        className="animate-[element-label-in_0.3s_ease-out_both] truncate text-foreground/85"
      >
        {label}
      </span>
      {elapsed && !done && (
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
          {elapsed}
        </span>
      )}
      <button
        type="button"
        aria-label={done ? "Run again" : "Pause agent"}
        title={done ? "Run again" : "Pause agent"}
        className="-mr-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
      >
        {done ? <RotateCcw className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
      </button>
    </div>
  );
}
