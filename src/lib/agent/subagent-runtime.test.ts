// @vitest-environment jsdom
/**
 * Sub-Agent Chat PRD regressions — streaming + reconciliation:
 *
 * PRD §1 (disappearing text): consecutive delta.content events must APPEND.
 * The runtime used to reset its accumulator every streaming round and
 * REPLACE the message content — after a tool round, all pre-tool text
 * vanished. Now `fullTurnText` lives across rounds and every store write
 * carries the full turn.
 *
 * PRD §3 (missing thinking): reasoning deltas were accumulated for the API
 * replay but NEVER written to the message — the sub-agent chat had no
 * thinking UI at all. Now they stream into `reasoning` + settle via
 * `isReasoningStreaming`.
 *
 * §Background network error: fetch()-level transient failures (TypeError:
 * network error) used to kill the whole background turn on the first blip;
 * now they retry with bounded backoff.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/services", () => ({
  settingsService: {
    getDecryptedSandboxKey: async () => null,
    getDecryptedEnvVars: async () => ({}),
    get: async () => null,
  },
  aiProviderService: {
    getDecryptedApiKey: vi.fn(async () => "test-key"),
  },
}));
vi.mock("@/lib/agent/provider-resolution", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/agent/provider-resolution")>();
  return {
    ...orig,
    listUsableProviders: vi.fn(async () => [
      {
        id: "prov1",
        name: "Test Gateway",
        base_url: "https://api.test/v1",
        is_active: true,
        models: ["test-model"],
        tools_enabled: true,
      },
    ]),
  };
});
vi.mock("@/stores", () => ({
  useAuthStore: { getState: () => ({ user: { id: "user_test" } }) },
  useChatStore: {
    getState: () => ({ selectedProviderId: null, selectedModel: null }),
  },
}));

import { useSubagentStore, type SubagentMessage } from "@/stores/subagent-store";

/** SSE chunks → message bodies. */
function sse(...objs: unknown[]): string {
  return objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join("");
}
function textDelta(t: string) {
  return { choices: [{ delta: { content: t }, index: 0 }] };
}
function reasoningDelta(t: string) {
  return { choices: [{ delta: { reasoning_content: t }, index: 0 }] };
}
function toolCallDelta(name: string, args: string) {
  return {
    choices: [
      {
        delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: args } }] },
        index: 0,
      },
    ],
  };
}
const finishChunk = { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }], usage: {} };

/** Build a streaming Response with the given SSE payload. */
function sseResponse(payload: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** The provider config the runtime should resolve. */
function fakeProviders() {
  return [
    {
      id: "prov1",
      name: "Test Gateway",
      base_url: "https://api.test/v1",
      is_active: true,
      models: ["test-model"],
      tools_enabled: true,
    },
  ];
}

import { executeSubagentTurn } from "@/lib/agent/subagent-runtime";

let fetchMock: ReturnType<typeof vi.fn>;

/** Seed one subagent config + return its id (delivery requires it). */
function seedSubagent(name = "Worker"): string {
  const store = useSubagentStore.getState();
  const existing = store.subagents.find((s) => s.name === name);
  if (existing) return existing.id;
  return useSubagentStore.getState().createSubagent({ name, description: "test agent" }).id;
}

beforeEach(async () => {
  window.localStorage.clear();
  useSubagentStore.setState({ subagents: [], sessions: [], activeSessionId: null });

  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("PRD §1 — consecutive delta.content events APPEND (never replace)", () => {
  it("text streamed across TWO ROUNDS (tool round between) is fully preserved", async () => {
    // Round 1: "Hello " → tool call → round 2: "World done".
    fetchMock
      .mockResolvedValueOnce(
        sseResponse(
          sse(textDelta("Hello "), textDelta("world"), toolCallDelta("list_files", "{}"), finishChunk),
        ),
      )
      .mockResolvedValueOnce(
        sseResponse(sse(textDelta("All "), textDelta("done!"), { choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage: {} })),
      );

    const reply = await executeSubagentTurn(seedSubagent("R1"), "run the demo", undefined, undefined).catch((e) => String(e));
    // The tool round's reply continues to round 2; the final message must
    // contain BOTH rounds' text — the pre-tool text must NOT vanish.
    const sessions = useSubagentStore.getState().sessions;
    const finalMsg = sessions[0]?.messages.find(
      (m) => m.role === "assistant" && !m.isStreaming,
    ) as SubagentMessage | undefined;
    // The tool call executes against the real registry (list_files needs a
    // sandbox) — it errors, which is fine: the turn still proceeds to
    // round 2. What matters is the accumulated text.
    expect(finalMsg?.content).toContain("Hello world");
    expect(finalMsg?.content).toContain("All done!");
    void reply;
  });

  it("many consecutive plain-text deltas accumulate exactly once, in order", async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse(
        sse(
          textDelta("The "),
          textDelta("quick "),
          textDelta("brown "),
          textDelta("fox"),
          { choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage: {} },
        ),
      ),
    );
    await executeSubagentTurn(seedSubagent("R2"), "say the phrase", undefined, undefined).catch(() => {});
    const finalMsg = useSubagentStore.getState().sessions[0]?.messages.find(
      (m) => m.role === "assistant" && !m.isStreaming,
    );
    expect(finalMsg?.content).toBe("The quick brown fox");
  });
});

describe("PRD §3 — reasoning streams into the message and settles", () => {
  it("reasoning deltas are visible while streaming and preserved after text arrives", async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse(
        sse(
          reasoningDelta("Step one. "),
          reasoningDelta("Step two. "),
          textDelta("Final answer."),
          { choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage: {} },
        ),
      ),
    );
    await executeSubagentTurn(seedSubagent("R3"), "think then answer", undefined, undefined).catch(() => {});
    const finalMsg = useSubagentStore.getState().sessions[0]?.messages.find(
      (m) => m.role === "assistant" && !m.isStreaming,
    ) as (SubagentMessage & { reasoning?: string }) | undefined;
    // Reasoning present, NOT merged into the text, and settled.
    expect(finalMsg?.reasoning).toContain("Step one.");
    expect(finalMsg?.reasoning).toContain("Step two.");
    expect(finalMsg?.isReasoningStreaming).toBeFalsy();
    expect(finalMsg?.content).toBe("Final answer.");
  });
});

describe("background network error — transient fetch failure retries", () => {
  it("a TypeError: network error blip retries and still completes the turn", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        sseResponse(
          sse(textDelta("Recovered."), {
            choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
            usage: {},
          }),
        ),
      );
    const reply = await executeSubagentTurn(seedSubagent("R4"), "survive the blip", undefined, undefined).catch((e) => String(e));
    expect(reply).toContain("Recovered.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("persistent network failures surface the honest error after bounded retries", async () => {
    // Fake timers so the ~30s of real backoff runs instantly.
    vi.useFakeTimers();
    try {
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
      const turnP = executeSubagentTurn(seedSubagent("R5"), "doomed", undefined, undefined).catch((e) => String(e));
      // Drive the backoff sleeps to completion.
      const reply = await Promise.race([
        turnP,
        (async () => {
          for (let i = 0; i < 40; i++) {
            await vi.advanceTimersByTimeAsync(20_000);
          }
          return await turnP;
        })(),
      ]);
      expect(reply).toMatch(/failed to fetch/i);
      // 5 retries + 1 initial = bounded, not infinite.
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6);
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);
});

describe("store — streaming persistence throttle", () => {
  it("mid-stream updates do not write localStorage on EVERY delta", async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    setItemSpy.mockClear();
    const store = useSubagentStore.getState();
    const session = store.createSession("agent1", "t");
    store.addMessage(session.id, { id: "m1", role: "assistant", content: "", timestamp: new Date().toISOString(), isStreaming: true });
    // Simulate 50 rapid deltas within the throttle window.
    for (let i = 0; i < 50; i++) {
      useSubagentStore.getState().updateMessage(session.id, "m1", {
        content: `x${i}`,
        isStreaming: true,
      });
    }
    const writesDuringStream = setItemSpy.mock.calls.length;
    // Settle — always persists.
    useSubagentStore.getState().updateMessage(session.id, "m1", { content: "done", isStreaming: false });
    expect(writesDuringStream).toBeLessThan(50);
    expect(setItemSpy.mock.calls.length).toBeGreaterThan(writesDuringStream);
    setItemSpy.mockRestore();
  });
});
