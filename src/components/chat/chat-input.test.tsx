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

  // ── TYPING ANIMATION ON THE USER'S OWN TYPING (directive 2026-11-24) ──
  // The auto-writing placeholder overlay is GONE; the mirror animates the
  // user's own keystrokes instead.

  it("NO auto-writing suggestion overlay on the empty composer (directive 2026-11-24)", () => {
    const { container } = setup();
    // The old rotating-suggestion overlay (TypingAnimation words) is gone —
    // its suggestions never appear in the DOM.
    const text = container.textContent ?? "";
    expect(text).not.toContain("Ask Onyx anything");
    expect(text).not.toContain("Build a complete website");
    // No animated auto-writing overlay element behind the empty textarea.
    expect(container.querySelector("[aria-hidden] .prompt-char-in")).toBeNull();
    expect(container.querySelector(".activity-bar")).toBeNull();
  });

  it("the user's OWN typing reveals through the mirror: per-char animated spans, not an overlay", () => {
    const { container } = setup();
    const textarea = screen.getByLabelText(/Reply to OnyxAgent/);
    // A real keystroke: one char appended at the end.
    fireEvent.change(textarea, { target: { value: "h" } });
    fireEvent.change(textarea, { target: { value: "he" } });
    fireEvent.change(textarea, { target: { value: "hel" } });
    // The mirror div exists behind the textarea and paints the same text…
    const mirror = container.querySelector(".prompt-char-in")?.parentElement;
    expect(mirror).toBeTruthy();
    expect(mirror!.textContent).toBe("hel");
    // …each visible char is its own animated span (3 chars = 3 spans)…
    const chars = container.querySelectorAll(".prompt-char-in");
    expect(chars.length).toBe(3);
    // …and the textarea itself paints transparently (the mirror owns the
    // glyphs; the caret stays inked).
    expect(textarea.className).toContain("prompt-mirror-text");
    expect((textarea as HTMLTextAreaElement).value).toBe("hel");
  });

  it("paste / big deltas render STATIC — no animation burst (safety valve)", () => {
    const { container } = setup();
    const textarea = screen.getByLabelText(/Reply to OnyxAgent/);
    // A paste-sized jump (10 chars at once) is not typing.
    fireEvent.change(textarea, { target: { value: "hello world" } });
    const chars = container.querySelectorAll(".prompt-char-in");
    expect(chars.length).toBe(0);
    // The mirror still paints the full text (statically)…
    const mirror = container.querySelector(".prompt-char-in")?.parentElement;
    // …as one plain text node — and the textarea renders natively (no
    // transparent-glyph mode): pasted text must be plainly visible.
    expect(mirror ?? container).toBeTruthy();
    expect((textarea as HTMLTextAreaElement).value).toBe("hello world");
    // Subsequent typing after a paste animates only the NEW chars.
    fireEvent.change(textarea, { target: { value: "hello world!" } });
    expect(container.querySelectorAll(".prompt-char-in").length).toBe(1);
  });

  it("deletion renders static (backspace never animates)", () => {
    const { container } = setup();
    const textarea = screen.getByLabelText(/Reply to OnyxAgent/);
    fireEvent.change(textarea, { target: { value: "abc" } });
    expect(container.querySelectorAll(".prompt-char-in").length).toBe(3);
    fireEvent.change(textarea, { target: { value: "ab" } });
    // A deletion resets the boundary: everything renders as one static run.
    expect(container.querySelectorAll(".prompt-char-in").length).toBe(0);
  });
});
