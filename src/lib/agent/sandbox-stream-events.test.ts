import { describe, expect, it } from "vitest";

import {
  mapSandboxStreamEvent,
  sandboxEventFeeder,
  type SandboxStreamEvent,
} from "@/lib/agent/sandbox-stream-events";
import {
  KILO_ANON_BASE_URL,
  KILO_ANON_DEFAULT_MODEL,
  KILO_ANON_FALLBACK_MODELS,
  kiloAnonProvider,
} from "@/lib/agent/kilo-anon";

const GEN = "run_abc123";

function ev(type: string, data?: Record<string, unknown>, i = 1): SandboxStreamEvent {
  return { i, type, ts: 1794750000000 + i, run_id: GEN, data: data ?? null };
}

describe("mapSandboxStreamEvent", () => {
  it("maps run.started to a round-1 model_request_start carrying the model", () => {
    expect(mapSandboxStreamEvent(GEN, ev("run.started", { model: "kilo-auto/free" }))).toEqual({
      type: "model_request_start",
      data: { round: 1, generation_id: GEN, model: "kilo-auto/free" },
    });
  });

  it("maps run.started without a model string (no model field)", () => {
    expect(mapSandboxStreamEvent(GEN, ev("run.started", { model: 42 }))).toEqual({
      type: "model_request_start",
      data: { round: 1, generation_id: GEN },
    });
  });

  it("maps round.started with the round number", () => {
    expect(mapSandboxStreamEvent(GEN, ev("round.started", { round: 4, total_rounds: 400 }, 7))).toEqual({
      type: "model_request_start",
      data: { round: 4, generation_id: GEN },
    });
  });

  it("falls back to round 1 on a malformed round number", () => {
    expect(mapSandboxStreamEvent(GEN, ev("round.started", { round: "oops" }))).toEqual({
      type: "model_request_start",
      data: { round: 1, generation_id: GEN },
    });
  });

  it("maps response.delta to text_delta with the runner's wall-clock ts", () => {
    expect(mapSandboxStreamEvent(GEN, ev("response.delta", { text: "hello " }, 12))).toEqual({
      type: "text_delta",
      data: { index: 0, content: "hello ", ts: 1794750000012 },
    });
  });

  it("drops an EMPTY response.delta (no phantom text events)", () => {
    expect(mapSandboxStreamEvent(GEN, ev("response.delta", { text: "" }))).toBeNull();
    expect(mapSandboxStreamEvent(GEN, ev("response.delta", {}))).toBeNull();
  });

  it("maps tool.started to tool_call with call_id / tool_name / args", () => {
    expect(
      mapSandboxStreamEvent(GEN, ev("tool.started", { call_id: "call_9", name: "run_terminal", args: { command: "ls" } })),
    ).toEqual({
      type: "tool_call",
      data: { tool_call_id: "call_9", tool_name: "run_terminal", args: { command: "ls" }, ts: 1794750000001 },
    });
  });

  it("maps tool.started with unparseable args to an empty args object", () => {
    expect(mapSandboxStreamEvent(GEN, ev("tool.started", { call_id: "c", name: "t" }))).toEqual({
      type: "tool_call",
      data: { tool_call_id: "c", tool_name: "t", args: {}, ts: 1794750000001 },
    });
  });

  it("maps tool.result to tool_result keyed by tool_call_id", () => {
    expect(mapSandboxStreamEvent(GEN, ev("tool.result", { call_id: "call_9", name: "run_terminal", ok: true, result: "out" }))).toEqual({
      type: "tool_result",
      data: { tool_call_id: "call_9", content: "out", ts: 1794750000001 },
    });
  });

  it("maps terminal markers to NULL — the landing stays history-authoritative", () => {
    // Streaming response.completed / run.failed would duplicate the final
    // content: the status poll's chat_history landing owns the final bubble.
    expect(mapSandboxStreamEvent(GEN, ev("response.completed", { content: "done", degraded: false }))).toBeNull();
    expect(mapSandboxStreamEvent(GEN, ev("run.failed", { error: "HTTP 500" }))).toBeNull();
    expect(mapSandboxStreamEvent(GEN, ev("something.else"))).toBeNull();
  });
});

describe("sandboxEventFeeder", () => {
  it("forwards every MAPPED event to the processor in order, drops the rest", () => {
    const handled: Array<{ type: string; data: unknown }> = [];
    const processor = {
      handle: (e: { type: string; data: unknown }) => {
        handled.push(e);
      },
    } as never;
    const feed = sandboxEventFeeder(processor, GEN);

    feed(ev("run.started", { model: "m" }, 1));
    feed(ev("response.delta", { text: "a" }, 2));
    feed(ev("response.delta", { text: "" }, 3)); // dropped
    feed(ev("tool.started", { call_id: "c1", name: "t", args: {} }, 4));
    feed(ev("response.completed", { content: "x" }, 5)); // dropped

    expect(handled.map((h) => h.type)).toEqual([
      "model_request_start",
      "text_delta",
      "tool_call",
    ]);
  });

  it("maps reasoning.delta to thinking_delta (thinking models stream live)", () => {
    expect(mapSandboxStreamEvent(GEN, ev("reasoning.delta", { text: "The user wants " }, 7))).toEqual({
      type: "thinking_delta",
      data: { index: 0, content: "The user wants ", ts: 1794750000007 },
    });
  });

  it("drops an EMPTY reasoning.delta", () => {
    expect(mapSandboxStreamEvent(GEN, ev("reasoning.delta", { text: "" }))).toBeNull();
  });
});

describe("kiloAnonProvider", () => {
  it("returns the verified anonymous gateway with a stable free-tier model + concrete fallbacks", () => {
    const kilo = kiloAnonProvider();
    expect(kilo.baseUrl).toBe(KILO_ANON_BASE_URL);
    expect(KILO_ANON_BASE_URL).toBe("https://ai-gateway.kilo.ai/api/v1");
    expect(kilo.apiKey).toBe(""); // anonymous — no Authorization header
    expect(kilo.model).toBe(KILO_ANON_DEFAULT_MODEL);
    expect(kilo.fallbackModels).toEqual(KILO_ANON_FALLBACK_MODELS);
    expect(kilo.fallbackModels.length).toBeGreaterThan(0);
    expect(kilo.anonymous).toBe(true);
  });

  it("uses distinct fallback ids (no degenerate retry loop)", () => {
    const ids = [KILO_ANON_DEFAULT_MODEL, ...KILO_ANON_FALLBACK_MODELS];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
