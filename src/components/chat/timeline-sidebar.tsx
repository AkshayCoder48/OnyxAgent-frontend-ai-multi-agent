"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ToolCall } from "@/types";
import { useChatStore } from "@/stores/chat-store";
import { useToolDisplayStore } from "@/stores/tool-display-store";
import {
  SimpleToolTimeline,
  ToolTimeline,
} from "@/components/assistant-ui/elements";
import { deriveTimeline } from "@/lib/agent-tool-steps";
import { friendlyStep } from "@/lib/agent-friendly-steps";
import { ListTree, X } from "lucide-react";

/**
 * TimelineSidebar — the conversation's whole working session as a DOCKED
 * right sidebar (not a popup dialog): a fixed-height, scrollable panel that
 * updates in real time as the agent works.
 *
 * Every tool call across every assistant turn becomes one step. The panel
 * reads the live chat store, so streaming tools appear the moment they
 * start — and while a turn runs, the list auto-follows the newest step.
 *
 * In "simple" display mode the same session is retold as plain sentences
 * (agent-friendly-steps.ts) — no verbs, chips, or +/- stats.
 *
 * The FIXED SCROLL AREA: the steps list lives in a `flex-1 min-h-0
 * overflow-y-auto` container — the panel NEVER grows unboundedly with the
 * conversation; long sessions scroll inside the fixed area.
 */
export function TimelineSidebar({ onClose }: { onClose?: () => void }) {
  const messages = useChatStore((s) => s.messages);
  const displayMode = useToolDisplayStore((s) => s.mode);
  const isSimple = displayMode === "simple";
  const scrollRef = useRef<HTMLDivElement>(null);

  const { steps, friendlySteps, stats, filesChanged, anyRunning } = useMemo(() => {
    const all: ToolCall[] = [];
    let running = false;
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      // Prefer parts (ordered); fall back to the flat toolCalls list.
      const toolCalls: ToolCall[] = msg.parts?.length
        ? msg.parts
            .filter((p) => p.type === "tool" && p.toolCall)
            .map((p) => p.toolCall!)
        : (msg.toolCalls ?? []);
      for (const tc of toolCalls) {
        if (tc.status === "running" || tc.status === "pending") running = true;
      }
      all.push(...toolCalls);
    }
    const derived = deriveTimeline(all);
    return {
      steps: derived.steps,
      friendlySteps: all.map(friendlyStep),
      stats: derived.stats,
      filesChanged: derived.filesChanged,
      anyRunning: running,
    };
  }, [messages]);

  // REAL-TIME AUTO-FOLLOW: while a turn runs and new steps arrive, keep the
  // newest step in view (the user watches progress, not a stale crop). When
  // nothing is running the scroll position is left alone.
  const stepsCount = steps.length;
  const prevCountRef = useRef(stepsCount);
  useEffect(() => {
    if (stepsCount !== prevCountRef.current) {
      prevCountRef.current = stepsCount;
      if (anyRunning && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }
  }, [stepsCount, anyRunning]);

  const stepWord = steps.length === 1 ? "step" : "steps";
  const fileWord = filesChanged === 1 ? "file" : "files";
  const restingLabel =
    steps.length === 0
      ? "No tool calls yet"
      : `${steps.length} ${stepWord}${
          filesChanged > 0 ? ` · ${filesChanged} ${fileWord} changed` : ""
        }`;

  return (
    <div className="bg-card flex h-full min-h-0 flex-col">
      {/* Header — fixed (never scrolls away). */}
      <div className="border-border flex h-12 shrink-0 items-center justify-between border-b px-3">
        <div className="flex min-w-0 items-center gap-2">
          <ListTree className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold leading-tight">Tool timeline</h3>
            <p className="text-muted-foreground truncate text-[11px] leading-tight">
              {restingLabel}
              {anyRunning ? " · working…" : ""}
            </p>
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close timeline sidebar"
            title="Close"
            className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* The FIXED SCROLL AREA — the list scrolls inside this bounded
          container instead of enlarging the panel forever. */}
      <div
        ref={scrollRef}
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 py-3"
        role="region"
        aria-label="Tool timeline steps"
      >
        {steps.length === 0 ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-[13px]">
            The agent hasn&apos;t used any tools in this conversation yet.
          </p>
        ) : isSimple ? (
          <SimpleToolTimeline
            steps={friendlySteps}
            streaming={anyRunning}
            open={true}
            onOpenChange={() => undefined}
            restingLabel={restingLabel}
            activeLabel="Working"
            filesChanged={filesChanged}
            className="max-w-none"
            embedded
          />
        ) : (
          <ToolTimeline
            steps={steps}
            visibleSteps={steps.length}
            streaming={anyRunning}
            open={true}
            onOpenChange={() => undefined}
            restingLabel={restingLabel}
            activeLabel="Working"
            stats={stats}
            className="max-w-none"
            embedded
          />
        )}
      </div>
    </div>
  );
}
