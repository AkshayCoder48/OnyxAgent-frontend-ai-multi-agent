// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Heavy graph stubs — consumeRun only needs these symbols at runtime
// (persistCheckpoint → conversationService; the browser-tool bridge fires
// solely on browser_tool_call events, which these tests never send).
vi.mock("@/lib/services", () => ({
  conversationService: {
    saveAgentCheckpoint: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(),
    addMessage: vi.fn(),
  },
}));
vi.mock("@/lib/agent/browser-tool-bridge", () => ({
  collectBridgeableTools: vi.fn(() => []),
  handleBrowserToolCall: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/e2b/bg-native-tools", () => ({ BG_NATIVE_TOOL_NAMES: [] }));
vi.mock("@/stores", () => ({
  useResearchStore: { getState: () => ({ byTurn: {} }) },
}));
vi.mock("@/stores/chat-store", () => ({
  useChatStore: { getState: () => ({ messages: [] }) },
}));

import { consumeRun } from "./background-turn";
import type { BgJob } from "@/lib/e2b/background-agent";
import type { WSEvent } from "@/types";
import { getActiveJob } from "@/lib/e2b/background-agent";
import { conversationService } from "@/lib/services";

// ============================================================================
// PRD §23 — the reconnect loop itself. Stream loss must NEVER emit a fatal
// "error" event or clear the persisted job; it reconnects with backoff and
// finishes honestly only when the RUN (not the transport) is terminal.
// ============================================================================

const JOBS_KEY = "onyx-bg-jobs";

function seedJob(): BgJob {
  const job: BgJob = {
    sandboxId: "sbx1",
    runId: "run_1",
    conversationId: "conv_1",
    assistantMessageId: "bgmsg_1",
    startedAt: Date.now(),
  };
  window.localStorage.setItem(JOBS_KEY, JSON.stringify({ bgmsg_1: job }));
  return job;
}

interface RoutedFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** fetch stub routing /api/sandbox calls by their `action`. */
function stubFetch(routes: {
  bgWait: () => Response;
  bgStatus: () => Response;
}): { calls: { action: string; args: Record<string, unknown> }[] } {
  const calls: { action: string; args: Record<string, unknown> }[] = [];
  const impl: RoutedFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      action?: string;
      args?: Record<string, unknown>;
    };
    calls.push({ action: body.action ?? "", args: body.args ?? {} });
    if (body.action === "bg_wait") return routes.bgWait();
    if (body.action === "bg_status") return routes.bgStatus();
    return new Response(JSON.stringify({ error: `unexpected action ${body.action}` }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };
  vi.stubGlobal("fetch", vi.fn(impl));
  return { calls };
}

function unreachableJson(msg: string): Response {
  return new Response(
    JSON.stringify({
      sandboxId: "sbx1",
      status: "unreachable",
      error: msg,
      events: [],
      done: false,
      afterSeq: 0,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function bgStatusRunning(): Response {
  return new Response(
    JSON.stringify({
      sandboxId: "sbx1",
      status: "running",
      events: [],
      content: "",
      error: null,
      startedAt: null,
      done: false,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("consumeRun reconnect loop (PRD §23: stream loss ≠ job failure)", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
    vi.clearAllMocks();
  });

  /** Drive the (fake-timer) loop until `isDone` or a step budget runs out. */
  async function drive(isDone: () => boolean, steps = 60): Promise<void> {
    for (let i = 0; i < steps && !isDone(); i++) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
  }

  it("treats a silently-killed segment (clean close, ZERO frames) as transport failure with backoff — never a busy loop, never a fatal error", async () => {
    const job = seedJob();
    let bgWaitCalls = 0;
    stubFetch({
      bgWait: () => {
        bgWaitCalls++;
        // 200 + SSE content-type but an EMPTY body: the generator ends
        // cleanly with zero frames (proxy killed the connection silently).
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      },
      bgStatus: () => bgStatusRunning(),
    });

    const events: WSEvent[] = [];
    let stopped = false;
    let finished = false;
    const run = consumeRun({
      e2bApiKey: "key",
      job,
      conversationId: "conv_1",
      userId: "user_1",
      emit: (type, data) => events.push({ type, data: { ...data } }),
      onFinished: () => {
        finished = true;
      },
      isStopped: () => stopped,
    });

    // ~5s of fake time: with backoff 1s→2s→4s only ~3 attempts may fire.
    await drive(() => stopped, 5);
    expect(bgWaitCalls).toBeGreaterThanOrEqual(2); // it did retry…
    expect(bgWaitCalls).toBeLessThanOrEqual(4); // …with backoff, not hammering
    expect(events.map((e) => e.type)).not.toContain("error");
    expect(finished).toBe(false); // the consumer is still reconnecting
    expect(getActiveJob("conv_1")).not.toBeNull(); // job NEVER cleared on transport loss

    // Stop cleanly exits the loop.
    stopped = true;
    await drive(() => finished, 3);
    await run;
    expect(finished).toBe(false); // isStopped exit does not call onFinished
    expect(getActiveJob("conv_1")).not.toBeNull(); // still resumable after reload
  });

  it("rides out an unreachable storm with backoff, then replays + finishes — NO fatal error, job cleared only at the end", async () => {
    const job = seedJob();
    let bgWaitCalls = 0;
    const { calls } = stubFetch({
      bgWait: () => {
        bgWaitCalls++;
        if (bgWaitCalls <= 3) {
          // Sandbox unreachable for the first 3 segments (paused sandbox /
          // serverless cold start) — the exact old "no stream frames" storm.
          return unreachableJson("Background sandbox unreachable: paused");
        }
        // Recovery: one batch with content + the terminal done frame.
        const body =
          `data: ${JSON.stringify({
            sandboxId: "sbx1",
            status: "running",
            events: [{ t: "text_delta", content: "Hello", seq: 1, round: 1, ts: 1 }],
            afterSeq: 1,
          })}\n\n` +
          `data: ${JSON.stringify({
            sandboxId: "sbx1",
            status: "done",
            events: [{ t: "done", content: "Hello", seq: 2, ts: 2 }],
            done: true,
            afterSeq: 2,
          })}\n\n`;
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      },
      bgStatus: () => bgStatusRunning(),
    });

    const events: WSEvent[] = [];
    let finished = false;
    const run = consumeRun({
      e2bApiKey: "key",
      job,
      conversationId: "conv_1",
      userId: "user_1",
      emit: (type, data) => events.push({ type, data: { ...data } }),
      onFinished: () => {
        finished = true;
      },
      isStopped: () => false,
      store: {
        getState: () => ({
          // The execution store holds the assistant message (the hub always
          // does) so persistCheckpoint actually reaches the service.
          messages: [
            { id: "bgmsg_1", role: "assistant", content: "", parts: [], toolCalls: [] },
          ],
          setRateLimitStatus: vi.fn(),
        }),
      } as unknown as Parameters<typeof consumeRun>[0]["store"],
    });

    await drive(() => finished);
    await run;

    const types = events.map((e) => e.type);
    // The crux: transport loss NEVER produced the old fatal error.
    expect(types).not.toContain("error");
    expect(types).toContain("text_delta");
    expect(types).toContain("final_result");
    expect(types).toContain("complete");
    expect(finished).toBe(true);
    // The job record survived the outage and was cleared exactly at finish.
    expect(bgWaitCalls).toBe(4);
    expect(calls.filter((c) => c.action === "bg_status").length).toBeGreaterThan(0);
    expect(window.localStorage.getItem(JOBS_KEY)).toBe("{}");
    expect(getActiveJob("conv_1")).toBeNull();
    // Final checkpoint isStreaming=false.
    expect(conversationService.saveAgentCheckpoint).toHaveBeenCalledWith(
      "conv_1",
      "user_1",
      "bgmsg_1",
      expect.objectContaining({ isStreaming: false }),
    );
  });

  it("surfaces an honest error ONLY when the run itself reports terminal failure (bg_status fallback)", async () => {
    const job = seedJob();
    stubFetch({
      bgWait: () => unreachableJson("Background sandbox unreachable: paused"),
      bgStatus: () =>
        new Response(
          JSON.stringify({
            sandboxId: "sbx1",
            status: "error",
            events: [],
            content: "",
            error: "model exploded",
            startedAt: null,
            done: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const events: WSEvent[] = [];
    let finished = false;
    await consumeRun({
      e2bApiKey: "key",
      job,
      conversationId: "conv_1",
      userId: "user_1",
      emit: (type, data) => events.push({ type, data: { ...data } }),
      onFinished: () => {
        finished = true;
      },
      isStopped: () => false,
    });

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);
    expect((errorEvents[0]!.data as { message: string }).message).toContain("model exploded");
    expect(events.some((e) => e.type === "complete")).toBe(true);
    expect(finished).toBe(true);
    expect(getActiveJob("conv_1")).toBeNull();
  });

  it("drains missed events through the bg_status fallback while the SSE path is down (no duplicates on the next drain)", async () => {
    const job = seedJob();
    let bgWaitCalls = 0;
    let bgStatusCalls = 0;
    stubFetch({
      bgWait: () => {
        bgWaitCalls++;
        return unreachableJson("Background sandbox unreachable: paused");
      },
      bgStatus: () => {
        bgStatusCalls++;
        // First probe: one missed event lands through the fallback; the run
        // keeps running. Second probe: the terminal event (seq 3) lands.
        const events =
          bgStatusCalls === 1
            ? [{ t: "text_delta", content: "world", seq: 2, round: 1, ts: 2 }]
            : [
                { t: "text_delta", content: "!", seq: 3, round: 1, ts: 3 },
                { t: "done", content: "Hello world!", seq: 4, ts: 4 },
              ];
        return new Response(
          JSON.stringify({
            sandboxId: "sbx1",
            status: bgStatusCalls === 1 ? "running" : "done",
            events,
            content: "",
            error: null,
            startedAt: null,
            done: bgStatusCalls !== 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const events: WSEvent[] = [];
    let finished = false;
    const run = consumeRun({
      e2bApiKey: "key",
      job,
      conversationId: "conv_1",
      userId: "user_1",
      emit: (type, data) => events.push({ type, data: { ...data } }),
      onFinished: () => {
        finished = true;
      },
      isStopped: () => false,
    });
    await drive(() => finished);
    await run;

    const types = events.map((e) => e.type);
    expect(types).not.toContain("error");
    // Both fallback batches replayed exactly once.
    const textDeltas = events.filter((e) => e.type === "text_delta") as Array<{
      type: string;
      data: unknown;
    }>;
    const contents = textDeltas.map((e) => (e.data as { content: string }).content);
    expect(contents).toEqual(["world", "!"]);
    expect(types).toContain("final_result");
    expect(types).toContain("complete");
    expect(finished).toBe(true);
    expect(getActiveJob("conv_1")).toBeNull();
    expect(bgWaitCalls).toBeGreaterThanOrEqual(2); // kept retrying SSE meanwhile
  });

  it("resumes from the persisted lastSeq cursor (replay starts AFTER the checkpoint)", async () => {
    const job = seedJob();
    job.lastSeq = 5; // events 1-5 are already checkpointed
    const waitArgs: Array<{ afterSeq?: number }> = [];
    stubFetch({
      bgWait: () => {
        const body = JSON.parse(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]?.body ?? "{}")) as { args?: { afterSeq?: number } };
        waitArgs.push({ afterSeq: body.args?.afterSeq });
        return new Response(
          `data: ${JSON.stringify({
            sandboxId: "sbx1",
            status: "done",
            events: [{ t: "done", content: "done", seq: 6, ts: 6 }],
            done: true,
            afterSeq: 6,
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } },
        );
      },
      bgStatus: () => bgStatusRunning(),
    });

    let finished = false;
    await consumeRun({
      e2bApiKey: "key",
      job,
      conversationId: "conv_1",
      userId: "user_1",
      emit: () => {},
      onFinished: () => {
        finished = true;
      },
      isStopped: () => false,
    });

    expect(finished).toBe(true);
    expect(waitArgs.length).toBeGreaterThan(0);
    expect(waitArgs[0]!.afterSeq).toBe(5); // bg_wait resumed strictly after the checkpoint
  });
});
