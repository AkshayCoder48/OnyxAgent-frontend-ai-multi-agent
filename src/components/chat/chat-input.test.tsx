// @vitest-environment jsdom
// Composer (PRD §5) — the redesigned structure: full-width textarea +
// bottom control bar; NO Live pill, NO Context indicator, NO ⏎ hint, NO
// separator strip; offline chip appears only when disconnected; send ⇄
// stop morph lives in one slot; attachments stagger.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import { ChatInput } from "./chat-input";

// The composer mounts ChatControls (model popover) — stub the data hooks
// it subscribes to so the tree renders without a live backend.
vi.mock("@/hooks/use-data", () => ({
  useProviders: () => ({ providers: [] }),
}));
vi.mock("@/hooks/use-dictation", () => ({
  useDictation: () => ({
    supported: false,
    active: false,
    recording: false,
    seconds: 0,
    interim: "",
    error: null,
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

function setup(overrides: Record<string, unknown> = {}) {
  const onSend = vi.fn();
  const utils = render(
    React.createElement(ChatInput, {
      onSend,
      isConnected: true,
      ...overrides,
    }),
  );
  return { onSend, ...utils };
}

describe("composer redesign (PRD §5)", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders the bottom control bar with attach + model selector + send", () => {
    setup();
    expect(screen.getByRole("button", { name: "Attach file" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Model selector — currently Default" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
  });

  it("NO Live pill, NO Context indicator, NO ⏎ hint (§5.1)", () => {
    const { container } = setup();
    const text = container.textContent ?? "";
    expect(text).not.toContain("Live");
    expect(text).not.toContain("Context");
    expect(text).not.toContain("⏎");
    // No separator strip element between input and controls (§5.2): the
    // dock is one container — no border-t child row exists.
    expect(container.querySelector(".border-t")).toBeNull();
  });

  it("offline chip appears ONLY when disconnected", () => {
    const { rerender } = setup();
    expect(screen.queryByText("Offline")).toBeNull();

    rerender(
      React.createElement(ChatInput, { onSend: vi.fn(), isConnected: false }),
    );
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText("Offline").className).toContain("destructive");
  });

  it("send morphs to stop while processing, and back (§5.4)", () => {
    const onStop = vi.fn();
    const { rerender } = setup({ isProcessing: false, onStop });
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();

    rerender(
      React.createElement(ChatInput, {
        onSend: vi.fn(),
        isProcessing: true,
        onStop,
      }),
    );
    expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
  });

  it("Enter sends, Shift+Enter does not (keyboard contract intact)", () => {
    const { onSend } = setup();
    const textarea = screen.getByPlaceholderText(/Reply to OnyxAgent/);
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toContain("hello");
  });

  it("empty input cannot send (send stays disabled)", () => {
    const { onSend } = setup();
    const send = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const textarea = screen.getByPlaceholderText(/Reply to OnyxAgent/);
    fireEvent.change(textarea, { target: { value: "x" } });
    expect(send.disabled).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });
});
