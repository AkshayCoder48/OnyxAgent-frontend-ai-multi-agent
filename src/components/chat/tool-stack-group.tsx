"use client";

import React, { useMemo, useState } from "react";
import { ChevronRight, FileText } from "lucide-react";
import type { ToolCall } from "@/types";
import { cn } from "@/lib/utils";
import { CollapsePanel } from "@/components/assistant-ui/elements";
import { mapBrowserRunStarts } from "@/lib/browser-run-group";
import { resolveEffectiveToolCall } from "@/lib/agent/tool-umbrella";

/**
 * ToolStackGroup — the COMBINED TOOLS row (user screenshots 2026-11-13 +
 * directive 2026-11-14). A run of consecutive tool calls rests as ONE
 * compact disclosure row,
 *
 *     [doc icon] Used 10 tools · created 3 files          ›
 *
 * and tapping anywhere on it expands the individual stacked tool rows
 * underneath. While ANY tool in the stack is still live the rows stay
 * fully visible so the run narrates itself; the moment the whole stack
 * settles it folds into the summary — the same auto-fold state machine
 * the "Thought for Ns" reasoning row uses.
 *
 * SMART CAPTION (2026-11-14 — "creating a file is saying used files 😂"):
 * the summary is derived from WHAT THE RUN DID, not a bare tool count.
 * A stack that only created files reads "Created 3 files"; mixed runs
 * read "Used 8 tools · created 3 files · edited 1 file"; anything else
 * falls back to "Used N tools". File counts dedupe by path (a file
 * written in 5 chunks is ONE file) and only count completed, error-free
 * calls.
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

// ── smart-caption derivation ────────────────────────────────────────────────

/** Tool names whose successful completion means "a file was created".
 *  create_file_chunk writes one chunk of one file — deduped by path. */
const FILE_CREATE_NAMES = new Set(["create_file", "write_file", "create_file_chunk"]);

/** A completed call whose parsed result carries an error is NOT a landed
 *  file ("3 files created" must never describe three error results). */
function resultHasError(tc: ToolCall): boolean {
  if (tc.result && typeof tc.result === "object") {
    return Boolean((tc.result as Record<string, unknown>).error);
  }
  if (typeof tc.result === "string" && tc.result.startsWith('{"error"')) {
    return true;
  }
  return false;
}

/** The units whose successful completion means "a file was created"
 *  (create_file / write_file / create_file_chunk, umbrella-resolved,
 *  completed, error-free — path dedupe happens separately). */
function creationUnitsOf(units: readonly ToolCall[]): ToolCall[] {
  return units.filter((raw) => {
    if (raw.status !== "completed" || resultHasError(raw)) return false;
    return FILE_CREATE_NAMES.has(resolveEffectiveToolCall(raw).name);
  });
}

/** Dedupe landed file creations by target path (a file written in N
 *  chunks is ONE file). */
function landedFileCount(creations: readonly ToolCall[]): number {
  const paths = new Set<string>();
  for (const raw of creations) {
    const tc = resolveEffectiveToolCall(raw);
    const path =
      (typeof tc.args?.path === "string" && tc.args.path) ||
      (typeof tc.args?.file_path === "string" && tc.args.file_path) ||
      tc.id;
    paths.add(path);
  }
  return paths.size;
}

function countName(calls: readonly ToolCall[], name: string): number {
  let n = 0;
  for (const raw of calls) {
    const tc = resolveEffectiveToolCall(raw);
    if (tc.name === name && raw.status === "completed") n += 1;
  }
  return n;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The combined summary line for a settled stack. */
export function stackSummary(toolCalls: readonly ToolCall[]): string {
  // Units = run-starts + non-browser calls (matches the rows rendered).
  const runs = mapBrowserRunStarts(toolCalls);
  const units: ToolCall[] = [];
  for (const tc of toolCalls) {
    if (runs.isContinuation(tc.id)) continue;
    units.push(tc);
  }
  const unitCount = units.length;

  const creationUnits = creationUnitsOf(units);
  const created = landedFileCount(creationUnits);
  const edited = countName(units, "edit_file");
  const failed = units.filter((tc) => tc.status === "error").length;

  // EVERY unit a landed file creation → the whole run IS file creation
  // ("Created 4 files", never "Used 4 tools" — the 😂 case). Chunked
  // writes count as creation units too, deduped to their file count.
  if (creationUnits.length > 0 && creationUnits.length === unitCount && failed === 0) {
    return `Created ${created} ${plural(created, "file", "files")}`;
  }

  // Mixed run — lead with the tool count, then the notable actions.
  const segments: string[] = [];
  if (created > 0) segments.push(`created ${created} ${plural(created, "file", "files")}`);
  if (edited > 0) segments.push(`edited ${edited} ${plural(edited, "file", "files")}`);
  const head = `Used ${unitCount} ${plural(unitCount, "tool", "tools")}`;
  return segments.length > 0 ? `${head} · ${segments.join(" · ")}` : head;
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

  // The smart caption — memoized like the counts above.
  const summary = useMemo(() => stackSummary(toolCalls), [toolCalls]);

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
      {/* The combined row — doc glyph · smart summary · chevron. The
          WHOLE row is the disclosure (same a11y pattern as every other
          tool row: div role=button so nested interactive rows stay
          legal). Muted monochrome per the screenshot — theme-aware
          tokens, never literal gray. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${summary}${failedCount > 0 ? `, ${failedCount} failed` : ""}`}
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
