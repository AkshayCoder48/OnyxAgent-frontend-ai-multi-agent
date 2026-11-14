"use client";

import React, { useMemo, useState } from "react";
import { ChevronRight, FileText } from "lucide-react";
import type { ToolCall } from "@/types";
import { cn } from "@/lib/utils";
import { CollapsePanel } from "@/components/assistant-ui/elements";
import { mapBrowserRunStarts } from "@/lib/browser-run-group";
import { stackSummaryLabel, stackSummarySegments } from "@/lib/tool-stack-summaries";

/**
 * ToolStackGroup — the COMBINED TOOLS row (user screenshots 2026-11-13 +
 * directives 2026-11-14). A run of consecutive tool calls rests as ONE
 * compact disclosure row,
 *
 *     [doc icon] Created 3 Files · Created 5 Todos · Used 2 Tools   ›
 *
 * CAPTION (2026-11-14 directive — "docs icon + 'Created N Files, Used N
 * Tools, Created N Todos' … for every tool; custom tools show Used N
 * Tools"): the doc glyph stays, the word "Tools" is replaced by per-tool
 * summaries of what the run actually DID — each tool family aggregates to
 * "Verb N Noun(s)" (Created 3 Files, Created 5 Todos, Ran 2 Searches…),
 * unknown names (custom/MCP tools) fold into the "Used N Tools" bucket.
 * Failures stay visible as the one destructive number ("· N failed").
 *
 * Tapping anywhere on the row expands the individual stacked tool rows
 * underneath. While ANY tool in the stack is still live the rows stay
 * fully visible so the run narrates itself; the moment the whole stack
 * settles it folds into the summary — the same auto-fold state machine
 * the "Thought for Ns" reasoning row uses.
 */

interface ToolStackGroupProps {
  /** The stack's tool calls in order — the SAME array the rows render
   *  from (browser continuations included; each browser run counts as
   *  ONE unit so counts match the rows the user sees). */
  toolCalls: readonly ToolCall[];
  /** The rendered row units (ToolCallCard rows + BrowserUseGroup frames). */
  children: React.ReactNode;
}

/** True while any call in the stack is still in flight — running,
 *  pending, or paused at the approval gate (an interactive approval
 *  card must never be folded behind the summary row). */
export function isStackLive(toolCalls: readonly ToolCall[]): boolean {
  return toolCalls.some(
    (tc) =>
      tc.status === "pending" ||
      tc.status === "running" ||
      tc.status === "awaiting_approval",
  );
}

// ── summary derivation ────────────────────────────────────────────────────

/** The combined summary line for a settled stack — per-tool captions
 *  ("Created 3 Files · Created 5 Todos · Used 2 Tools") from
 *  tool-stack-summaries, plus "· N failed" when something broke. */
export function stackSummary(toolCalls: readonly ToolCall[]): string {
  const failed = toolCalls.filter((tc) => tc.status === "error").length;
  const label = stackSummaryLabel(toolCalls);
  return failed > 0 ? `${label} · ${failed} failed` : label;
}

export function ToolStackGroup({ toolCalls, children }: ToolStackGroupProps) {
  // Unit count — browser continuations fold into their run's frame, so
  // only run-starts and non-browser calls count. Memoized on the array
  // identity (the store swaps it immutably only when a tool changes).
  const unitCount = useMemo(() => {
    const runs = mapBrowserRunStarts(toolCalls);
    let units = 0;
    for (const tc of toolCalls) {
      if (runs.isContinuation(tc.id)) continue;
      units += 1;
    }
    return units;
  }, [toolCalls]);

  const failedCount = useMemo(
    () => toolCalls.filter((tc) => tc.status === "error").length,
    [toolCalls],
  );

  // The caption — per-tool summaries ("Created 3 Files · Created 5 Todos"),
  // memoized like the counts above. The failure suffix is appended in the
  // JSX so it keeps its destructive tint.
  const summary = useMemo(() => stackSummaryLabel(toolCalls), [toolCalls]);

  const live = isStackLive(toolCalls);

  // AUTO-FOLD STATE MACHINE (same contract as the reasoning row): while
  // live the rows are always visible; on the live→settled transition the
  // stack folds into the summary. A settled→live transition (a new tool
  // joins the stack) shows the rows again and resets the fold for the
  // next settle. Render-time adjustment pattern — no effect, no
  // cascading renders.
  const [open, setOpen] = useState(false);
  const [prevLive, setPrevLive] = useState(live);
  if (live !== prevLive) {
    setPrevLive(live);
    setOpen(false);
  }

  // LIVE or SINGLE unit: the bare stacked rows — no group chrome. A live
  // stack keeps every row visible (the run narrates itself); one lone
  // settled tool is just its row.
  if (live || unitCount <= 1) {
    return (
      <div className="tool-call-stack mb-stagger w-full space-y-0">{children}</div>
    );
  }

  // SETTLED multi-tool stack: the combined summary row + the folded rows.
  return (
    <div className="tool-call-stack step-card-in w-full">
      {/* The combined row — doc glyph · clean caption · chevron. The
          WHOLE row is the disclosure (same a11y pattern as every other
          tool row: div role=button so nested interactive rows stay
          legal). Muted monochrome per the screenshot — theme-aware
          tokens, never literal gray. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={summary}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className="mb-press flex min-h-7 w-full cursor-pointer select-none items-center gap-2 rounded-lg px-1 py-1 text-left transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate text-sm font-medium text-muted-foreground">
          {summary}
          {failedCount > 0 && (
            <span className="text-destructive/90"> · {failedCount} failed</span>
          )}
        </span>
        <ChevronRight
          className={cn(
            "ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground/80 transition-transform duration-200 ease-out",
            open && "rotate-90",
          )}
          aria-hidden
        />
      </div>

      {/* The folded rows — height + fade disclosure; rows stay mounted so
          the expand/collapse transition is smooth (and stagger their
          entrance when revealed). */}
      <CollapsePanel open={open}>
        <div className="mb-stagger space-y-0 pt-0.5">{children}</div>
      </CollapsePanel>
    </div>
  );
}
