// @vitest-environment node
/**
 * Streaming Message Integrity — regression tests.
 *
 * These lock down the core PRD invariants:
 *   1. SSE frames are parsed as LOGICAL events (network chunk boundaries are
 *      irrelevant), so a word split across two network chunks is reassembled.
 *   2. Provider delta normalization covers content / reasoning_content /
 *      reasoning / thinking / tool_calls.
 *   3. The chat store appends deltas to ONE message — text never spawns new
 *      message bars, reasoning merges into a single reasoning part, and
 *      interleaved thinking → text → tool → text keeps its chronology inside
 *      a single message.
 *   4. Tool-call arguments fragmented across deltas accumulate into one call.
 */
import { describe, it, expect } from "vitest";
import { parseSSEStream, extractDelta, extractFinishReason } from "./runtime";
import { useChatStore } from "@/stores/chat-store";
import type { ChatMessage } from "@/types";

// ---------------------------------------------------------------------------
// Helpers — build SSE byte streams with arbitrary network chunk splits.
// ---------------------------------------------------------------------------

/** Encode a string into a Uint8Array (the shape ReadableStream delivers). */
function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Wrap parsed SSE events into a ReadableStream that emits the given chunks. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(bytes(chunks[i]!));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

async function collect(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const out: Array<Record<string, unknown>> = [];
  for await (const ev of parseSSEStream(reader)) out.push(ev);
  return out;
}

function readerFor(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  return streamOf(chunks).getReader();
}

// ---------------------------------------------------------------------------
// 1. SSE frame parsing — logical events, not network chunks.
// ---------------------------------------------------------------------------

describe("parseSSEStream", () => {
  it("parses multiple events in one network chunk", async () => {
    const chunk =
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
      "data: [DONE]\n\n";
    const events = await collect(readerFor([chunk]));
    expect(events).toHaveLength(2); // [DONE] is dropped
    expect(extractDelta(events[0]!)?.text).toBe("Hello");
    expect(extractDelta(events[1]!)?.text).toBe(" world");
  });

  it("reassembles an event split across network chunks (mid-word boundary)", async () => {
    // One logical JSON event split into 4 network chunks — the word
    // "integrity" is broken across chunk 2/3 and the closing braces across 3/4.
    const event =
      'data: {"choices":[{"delta":{"content":"stream integrity"}}]}\n\n';
    const cut1 = event.slice(0, 20);
    const cut2 = event.slice(20, 34);
    const cut3 = event.slice(34, 47);
    const cut4 = event.slice(47);
    const events = await collect(readerFor([cut1, cut2, cut3, cut4, "data: [DONE]\n\n"]));
    expect(events).toHaveLength(1);
    expect(extractDelta(events[0]!)?.text).toBe("stream integrity");
  });

  it("reassembles an event split mid-frame-delimiter", async () => {
    // Chunk boundary lands INSIDE the \n\n separator (one \n in each chunk).
    const events = await collect(readerFor([
      'data: {"choices":[{"delta":{"content":"a"}}]}\n',
      '\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n',
    ]));
    expect(events).toHaveLength(2);
    expect(extractDelta(events[0]!)?.text).toBe("a");
    expect(extractDelta(events[1]!)?.text).toBe("b");
  });

  it("flushes a trailing event that arrives without a final delimiter", async () => {
    const events = await collect(
      readerFor(['data: {"choices":[{"delta":{"content":"tail"}}]}']),
    );
    expect(events).toHaveLength(1);
    expect(extractDelta(events[0]!)?.text).toBe("tail");
  });

  it("ignores malformed JSON lines but keeps streaming", async () => {
    const events = await collect(readerFor([
      "data: {broken json\n\n",
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    ]));
    expect(events).toHaveLength(1);
    expect(extractDelta(events[0]!)?.text).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 2. Provider delta normalization.
// ---------------------------------------------------------------------------

describe("extractDelta — provider field normalization", () => {
  const deltaOf = (delta: Record<string, unknown>) => ({
    choices: [{ delta }],
  });

  it("maps standard content to text", () => {
    expect(extractDelta(deltaOf({ content: "hi" }))?.text).toBe("hi");
  });

  it("maps DeepSeek-style reasoning_content to reasoning", () => {
    expect(extractDelta(deltaOf({ reasoning_content: "think..." }))?.reasoning).toBe("think...");
  });

  it("maps vLLM-style reasoning to reasoning", () => {
    expect(extractDelta(deltaOf({ reasoning: "also think" }))?.reasoning).toBe("also think");
  });

  it("maps Anthropic-style thinking to thinking", () => {
    expect(extractDelta(deltaOf({ thinking: "hmm" }))?.thinking).toBe("hmm");
  });

  it("prefers reasoning_content over reasoning when both are present", () => {
    expect(
      extractDelta(deltaOf({ reasoning_content: "primary", reasoning: "secondary" }))?.reasoning,
    ).toBe("primary");
  });

  it("normalizes fragmented tool_calls deltas", () => {
    const d = extractDelta(deltaOf({
      tool_calls: [{ index: 0, id: "call_1", function: { name: "run_python", arguments: "{\"co" } }],
    }));
    expect(d?.toolCalls).toEqual([
      { index: 0, id: "call_1", name: "run_python", arguments: "{\"co" },
    ]);
  });

  it("returns an empty accumulator for usage-only chunks (no choices)", () => {
    expect(extractDelta({ usage: { total_tokens: 3 } })).toEqual({});
  });

  it("returns null for chunks with neither choices nor usage", () => {
    expect(extractDelta({})).toBeNull();
  });

  it("extracts finish_reason and stop_reason", () => {
    expect(extractFinishReason({ choices: [{ finish_reason: "stop" }] })).toBe("stop");
    expect(extractFinishReason({ choices: [{ stop_reason: "length" }] })).toBe("length");
    expect(extractFinishReason({ choices: [{ finish_reason: null }] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Chat store — one message, appended deltas, ordered parts.
// ---------------------------------------------------------------------------

describe("chat store streaming integrity", () => {
  function resetStore() {
    useChatStore.setState({ messages: [], isStreaming: false });
  }

  function addAssistant(): string {
    const id = `msg-${Math.random().toString(36).slice(2)}`;
    useChatStore.getState().addMessage({
      id,
      role: "assistant",
      content: "",
      timestamp: new Date(),
      isStreaming: true,
      toolCalls: [],
      parts: [],
    });
    return id;
  }

  function get(id: string): ChatMessage {
    const m = useChatStore.getState().messages.find((x) => x.id === id);
    if (!m) throw new Error("message disappeared");
    return m;
  }

  it("text deltas accumulate into ONE message — never new message bars", () => {
    resetStore();
    const id = addAssistant();
    const store = useChatStore.getState();

    // Simulate a word broken across three deltas (mid-word chunk boundary).
    store.appendTextDelta(id, "Integr");
    store.appendTextDelta(id, "ity ");
    store.appendTextDelta(id, "check");

    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(1); // invariant: one generation = one message
    expect(get(id).content).toBe("Integrity check");
    // Text lives in a single text part — no split bubbles inside the message.
    const textParts = get(id).parts!.filter((p) => p.type === "text");
    expect(textParts).toHaveLength(1);
    expect(textParts[0]!.content).toBe("Integrity check");
  });

  it("reasoning deltas merge into a single reasoning part even when text interleaves", () => {
    resetStore();
    const id = addAssistant();
    const store = useChatStore.getState();

    store.appendReasoningDelta(id, "Step 1: plan. ");
    store.appendTextDelta(id, "Here is the answer. ");
    store.appendReasoningDelta(id, "Step 2: verify."); // reasoning continues after text

    const reasoningParts = get(id).parts!.filter((p) => p.type === "reasoning");
    expect(reasoningParts).toHaveLength(1); // ONE reasoning bar, not two
    expect(reasoningParts[0]!.content).toBe("Step 1: plan. Step 2: verify.");
    expect(get(id).reasoning).toBe("Step 1: plan. Step 2: verify.");
  });

  it("thinking deltas merge into a single thinking part across interleaves", () => {
    resetStore();
    const id = addAssistant();
    const store = useChatStore.getState();

    store.appendThinkingDelta(id, "think A ");
    store.appendTextDelta(id, "answer ");
    store.appendThinkingDelta(id, "think B");

    const thinkingParts = get(id).parts!.filter((p) => p.type === "thinking");
    expect(thinkingParts).toHaveLength(1);
    expect(thinkingParts[0]!.content).toBe("think A think B");
  });

  it("same-round text after a tool call merges into the round's text part (no mid-sentence cuts)", () => {
    resetStore();
    const id = addAssistant();
    const store = useChatStore.getState();

    store.appendTextDelta(id, "Before tools. ");
    store.addToolCallPart(id, {
      id: "tc-1",
      name: "run_python",
      args: { code: "print(1)" },
      status: "running",
    });
    store.appendTextDelta(id, "After tools.");

    // ONE message, ONE text part for the round: the message content is a
    // single narrative that precedes its tool calls — even when the provider
    // interleaves content deltas around tool_call deltas. The old behavior
    // ([text, tool, text]) cut sentences in half and pushed the tail below
    // the tool cards.
    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(1);
    const partTypes = get(id).parts!.map((p) => p.type);
    expect(partTypes).toEqual(["text", "tool"]);
    const textParts = get(id).parts!.filter((p) => p.type === "text");
    expect(textParts).toHaveLength(1);
    expect(textParts[0]!.content).toBe("Before tools. After tools.");
  });

  it("NEW-ROUND text lands below the previous round's tools (chronological)", () => {
    resetStore();
    const id = addAssistant();
    const store = useChatStore.getState();

    store.appendTextDelta(id, "Round one. ", 1);
    store.addToolCallPart(
      id,
      { id: "tc-1", name: "run_python", args: { code: "print(1)" }, status: "completed" },
      1,
    );
    // Round 2's text (the model's post-tool narration).
    store.appendTextDelta(id, "Round two answer.", 2);

    const partTypes = get(id).parts!.map((p) => p.type);
    expect(partTypes).toEqual(["text", "tool", "text"]);
    const textParts = get(id).parts!.filter((p) => p.type === "text");
    expect(textParts[0]!.content).toBe("Round one. ");
    expect(textParts[1]!.content).toBe("Round two answer.");
    expect(textParts[1]!.round).toBe(2);
  });

  it("appendTextDelta appends to the same text bubble when reasoning interleaves", () => {
    resetStore();
    const id = addAssistant();
    const store = useChatStore.getState();

    store.appendTextDelta(id, "Hel");
    store.appendReasoningDelta(id, "(thinking)");
    store.appendTextDelta(id, "lo");

    // "Hel" + "lo" reassemble into the SAME text part — no broken half words.
    const textParts = get(id).parts!.filter((p) => p.type === "text");
    expect(textParts).toHaveLength(1);
    expect(textParts[0]!.content).toBe("Hello");
  });

  it("tool result updates the existing card instead of creating a duplicate", () => {
    resetStore();
    const id = addAssistant();
    const store = useChatStore.getState();

    store.addToolCallPart(id, {
      id: "tc-1",
      name: "run_python",
      args: { code: "print(1)" },
      status: "running",
    });
    store.updateToolCallPart(id, "tc-1", {
      status: "completed",
      result: "1",
    });

    const toolParts = get(id).parts!.filter((p) => p.type === "tool");
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0]!.toolCall!.status).toBe("completed");
    expect(toolParts[0]!.toolCall!.result).toBe("1");
  });

  it("deltas targeting a missing message are ignored (no accidental creation)", () => {
    resetStore();
    useChatStore.getState().appendTextDelta("does-not-exist", "ghost");
    expect(useChatStore.getState().messages).toHaveLength(0);
  });
});
