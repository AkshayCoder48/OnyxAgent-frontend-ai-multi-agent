// @vitest-environment jsdom
// ComposerTodoPanel — the connected "Plan" dock above the prompt box
// (user-uploaded design): progress header, live status rows, expand /
// collapse, and the settle contract (auto-expand on activity, auto-fold
// when the plan completes).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { act } from "react";
import React from "react";
import { ComposerTodoPanel } from "./composer-todo-panel";
import { useResearchStore } from "@/stores";
import { persistTodos } from "@/lib/tools/todos";
import type { Todo } from "@/types";

vi.mock("@/lib/tools/todos", () => ({
  persistTodos: vi.fn().mockResolvedValue(undefined),
}));

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
    byTurn: { [turnId]: { todos: [], agentTodos: todos } },
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
    const { getByText, getAllByRole } = render(<ComposerTodoPanel />);
    expect(getByText("Plan")).toBeTruthy();
    expect(getByText("1 of 3 complete")).toBeTruthy();
    expect(getByText("Sync repo + verify test baseline")).toBeTruthy();
    // Every todo row is a toggle button.
    const rows = getAllByRole("button").filter(
      (el) => el.getAttribute("aria-pressed") !== null,
    );
    expect(rows.length).toBe(3);
  });

  it("active plan mounts EXPANDED; header collapses on click", () => {
    seed(PLAN);
    const { getByRole } = render(<ComposerTodoPanel />);
    const header = getByRole("button", { name: /plan/i }) as HTMLElement;
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("header toggles via keyboard (Enter + Space)", () => {
    seed(PLAN);
    const { getByRole } = render(<ComposerTodoPanel />);
    const header = getByRole("button", { name: /plan/i });
    fireEvent.keyDown(header, { key: "Enter" });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(header, { key: " " });
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("tapping a row flips its status in the store + persists the snapshot", () => {
    seed(PLAN);
    const { getByText } = render(<ComposerTodoPanel />);
    const row = getByText("Single API-keys tab with platform logos");
    fireEvent.click(row);

    const next = useResearchStore.getState().byTurn["conv-1"]!.agentTodos!;
    expect(next.find((t) => t.id === "t3")!.status).toBe("done");
    expect(persistTodos).toHaveBeenCalledWith("conv-1", next);
    // Progress header follows the live store.
    expect(getByText("2 of 3 complete")).toBeTruthy();
  });

  it("tapping a done row un-completes it", () => {
    seed(PLAN);
    const { getByText } = render(<ComposerTodoPanel />);
    fireEvent.click(getByText("Sync repo + verify test baseline"));
    const next = useResearchStore.getState().byTurn["conv-1"]!.agentTodos!;
    expect(next.find((t) => t.id === "t1")!.status).toBe("not_planned");
  });

  it("done rows read as struck-through + muted; active rows pulse", () => {
    seed(PLAN);
    const { getByText } = render(<ComposerTodoPanel />);
    const doneText = getByText("Sync repo + verify test baseline");
    expect(doneText.className).toContain("line-through");
    // The in_progress row carries the pulsing accent dot.
    const activeRow = getByText("Fix python tool output when collapsed").closest("button")!;
    expect(activeRow.querySelector(".animate-pulse")).not.toBeNull();
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
    const header = getByRole("button", { name: /plan/i });
    expect(header.getAttribute("aria-expanded")).toBe("false");

    // The agent starts a new step → the panel re-opens.
    act(() => {
      seed([todo("a", "Only step", "done"), todo("b", "New step", "in_progress")]);
    });
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("no turn id → buckets into 'default' without persisting", () => {
    useResearchStore.setState({
      currentTurnId: null,
      byTurn: { default: { todos: [], agentTodos: PLAN } },
    });
    const { getByText } = render(<ComposerTodoPanel />);
    fireEvent.click(getByText("Sync repo + verify test baseline"));
    const next = useResearchStore.getState().byTurn["default"]!.agentTodos!;
    expect(next.find((t) => t.id === "t1")!.status).toBe("not_planned");
    expect(persistTodos).not.toHaveBeenCalled();
  });
});
