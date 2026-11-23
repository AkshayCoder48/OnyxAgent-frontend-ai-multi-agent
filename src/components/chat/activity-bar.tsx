"use client";

import React, { useMemo, useState } from "react";
import { Check, ChevronRight, CircleAlert } from "lucide-react";
import type { ChatMessage, ToolCall } from "@/types";
import { cn } from "@/lib/utils";
import { CollapsePanel } from "@/components/assistant-ui/elements";
import { statusCaptionFor } from "@/hooks/use-status-caption";

/**
 * Unified Activity Bar — PRD "Unified Activity Bar & Premium Magic UI
 * Integration" PART A. ONE collapsible activity container per assistant
 * response holding EVERYTHING that happened during execution: thinking
 * runs, approved reasoning summaries, tool calls and their results,
 * progress and completion status. No per-tool activity panels.
 *
 *   Collapsed:  ◉ Worked 2m 34s · Used 4 tools            ⌄
 *   Expanded:   ◉ Worked 2m 34s · Used 4 tools            ⌃
 *              ─────────────────────────────────────────
 *               (the chronological execution timeline:
 *                thinking rows + tool cards, live-updating)
 *
 * The summary row toggles the fold AT ANY TIME — including while the turn
 * is still streaming (manual collapse mid-write works; user directive
 * 2026-11-23). Auto behavior only rides the transitions: a live round
 * opens the timeline, settling folds it back into the summary; the one
 * exception is the approval gate, which pins the panel open (an
 * interactive approval card never hides behind the summary row).
 *
 * The timeline content itself (thinking rows, ToolCallCards, browser
 * groups) is rendered by the caller and passed as `children` — the same
 * rich rows the inline flow already used, now folded into ONE bar whose
 * header carries the dynamic summary. Because it derives entirely from
 * the message's parts (SSE-fed, checkpointed to Dexie), live updates,
 * refresh persistence and background-execution recovery come for free.
 */

// ── the chronological flow walk (shared with message-item) ─────────────────

/** One chronological step of the generation process, built by walking the
 *  message parts (the execution timeline). Runs of consecutive thinking /
 *  reasoning parts merge into ONE item while the run is open; tool and
 *  text parts stay in place. */
export type FlowItem =
  | {
      kind: "thinking";
      partId: string;
      text: string;
      variant: "thinking" | "reasoning";
      /** The reasoning stream is still open (no reasoningEndedAt stamp). */
      open: boolean;
      /** Round start stamp — drives the "Thought for Ns" duration. */
      startedAt?: number;
      /** reasoningEndedAt stamp of the run's last part. */
      endedAt?: number;
    }
  | { kind: "tool"; partId: string; toolCall: ToolCall }
  | { kind: "text"; partId: string; text: string };

/** Walk the message parts into chronological FlowItems. A closed reasoning
 *  run is never merged into — the next round's thinking starts a fresh
 *  row (each "Thought for Ns" belongs to its own round). */
export function buildFlowItems(
  parts: readonly import("@/types/chat").MessagePart[],
): FlowItem[] {
  const items: FlowItem[] = [];
  for (const p of parts) {
    if ((p.type === "thinking" || p.type === "reasoning") && p.content) {
      const last = items[items.length - 1];
      if (
        last &&
        last.kind === "thinking" &&
        last.variant === p.type &&
        last.open
      ) {
        last.text += "\n" + p.content;
        last.open = p.reasoningEndedAt === undefined;
        if (p.reasoningEndedAt !== undefined) last.endedAt = p.reasoningEndedAt;
        if (p.roundStartedAt !== undefined && last.startedAt === undefined) {
          last.startedAt = p.roundStartedAt;
        }
        continue;
      }
      items.push({
        kind: "thinking",
        partId: p.id,
        text: p.content,
        variant: p.type,
        open: p.reasoningEndedAt === undefined,
        startedAt: p.roundStartedAt,
        endedAt: p.reasoningEndedAt,
      });
    } else if (p.type === "tool" && p.toolCall) {
      items.push({ kind: "tool", partId: p.id, toolCall: p.toolCall });
    } else if (p.type === "text" && p.content) {
      items.push({ kind: "text", partId: p.id, text: p.content });
    }
  }
  return items;
}

// ── duration + summary formatting ──────────────────────────────────────────

/** "2m 34s" / "8s" / "1h 05m" — the PRD's summary wording. */
export function formatWorkDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${hours}h`;
}

/** True while any call is still in flight — running, pending, or paused at
 *  the approval gate (an interactive approval card must never be folded
 *  behind the summary row). */
function isLive(message: ChatMessage, toolCalls: readonly ToolCall[]): boolean {
  if (message.isStreaming) return true;
  return toolCalls.some(
    (tc) =>
      tc.status === "pending" ||
      tc.status === "running" ||
      tc.status === "awaiting_approval",
  );
}

interface ActivityBarProps {
  message: ChatMessage;
  /** The message's tool calls in order (unit counting mirrors the rows the
   *  user sees — browser continuations fold into their run). */
  toolCalls: readonly ToolCall[];
  /** Count of tool UNITS (browser runs folded to one) — supplied by the
   *  caller which already runs mapBrowserRunStarts. */
  toolUnitCount: number;
  /** The chronological timeline rows (thinking + tool cards). */
  children: React.ReactNode;
}

export function ActivityBar({
  message,
  toolCalls,
  toolUnitCount,
  children,
}: ActivityBarProps) {
  const streaming = Boolean(message.isStreaming);
  const live = isLive(message, toolCalls);

  // ── the dynamic summary line ────────────────────────────────────────
  // RUNNING  — the live caption narrates the CURRENT activity ("Thinking",
  //            "Searching “dragons”", "Writing") + the running tool count.
  // SETTLED  — "Worked 2m 34s · Used 4 tools" / "Stopped after 42s · …" /
  //            "Failed after 8s · …" from the stamped generation summary
  //            (fallback: derived from the part stamps).
  const summary = useMemo(() => {
    if (streaming) {
      const caption = statusCaptionFor(message) ?? "Working";
      return toolUnitCount > 0 ? `${caption} · Used ${toolUnitCount} tool${toolUnitCount === 1 ? "" : "s"}` : caption;
    }
    const gen = message.generation;
    let durationMs = gen?.durationMs;
    if (durationMs === undefined) {
      // Fallback: earliest activity stamp → latest settle stamp across the
      // parts — tool calls carry startedAt/endedAt (epoch ms), thinking
      // parts carry roundStartedAt/reasoningEndedAt. A thinking-less turn
      // (a provider without reasoning) still resolves from its tools.
      let first: number | undefined;
      let last: number | undefined;
      const see = (t: number | undefined, isStart: boolean) => {
        if (t === undefined) return;
        if (isStart && (first === undefined || t < first)) first = t;
        if (!isStart && (last === undefined || t > last)) last = t;
      };
      for (const p of message.parts ?? []) {
        see(p.roundStartedAt, true);
        see(p.reasoningEndedAt, false);
        if (p.type === "tool" && p.toolCall) {
          see(p.toolCall.startedAt, true);
          see(p.toolCall.endedAt, false);
        }
      }
      durationMs =
        first !== undefined && last !== undefined && last > first
          ? last - first
          : undefined;
    }
    const durationLabel = durationMs !== undefined ? formatWorkDuration(durationMs) : null;
    const toolLabel = toolUnitCount > 0 ? ` · Used ${toolUnitCount} tool${toolUnitCount === 1 ? "" : "s"}` : "";
    if (gen?.stopped) {
      return `${durationLabel ? `Stopped after ${durationLabel}` : "Stopped"}${toolLabel}`;
    }
    if (gen?.failed) {
      return `${durationLabel ? `Failed after ${durationLabel}` : "Failed"}${toolLabel}`;
    }
    return `${durationLabel ? `Worked ${durationLabel}` : "Finished"}${toolLabel}`;
  }, [streaming, message, toolUnitCount]);

  // AUTO-FOLD STATE MACHINE (user directive 2026-11-23: "collapsing that
  // thing while ai writing something is not working — fix it"): a live
  // round OPENS the timeline (the run narrates itself) and the
  // live→settled transition folds it into the summary — but BETWEEN those
  // transitions the summary row's click is the USER's: manual collapse and
  // expand work at ANY time, including mid-stream. Render-time adjustment
  // pattern — no effect, no cascading renders.
  const [open, setOpen] = useState(live);
  const [prevLive, setPrevLive] = useState(live);
  if (live !== prevLive) {
    setPrevLive(live);
    setOpen(live);
  }

  // The approval gate is the ONE state that never folds (an interactive
  // approval card must not hide behind the summary row): while any call
  // awaits approval the panel is forced open — manual toggle included.
  const approvalGated = toolCalls.some(
    (tc) => tc.status === "awaiting_approval",
  );
  const panelOpen = approvalGated || open;

  const failed = !streaming && (message.generation?.failed || message.generation?.stopped || false);

  return (
    <div className="activity-bar step-card-in w-full">
      {/* The summary row — status glyph · dynamic summary · chevron. The
          WHOLE row is the disclosure (div role=button so the nested
          interactive timeline rows stay legal). */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={panelOpen}
        aria-label={`Activity — ${summary}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className="mb-press flex min-h-8 w-full cursor-pointer select-none items-center gap-2 rounded-lg px-1 py-1 text-left transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {live ? (
          <span
            className="bg-primary h-2 w-2 shrink-0 animate-pulse rounded-full"
            aria-hidden
          />
        ) : failed ? (
          <CircleAlert className="text-destructive h-3.5 w-3.5 shrink-0" aria-hidden />
        ) : (
          <Check
            className="h-3.5 w-3.5 shrink-0 text-emerald-500 dark:text-emerald-400"
            aria-hidden
          />
        )}
        <span
          className={cn(
            "min-w-0 truncate text-sm font-medium",
            failed ? "text-destructive/90" : "text-muted-foreground",
          )}
        >
          {summary}
        </span>
        <ChevronRight
          className={cn(
            "text-muted-foreground/80 ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200 ease-out",
            panelOpen && "rotate-90",
          )}
          aria-hidden
        />
      </div>

      {/* The folded timeline — height + fade disclosure; rows stay mounted
          so the expand/collapse transition is smooth. MANUAL COLLAPSE
          WORKS WHILE LIVE (the user's click is honored mid-stream); only
          the live↔settled transitions and the approval gate override it. */}
      <CollapsePanel open={panelOpen}>
        <div className="mb-stagger space-y-0 pt-0.5">{children}</div>
      </CollapsePanel>
    </div>
  );
}
