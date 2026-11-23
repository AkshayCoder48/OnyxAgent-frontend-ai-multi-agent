// @vitest-environment jsdom
// DOM probe: the Unified Activity Bar (PRD Part A) — ONE collapsible
// container per assistant response. Covers the two user directives of
// 2026-11-23 on top of the PRD contract:
//
//   1. "remove the dot thinking … when ai haven't generated anything" —
//      a streaming turn with ZERO generated parts renders NOTHING (no
//      pulsing dot, no "Thinking" label); the UI appears with the first
//      real part.
//   2. "collapsing that thing while ai writing something is not working —
//      fix it" — the summary row toggles the fold AT ANY TIME, including
//      MID-STREAM; only the live↔settled transitions and the approval
//      gate override the user's click.
import { describe, it, expect, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import { MessageItem } from "./message-item";
import type { ChatMessage } from "@/types";

vi.mock("@/hooks/use-data", () => ({
  useProviders: () => ({ providers: [] }),
}));

const toolPart = (
  id: string,
  name: string,
  args: Record<string, unknown>,
  status: string,
  startedAt?: number,
  endedAt?: number,
) => ({
  id,
  type: "tool",
  toolCall: { id: `tc-${id}`, name, args, status, result: "{}", startedAt, endedAt },
});

// Settled multi-tool turn (the PRD's own worked example shape): thinking
// run → two completed tools → answer text. Stamps give the fallback
// duration (first 1000 → last 4100 = 3.1s → "Worked 3s").
const settledMsg = {
  id: "m1",
  role: "assistant",
  content: "Here is the answer.",
  isStreaming: false,
  createdAt: new Date().toISOString(),
  conversationId: "c1",
  parts: [
    { id: "p-think", type: "thinking", content: "Let me search.", roundStartedAt: 1000, reasoningEndedAt: 2500 },
    toolPart("p-t1", "web_search", { query: "weather" }, "completed", 2600, 3200),
    toolPart("p-t2", "web_fetch", { url: "https://example.com" }, "completed", 3300, 4100),
    { id: "p-text", type: "text", content: "Here is the answer.", roundStartedAt: 4200, roundEndedAt: 5000 },
  ],
} as unknown as ChatMessage;

// LIVE turn mid-write: one settled tool + the answer text streaming at
// the tail (caption "Writing · Used 1 tool").
const streamingMsg = {
  ...settledMsg,
  id: "m2",
  isStreaming: true,
  parts: [
    toolPart("p-t1", "web_search", { query: "weather" }, "completed", 2600, 3200),
    { id: "p-text", type: "text", content: "Answering now", roundStartedAt: 4200 },
  ],
} as unknown as ChatMessage;

// The ZERO-GENERATION window: streaming has started, not one part exists.
const emptyStreamingMsg = {
  id: "m3",
  role: "assistant",
  content: "",
  isStreaming: true,
  createdAt: new Date().toISOString(),
  conversationId: "c1",
  parts: [],
} as unknown as ChatMessage;

// A turn paused at the approval gate: the interactive card must stay
// visible — the fold click cannot hide it.
const approvalMsg = {
  ...settledMsg,
  id: "m4",
  isStreaming: true,
  content: "",
  parts: [toolPart("p-t1", "run_terminal", { command: "rm -rf /tmp/probe" }, "awaiting_approval", 2600)],
} as unknown as ChatMessage;

const header = (container: HTMLElement) =>
  container.querySelector('[aria-label^="Activity —"]');
const panel = (container: HTMLElement) =>
  container.querySelector(".activity-bar .mb-collapse");

describe("Unified Activity Bar (PRD Part A)", () => {
  it("settled tool turn: rests FOLDED on the Worked summary; one click expands the timeline", () => {
    const { container } = render(
      React.createElement(MessageItem, { message: settledMsg }),
    );
    const text = container.textContent ?? "";
    // The dynamic settled summary (stamps → duration + tool units).
    expect(text).toContain("Worked 3s");
    expect(text).toContain("Used 2 tools");
    const h = header(container)!;
    expect(h).toBeTruthy();
    expect(h.getAttribute("aria-expanded")).toBe("false"); // auto-folded on settle
    // The timeline rows stay mounted behind the fold.
    expect(text).toContain("Searched the web");
    expect(panel(container)!.getAttribute("data-open")).toBe("false");
    fireEvent.click(h);
    expect(h.getAttribute("aria-expanded")).toBe("true");
    expect(panel(container)!.getAttribute("data-open")).toBe("true");
    cleanup();
  });

  it("live turn: opens narrating; MANUAL COLLAPSE works mid-stream (user directive 2026-11-23)", () => {
    const { container } = render(
      React.createElement(MessageItem, { message: streamingMsg }),
    );
    const h = header(container)!;
    expect(h).toBeTruthy();
    // Live caption narrates the tail (text streaming) + the tool count.
    expect(h.getAttribute("aria-label")).toMatch(/Activity — Writing.*Used 1 tool/);
    // Mounted live → the timeline narrates itself…
    expect(h.getAttribute("aria-expanded")).toBe("true");
    expect(panel(container)!.getAttribute("data-open")).toBe("true");
    // …and the user's click folds it MID-STREAM (the fix).
    fireEvent.click(h);
    expect(h.getAttribute("aria-expanded")).toBe("false");
    expect(panel(container)!.getAttribute("data-open")).toBe("false");
    // …and re-expands on the next click.
    fireEvent.click(h);
    expect(h.getAttribute("aria-expanded")).toBe("true");
    expect(panel(container)!.getAttribute("data-open")).toBe("true");
    cleanup();
  });

  it("zero-generation window: NOTHING before the first part — no dot, no 'Thinking' (user directive 2026-11-23)", () => {
    const { container } = render(
      React.createElement(MessageItem, { message: emptyStreamingMsg }),
    );
    // No activity bar, no status line, no "Thinking" dot — the turn is
    // blank until the AI actually generates something.
    expect(header(container)).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector(".activity-bar")).toBeNull();
    expect(container.textContent ?? "").not.toContain("Thinking");
    cleanup();
  });

  it("approval gate: an awaiting_approval tool PINS the timeline open — the fold click cannot hide it", () => {
    const { container } = render(
      React.createElement(MessageItem, { message: approvalMsg }),
    );
    const h = header(container)!;
    expect(h).toBeTruthy();
    expect(h.getAttribute("aria-expanded")).toBe("true");
    expect(panel(container)!.getAttribute("data-open")).toBe("true");
    fireEvent.click(h); // pinned: the interactive card must not fold away
    expect(h.getAttribute("aria-expanded")).toBe("true");
    expect(panel(container)!.getAttribute("data-open")).toBe("true");
    cleanup();
  });
});
