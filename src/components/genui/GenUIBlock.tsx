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
 *
 * STREAMING STABILITY (PRD §5/§7/§14 — GenUI flicker fix): the streaming
 * pipeline re-parses the partial JSON on every ~30ms flush, producing NEW
 * node object identities each time. Default React.memo (shallow) would
 * re-render every node on every flush; worse, unstable keys would REMOUNT
 * them. Keys are now stable (position-path ids — see validate.ts), and
 * `GenUINodeRenderer` uses a VALUE-based comparator (`nodesEqual`) so a
 * node whose content didn't change re-renders nothing — only the node
 * actively receiving tokens updates.
 */

import * as React from "react";
import type { GenUINode, GenUISpec } from "@/lib/genui/types";
import { getRenderer } from "./registry";
import type { GenUIComponentProps } from "./helpers";
import { genuiPerfLog } from "@/lib/genui/perf";

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
      {spec.nodes.map((node, i) => (
        <GenUINodeRenderer
          key={node.id}
          node={node}
          forceStreaming={streaming}
          index={i}
        />
      ))}
    </div>
  );
}

/**
 * Value-based node equality — two re-parsed nodes are equal when their
 * type, props and full child subtree match. Props are small flat objects,
 * so a JSON compare is cheap relative to a React render pass; comparing
 * recursively avoids re-rendering SETTLED subtrees while the sibling node
 * that is actively streaming keeps updating.
 */
function nodesEqual(a: GenUINode, b: GenUINode): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.type !== b.type) return false;
  const pa = JSON.stringify(a.props ?? null);
  const pb = JSON.stringify(b.props ?? null);
  if (pa !== pb) return false;
  const ca = a.children ?? [];
  const cb = b.children ?? [];
  if (ca.length !== cb.length) return false;
  for (let i = 0; i < ca.length; i++) {
    if (!nodesEqual(ca[i]!, cb[i]!)) return false;
  }
  return true;
}

/**
 * Render a single node + its subtree. Recursively renders children via the
 * `renderChildren` callback passed to each renderer.
 */
const GenUINodeRenderer = React.memo(
  function GenUINodeRenderer({
    node,
    forceStreaming,
  }: {
    node: GenUINode;
    forceStreaming?: boolean;
    /** Position among siblings — reserved for instrumentation. */
    index?: number;
  }) {
    const isStreaming = forceStreaming ?? Boolean(node.meta?.streaming);

    // Dev instrumentation (PRD §16): a node MOUNTING during streaming means
    // the key-stability fix regressed (nodes should reconcile in place, not
    // remount). Gated by the dev-only perf flag — no-op in production.
    React.useEffect(() => {
      genuiPerfLog("GenUI", "node mount", {
        type: node.type,
        id: node.id,
        t: Math.round(performance.now()),
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
  },
  (prev, next) =>
    prev.forceStreaming === next.forceStreaming &&
    (prev.node === next.node || nodesEqual(prev.node, next.node)),
);

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
