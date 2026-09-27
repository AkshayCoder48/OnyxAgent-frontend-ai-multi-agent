// @vitest-environment jsdom
//
// REGRESSION TEST — "the app streams behind but the UI stays on Thinking".
//
// The bug (reproduced end-to-end in the real UI before this fix): in
// background (E2B) mode, useChat.doSend primes the ExecutionHub's processor
// with an early `model_request_start { generation_id: turnGenerationId }`,
// but startBackgroundTurn minted its OWN `bg-…` generation id and stamped
// every consumer event with it. The processor's stale-generation guard then
// dropped EVERY live event — text/thinking/tool deltas, user_prompt,
// message_saved, complete — so:
//   · the UI stayed on the Thinking orb with zero rendered text,
//   · no Dexie checkpoint could exist (the bgmsg row never materialized in
//     the execution store), so a refresh lost everything streamed so far,
//   · the turn only ended via the onFinished safety net ("failed").
// A page RELOAD "fixed" it because the resumed processor was unprimed and
// accepted the fresh generation — which is exactly what users reported:
// "after refresh it streams, but the text from before the refresh is gone".
//
// These tests pin the contract from BOTH sides:
//   1. startBackgroundTurn MUST stamp its events with turn.generationId —
//      primed-processor + turn → text lands live, ids swap, checkpoints
//      run, the turn ends "completed".
//   2. the processor's stale-generation guard DOES drop mismatched
//      generations (why the contract matters — documents the mechanism).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/services", () => ({
  conversationService: {
    create: vi.fn().mockResolvedValue({ id: "conv_new_1" }),
    addMessage: vi.fn().mockResolvedValue({ id: "user_row_1" }),
    saveAgentCheckpoint: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("@/lib/agent/browser-tool-bridge", () => ({
  collectBridgeableTools: vi.fn(() => []),
  handleBrowserToolCall: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/e2b/bg-native-tools", () => ({ BG_NATIVE_TOOL_NAMES: [] }));
vi.mock("@/lib/tools/dynamic_tools", () => ({ loadDynamicTools: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/tools/mcp_tools", () => ({ loadMCPTools: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/stores", () => ({
  useResearchStore: { getState: () => ({ byTurn: {} }) },
  useConversationStore: {
    getState: () => ({
      currentConversationId: null,
      attachConversation: vi.fn(),
    }),
  },
}));
vi.mock("@/stores/subagent-store", () => ({
  useSubagentStore: { getState: () => ({ setSidebarOpen: vi.fn() }) },
}));
vi.mock("@/lib/tools/todos", () => ({ persistTodos: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/client-logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("@/lib/utils", () => ({ setUrlParam: vi.fn() }));

import { startBackgroundTurn } from "./background-turn";
import { AgentEventProcessor } from "./event-processor";
import { createExecutionChatStore } from "@/stores/chat-store";
import type { AgentTurnOptions } from "./runtime";
import type { WSEvent } from "@/types";
import { conversationService } from "@/lib/services";

/** The bg_wait SSE body: one segment that carries the full run + done. */
function bgWaitDoneBody(): string {
  const frame = {
    sandboxId: "sbx_fix",
    status: "done",
    events: [
      { t: "round_start", round: 1, ts: 1, seq: 1 },
      { t: "text_delta", content: "LIVE BACKGROUND TEXT ", round: 1, ts: 2, seq: 2 },
      { t: "text_delta", content: "RENDERED", round: 1, ts: 3, seq: 3 },
      { t: "done", content: "", ts: 4, seq: 4 },
    ],
    content: "",
    error: null,
    startedAt: null,
    done: true,
    afterSeq: 4,
  };
  return `data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`;
}

function stubSandboxFetch(): void {
  const impl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
    if (body.action === "bg_start") {
      return new Response(JSON.stringify({ sandboxId: "sbx_fix", pid: 1, runId: "run_fix" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (body.action === "bg_wait") {
      return new Response(bgWaitDoneBody(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (body.action === "bg_status") {
      return new Response(
        JSON.stringify({
          sandboxId: "sbx_fix",
          status: "done",
          events: [],
          content: "",
          error: null,
          startedAt: null,
          done: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: `unexpected action ${body.action}` }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };
  vi.stubGlobal("fetch", vi.fn(impl));
}

function buildTurn(generationId: string | undefined): AgentTurnOptions {
  return {
    userId: "user_1",
    conversationId: null,
    userMessage: "stream me a sentence",
    provider: {
      baseUrl: "https://mock.local/v1",
      apiKey: "sk-mock",
      model: "mock-1",
      modelType: "openai",
      toolsEnabled: false,
    },
    systemPrompt: "You are a test agent.",
    emit: () => {},
    ...(generationId ? { generationId } : {}),
  } as AgentTurnOptions;
}

interface Harness {
  store: ReturnType<typeof createExecutionChatStore>;
  processor: AgentEventProcessor;
  onTurnEnd: ReturnType<typeof vi.fn>;
  onFinished: () => void;
  finished: Promise<void>;
}

/** Replicates doSend's exact priming sequence on a real processor + store. */
function primeLikeDoSend(harness: Harness, generationId: string): void {
  // doSend sets the optimistic user message id BEFORE the priming event.
  harness.processor.setUserMessageId("user_temp_1");
  harness.processor.handle({
    type: "model_request_start",
    data: { round: 1, generation_id: generationId },
  });
  harness.store.getState().addMessage({
    id: "user_temp_1",
    role: "user",
    content: "stream me a sentence",
    timestamp: new Date(),
  });
}

function makeHarness(): Harness {
  const store = createExecutionChatStore(() => true);
  const onTurnEnd = vi.fn();
  const processor = new AgentEventProcessor({
    store,
    getConversationId: () => "conv_new_1",
    onTurnEnd,
  });
  let resolveFinished!: () => void;
  const finished = new Promise<void>((r) => {
    resolveFinished = r;
  });
  return {
    store,
    processor,
    onTurnEnd,
    onFinished: () => resolveFinished(),
    finished,
  };
}

async function runBackgroundTurn(h: Harness, turn: AgentTurnOptions) {
  const handle = await startBackgroundTurn({
    turn,
    e2bApiKey: "e2b-key",
    userId: "user_1",
    conversationId: null,
    emit: (event: WSEvent) => h.processor.handle(event),
    // Mirrors doSend's wiring: checkpoints flush the render buffers first
    // so the persisted content never lags the persisted seq cursor.
    flush: () => h.processor.flush(),
    onFinished: h.onFinished,
    store: h.store,
  });
  expect(handle).not.toBeNull();
  return handle!;
}

describe("background turn generation identity (live-render regression)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    stubSandboxFetch();
    vi.mocked(conversationService.addMessage)!.mockClear();
    vi.mocked(conversationService.saveAgentCheckpoint)!.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders the live stream when the consumer stamps doSend's generation id (THE FIX)", async () => {
    const h = makeHarness();
    primeLikeDoSend(h, "gen_turn_1");

    await runBackgroundTurn(h, buildTurn("gen_turn_1"));

    // The consumer finishes the run (done frame) — with the fix the whole
    // pipeline runs: deltas → store, checkpoint, terminal → "completed".
    await vi.waitFor(
      () => {
        expect(h.onTurnEnd).toHaveBeenCalledWith("completed");
      },
      { timeout: 5000 },
    );
    await h.finished;

    const messages = h.store.getState().messages;
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    // THE assertion of the fix: the streamed text landed in the live store.
    expect(assistant!.content).toContain("LIVE BACKGROUND TEXT RENDERED");
    // The placeholder's temp id swapped for the bgmsg id (message_saved was
    // accepted — checkpoints can find the row, so a refresh keeps the text).
    expect(assistant!.id).toMatch(/^bgmsg-/);
    expect(assistant!.isStreaming).toBe(false);
    // Exactly one assistant message — no duplicate bubbles.
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    // The optimistic user message id swapped for the Dexie row id too.
    expect(messages.some((m) => m.id === "user_row_1" && m.role === "user")).toBe(true);
    // Checkpoints ran (the refresh-mid-stream data source) — and with the
    // flush-before-checkpoint wiring the checkpointed CONTENT covers the
    // same events the seq cursor covers (the old off-by-one lost the last
    // buffered token of every abruptly-killed stream).
    expect(conversationService.saveAgentCheckpoint).toHaveBeenCalled();
    const lastCheckpoint = vi.mocked(conversationService.saveAgentCheckpoint)!.mock.calls.at(-1);
    expect(lastCheckpoint?.[3]?.content).toContain("LIVE BACKGROUND TEXT RENDERED");
  });

  it("drops every event when the generation does NOT match the primed processor (the mechanism — why the contract matters)", async () => {
    const h = makeHarness();
    // Primed with gen_A …
    primeLikeDoSend(h, "gen_turn_A");
    // … but the turn runs with a different generation (the pre-fix state:
    // startBackgroundTurn minted its own bg-… id).
    await runBackgroundTurn(h, buildTurn("gen_turn_B"));

    // The sandbox stream completes; give the consumer a moment to settle.
    await new Promise((r) => setTimeout(r, 300));

    const messages = h.store.getState().messages;
    const assistant = messages.find((m) => m.role === "assistant");
    // NOTHING landed: the empty placeholder exists but carries no text…
    expect(assistant?.content ?? "").not.toContain("LIVE BACKGROUND TEXT");
    // …no checkpoint could be written (the bgmsg row never materialized)…
    expect(conversationService.saveAgentCheckpoint).not.toHaveBeenCalled();
    // …and the terminal "complete" was dropped too — the turn only ever
    // ended through the caller's safety net, never "completed".
    expect(h.onTurnEnd).not.toHaveBeenCalledWith("completed");
  });
});
