"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * StoppedRun — you pressed stop. The half-written answer stays, and
 * continuing is one tap away: streamed words with a blinking cursor, a
 * small reason badge, and Continue / Discard actions (assistant-ui
 * `elements-stopped-run` recipe, Terra retheme).
 */
export function StoppedRun({
  words,
  reason,
  onContinue,
  onDiscard,
  className,
  ...props
}: {
  words: readonly string[];
  reason: string;
  onContinue?: () => void;
  onDiscard?: () => void;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "children">) {
  return (
    <div data-slot="stopped-run" className={cn("max-w-md space-y-2", className)} {...props}>
      <p className="text-sm leading-relaxed text-foreground/85">
        {words.join(" ")}
        <span
          aria-hidden
          className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-primary align-middle"
        />
      </p>
      <div className="flex items-center gap-2">
        <span className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {reason}
        </span>
        <button
          type="button"
          onClick={onContinue}
          className="rounded-md px-2 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
        >
          Continue
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="rounded-md px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          Discard
        </button>
      </div>
    </div>
  );
}
