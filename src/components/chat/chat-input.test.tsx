// @vitest-environment jsdom
// Composer (PRD §5) — the redesigned structure: full-width textarea +
// bottom control bar; NO Live pill, NO Context indicator, NO ⏎ hint, NO
// separator strip; offline chip appears only when disconnected; send ⇄
// stop morph lives in one slot; attachments stagger.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    const textarea = screen.getByLabelText(/Reply to OnyxAgent/);
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
    const textarea = screen.getByLabelText(/Reply to OnyxAgent/);
    fireEvent.change(textarea, { target: { value: "x" } });
    expect(send.disabled).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });

  // ── TYPING ANIMATION REMOVED (directive 2026-11-28: "remove chat
  // message box's typing animation and kill that auto far going cursor") ──
  // The mirror-overlay animation (transparent textarea glyphs + a painted
  // div behind) was also the ENTIRE source of the caret-drift bug family:
  // an overlay can never be guaranteed pixel-identical to the textarea's
  // internal layout — span shaping boundaries, scrollbar gutters, font
  // rendering — and every divergence showed as the caret walking away
  // from the text while typing. The composer is now a PLAIN NATIVE
  // TEXTAREA: its own glyphs, its own caret — pixel-identical by
  // construction. These tests pin that state so the overlay can never
  // silently return.

  describe("typing animation removed: plain native textarea, native caret", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/app/globals.css"),
      "utf8",
    );

    it("no mirror overlay element renders — the textarea paints its own text", () => {
      const { container } = setup();
      const textarea = screen.getByLabelText(/Reply to OnyxAgent/);
      fireEvent.change(textarea, { target: { value: "hello world" } });
      // No overlay div behind the textarea, no animated char spans.
      expect(container.querySelector(".prompt-mirror-gutter")).toBeNull();
      expect(container.querySelectorAll(".prompt-char-in").length).toBe(0);
      // The textarea itself is the only text surface — fully native.
      expect((textarea as HTMLTextAreaElement).value).toBe("hello world");
      // …and it does NOT enter transparent-glyph mode (the mode that made
      // the overlay paint the text while the native caret floated over
      // a different layout — the drift).
      expect(textarea.className).not.toContain("prompt-mirror-text");
    });

    it("typing, deleting, pasting all stay native — value is the single source of truth", () => {
      setup();
      const textarea = screen.getByLabelText(/Reply to OnyxAgent/) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "h" } });
      fireEvent.change(textarea, { target: { value: "he" } });
      fireEvent.change(textarea, { target: { value: "hello world, typed fast" } });
      expect(textarea.value).toBe("hello world, typed fast");
      fireEvent.change(textarea, { target: { value: "hello world, typed" } });
      expect(textarea.value).toBe("hello world, typed");
      fireEvent.change(textarea, { target: { value: "" } });
      expect(textarea.value).toBe("");
    });

    it("the mirror component and its CSS are gone from the codebase (drift source removed)", () => {
      // The component file is deleted…
      expect(() =>
        readFileSync(resolve(process.cwd(), "src/components/chat/prompt-typing-mirror.tsx")),
      ).toThrow();
      // …and none of the mirror CSS classes survive in the stylesheet.
      expect(css).not.toContain(".prompt-char-in");
      expect(css).not.toContain(".prompt-mirror-text");
      expect(css).not.toContain(".prompt-mirror-gutter");
    });

    it("the native placeholder renders on the empty composer (no overlay suggestions)", () => {
      const { container } = setup();
      const textarea = screen.getByLabelText(/Reply to OnyxAgent/) as HTMLTextAreaElement;
      expect(textarea.placeholder).toContain("Reply to OnyxAgent");
      const text = container.textContent ?? "";
      expect(text).not.toContain("Ask Onyx anything");
      expect(text).not.toContain("Build a complete website");
      expect(container.querySelector(".activity-bar")).toBeNull();
    });
  });
});
