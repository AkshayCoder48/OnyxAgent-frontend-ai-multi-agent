"use client";

/**
 * EXECUTION-PROOF TELEMETRY (PRD §8 diagnostic panel).
 *
 * A tiny observable store fed from TWO real sources — never simulated:
 *
 *   · recordProofEvent(ev)  — every event the SSE bridge delivers from the
 *     sandbox runner (provider.request_started, provider.first_token,
 *     tool.dispatched, tool.result, deltas, …). Each row in the ring buffer
 *     is an OBSERVED runtime fact from inside E2B.
 *   · recordProofStatus(st) — each agent_status.json poll result (v7 proof
 *     fields: runner_pid, provider_stream, first/last token timestamps,
 *     last_event_id, the in-flight tool's idempotency key).
 *
 * The dev-mode ExecutionProofPanel renders these as the PRD §8 table. The
 * panel exists to answer ONE question with evidence: is the sandbox actually
 * executing (process alive, provider stream connected, tokens arriving,
 * tools dispatched) — as opposed to restored UI state.
 */
import { create } from "zustand";
import type { SandboxAgentStatus } from "@/lib/e2b/client";
import type { SandboxStreamEvent } from "@/lib/agent/sandbox-stream-events";

export interface ProofEventRow {
  i: number;
  type: string;
  ts: number;
  detail: string;
}

interface ProofState {
  runId: string | null;
  /** Last 60 observed stream events (the SSE bridge's actual deliveries). */
  events: ProofEventRow[];
  /** Latest agent_status.json snapshot (v7 proof fields included). */
  status: SandboxAgentStatus | null;
  /** Wall-clock of the last status poll recorded. */
  statusAt: number | null;
  recordEvent: (ev: SandboxStreamEvent) => void;
  recordStatus: (st: SandboxAgentStatus) => void;
  reset: (runId: string | null) => void;
}

const RING_LIMIT = 60;

/** Compact one observed event into a panel row — detail is a short,
 * non-sensitive summary (ids, names, counts; never keys or full payloads). */
function detailFor(ev: SandboxStreamEvent): string {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "provider.request_started":
      return `${String(d.model ?? "?")} · stream=${d.stream === true ? "on" : "off"} · tools=${d.tools === true}`;
    case "provider.stream_connected":
      return String(d.content_type ?? "");
    case "provider.first_token":
      return `kind=${String(d.kind ?? "?")}`;
    case "provider.response_received":
    case "provider.request_failed":
      return d.http_status != null ? `HTTP ${String(d.http_status)}` : "";
    case "provider.request_retry":
      return `attempt ${String(d.attempt ?? "?")} · HTTP ${String(d.http_status ?? "—")} · ${String(d.delay_s ?? "?")}s`;
    case "provider.model_fallback":
      return `${String(d.from ?? "?")} → ${String(d.to ?? "?")}`;
    case "provider.compatibility":
      return String(d.mode ?? "");
    case "provider.continuation_started":
      return `round ${String(d.round ?? "?")} · ${String(d.tool_results_in_context ?? "?")} tool results in context`;
    case "tool.dispatched":
      return `${String(d.name ?? "?")} · confirmed`;
    case "tool.started":
      return `${String(d.name ?? "?")} · ${String(d.tool_execution_id ?? "")}`;
    case "tool.result":
      return `${String(d.name ?? "?")} · ${String(d.duration_ms ?? "?")}ms · ${d.ok === true ? "ok" : "error"}`;
    case "round.started":
      return `round ${String(d.round ?? "?")}/${String(d.total_rounds ?? "?")}`;
    default:
      return "";
  }
}

export const useExecutionProofStore = create<ProofState>((set) => ({
  runId: null,
  events: [],
  status: null,
  statusAt: null,
  recordEvent: (ev) =>
    set((state) => {
      // A new run's log resets the ring (the runner truncates its event
      // file per run — keep the mirror consistent).
      const freshRun = state.runId !== null && ev.run_id != null && ev.run_id !== state.runId;
      const events = freshRun ? [] : [...state.events];
      events.push({
        i: ev.i,
        type: ev.type,
        ts: ev.ts,
        detail: detailFor(ev),
      });
      return {
        runId: ev.run_id ?? state.runId,
        events: events.slice(-RING_LIMIT),
      };
    }),
  recordStatus: (st) =>
    set((state) => ({
      status: st,
      statusAt: Date.now(),
      runId: st.run_id ?? state.runId,
    })),
  reset: (runId) => set({ runId, events: [], status: null, statusAt: null }),
}));

/** Imperative recorders for the non-React adoption paths (use-chat). */
export function recordProofEvent(ev: SandboxStreamEvent): void {
  useExecutionProofStore.getState().recordEvent(ev);
}

export function recordProofStatus(st: SandboxAgentStatus): void {
  useExecutionProofStore.getState().recordStatus(st);
}
