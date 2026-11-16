import type { AgentEventProcessor } from "@/lib/agent/event-processor";

/**
 * SANDBOX STREAM EVENTS — the typed bridge between the sandbox runner's
 * replay log (agent_events.jsonl, tailed by /api/sandbox?stream=1) and the
 * app's AgentEvent vocabulary.
 *
 * The headless runner appends one JSON object per line:
 *   { i: <1-based id>, type, ts, run_id, data } — `i` doubles as the SSE
 *   Last-Event-ID so reconnects (or a page refresh mid-run) replay exactly
 *   the missing tail.
 *
 * mapSandboxStreamEvent is PURE (trivially testable); sandboxEventFeeder is
 * the processor-bound closure use-chat uses for both the live send path and
 * the reattach-on-return path.
 */

/** One structured event from the runner's replay log. */
export interface SandboxStreamEvent {
  i: number;
  type: string;
  ts: number;
  run_id?: string;
  data?: Record<string, unknown> | null;
}

/** The processor event shapes the mapper emits (the same literals the
 *  foreground runtime emits — see event-processor.ts cases). */
export type MappedProcessorEvent =
  | {
      type: "model_request_start";
      data: {
        round: number;
        generation_id: string;
        model?: string;
      };
    }
  | { type: "text_delta"; data: { index: number; content: string; ts: number } }
  | {
      type: "thinking_delta";
      data: { index: number; content: string; ts: number };
    }
  | {
      type: "tool_call";
      data: {
        tool_call_id: string;
        tool_name: string;
        args: Record<string, unknown>;
        ts: number;
      };
    }
  | {
      type: "tool_result";
      data: { tool_call_id: string; content: string; ts: number };
    };

/** Map ONE sandbox stream event onto the processor vocabulary, or null when
 *  the event carries no processor counterpart (response.completed /
 *  run.failed terminal markers land via the status poll's authoritative
 *  chat_history landing instead — streaming them would risk duplicate
 *  content in the final bubble). */
export function mapSandboxStreamEvent(
  generationId: string,
  ev: SandboxStreamEvent,
): MappedProcessorEvent | null {
  switch (ev.type) {
    case "run.started": {
      const model = typeof ev.data?.model === "string" ? ev.data.model : undefined;
      return {
        type: "model_request_start",
        data: { round: 1, generation_id: generationId, ...(model ? { model } : {}) },
      };
    }
    case "round.started": {
      const round = Number(ev.data?.round ?? 1) || 1;
      return {
        type: "model_request_start",
        data: { round, generation_id: generationId },
      };
    }
    case "response.delta": {
      const text = typeof ev.data?.text === "string" ? ev.data.text : "";
      if (!text) return null;
      return {
        type: "text_delta",
        data: { index: 0, content: text, ts: ev.ts },
      };
    }
    case "reasoning.delta": {
      // The model's chain-of-thought (thinking models) — streamed live into
      // the processor's thinking panel. Was silently dropped before, which
      // is why the live view showed NOTHING while the model thought.
      const text = typeof ev.data?.text === "string" ? ev.data.text : "";
      if (!text) return null;
      return {
        type: "thinking_delta",
        data: { index: 0, content: text, ts: ev.ts },
      };
    }
    case "tool.started":
      return {
        type: "tool_call",
        data: {
          tool_call_id: String(ev.data?.call_id ?? ""),
          tool_name: String(ev.data?.name ?? ""),
          args: (ev.data?.args as Record<string, unknown> | null) ?? {},
          ts: ev.ts,
        },
      };
    case "tool.result":
      return {
        type: "tool_result",
        data: {
          tool_call_id: String(ev.data?.call_id ?? ""),
          content: typeof ev.data?.result === "string" ? ev.data.result : "",
          ts: ev.ts,
        },
      };
    default:
      return null;
  }
}

/** The processor-bound closure: every mapped event flows into the processor
 *  (which owns the streaming UI), unmapped events are dropped. */
export function sandboxEventFeeder(
  processor: AgentEventProcessor,
  generationId: string,
): (ev: SandboxStreamEvent) => void {
  return (ev) => {
    const mapped = mapSandboxStreamEvent(generationId, ev);
    if (mapped) {
      processor.handle(mapped as Parameters<AgentEventProcessor["handle"]>[0]);
    }
  };
}
