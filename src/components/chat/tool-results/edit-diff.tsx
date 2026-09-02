"use client";

import { useMemo } from "react";
import type { ToolCall } from "@/types";
import { CodeDiff } from "@/components/assistant-ui/elements/code-diff";
import { deriveEditDiff } from "@/lib/agent-tool-steps";

/**
 * CodeDiff for the agent's `edit_file` tool (assistant-ui
 * `elements-code-diff` recipe, wired to the tool's own find/replace pair).
 *
 * The removed block is the `find` argument's lines, the added block is the
 * `replace` argument's lines — exactly the change the tool made. Header
 * counts are the true line counts; the body is capped with an explicit
 * "… N more lines" marker (see deriveEditDiff). Only renders for completed,
 * successful edits; everything else falls back to the raw view.
 */
export function EditFileDiff({ toolCall }: { toolCall: ToolCall }) {
  const diff = useMemo(() => deriveEditDiff(toolCall), [toolCall]);
  if (!diff) return null;
  return (
    <CodeDiff
      filename={diff.filename}
      additions={diff.additions}
      deletions={diff.deletions}
      lines={diff.lines}
      cycle={0}
      className="max-w-full"
    />
  );
}
