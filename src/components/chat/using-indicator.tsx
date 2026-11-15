"use client";

import React from "react";

import type { ToolCall } from "@/types";
import { toolDisplayName } from "@/lib/tool-display-names";
import { deriveStreamingTree } from "./streaming-file-tree";

/**
 * USING indicator (user request 2026-11-15) — the caption that rides at the
 * TOP of every assistant response that ran tools.
 *
 * LIVE (message still streaming): "Using {current tool} ········" — the
 * currently running tool (or the most recent one) followed by a dotted
 * leader that stretches to the end of the line, i.e. all the way to the
 * viewport edge, gently pulsing while work is in flight.
 *
 * SETTLED (response ended): the live line collapses into the compact
 * summary "Used N Tools · Created N Files" (files count = files that
 * actually landed — failed creates never inflate it; omitted entirely when
 * no files were touched).
 *
 * Colour-aware: eyebrow text rides muted foreground tokens, the live tool
 * name and dot ride --color-brand, the leader dots ride the glass hairline
 * tokens — so dark, light and custom schemes each get a correct paint.
 */
export function UsingIndicator({
  toolCalls,
  streaming,
}: {
  toolCalls: readonly ToolCall[];
  streaming: boolean;
}) {
  const live = streaming && toolCalls.length > 0;

  const { current, toolCount, fileCount } = React.useMemo(() => {
    // The in-flight call wins (last of them); otherwise the most recent.
    let current: ToolCall | null = null;
    for (const tc of toolCalls) {
      if (tc.status === "running" || tc.status === "pending" || tc.status === "awaiting_approval") {
        current = tc;
      }
    }
    if (!current && toolCalls.length > 0) current = toolCalls[toolCalls.length - 1] ?? null;
    const tree = deriveStreamingTree(toolCalls);
    return { current, toolCount: toolCalls.length, fileCount: tree.fileCount };
  }, [toolCalls]);

  if (toolCalls.length === 0) return null;

  const pluralTools = toolCount === 1 ? "Tool" : "Tools";
  const pluralFiles = fileCount === 1 ? "File" : "Files";

  if (live) {
    return (
      <div
        className="using-indicator mb-1.5 flex w-full items-center gap-2.5 select-none"
        aria-live="polite"
      >
        <span
          aria-hidden
          className="using-indicator-dot h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: "var(--color-brand)", boxShadow: "0 0 8px var(--color-brand)" }}
        />
        <span className="text-muted-foreground shrink-0 text-[10.5px] font-bold tracking-[0.16em] uppercase">
          Using
        </span>
        <span
          className="shrink-0 text-[10.5px] font-bold tracking-[0.16em] uppercase"
          style={{ color: "var(--color-brand)" }}
        >
          {current ? toolDisplayName(current.name) : "Tools"}
        </span>
        {/* Dotted leader — the "......" stretching to the viewport end. */}
        <span
          aria-hidden
          className="using-indicator-leader min-w-4 flex-1 border-b border-dotted"
          style={{ borderColor: "var(--glass-line-2)", transform: "translateY(-2px)" }}
        />
      </div>
    );
  }

  return (
    <div className="text-muted-foreground/90 mb-1.5 flex w-full items-center gap-2 text-[10.5px] font-bold tracking-[0.16em] uppercase select-none">
      <span>
        Used {toolCount} {pluralTools}
      </span>
      {fileCount > 0 && (
        <>
          <span aria-hidden className="text-muted-foreground/50">
            ·
          </span>
          <span>
            Created {fileCount} {pluralFiles}
          </span>
        </>
      )}
    </div>
  );
}
