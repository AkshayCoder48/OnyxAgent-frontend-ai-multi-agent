// @vitest-environment jsdom
/**
 * BranchPicker — the ‹ i/n › switcher (CHAT BRANCHES, 2026-11-05).
 * Borrowed interaction model from assistant-ui's BranchPickerPrimitive
 * (previous / count / next) — hand-built because no assistant-ui runtime
 * is wired in this app.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { BranchPicker } from "./branch-picker";

function renderPicker(props: Partial<Parameters<typeof BranchPicker>[0]> = {}) {
  const { render } = require("@testing-library/react") as typeof import("@testing-library/react");
  return render(
    <BranchPicker index={2} count={3} onPrev={vi.fn()} onNext={vi.fn()} {...props} />,
  );
}

describe("BranchPicker", () => {
  it("renders the position and wires prev/next", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    renderPicker({ onPrev, onNext });
    expect(screen.getByText("2/3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous variant" }));
    expect(onPrev).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Next variant" }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("single-sibling groups render nothing", () => {
    const { container } = renderPicker({ index: 1, count: 1 });
    expect(container.firstChild).toBeNull();
  });

  it("edges disable the matching direction (no wrap-around)", () => {
    renderPicker({ index: 1, count: 3 });
    expect(screen.getByRole("button", { name: "Previous variant" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next variant" })).toBeEnabled();
  });

  it("the last position disables next", () => {
    renderPicker({ index: 3, count: 3 });
    expect(screen.getByRole("button", { name: "Previous variant" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next variant" })).toBeDisabled();
  });

  it("disabled blocks both directions (live-turn guard)", () => {
    renderPicker({ disabled: true });
    expect(screen.getByRole("button", { name: "Previous variant" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next variant" })).toBeDisabled();
    // the position stays visible + readable while disabled
    expect(screen.getByText("2/3")).toBeInTheDocument();
  });

  it("carries an accessible group label", () => {
    renderPicker({ label: "edit" });
    expect(screen.getByRole("group", { name: "Message edit 2 of 3" })).toBeInTheDocument();
  });
});
