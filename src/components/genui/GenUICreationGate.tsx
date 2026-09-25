"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { GenUINode, GenUISpec } from "@/lib/genui/types";
import { GenUIBlock } from "./GenUIBlock";
import { preloadRenderer } from "./registry";
import { deriveCreationPhrase } from "@/lib/genui/creation-label";
import { ThinkingIndicator } from "@/components/assistant-ui/elements";

/**
 * GenUICreationGate — PRD §21 "creation text" phase.
 *
 * When a `<<<genui>>>` block starts streaming in, the chat does NOT show the
 * shimmer placeholder card. It shows a THINKING-UI-STYLE gray animated line —
 * the exact ThinkingIndicator used by the reasoning UI (pulsing dot +
 * shimmering label) — reading "Creating a minigame…" / "Creating a card
 * grid…" / "Creating this UI…". The description is AI-GENERATED: derived from
 * the partial spec as it parses (an explicit label/title prop, or the node
 * type mapped to a friendly phrase — see lib/genui/creation-label.ts).
 *
 * When the spec finishes parsing (the close sentinel arrives), the creation
 * line transitions SEAMLESSLY into the rendered block: the line blurs + fades
 * out (absolutely positioned over the incoming block's top edge, so the exit
 * never shifts layout) while the block itself blur-in materializes
 * (.mb-blur-in). No shimmer card, no snap — one continuous motion.
 *
 * While the line streams, the lazy renderer chunks for the partial spec's
 * node types are preloaded so the completed block mounts without a
 * next/dynamic loading flash.
 *
 * Persisted messages (mounted with streaming=false) render the block
 * directly — the entrance replay is only for the live creation moment.
 */
export function GenUICreationGate({
  spec,
  streaming,
}: {
  /** Parsed (possibly partial) spec for this block. `undefined` while the
   *  JSON has not produced a node yet — the creation line still shows. */
  spec?: GenUISpec | null;
  /** True while the `<<<genui>>>` block is open (no close sentinel yet). */
  streaming?: boolean;
}) {
  const isStreaming = Boolean(streaming);
  // Read-once: did this gate ever stream? A persisted message mounts with
  // streaming=false and must NOT replay the creation-exit cross-fade.
  const [wasCreating] = React.useState(isStreaming);

  const phrase = React.useMemo(() => deriveCreationPhrase(spec), [spec]);

  // Warm the lazy renderer chunks while the creation line streams.
  // next/dynamic caches imports, so re-running this on every stream flush
  // is a free no-op.
  React.useEffect(() => {
    if (!isStreaming || !spec) return;
    const walk = (nodes: GenUINode[], depth: number) => {
      if (depth > 4) return;
      for (const n of nodes) {
        preloadRenderer(n.type);
        if (n.children && n.children.length > 0) walk(n.children, depth + 1);
      }
    };
    walk(spec.nodes, 0);
  }, [isStreaming, spec]);

  const showBlock = !isStreaming && !!spec && spec.nodes.length > 0;
  // The creation line stays mounted through the completion flip so the exit
  // animation plays (className swap on the SAME element: mb-fade-in →
  // mb-fade-out-blur overlay). It ends visibility:hidden and never returns.
  const showLine = isStreaming || (wasCreating && showBlock);

  if (!showBlock && !showLine) return null;

  return (
    <div className="relative">
      {showBlock ? (
        <div className="mb-blur-in">
          <GenUIBlock spec={spec!} streaming={false} />
        </div>
      ) : null}
      {showLine ? (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            isStreaming
              ? "mb-fade-in"
              : // Exit overlay: fades + blurs out over the incoming block,
                // out of the flow so the exit never shifts layout.
                "mb-fade-out-blur pointer-events-none absolute inset-x-0 top-0 z-10",
          )}
        >
          <ThinkingIndicator label={`Creating ${phrase}…`} />
        </div>
      ) : null}
    </div>
  );
}

export default GenUICreationGate;
