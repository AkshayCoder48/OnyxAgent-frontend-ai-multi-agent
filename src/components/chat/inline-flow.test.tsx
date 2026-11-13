// @vitest-environment jsdom
// DOM probe: the inline flow (PRD §3.1) — no "Worked Ns" trigger line, no
// separator rail; thinking rows + tool stacks render naturally; the
// streaming status line is the ONE live indicator.
import { describe, it, expect, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import { MessageItem } from "./message-item";
import type { ChatMessage } from "@/types";

vi.mock("@/hooks/use-data", () => ({
  useProviders: () => ({ providers: [] }),
}));

const settledMsg = {
  id: "m1",
  role: "assistant",
  content: "Here is the answer.",
  isStreaming: false,
  createdAt: new Date().toISOString(),
  conversationId: "c1",
  parts: [
    { id: "p-think", type: "thinking", content: "Let me search.", roundStartedAt: 1000, reasoningEndedAt: 2500 },
    { id: "p-t1", type: "tool", toolCall: { id: "tc1", name: "web_search", args: { query: "weather" }, status: "completed", result: "{}", startedAt: 2600, endedAt: 3200 } },
    { id: "p-t2", type: "tool", toolCall: { id: "tc2", name: "web_fetch", args: { url: "https://example.com" }, status: "completed", result: "{}", startedAt: 3300, endedAt: 4100 } },
    { id: "p-text", type: "text", content: "Here is the answer.", roundStartedAt: 4200, roundEndedAt: 5000 },
  ],
} as unknown as ChatMessage;

const streamingMsg = {
  ...settledMsg,
  id: "m2",
  isStreaming: true,
  parts: [
    { id: "p-t1", type: "tool", toolCall: { id: "tc1", name: "web_search", args: { query: "weather" }, status: "completed", result: "{}", startedAt: 2600, endedAt: 3200 } },
    { id: "p-text", type: "text", content: "Answering now", roundStartedAt: 4200 },
  ],
} as unknown as ChatMessage;

describe("inline flow (PRD §3.1)", () => {
  it("settled tool turn: NO Worked summary line, NO rail; rows + thought row render", () => {
    const { container } = render(
      React.createElement(MessageItem, { message: settledMsg }),
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain("Worked");
    expect(container.querySelector(".border-l.border-border\\/70")).toBeNull();
    expect(text).toContain("Thought"); // the thinking row keeps its own summary
    expect(text).toContain("Searched the web"); // tool row 1
    expect(text).toContain("Read a web page"); // tool row 2
    expect(container.querySelector(".tool-call-stack")).toBeTruthy();
    // No chevron glyphs anywhere.
    expect(container.querySelector("svg.lucide-chevron-right")).toBeNull();
    cleanup();
  });

  it("streaming tool turn: the AgentStatusLine is the ONE live indicator", () => {
    const { container } = render(
      React.createElement(MessageItem, { message: streamingMsg }),
    );
    const status = container.querySelector('[role="status"]');
    expect(status).toBeTruthy();
    expect(status!.textContent).toMatch(/Searching|Writing|Thinking|Working/);
    expect(container.textContent).not.toContain("Worked");
    cleanup();
  });
});
