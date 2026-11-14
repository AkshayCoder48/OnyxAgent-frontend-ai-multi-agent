// @vitest-environment jsdom
// ComposerTodoPanel — the connected "Todos" dock above the prompt box
// (user-uploaded design): progress header, AGENT-OWNED status glyphs
// (2026-11-14: no manual ticking — pending/in_progress show the striped
// loading ring, done shows the tick), expand / collapse, the settle
// contract, and the vanish-with-motion-blur exit when the list clears.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { act } from "react";
import React from "react";
import { ComposerTodoPanel } from "./composer-todo-panel";
import { useResearchStore } from "@/stores";
import type { Todo } from "@/types";

const todo = (id: string, title: string, status: Todo["status"]): Todo => ({
  id,
  title,
  status,
  createdAt: 1,
  updatedAt: 1,
});

const seed = (todos: Todo[], turnId = "conv-1") => {
  useResearchStore.setState({
    currentTurnId: turnId,
    byTurn: { [turnId]: { agentTodos: todos } },
  });
};

const PLAN = [
  todo("t1", "Sync repo + verify test baseline", "done"),
  todo("t2", "Fix python tool output when collapsed", "in_progress"),
  todo("t3", "Single API-keys tab with platform logos", "not_planned"),
];

describe("ComposerTodoPanel (connected plan dock)", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    useResearchStore.setState({ byTurn: {}, currentTurnId: null });
  });

  it("renders nothing when the conversation has no plan", () => {
    seed([]);
    const { container } = render(<ComposerTodoPanel />);
    expect(container.firstElementChild).toBeNull();
  });

  it("shows the plan rows + 'N of M complete' progress", () => {
    seed(PLAN);
    const { getByText } = render(<ComposerTodoPanel />);
    expect(getByText("Todos")).toBeTruthy();
    expect(getByText("1 of 3 complete")).toBeTruthy();
    expect(getByText("Sync repo + verify test baseline")).toBeTruthy();
  });

  it("rows are READ-ONLY — no toggle buttons, clicks never flip the store", () => {
    seed(PLAN);
    const { getByText, getAllByRole } = render(<ComposerTodoPanel />);
    // Only the header is a button.
    const buttons = getAllByRole("button");
    expect(buttons.length).toBe(1);
    expect(buttons[0]!.getAttribute("aria-expanded")).not.toBeNull();
    // Clicking a row text does nothing to the store.
    fireEvent.click(getByText("Single API-keys tab with platform logos"));
    const next = useResearchStore.getState().byTurn["conv-1"]!.agentTodos!;
    expect(next.find((t) => t.id === "t3")!.status).toBe("not_planned");
  });

  it("STATUS GLYPHS: pending + in_progress show the striped spinner, done the tick", () => {
    seed([
      todo("t1", "Done step", "done"),
      todo("t2", "Active step", "in_progress"),
      todo("t3", "Pending step", "not_planned"),
      todo("t4", "Failed step", "not_done"),
    ]);
    const { container, getByText } = render(<ComposerTodoPanel />);
    // Two striped spinners: one accent (in_progress), one muted (pending).
    const spinners = container.querySelectorAll(".striped-spinner");
    expect(spinners.length).toBe(2);
    expect(
      container.querySelectorAll('.striped-spinner[data-accent="true"]').length,
    ).toBe(1);
    // Done row: struck through.
    expect(getByText("Done step").className).toContain("line-through");
    // Failed row keeps the destructive cross glyph.
    expect(container.querySelectorAll("[data-glyph='failed']").length).toBe(1);
  });

  it("active plan mounts EXPANDED; header collapses on click", () => {
    seed(PLAN);
    const { getByRole } = render(<ComposerTodoPanel />);
    const header = getByRole("button", { name: /todos/i }) as HTMLElement;
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("header toggles via keyboard (Enter + Space)", () => {
    seed(PLAN);
    const { getByRole } = render(<ComposerTodoPanel />);
    const header = getByRole("button", { name: /todos/i });
    fireEvent.keyDown(header, { key: "Enter" });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(header, { key: " " });
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("SETTLE CONTRACT: a fully-done plan mounts COLLAPSED (no dead chrome)", () => {
    seed([
      todo("a", "Step one", "done"),
      todo("b", "Step two", "done"),
    ]);
    const { getByRole } = render(<ComposerTodoPanel />);
    const header = getByRole("button", { name: /2 of 2 complete/i });
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("SETTLE CONTRACT: activity after settle re-expands the panel", () => {
    seed([todo("a", "Only step", "done")]);
    const { getByRole } = render(<ComposerTodoPanel />);
    const header = getByRole("button", { name: /todos/i });
    expect(header.getAttribute("aria-expanded")).toBe("false");

    // The agent starts a new step → the panel re-opens.
    act(() => {
      seed([todo("a", "Only step", "done"), todo("b", "New step", "in_progress")]);
    });
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("VANISH ON CLEAR: emptying the list plays the motion-blur exit, then unmounts", () => {
    vi.useFakeTimers();
    try {
      seed(PLAN);
      const { container } = render(<ComposerTodoPanel />);
      expect(container.firstElementChild).not.toBeNull();

      // The agent clears the list (clear_todo / manage_todo clear).
      act(() => {
        seed([]);
      });

      // Snapshot still mounted, playing .mb-object-out, hidden from a11y.
      const panel = container.firstElementChild as HTMLElement;
      expect(panel.className).toContain("mb-object-out");
      expect(panel.getAttribute("aria-hidden")).toBe("true");
      // The frozen snapshot still shows the last rows.
      expect(container.textContent).toContain("Sync repo + verify test baseline");

      // After the exit duration the panel unmounts.
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(container.firstElementChild).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("no turn id → buckets into 'default' (rows render, no crash)", () => {
    useResearchStore.setState({
      currentTurnId: null,
      byTurn: { default: { agentTodos: PLAN } },
    });
    const { getByText } = render(<ComposerTodoPanel />);
    expect(getByText("1 of 3 complete")).toBeTruthy();
  });
});
