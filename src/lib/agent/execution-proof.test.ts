// @vitest-environment jsdom
/**
 * EXECUTION-PROOF STORE (PRD §8) — the diagnostics panel's data source.
 * Every recorded row must be an OBSERVED fact (an event the bridge
 * delivered / a status poll result); the store must never fabricate state,
 * and a new run's events must reset the mirror (the runner truncates its
 * event log per run).
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  recordProofEvent,
  recordProofStatus,
  useExecutionProofStore,
} from "./execution-proof";
import type { SandboxStreamEvent } from "./sandbox-stream-events";

function ev(i: number, type: string, run_id: string, data?: Record<string, unknown>): SandboxStreamEvent {
  return { i, type, ts: 1_700_000_000_000 + i, run_id, data: data ?? null };
}

beforeEach(() => {
  useExecutionProofStore.getState().reset(null);
});

describe("execution-proof store", () => {
  it("records observed events in order with compact, non-sensitive details", () => {
    recordProofEvent(ev(1, "run.started", "run_a", { model: "kilo-auto/free" }));
    recordProofEvent(ev(2, "provider.request_started", "run_a", {
      request_id: "req_ab12cd34", model: "kilo-auto/free", stream: true, tools: true,
    }));
    recordProofEvent(ev(3, "provider.first_token", "run_a", { request_id: "req_ab12cd34", kind: "reasoning" }));
    recordProofEvent(ev(4, "tool.dispatched", "run_a", {
      tool_execution_id: "texec_call-1", call_id: "call-1", name: "run_terminal", dispatch_confirmed: true,
    }));
    const s = useExecutionProofStore.getState();
    expect(s.events.map((e) => e.type)).toEqual([
      "run.started", "provider.request_started", "provider.first_token", "tool.dispatched",
    ]);
    expect(s.events[1]?.detail).toContain("kilo-auto/free");
    expect(s.events[3]?.detail).toContain("confirmed");
    expect(s.runId).toBe("run_a");
  });

  it("a NEW run's events reset the ring (the runner truncates its log per run)", () => {
    recordProofEvent(ev(1, "run.started", "run_a"));
    recordProofEvent(ev(2, "response.delta", "run_a", { text: "x" }));
    recordProofEvent(ev(1, "run.started", "run_b"));
    const s = useExecutionProofStore.getState();
    expect(s.events).toHaveLength(1);
    expect(s.events[0]?.type).toBe("run.started");
    expect(s.runId).toBe("run_b");
  });

  it("keeps only the last 60 events (ring buffer)", () => {
    for (let i = 1; i <= 80; i++) recordProofEvent(ev(i, "response.delta", "run_a", { text: "t" }));
    const s = useExecutionProofStore.getState();
    expect(s.events).toHaveLength(60);
    expect(s.events[0]?.i).toBe(21);
    expect(s.events[59]?.i).toBe(80);
  });

  it("records status polls with the v7 proof fields", () => {
    recordProofStatus({
      status: "running",
      stage: "tool",
      round: 2,
      run_id: "run_a",
      last_update: Date.now(),
      runner_pid: 4242,
      last_event_id: 9,
      provider_request_id: "req_ab12cd34",
      provider_stream: "streaming",
      first_token_at: Date.now() - 4000,
      last_token_at: Date.now() - 250,
      current_tool_execution_id: "texec_call-1",
    });
    const s = useExecutionProofStore.getState();
    expect(s.status?.runner_pid).toBe(4242);
    expect(s.status?.provider_stream).toBe("streaming");
    expect(s.status?.current_tool_execution_id).toBe("texec_call-1");
    expect(s.statusAt).toBeGreaterThan(0);
  });

  it("unknown event types record without throwing (forward compatibility)", () => {
    expect(() => recordProofEvent(ev(5, "provider.something.new", "run_a"))).not.toThrow();
    const s = useExecutionProofStore.getState();
    expect(s.events[0]?.type).toBe("provider.something.new");
    expect(s.events[0]?.detail).toBe("");
  });
});
