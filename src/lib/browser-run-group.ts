import type { ToolCall } from "@/types";

/**
 * Browser-run grouping — which use_browser tool calls form ONE consecutive
 * run (rendered as a single BrowserUseGroup frame in the chat flow).
 *
 * A run is a MAXIMAL consecutive subsequence where every entry is a
 * use_browser call. In the panel flow the sequence is the FlowItems in
 * order, with `null` standing in for every NON-tool item (thinking or text)
 * — any such item BREAKS a run, because the group must render at one
 * position in the flow (where the run starts). In the simple flow the
 * sequence is the plain tool-call list (no breaks).
 *
 * Node-safe pure TS (type-only import) — no React, no "use client".
 */
export interface BrowserRunMap {
  /** The full run (oldest→newest) whose FIRST call has this id, or
   *  undefined when the id is not a run start. */
  runStartedBy(id: string): ToolCall[] | undefined;
  /** True when this call is a CONTINUATION of a run started earlier —
   *  render nothing for it; the run's start call renders the whole group. */
  isContinuation(id: string): boolean;
}

/**
 * Map consecutive use_browser runs over a call sequence. `null`/`undefined`
 * entries are run breakers (any non-tool flow item).
 */
export function mapBrowserRunStarts(
  sequence: ReadonlyArray<ToolCall | null | undefined>,
): BrowserRunMap {
  const starts = new Map<string, ToolCall[]>();
  const continuations = new Set<string>();
  let current: ToolCall[] | null = null;
  for (const entry of sequence) {
    if (entry && entry.name === "use_browser") {
      if (current) {
        current.push(entry);
        continuations.add(entry.id);
      } else {
        current = [entry];
        starts.set(entry.id, current);
      }
    } else {
      // A non-browser item ends the current run.
      current = null;
    }
  }
  return {
    runStartedBy: (id) => starts.get(id),
    isContinuation: (id) => continuations.has(id),
  };
}
