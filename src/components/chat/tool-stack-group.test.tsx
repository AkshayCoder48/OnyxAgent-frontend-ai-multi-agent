// @vitest-environment jsdom
// ToolStackGroup — the COMBINED TOOLS row (user screenshots 2026-11-13;
// caption directive 2026-11-14: "docs icon + 'Created N Files, Used N
// Tools, Created N Todos' — for every tool; custom tools show Used N
// Tools"): a settled run of consecutive tool calls rests as ONE disclosure
// row whose caption aggregates WHAT the run did; live runs and single-tool
// stacks render their rows bare.
import { describe, it, expect } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import { ToolStackGroup, stackSummary } from "./tool-stack-group";
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

/** A create_file call with a target path + a landed/error result. */
const fileCreate = (id: string, path: string, ok = true): ToolCall =>
  ({
    id,
    name: "create_file",
    args: { path },
    status: "completed",
    result: ok ? '{"ok":true}' : '{"error":"disk full"}',
    startedAt: 1000,
    endedAt: 2000,
  }) as unknown as ToolCall;

/** A manage_todo create call — the user's "Created N Todos" example. */
const todoCreate = (id: string): ToolCall =>
  ({
    id,
    name: "manage_todo",
    args: { title: `Step ${id}` },
    status: "completed",
    result: '{"success":true}',
    startedAt: 1000,
    endedAt: 2000,
  }) as unknown as ToolCall;

const Row = ({ label }: { label: string }) => <div data-testid="row">{label}</div>;

describe("ToolStackGroup (combined tools UI)", () => {
  it("settled multi-tool stack rests as the collapsed summary row with a chevron", () => {
    const { container, getByText } = render(
      <ToolStackGroup toolCalls={[tc("a", "completed"), tc("b", "completed")]}>
        <Row label="Searched the web" />
        <Row label="Read a web page" />
      </ToolStackGroup>,
    );
    expect(getByText("Ran 2 Web Searches")).toBeTruthy();
    // Known tools never fall into the generic "Used" bucket.
    expect(container.textContent).not.toContain("Used");
    // The chevron disclosure indicator — rotates when expanded.
    const chevron = container.querySelector("svg.lucide-chevron-right");
    expect(chevron).not.toBeNull();
    // Folded by default: the panel is closed and aria-expanded is false.
    const trigger = getByText("Ran 2 Web Searches").closest('[role="button"]')!;
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
    const trigger = getByText("Ran 2 Web Searches").closest('[role="button"]')!;
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
    const trigger = getByText("Ran 2 Web Searches").closest('[role="button"]')!;
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
    expect(container.textContent).not.toContain("Web Searches");
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
    expect(container.textContent).not.toContain("Web Searches");
    expect(container.textContent).toContain("Approve me");
    cleanup();
  });

  it("a single settled tool renders its bare row — no group chrome", () => {
    const { container } = render(
      <ToolStackGroup toolCalls={[tc("a", "completed")]}>
        <Row label="Searched the web" />
      </ToolStackGroup>,
    );
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
    expect(container.textContent).not.toContain("Web Searches");

    // The run settles → the stack folds into the summary.
    const settled = [tc("a", "completed"), tc("b", "completed")];
    rerender(
      <ToolStackGroup toolCalls={settled}>
        <Row label="Working" />
      </ToolStackGroup>,
    );
    expect(getByText("Ran 2 Web Searches")).toBeTruthy();
    let trigger = getByText("Ran 2 Web Searches").closest('[role="button"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    // Manual expand wins after the fold.
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    trigger = getByText("Ran 2 Web Searches").closest('[role="button"]')!;
    cleanup();
  });

  it("failed calls surface on the summary line — the one destructive number", () => {
    const { container } = render(
      <ToolStackGroup toolCalls={[tc("a", "completed"), tc("b", "error"), tc("c", "completed")]}>
        <Row label="A" />
      </ToolStackGroup>,
    );
    expect(container.textContent).toContain("Ran 2 Web Searches");
    expect(container.textContent).toContain("1 failed");
    cleanup();
  });

  it("stackSummary: per-tool captions (the 2026-11-14 directive)", () => {
    // File work aggregates per verb.
    expect(
      stackSummary([
        fileCreate("a", "src/App.tsx"),
        fileCreate("b", "src/lib.ts"),
        { ...tc("e", "completed", "edit_file"), args: { path: "README.md" } },
      ]),
    ).toBe("Created 2 Files · Edited 1 File");
    // The user's exact example — todo creations read "Created N Todos".
    expect(stackSummary([todoCreate("a"), todoCreate("b"), todoCreate("c")])).toBe(
      "Created 3 Todos",
    );
    // Failures keep their count and never read as work done.
    expect(stackSummary([tc("a", "completed"), tc("b", "error")])).toBe(
      "Ran 1 Web Search · 1 failed",
    );
    // Nothing landed at all → the plain label + failures.
    expect(stackSummary([tc("a", "error"), tc("b", "error")])).toBe("Tools · 2 failed");
    cleanup();
  });
});
