import { describe, expect, it, vi } from "vitest";
import type { SandboxHistoryMessage } from "@/lib/e2b/client";
import {
  buildSeedMessages,
  convertHistoryToAssistantMessage,
  getDetachedRunForConversation,
  sliceNewRunMessages,
} from "@/lib/agent/detached-run";

describe("buildSeedMessages", () => {
  it("prepends the system prompt, keeps user/assistant history, appends the new prompt", () => {
    const seed = buildSeedMessages(
      "SYS",
      [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "tool", content: "ignored" },
        { role: "user", content: "" }, // dropped — empty
      ],
      "NEW",
    );
    expect(seed.map((m) => [m.role, m.content])).toEqual([
      ["system", "SYS"],
      ["user", "one"],
      ["assistant", "two"],
      ["user", "NEW"],
    ]);
  });

  it("caps the history at the last 30 messages (never the system prompt or new prompt)", () => {
    const history = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: `m${i}`,
    }));
    const seed = buildSeedMessages("", history, "NEW");
    expect(seed).toHaveLength(31); // 30 history + the new prompt
    expect(seed[0]).toEqual({ role: "user", content: "m20" }); // the 31st-from-last
    expect(seed[30]).toEqual({ role: "user", content: "NEW" });
  });

  it("caps each message body at 12k chars", () => {
    const seed = buildSeedMessages("", [{ role: "user", content: "x".repeat(20_000) }], "NEW");
    expect(seed[0]!.content).toHaveLength(12_000);
  });
});

describe("convertHistoryToAssistantMessage (the landing path)", () => {
  it("converts tool calls + results + final text into parts + toolCalls", () => {
    const history: SandboxHistoryMessage[] = [
      { role: "user", content: "make a file" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "create_file", arguments: '{"path":"a.txt"}' },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "run_terminal", arguments: "not-json" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "created a.txt" },
      { role: "tool", tool_call_id: "call_2", content: "error: boom" },
      { role: "assistant", content: "All done." },
    ];
    const out = convertHistoryToAssistantMessage(history);
    // 2 tool parts + the closing text part.
    expect(out.parts).toHaveLength(3);
    expect(out.parts.filter((p) => p.type === "tool")).toHaveLength(2);
    expect(out.content).toBe("All done.");
    // Tool-call mapping: completed vs error, results resolved by id.
    expect(out.toolCalls).toHaveLength(2);
    expect(out.toolCalls[0]).toMatchObject({
      name: "create_file",
      status: "completed",
      result: "created a.txt",
      args: { path: "a.txt" },
    });
    expect(out.toolCalls[1]).toMatchObject({ name: "run_terminal", status: "error" });
    expect(out.toolCalls[1]!.args).toEqual({ raw: "not-json" }); // unparseable args are wrapped, never thrown
    expect(out.failed).toBe(true); // the error: result marks the run
  });

  it("reports honest copy when the run produced no final message", () => {
    const history: SandboxHistoryMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "" },
    ];
    const out = convertHistoryToAssistantMessage(history);
    expect(out.content).toBe("(the run finished without a final message)");
    expect(out.parts.at(-1)).toMatchObject({ type: "text" });
    expect(out.toolCalls).toHaveLength(0);
    expect(out.failed).toBe(false);
  });

  it("keeps only the LAST assistant text as the final message", () => {
    const history: SandboxHistoryMessage[] = [
      { role: "assistant", content: "thinking out loud" },
      { role: "assistant", content: "final answer" },
    ];
    expect(convertHistoryToAssistantMessage(history).content).toBe("final answer");
  });

  it("converts each assistant turn's reasoning into thinking parts + the thinking field", () => {
    const history: SandboxHistoryMessage[] = [
      {
        role: "assistant",
        content: "",
        reasoning: "I should list the primes under 50 first.",
        tool_calls: [{ id: "c1", function: { name: "run_terminal", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
      { role: "assistant", content: "There are 15.", reasoning: "Counted them." },
    ];
    const out = convertHistoryToAssistantMessage(history);
    expect(out.thinking).toBe("I should list the primes under 50 first.Counted them.");
    const thinkParts = out.parts.filter((p) => p.type === "thinking");
    expect(thinkParts).toHaveLength(2); // one per round — never merged
    expect((thinkParts[0] as { content?: string }).content).toContain("primes under 50");
  });

  it("omits thinking entirely when no assistant turn carried reasoning", () => {
    const history: SandboxHistoryMessage[] = [{ role: "assistant", content: "done" }];
    const out = convertHistoryToAssistantMessage(history);
    expect(out.thinking).toBe("");
    expect(out.parts.some((p) => p.type === "thinking")).toBe(false);
  });
});

// ── getDetachedRunForConversation — the refresh auto-stop regression ──────
// A run dispatched under the transient pre-auth id ("local-user") while the
// session later resolves to the real id must STILL be found by the
// reattach-on-return path, or a live sandbox run settles as "interrupted"
// on every reload (the reported "still auto stopping on refreshed").
vi.mock("@/lib/db", () => ({
  getDB: () => ({ detached_runs: { where: fakeDetachedWhere } }),
}));

type FakeRow = Record<string, unknown>;
let fakeRows: FakeRow[] = [];

function fakeDetachedWhere(_index: string) {
  const byConversation = (rows: FakeRow[], conversationId: string) =>
    rows.filter((r) => r.conversation_id === conversationId);
  return {
    equals: (conversationId: string) => ({
      and: (pred: (r: FakeRow) => boolean) => ({
        sortBy: async () =>
          byConversation(fakeRows, conversationId)
            .filter(pred)
            .sort((a, b) => Number(a.started_at) - Number(b.started_at)),
      }),
      sortBy: async () =>
        byConversation(fakeRows, conversationId).sort(
          (a, b) => Number(a.started_at) - Number(b.started_at),
        ),
    }),
  };
}

function row(over: Partial<FakeRow> & { id: string; conversation_id: string }): FakeRow {
  return {
    user_id: "local-user",
    status: "running",
    started_at: 1,
    result_message_id: null,
    ...over,
  } as FakeRow;
}

describe("getDetachedRunForConversation (user-id drift fallback)", () => {
  it("falls back to a conversation-scoped lookup when the user-scoped query misses", async () => {
    fakeRows = [row({ id: "r1", conversation_id: "c1", user_id: "local-user", started_at: 5 })];
    const found = await getDetachedRunForConversation("real-user", "c1");
    expect(found?.id).toBe("r1"); // found despite the user-id drift
  });

  it("prefers the user-scoped match when one exists (and the LATEST by started_at)", async () => {
    fakeRows = [
      row({ id: "r-old", conversation_id: "c1", user_id: "real-user", started_at: 1 }),
      row({ id: "r-foreign", conversation_id: "c1", user_id: "other", started_at: 9 }),
      row({ id: "r-new", conversation_id: "c1", user_id: "real-user", started_at: 5 }),
    ];
    const found = await getDetachedRunForConversation("real-user", "c1");
    expect(found?.id).toBe("r-new");
  });

  it("returns null when the conversation has no rows at all", async () => {
    fakeRows = [row({ id: "r9", conversation_id: "other-conv" })];
    expect(await getDetachedRunForConversation("real-user", "c1")).toBeNull();
  });

  it("survives a Dexie failure (returns null, never throws)", async () => {
    const db = await import("@/lib/db");
    const original = (db as unknown as { getDB: () => unknown }).getDB;
    (db as unknown as { getDB: () => unknown }).getDB = () => {
      throw new Error("dexie unavailable");
    };
    expect(await getDetachedRunForConversation("u", "c1")).toBeNull();
    (db as unknown as { getDB: () => unknown }).getDB = original;
  });
});

describe("sliceNewRunMessages (lost-row landing)", () => {
  it("a persisted seed count slices by index", () => {
    const history = [
      { role: "system", content: "SYS" },
      { role: "user", content: "one" },
      { role: "user", content: "two" },
      { role: "assistant", content: "answer" },
    ];
    expect(sliceNewRunMessages(history, 3).map((m) => m.role)).toEqual(["assistant"]);
  });

  it("an unknown seed (ref-synthesized row, -1) slices from after the LAST user message", () => {
    const history = [
      { role: "system", content: "SYS" },
      { role: "user", content: "old prompt" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "the new prompt" },
      { role: "assistant", content: "tool call" },
      { role: "tool", content: "result" },
      { role: "assistant", content: "final" },
    ];
    expect(sliceNewRunMessages(history, -1).map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("an unknown seed with no user message falls back to the whole history", () => {
    const history = [
      { role: "system", content: "SYS" },
      { role: "assistant", content: "final" },
    ];
    expect(sliceNewRunMessages(history, -1)).toHaveLength(2);
  });
});
