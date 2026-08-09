"use client";

import dynamic from "next/dynamic";

import type { ChartSpec } from "@/types";

/** Parse a `create_chart` tool result into a ChartSpec, or null if it isn't one.
 *
 * The tool result may be:
 *   - A JSON string: '{"success":true,"output":{"kind":"chart",...}}'
 *   - An object: { success: true, output: { kind: "chart", ... } }
 *   - A bare spec: { kind: "chart", ... }
 *
 * We handle all three by checking `.output.kind` first, then `.kind`.
 */
export function parseChartResult(result: unknown): ChartSpec | null {
  let payload: unknown = result;
  if (typeof result === "string") {
    try {
      payload = JSON.parse(result);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as { kind?: unknown; output?: { kind?: unknown } };
  // Case 1: full ToolResult wrapper { success, output: { kind: "chart", ... } }
  if (obj.output && typeof obj.output === "object" && obj.output.kind === "chart") {
    return obj.output as unknown as ChartSpec;
  }
  // Case 2: bare spec { kind: "chart", ... }
  if (obj.kind === "chart") {
    return payload as ChartSpec;
  }
  return null;
}

/**
 * Recharts is a large dependency. It's only needed when an assistant message
 * actually contains a `create_chart` tool result, so the chart renderer lives in
 * `chart-message.impl.tsx` and is loaded on demand via `next/dynamic`. This keeps
 * recharts out of the initial chat bundle. `parseChartResult` stays a static,
 * synchronous export so callers can decide whether to render a chart without
 * pulling in recharts.
 *
 * `ssr: false` because Recharts' ResponsiveContainer measures the DOM. The
 * placeholder matches the chart card's height to avoid layout shift.
 */
export const ChartMessage = dynamic(
  () => import("./chart-message.impl").then((m) => m.ChartMessage),
  {
    ssr: false,
    loading: () => (
      <div className="bg-card overflow-hidden rounded-xl border p-3 sm:p-4">
        <div className="bg-foreground/10 mb-3 h-4 w-32 animate-pulse rounded" />
        <div className="bg-foreground/5 h-[300px] w-full animate-pulse rounded-md" />
      </div>
    ),
  },
);
