import { describe, expect, it } from "vitest";
import type { SandboxHistoryMessage } from "@/lib/e2b/client";
import {
  buildSeedMessages,
  convertHistoryToAssistantMessage,
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
});
