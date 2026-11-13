// @vitest-environment jsdom
// ToolStackGroup — the COMBINED TOOLS row (user screenshots 2026-11-13):
// a settled run of consecutive tool calls rests as ONE "Used N tools ›"
// disclosure; live runs and single-tool stacks render their rows bare.
import { describe, it, expect } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import { ToolStackGroup } from "./tool-stack-group";
import type { ToolCall } from "@/types";

const tc = (id: string, status: ToolCall["status"], name = "web_search"): ToolCall =>
  ({
    id,
    name,
    args: {},
    status,
    result: "{}",
    startedAt: 1000,
    endedAt: 2000,
  }) as unknown as ToolCall;

const Row = ({ label }: { label: string }) => <div data-testid="row">{label}</div>;

describe("ToolStackGroup (combined tools UI)", () => {
  it("settled multi-tool stack rests as the collapsed 'Used N tools' row with a chevron", () => {
    const { container, getByText } = render(
      <ToolStackGroup toolCalls={[tc("a", "completed"), tc("b", "completed")]}>
        <Row label="Searched the web" />
        <Row label="Read a web page" />
      </ToolStackGroup>,
    );
    expect(getByText("Used 2 tools")).toBeTruthy();
    // The chevron disclosure indicator — rotates when expanded.
    const chevron = container.querySelector("svg.lucide-chevron-right");
    expect(chevron).not.toBeNull();
    // Folded by default: the panel is closed and aria-expanded is false.
    const trigger = getByText("Used 2 tools").closest('[role="button"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    const panel = container.querySelector(".mb-collapse") as HTMLElement;
    expect(panel.getAttribute("data-open")).toBe("false");
    // Rows stay mounted behind the fold.
    expect(container.textContent).toContain("Searched the web");
    cleanup();
  });

  it("tapping the summary row expands the stacked rows", () => {
    const { container, getByText } = render(
      <ToolStackGroup toolCalls={[tc("a", "completed"), tc("b", "completed")]}>
        <Row label="Searched the web" />
        <Row label="Read a web page" />
      </ToolStackGroup>,
    );
    const trigger = getByText("Used 2 tools").closest('[role="button"]')!;
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const panel = container.querySelector(".mb-collapse") as HTMLElement;
    expect(panel.getAttribute("data-open")).toBe("true");
    cleanup();
  });

  it("keyboard activation (Enter / Space) toggles the disclosure", () => {
    const { getByText } = render(
      <ToolStackGroup toolCalls={[tc("a", "completed"), tc("b", "completed")]}>
        <Row label="A" />
        <Row label="B" />
      </ToolStackGroup>,
    );
    const trigger = getByText("Used 2 tools").closest('[role="button"]')!;
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(trigger, { key: " " });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    cleanup();
  });

  it("a live stack renders its rows BARE — no summary chrome while running", () => {
    const { container } = render(
      <ToolStackGroup
        toolCalls={[tc("a", "completed"), tc("b", "running"), tc("c", "pending")]}
      >
        <Row label="Searched the web" />
        <Row label="Reading a page" />
      </ToolStackGroup>,
    );
    expect(container.textContent).not.toContain("Used");
    expect(container.querySelector(".tool-call-stack")).toBeTruthy();
    expect(container.textContent).toContain("Reading a page");
    cleanup();
  });

  it("an approval-gated call keeps the stack live (interactive card never folds)", () => {
    const { container } = render(
      <ToolStackGroup toolCalls={[tc("a", "completed"), tc("b", "awaiting_approval")]}>
        <Row label="Approve me" />
      </ToolStackGroup>,
    );
    expect(container.textContent).not.toContain("Used");
    expect(container.textContent).toContain("Approve me");
    cleanup();
  });

  it("a single settled tool renders its bare row — no 'Used 1 tool' summary", () => {
    const { container } = render(
      <ToolStackGroup toolCalls={[tc("a", "completed")]}>
        <Row label="Searched the web" />
      </ToolStackGroup>,
    );
    expect(container.textContent).not.toContain("Used 1 tool");
    expect(container.textContent).toContain("Searched the web");
    expect(container.querySelector("svg.lucide-chevron-right")).toBeNull();
    cleanup();
  });

  it("auto-folds when the stack settles, and respects a manual toggle afterwards", () => {
    const calls = [tc("a", "running"), tc("b", "pending")];
    const { container, getByText, rerender } = render(
      <ToolStackGroup toolCalls={calls}>
        <Row label="Working" />
      </ToolStackGroup>,
    );
    expect(container.textContent).not.toContain("Used");

    // The run settles → the stack folds into the summary.
    const settled = [tc("a", "completed"), tc("b", "completed")];
    rerender(
      <ToolStackGroup toolCalls={settled}>
        <Row label="Working" />
      </ToolStackGroup>,
    );
    expect(getByText("Used 2 tools")).toBeTruthy();
    let trigger = getByText("Used 2 tools").closest('[role="button"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    // Manual expand wins after the fold.
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    trigger = getByText("Used 2 tools").closest('[role="button"]')!;
    cleanup();
  });

  it("failed calls surface on the summary line", () => {
    const { container } = render(
      <ToolStackGroup toolCalls={[tc("a", "completed"), tc("b", "error"), tc("c", "completed")]}>
        <Row label="A" />
      </ToolStackGroup>,
    );
    expect(container.textContent).toContain("Used 3 tools");
    expect(container.textContent).toContain("· 1 failed");
    cleanup();
  });

  it("a browser run counts as ONE unit next to other tools", () => {
    const calls = [
      tc("b1", "completed", "use_browser"),
      tc("b2", "completed", "use_browser"), // continuation — same run
      tc("b3", "completed", "use_browser"), // continuation — same run
      tc("w", "completed", "web_search"),
    ];
    const { getByText } = render(
      <ToolStackGroup toolCalls={calls}>
        <Row label="Browser" />
        <Row label="Search" />
      </ToolStackGroup>,
    );
    expect(getByText("Used 2 tools")).toBeTruthy();
    cleanup();
  });
});
