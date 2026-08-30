"use client";

/**
 * GenUIBlock — root renderer for a GenUI spec.
 *
 * Takes a `GenUISpec` and renders the tree of nodes. For each node:
 *   1. Looks up the renderer by `type` in the registry.
 *   2. If `meta.streaming` is true, the renderer shows a shimmer placeholder
 *      until enough props have arrived to render meaningfully.
 *   3. Passes `children` + a `renderChildren` callback so container types
 *      (card_grid, columns, tabs, etc.) can recursively render their children.
 *
 * Unknown types fall back to `UnknownFallback` (the registry handles this).
 *
 * Never throws — if a renderer crashes, React's error boundary in
 * `GenUIBlockErrorBoundary` catches it and shows the raw JSON.
 */

import * as React from "react";
import type { GenUINode, GenUISpec } from "@/lib/genui/types";
import { getRenderer } from "./registry";
import type { GenUIComponentProps } from "./helpers";

export interface GenUIBlockProps {
  spec: GenUISpec;
  /** Override the streaming flag for all nodes (used during live streaming). */
  streaming?: boolean;
}

export function GenUIBlock({ spec, streaming }: GenUIBlockProps) {
  if (!spec || !Array.isArray(spec.nodes) || spec.nodes.length === 0) {
    return null;
  }
  return (
    <div className="space-y-3">
      {spec.nodes.map((node) => (
        <GenUINodeRenderer
          key={node.id}
          node={node}
          forceStreaming={streaming}
        />
      ))}
    </div>
  );
}

/**
 * Render a single node + its subtree. Recursively renders children via the
 * `renderChildren` callback passed to each renderer.
 */
const GenUINodeRenderer = React.memo(function GenUINodeRenderer({
  node,
  forceStreaming,
}: {
  node: GenUINode;
  forceStreaming?: boolean;
}) {
  const isStreaming = forceStreaming ?? Boolean(node.meta?.streaming);

  const renderChildren = React.useCallback(
    (children: GenUINode[]) => (
      <>
        {children.map((child) => (
          <GenUINodeRenderer
            key={child.id}
            node={child}
            forceStreaming={isStreaming}
          />
        ))}
      </>
    ),
    [isStreaming],
  );

  const componentProps: GenUIComponentProps = {
    props: node.props ?? {},
    children: node.children,
    streaming: isStreaming,
    renderChildren,
  };

  // Look up the renderer and render it via createElement — assigning the
  // component to a Capitalized local (`const Renderer = getRenderer(...)`)
  // is flagged by the React Compiler lint as "creating a component during
  // render". getRenderer returns a stable, module-registered component, and
  // createElement references it directly without a local binding.
  const renderer = getRenderer(node.type);

  return (
    <GenUIBlockErrorBoundary node={node}>
      {React.createElement(renderer, componentProps)}
    </GenUIBlockErrorBoundary>
  );
});

/**
 * Error boundary — if a renderer throws (e.g. on malformed props we didn't
 * anticipate), fall back to showing the raw JSON in a `<pre>` so the chat
 * doesn't crash and the user/AI can see what went wrong.
 */
class GenUIBlockErrorBoundary extends React.Component<
  { node: GenUINode; children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.warn("[GenUI] renderer crashed:", error, this.props.node);
  }

  render() {
    if (this.state.error) {
      const raw = JSON.stringify(this.props.node, null, 2);
      return (
        <div className="bg-muted/40 border-destructive/30 rounded-xl border p-3">
          <div className="text-destructive mb-2 text-xs font-semibold">
            Failed to render {this.props.node.type}: {this.state.error.message}
          </div>
          <pre className="scrollbar-thin bg-muted/60 text-foreground/70 max-h-48 overflow-auto rounded-lg p-2 font-mono text-[11px]">
            {raw}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export default GenUIBlock;
