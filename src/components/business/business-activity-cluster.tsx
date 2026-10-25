"use client";

/**
 * Business Mode — compact activity cluster (Task 2-d / PRD §6).
 *
 * The Business Mode chat overhaul: runs of CONSECUTIVE role:"activity" rows
 * (internal orchestration events — "Taken decision", "Delegated to X agents",
 * task progress…) no longer interleave with the conversation as individual
 * messages. Each run collapses into ONE muted line ("⚡ N activity events —
 * last: …") that expands to the individual compact BusinessActivityItem
 * rows. Non-activity messages keep their exact previous rendering (the
 * grouping lives in business-chat.tsx, this component only renders a run).
 */

import * as React from "react";
import { ChevronDown, Zap } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { BusinessChatMessageRow } from "@/lib/business/types";
import { BusinessActivityItem } from "./business-activity-item";

/** Single-line preview of the latest event (collapsed trigger label). */
function clip(text: string, max: number): string {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** One collapsible cluster of consecutive activity rows (collapsed by
 *  default — the orchestration log is detail, not the conversation). */
export function BusinessActivityCluster({
  messages,
}: {
  messages: BusinessChatMessageRow[];
}) {
  const [open, setOpen] = React.useState(false);
  if (messages.length === 0) return null;
  // The rows are chronological; the LAST one is the most recent event.
  const latest = messages[messages.length - 1]!;
  const latestContent = latest.content?.trim();

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      {/* Muted single-line summary; aria-expanded is explicit (Radix also
          auto-sets it — the explicit prop keeps the contract obvious). */}
      <CollapsibleTrigger
        aria-expanded={open}
        className="group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-1.5 text-left transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <Zap className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          <span className="font-medium">
            {messages.length} activity {messages.length === 1 ? "event" : "events"}
          </span>
          {latestContent ? ` — last: ${clip(latestContent, 80)}` : ""}
        </span>
        <ChevronDown
          className="size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-200 group-data-[state=open]:rotate-180"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 space-y-0.5 border-l border-border/60 pl-2">
          {messages.map((message) => (
            <BusinessActivityItem key={message.id} message={message} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
