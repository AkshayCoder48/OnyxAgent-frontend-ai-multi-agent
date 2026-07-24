"use client";

import { registerTool } from "./registry";
import { db } from "@/lib/db";
import type { ChartSpec } from "@/types";

/**
 * create_chart_tool — produces a structured `ChartSpec` payload that the
 * frontend's `ChartMessage` component renders directly. Mirrors the original
 * Python `chart_tool.create_chart` Pydantic model.
 *
 * The chart spec is also persisted to the `chart_specs` Dexie table so it can
 * be re-hydrated when a conversation is reloaded (avoids re-parsing the
 * tool-call result string).
 */

const CHART_TYPES = ["line", "bar", "pie", "area", "scatter"] as const;

registerTool(
  "create_chart",
  "Create a chart (line / bar / pie / area / scatter) from structured data. The chart is rendered inline in the chat. Pass `data` as an array of objects, `x_key` as the field for the x-axis, and `series` as the list of value fields to plot. Optionally pass `style` for palette/grid/legend/labels/stacked.",
  {
    type: "object",
    properties: {
      chart_type: {
        type: "string",
        enum: CHART_TYPES as unknown as string[],
        description: "Chart type.",
      },
      title: { type: "string", description: "Chart title." },
      data: {
        type: "array",
        items: { type: "object" },
        description: "Array of data records.",
      },
      x_key: {
        type: "string",
        description: "Field name in each record to use as the x-axis.",
      },
      series: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            label: { type: "string" },
            color: { type: "string" },
          },
          required: ["key"],
        },
        description: "Value series to plot.",
      },
      style: {
        type: "object",
        properties: {
          palette: { type: "array", items: { type: "string" } },
          grid: { type: "boolean" },
          legend: { type: "boolean" },
          x_label: { type: "string" },
          y_label: { type: "string" },
          stacked: { type: "boolean" },
        },
      },
    },
    required: ["chart_type", "title", "data", "x_key", "series"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const spec: ChartSpec = {
      kind: "chart",
      chart_type: args.chart_type as ChartSpec["chart_type"],
      title: args.title as string,
      data: args.data as ChartSpec["data"],
      x_key: args.x_key as string,
      series: (args.series as ChartSpec["series"]) ?? [],
      style: (args.style as ChartSpec["style"]) ?? {},
    };
    // Persist for later re-hydration if we have a conversation id.
    if (ctx.conversationId) {
      try {
        const nanoid = (await import("nanoid")).nanoid;
        await db.chart_specs.add({
          id: nanoid(),
          user_id: ctx.userId,
          conversation_id: ctx.conversationId,
          message_id: "", // filled in by the runtime after the assistant message is saved.
          tool_call_id: "", // filled in by the runtime.
          spec,
          created_at: new Date().toISOString(),
        });
      } catch {
        // best-effort — chart still renders inline via the tool result.
      }
    }
    return spec;
  },
  false,
  "chart",
);
