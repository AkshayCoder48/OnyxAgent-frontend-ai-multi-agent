// @vitest-environment jsdom
// DOM probe: the inline flow (PRD §3.1) — no "Worked Ns" trigger line, no
// separator rail; thinking rows + tool stacks render naturally; the
// streaming status line is the ONE live indicator.
//
// COMBINED TOOLS ROW (user screenshots 2026-11-13): a settled multi-tool
// stack now rests as ONE "Used N tools ›" disclosure (chevron included —
// the summary row is the one place a chevron lives); the individual rows
// stay mounted inside the folded panel.
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
  it("settled tool turn: NO Worked line, NO rail; combined rows + thought row render", () => {
    const { container } = render(
      React.createElement(MessageItem, { message: settledMsg }),
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain("Worked");
    expect(container.querySelector(".border-l.border-border\\/70")).toBeNull();
    expect(text).toContain("Thought"); // the thinking row keeps its own summary
    // The two-tool stack rests as the combined per-tool summary row
    // (web_search + web_fetch → "Ran 1 Web Search · Fetched 1 Page")…
    expect(text).toContain("Ran 1 Web Search · Fetched 1 Page");
    // …with the individual rows folded behind it (still mounted).
    expect(text).toContain("Searched the web");
    expect(text).toContain("Read a web page");
    expect(container.querySelector(".tool-call-stack")).toBeTruthy();
    // The combined row carries the chevron (the ONLY chevron in the flow).
    expect(container.querySelector("svg.lucide-chevron-right")).not.toBeNull();
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
    // A single settled tool renders as its bare row — no group summary.
    expect(container.textContent).not.toMatch(/\d+ tools/);
    cleanup();
  });
});
