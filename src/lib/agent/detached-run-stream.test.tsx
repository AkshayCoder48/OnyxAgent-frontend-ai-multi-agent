// @vitest-environment jsdom
/**
 * openAgentEventStream — bridge-failure recovery semantics (the "auto-stop
 * after refresh" hardening):
 *   · an EventSource error (HTTP-level bridge failure closes it permanently
 *     in the browser) reopens with backoff, resuming AFTER the last
 *     delivered event id — never freezing the live view silently;
 *   · delivered events reset the reopen budget;
 *   · a terminal `done` (no noSandbox) never reopens — the connection close
 *     that follows it is not an error to recover from;
 *   · the closer stops every reopen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAgentEventStream } from "./detached-run";

vi.mock("@/lib/e2b/env-key", () => ({
  getEffectiveE2BKey: async () => "test_key",
}));

type Listener = (e: { data?: string }) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onerror: (() => void) | null = null;
  closed = false;
  listeners = new Map<string, Listener[]>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data: data === undefined ? undefined : JSON.stringify(data) });
    }
  }
  fireError() {
    this.onerror?.();
  }
}

const INPUT = {
  userId: "user_1",
  conversationId: "conv_1",
  sandboxId: "sbx_1",
  isCancelled: () => false,
} as Parameters<typeof openAgentEventStream>[0];

async function openStream() {
  const events: Array<{ i?: number; type?: string }> = [];
  const close = openAgentEventStream(INPUT, "run_1", (ev) => events.push(ev));
  // Real timers while the dynamic import + key resolution settle.
  await vi.waitFor(() => {
    if (FakeEventSource.instances.length === 0) throw new Error("stream not open yet");
  });
  vi.useFakeTimers();
  return { close, events };
}

beforeEach(() => {
  vi.resetModules();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("openAgentEventStream — bridge failure recovery", () => {
  it("reopens after an error, resuming AFTER the last delivered event id", async () => {
    const { events } = await openStream();
    const first = FakeEventSource.instances[0]!;
    first.emit("agent", { i: 7, type: "response.delta", data: { text: "hi" } });
    expect(events.map((e) => e.i)).toEqual([7]);

    first.fireError(); // HTTP-level bridge failure — browser closed the ES
    await vi.advanceTimersByTimeAsync(6_000); // past the first backoff (4s + 2s)
    expect(FakeEventSource.instances.length).toBe(2);
    const second = FakeEventSource.instances[1]!;
    expect(second.url).toContain("after=7");
    expect(second.closed).toBe(false);
  });

  it("delivered events reset the reopen budget — a flaky bridge recovers repeatedly", async () => {
    const { events } = await openStream();
    for (let round = 0; round < 5; round++) {
      const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
      es.emit("agent", { i: round + 1, type: "response.delta", data: { text: "x" } });
      es.fireError();
      await vi.advanceTimersByTimeAsync(6_000);
      // An event was delivered on the previous connection → budget was reset.
      expect(FakeEventSource.instances.length).toBe(round + 2);
    }
    expect(events.length).toBe(5);
  });

  it("stops reopening after MAX_REOPEN consecutive failures with zero events", async () => {
    await openStream();
    for (let i = 0; i < 12; i++) {
      const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
      es.fireError();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    // 1 initial + MAX_REOPEN(6) reopens — then it gives up (the status-poll
    // watchdog still lands the run).
    expect(FakeEventSource.instances.length).toBeLessThanOrEqual(7);
  });

  it("a terminal done is final — the connection close after it never reopens", async () => {
    const { events } = await openStream();
    const first = FakeEventSource.instances[0]!;
    first.emit("agent", { i: 3, type: "response.completed", data: {} });
    first.emit("done", { status: "completed" });
    expect(first.closed).toBe(true);
    first.fireError(); // the close event after the terminal done
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeEventSource.instances.length).toBe(1);
    expect(events.map((e) => e.i)).toEqual([3]);
  });

  it("a noSandbox done retries with the cursor preserved", async () => {
    await openStream();
    const first = FakeEventSource.instances[0]!;
    first.emit("agent", { i: 2, type: "reasoning.delta", data: { text: "t" } });
    first.emit("done", { noSandbox: true }); // sandbox mid-pause/resume
    await vi.advanceTimersByTimeAsync(8_000);
    expect(FakeEventSource.instances.length).toBe(2);
    expect(FakeEventSource.instances[1]!.url).toContain("after=2");
  });

  it("the closer stops every future reopen", async () => {
    const { close } = await openStream();
    close();
    const first = FakeEventSource.instances[0]!;
    first.fireError();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeEventSource.instances.length).toBe(1);
    expect(first.closed).toBe(true);
  });
});
