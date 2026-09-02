"use client";

import { useMemo, useState } from "react";
import type { ToolCall } from "@/types";
import { useChatStore } from "@/stores/chat-store";
import { useToolDisplayStore } from "@/stores/tool-display-store";
import {
  SimpleToolTimeline,
  ToolTimeline,
} from "@/components/assistant-ui/elements";
import { deriveTimeline } from "@/lib/agent-tool-steps";
import { friendlyStep } from "@/lib/agent-friendly-steps";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * TimelineDialog — the conversation's whole working session summarized as
 * verbs, targets, and file stats (assistant-ui "Tool timeline"), opened from
 * the chat header's timeline button. Every tool call across every assistant
 * turn becomes one step; file-affecting tools also produce stats chips.
 * The verb/chip/stat derivation lives in `agent-tool-steps.ts` so the chat
 * message flow (CollapsibleToolGroup) and this dialog share one truth.
 *
 * In "simple" display mode the same session is retold as plain sentences
 * (agent-friendly-steps.ts) — no verbs, chips, or +/- stats.
 */

export function TimelineDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const messages = useChatStore((s) => s.messages);
  const displayMode = useToolDisplayStore((s) => s.mode);
  const isSimple = displayMode === "simple";
  const [expanded, setExpanded] = useState(true);

  const { steps, friendlySteps, stats, filesChanged } = useMemo(() => {
    const all: ToolCall[] = [];
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      // Prefer parts (ordered); fall back to the flat toolCalls list.
      const toolCalls: ToolCall[] = msg.parts?.length
        ? msg.parts
            .filter((p) => p.type === "tool" && p.toolCall)
            .map((p) => p.toolCall!)
        : (msg.toolCalls ?? []);
      all.push(...toolCalls);
    }
    const derived = deriveTimeline(all);
    return {
      steps: derived.steps,
      friendlySteps: all.map(friendlyStep),
      stats: derived.stats,
      filesChanged: derived.filesChanged,
    };
  }, [messages]);

  const restingLabel =
    steps.length === 0
      ? "No tool calls yet"
      : `${steps.length} step${steps.length !== 1 ? "s" : ""}${
          filesChanged > 0 ? ` · ${filesChanged} file${filesChanged !== 1 ? "s" : ""} changed` : ""
        }`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 overflow-y-auto p-0 sm:max-w-md">
        <DialogHeader className="border-b px-4 pt-4 pb-3">
          <DialogTitle className="font-display text-base font-medium tracking-tight">
            Tool timeline
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-[12px] leading-relaxed">
            {isSimple
              ? "The whole session, told in plain words."
              : "The whole session as verbs, targets, and file changes."}
          </DialogDescription>
        </DialogHeader>
        <div className="px-2 py-3">
          {steps.length === 0 ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-[13px]">
              The agent hasn&apos;t used any tools in this conversation yet.
            </p>
          ) : isSimple ? (
            <SimpleToolTimeline
              steps={friendlySteps}
              streaming={false}
              open={expanded}
              onOpenChange={setExpanded}
              restingLabel={restingLabel}
              activeLabel="Working"
              filesChanged={filesChanged}
              className="max-w-none"
            />
          ) : (
            <ToolTimeline
              steps={steps}
              visibleSteps={steps.length}
              streaming={false}
              open={expanded}
              onOpenChange={setExpanded}
              restingLabel={restingLabel}
              activeLabel="Working"
              stats={stats}
              className="max-w-none"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
