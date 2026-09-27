import { beforeEach, describe, expect, it } from "vitest";
import { AgentEventProcessor } from "./event-processor";
import {
  canMergeIntoLastTextPart,
  deriveAgentPhase,
  isInternalMarkerLine,
  resolveToolCall,
  stripInternalMarkers,
} from "./timeline";
import { createExecutionChatStore, type ExecutionChatStore } from "@/stores/chat-store";
import type { ChatMessage, WSEvent } from "@/types";

/**
 * Timeline PRD §28 regression tests — the seven scenarios the renderer
 * pipeline must satisfy, exercised against the REAL AgentEventProcessor +
 * execution store (normalizer → dedup → timeline → phase derivation).
 * Buffer timers are bypassed with `flush()` so the assertions are
 * deterministic (no timing flakiness).
 */

function setup(): { processor: AgentEventProcessor; store: ExecutionChatStore } {
  const store = createExecutionChatStore();
  const processor = new AgentEventProcessor({
    store,
    getConversationId: () => null,
  });
  return { processor, store };
}

function emit(p: AgentEventProcessor, type: WSEvent["type"], data?: unknown): void {
  p.handle({ type, data } as WSEvent);
}

function lastAssistant(store: ExecutionChatStore): ChatMessage {
  const msgs = store.getState().messages;
  const msg = msgs[msgs.length - 1];
  if (!msg || msg.role !== "assistant") throw new Error("no assistant message");
  return msg;
}

function start(p: AgentEventProcessor, round = 1, generation = "g-test"): void {
  emit(p, "model_request_start", { round, generation_id: generation });
}

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

describe("stripInternalMarkers / isInternalMarkerLine (§8)", () => {
  it("drops whole-line internal markers at the parsing layer", () => {
    expect(stripInternalMarkers("PROCESS")).toBe("");
    expect(stripInternalMarkers("process")).toBe("");
    expect(stripInternalMarkers("PROCESSING")).toBe("");
    expect(stripInternalMarkers("PROCESS:")).toBe("");
    expect(stripInternalMarkers("Tool started")).toBe("");
    expect(stripInternalMarkers("Calling tool")).toBe("");
  });

  it("keeps legitimate prose that contains the words", () => {
    expect(stripInternalMarkers("The process of photosynthesis works as follows.")).toBe(
      "The process of photosynthesis works as follows.",
    );
    expect(isInternalMarkerLine("A tool started the work")).toBe(false);
  });

  it("drops marker LINES inside a multi-line chunk but keeps content lines", () => {
    expect(stripInternalMarkers("PROCESS\nNow I have the full picture.")).toBe(
      "Now I have the full picture.",
    );
  });
});

describe("resolveToolCall (§6/§17)", () => {
  const stub = (partId: string, id: string, name: string) => ({
    partId,
    toolCall: { id, name, args: {}, status: "pending" as const },
  });

  it("exact toolCallId match → update, never a second card", () => {
    const parts = [stub("p1", "abc", "read_file"), stub("p2", "def", "read_file")];
    const r = resolveToolCall({
      toolCallId: "abc",
      toolName: "read_file",
      preemit: false,
      toolParts: parts,
      preemitQueue: [],
    });
    expect(r).toEqual({ action: "update", toolCallId: "abc" });
  });

  it("final call with a late provider id ADOPTS the oldest matching pre-emit placeholder", () => {
    const parts = [stub("p1", "pending-0", "pending-0"), stub("p2", "real-2", "list_folder")];
    const r = resolveToolCall({
      toolCallId: "provider-1",
      toolName: "list_folder",
      preemit: false,
      toolParts: parts,
      preemitQueue: ["p2"],
    });
    expect(r).toEqual({ action: "adopt", partId: "p2" });
  });

  it("two DIFFERENT tools with the same name stay separate (no name-only dedup)", () => {
    const parts = [stub("p1", "call-1", "read_file")];
    const r = resolveToolCall({
      toolCallId: "call-2",
      toolName: "read_file",
      preemit: false,
      toolParts: parts,
      preemitQueue: [],
    });
    expect(r).toEqual({ action: "create", identityId: "call-2" });
  });
});

describe("canMergeIntoLastTextPart (§23)", () => {
  it("merges only into a TRAILING same-round text part", () => {
    expect(canMergeIntoLastTextPart([{ id: "a", type: "text", content: "x", round: 1 }], 1)).toBe(true);
    // Different round → no merge.
    expect(canMergeIntoLastTextPart([{ id: "a", type: "text", content: "x", round: 1 }], 2)).toBe(false);
    // Tool boundary → no merge.
    expect(
      canMergeIntoLastTextPart(
        [
          { id: "a", type: "text", content: "x", round: 1 },
          { id: "b", type: "tool", round: 1 },
        ],
        1,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end processor scenarios (PRD §28 tests 1–7).
// ---------------------------------------------------------------------------

describe("AgentEventProcessor timeline regression tests", () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => {
    env = setup();
  });

  // Test 1 — text → tool → result → text ⇒ text, tool, text.
  it("keeps assistant text before AND after a tool call in order", () => {
    const { processor, store } = env;
    start(processor);
    emit(processor, "text_delta", { index: 0, content: "I'll start by analyzing your workspace." });
    emit(processor, "tool_call", {
      tool_name: "analyze_workspace",
      args: { path: "/home/user" },
      tool_call_id: "tc-1",
    });
    emit(processor, "tool_result", { tool_call_id: "tc-1", content: "Listed /home/user" });
    emit(processor, "model_request_start", { round: 2, generation_id: "g-test" });
    emit(processor, "text_delta", { index: 0, content: "Now I have a complete picture." });
    processor.flush();

    const parts = lastAssistant(store).parts ?? [];
    const shape = parts.map((p) => p.type);
    expect(shape).toEqual(["text", "tool", "text"]);
    expect(parts[0]!.content).toBe("I'll start by analyzing your workspace.");
    expect(parts[1]!.toolCall?.name).toBe("analyze_workspace");
    expect(parts[2]!.content).toBe("Now I have a complete picture.");
  });

  // Test 2 — tool → duplicate tool → result ⇒ ONE tool.
  it("never duplicates a tool card for the same underlying call", () => {
    const { processor, store } = env;
    start(processor);
    emit(processor, "tool_call", {
      tool_name: "analyze_workspace",
      args: { path: "/home/user" },
      tool_call_id: "abc",
    });
    emit(processor, "tool_call", {
      tool_name: "analyze_workspace",
      args: { path: "/home/user" },
      tool_call_id: "abc",
    });
    emit(processor, "tool_result", { tool_call_id: "abc", content: "Listed /home/user" });
    processor.flush();

    const msg = lastAssistant(store);
    const toolParts = (msg.parts ?? []).filter((p) => p.type === "tool");
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0]!.toolCall?.status).toBe("completed");
    expect(toolParts[0]!.toolCall?.result).toBe("Listed /home/user");
  });

  // Test 3 — text chunks → tool → text chunks ⇒ one text block, one tool, one text block.
  it("aggregates adjacent chunks but never merges across the tool boundary", () => {
    const { processor, store } = env;
    start(processor);
    emit(processor, "text_delta", { index: 0, content: "I'll start" });
    emit(processor, "text_delta", { index: 0, content: " by analyzing" });
    emit(processor, "text_delta", { index: 0, content: " your workspace" });
    emit(processor, "tool_call", {
      tool_name: "analyze_workspace",
      args: {},
      tool_call_id: "tc-9",
    });
    emit(processor, "model_request_start", { round: 2, generation_id: "g-test" });
    emit(processor, "text_delta", { index: 0, content: "Now I have" });
    emit(processor, "text_delta", { index: 0, content: " the full picture." });
    processor.flush();

    const parts = lastAssistant(store).parts ?? [];
    const shape = parts.map((p) => p.type);
    expect(shape).toEqual(["text", "tool", "text"]);
    expect(parts[0]!.content).toBe("I'll start by analyzing your workspace");
    expect(parts[2]!.content).toBe("Now I have the full picture.");
  });

  // Test 4 — tool → result chunk ×4 ⇒ ONE tool component (streaming output
  // updates the existing part).
  it("attaches result/output chunks to the ONE existing tool part", () => {
    const { processor, store } = env;
    start(processor);
    emit(processor, "tool_call", {
      tool_name: "run_terminal",
      args: { command: "ls -R /home/user" },
      tool_call_id: "tc-run",
    });
    for (const chunk of ["Listed /home/user\n", "Listed /home/user/uploads\n", "Listed /home/user/projects\n", "Listed /home/user/output\n"]) {
      emit(processor, "tool_output", { tool_call_id: "tc-run", content: chunk, type: "stdout" });
    }
    processor.flush();
    emit(processor, "tool_result", { tool_call_id: "tc-run", content: "done" });
    processor.flush();

    const msg = lastAssistant(store);
    const toolParts = (msg.parts ?? []).filter((p) => p.type === "tool");
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0]!.toolCall?.streamingOutput).toBe(
      "Listed /home/user\nListed /home/user/uploads\nListed /home/user/projects\nListed /home/user/output\n",
    );
    expect(toolParts[0]!.toolCall?.status).toBe("completed");
  });

  // Test 5 — thinking → tool → thinking → final ⇒ Thinking, Working,
  // Thinking, Final (the state machine, §12–§14).
  it("derives Thinking/Working phases from the live parts", () => {
    const { processor, store } = env;
    start(processor);
    // Phase 1 — model reasoning: an OPEN thinking part renders the
    // ThinkingReasoning panel ("Thinking…" owns the status → line hides).
    emit(processor, "thinking_delta", { index: 0, content: "Let me think about the layout of this workspace." });
    processor.flush();
    let msg = lastAssistant(store);
    let openReasoning = (msg.parts ?? []).some(
      (p) => (p.type === "thinking" || p.type === "reasoning") && p.reasoningEndedAt === undefined,
    );
    expect(openReasoning).toBe(true); // → Thinking UI
    expect(deriveAgentPhase(msg)).toBeNull(); // no duplicate status line

    // Phase 2 — tool executing → Working.
    emit(processor, "tool_call", {
      tool_name: "analyze_workspace",
      args: {},
      tool_call_id: "tc-think",
    });
    processor.flush();
    msg = lastAssistant(store);
    expect(deriveAgentPhase(msg)).toBe("working");

    // Phase 3 — tool done, model reasoning again → Thinking.
    emit(processor, "tool_result", { tool_call_id: "tc-think", content: "listed" });
    emit(processor, "model_request_start", { round: 2, generation_id: "g-test" });
    emit(processor, "thinking_delta", { index: 0, content: "Now I understand the structure." });
    processor.flush();
    msg = lastAssistant(store);
    openReasoning = (msg.parts ?? []).some(
      (p) => (p.type === "thinking" || p.type === "reasoning") && p.reasoningEndedAt === undefined,
    );
    expect(openReasoning).toBe(true); // → Thinking UI again
    expect(deriveAgentPhase(msg)).toBeNull();

    // Phase 4 — final answer generated → Thinking (generating) → Completed.
    emit(processor, "text_delta", { index: 0, content: "Here is the summary." });
    processor.flush();
    msg = lastAssistant(store);
    expect(deriveAgentPhase(msg)).toBe("thinking"); // final response generation
    emit(processor, "final_result", { output: "" });
    processor.flush();
    msg = lastAssistant(store);
    expect(msg.isStreaming).toBe(false);
    expect(deriveAgentPhase(msg)).toBeNull(); // completed
  });

  // Test 6 — PROCESS ⇒ not rendered.
  it("drops internal PROCESS markers at the parsing layer", () => {
    const { processor, store } = env;
    start(processor);
    emit(processor, "text_delta", { index: 0, content: "PROCESS" });
    emit(processor, "text_delta", { index: 0, content: "Working on it…" });
    processor.flush();
    const msg = lastAssistant(store);
    expect((msg.parts ?? []).filter((p) => p.type === "text")).toHaveLength(1);
    expect(msg.content).toBe("Working on it…");

    // Marker split across chunks → caught by the flush-time pass (the
    // holdback keeps the partial marker out of the flushed text until the
    // line completes).
    const { processor: p2, store: s2 } = setup();
    start(p2);
    emit(p2, "text_delta", { index: 0, content: "PROC" });
    emit(p2, "text_delta", { index: 0, content: "ESS\n" });
    emit(p2, "text_delta", { index: 0, content: "Real answer." });
    p2.flush();
    expect(lastAssistant(s2).content).toBe("Real answer.");
  });

  // Test 7 — tool_call abc ×3 (provider replay) ⇒ ONE tool call.
  it("is idempotent under repeated provider events", () => {
    const { processor, store } = env;
    start(processor);
    emit(processor, "tool_call", { tool_name: "read_file", args: { path: "/home/user/Onyx.md" }, tool_call_id: "abc" });
    emit(processor, "tool_call", { tool_name: "read_file", args: { path: "/home/user/Onyx.md" }, tool_call_id: "abc" });
    emit(processor, "tool_call", { tool_name: "read_file", args: { path: "/home/user/Onyx.md" }, tool_call_id: "abc" });
    processor.flush();

    const msg = lastAssistant(store);
    expect((msg.parts ?? []).filter((p) => p.type === "tool")).toHaveLength(1);
  });

  // §6 supplementary — pre-emit placeholder adoption: ONE card across the
  // pre-emit → final(id swap) → result lifecycle.
  it("adopts a pre-emit placeholder when the provider id arrives late", () => {
    const { processor, store } = env;
    start(processor);
    emit(processor, "text_delta", { index: 0, content: "Reading your profile…" });
    // Pre-emit BEFORE the provider id is known (name-less placeholder).
    emit(processor, "tool_call", {
      tool_name: "pending-0",
      args: { _streaming: '{"path": "/home/user/.profile"' },
      tool_call_id: "pending-0",
      _preemit: true,
    });
    processor.flush();
    let toolParts = (lastAssistant(store).parts ?? []).filter((p) => p.type === "tool");
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0]!.toolCall?.status).toBe("pending");

    // Final call carries the REAL provider id → adoption, not a new card.
    emit(processor, "tool_call", {
      tool_name: "read_file",
      args: { path: "/home/user/.profile" },
      tool_call_id: "call_real_1",
    });
    emit(processor, "tool_result", { tool_call_id: "call_real_1", content: "the file body" });
    processor.flush();

    const msg = lastAssistant(store);
    toolParts = (msg.parts ?? []).filter((p) => p.type === "tool");
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0]!.toolCall?.id).toBe("call_real_1");
    expect(toolParts[0]!.toolCall?.name).toBe("read_file");
    expect(toolParts[0]!.toolCall?.status).toBe("completed");
    // Text that arrived BEFORE the pre-emit stays ABOVE the tool part.
    const parts = msg.parts ?? [];
    expect(parts.findIndex((p) => p.type === "text")).toBeLessThan(
      parts.findIndex((p) => p.type === "tool"),
    );
  });

  // §6 supplementary — same tool, different targets: two legitimate cards.
  it("keeps two read_file calls on different files separate", () => {
    const { processor, store } = env;
    start(processor);
    emit(processor, "tool_call", { tool_name: "read_file", args: { path: "/home/user/Onyx.md" }, tool_call_id: "r1" });
    emit(processor, "tool_call", { tool_name: "read_file", args: { path: "/home/user/.bashrc" }, tool_call_id: "r2" });
    processor.flush();
    const toolParts = (lastAssistant(store).parts ?? []).filter((p) => p.type === "tool");
    expect(toolParts).toHaveLength(2);
    expect(toolParts[0]!.toolCall?.args).toEqual({ path: "/home/user/Onyx.md" });
    expect(toolParts[1]!.toolCall?.args).toEqual({ path: "/home/user/.bashrc" });
  });

  // §17 supplementary — a provider round RETRY re-streams the round: the
  // failed attempt's partial text must be rewound, never duplicated.
  it("rewinds a failed round attempt before the retry re-streams it", () => {
    const { processor, store } = env;
    start(processor);
    // Attempt 1: partial text flushed, then the provider dies mid-stream.
    emit(processor, "text_delta", { index: 0, content: "I'll start by analyzin" });
    processor.flush();
    expect(lastAssistant(store).content).toBe("I'll start by analyzin");
    // The runtime announces the retry before re-streaming the round.
    emit(processor, "round_retry", { round: 1, attempt: 1 });
    expect(lastAssistant(store).content).toBe("");
    expect((lastAssistant(store).parts ?? []).filter((p) => p.type === "text")).toHaveLength(0);
    // Attempt 2 streams the round from the start — final state has the
    // text EXACTLY ONCE.
    emit(processor, "text_delta", { index: 0, content: "I'll start by analyzing your workspace." });
    emit(processor, "tool_call", {
      tool_name: "list_uploaded_files",
      args: {},
      tool_call_id: "tc-retry",
    });
    processor.flush();
    const msg = lastAssistant(store);
    expect(msg.content).toBe("I'll start by analyzing your workspace.");
    expect((msg.parts ?? []).map((p) => p.type)).toEqual(["text", "tool"]);
  });

  // §17 supplementary — the rewind also drops a stale pre-emit placeholder
  // from the failed attempt (a re-stream with a fresh id can't duplicate it).
  it("drops a failed attempt's pre-emit placeholder on round_retry", () => {
    const { processor, store } = env;
    start(processor);
    emit(processor, "tool_call", {
      tool_name: "pending-0",
      args: { _streaming: "{}" },
      tool_call_id: "pending-0",
      _preemit: true,
    });
    processor.flush();
    expect((lastAssistant(store).parts ?? []).filter((p) => p.type === "tool")).toHaveLength(1);
    emit(processor, "round_retry", { round: 1, attempt: 1 });
    expect((lastAssistant(store).parts ?? []).filter((p) => p.type === "tool")).toHaveLength(0);
    // The retry's pre-emit + final call land cleanly — ONE card.
    emit(processor, "tool_call", {
      tool_name: "read_file",
      args: { _streaming: "{}" },
      tool_call_id: "pending-0",
      _preemit: true,
    });
    emit(processor, "tool_call", {
      tool_name: "read_file",
      args: { path: "/home/user/Onyx.md" },
      tool_call_id: "call_fresh_1",
    });
    emit(processor, "tool_result", { tool_call_id: "call_fresh_1", content: "body" });
    processor.flush();
    const toolParts = (lastAssistant(store).parts ?? []).filter((p) => p.type === "tool");
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0]!.toolCall?.status).toBe("completed");
  });
});
