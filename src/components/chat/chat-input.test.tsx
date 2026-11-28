// @vitest-environment jsdom
// Composer (PRD §5) — the redesigned structure: full-width textarea +
// bottom control bar; NO Live pill, NO Context indicator, NO ⏎ hint, NO
// separator strip; offline chip appears only when disconnected; send ⇄
// stop morph lives in one slot; attachments stagger.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ChatInput } from "./chat-input";
import { PromptTypingMirror } from "./prompt-typing-mirror";

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

  // ── CARET ALIGNMENT (Task 50 — "cursor drifts progressively from the
  // text while typing, moves closer on backspace") ──────────────────────
  // The textarea paints transparent glyphs while the mirror div paints the
  // visible text — the NATIVE caret still positions itself against the
  // TEXTAREA's layout. The mirror must therefore be layout-identical to the
  // textarea, or the caret visually drifts from the painted text. The old
  // per-char inline-block spans broke the text-shaping run at every span
  // boundary (no kerning/ligatures across atomic inlines, per-span rounded
  // advance widths) — each typed span added another micro-divergence
  // (progressive drift while typing) and any deletion collapsed the value
  // into one static text node (drift snapped back). Exactly the report.

  describe("caret alignment: the mirror must be layout-identical to the textarea", () => {
    // jsdom has no text layout/shaping engine, so the core guarantee can't
    // be measured directly — pin the STRUCTURAL contracts that produce it:
    // the CSS rule (inline spans + top-based rise + gutter parity) and the
    // DOM class wiring. A regression to inline-block or a removed gutter
    // class fails here instead of shipping the drift back.
    const css = readFileSync(
      resolve(process.cwd(), "src/app/globals.css"),
      "utf8",
    );

    it(".prompt-char-in is INLINE (never inline-block) — atomic inlines broke kerning/shaping", () => {
      const rule = css.slice(
        css.indexOf(".prompt-char-in {"),
        css.indexOf("}", css.indexOf(".prompt-char-in {")),
      );
      // Declarations only — strip comments so the explanatory prose
      // ("never make this inline-block") can't trip the pin.
      const decls = rule.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(decls).toMatch(/display:\s*inline\s*;/);
      expect(decls).not.toMatch(/inline-block/);
      expect(decls).toMatch(/position:\s*relative\s*;/);
    });

    it("the char-rise keyframe animates `top`, not transform (transforms are ignored on inline boxes)", () => {
      const start = css.indexOf("@keyframes prompt-char-in");
      // Slice to the keyframe's closing brace (this keyframe uses
      // from/to, not 0%/100% — slicing to "100%" overran into unrelated
      // rules and tripped on their transforms).
      const end = css.indexOf("\n}", start);
      const kf = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
      expect(kf).toMatch(/top:\s*0\.12em\s*;/);
      expect(kf).not.toMatch(/transform/);
    });

    it("both mirror-pair elements share the scrollbar-gutter contract", () => {
      // The textarea reserves its gutter (stable)… (declarations only —
      // the explanatory comments between selector and block are stripped)
      const scrollRule = css
        .slice(
          css.indexOf(".prompt-mirror-scroll"),
          css.indexOf("}", css.indexOf(".prompt-mirror-scroll")),
        )
        .replace(/\/\*[\s\S]*?\*\//g, "");
      expect(scrollRule).toMatch(/scrollbar-gutter:\s*stable\s*;/);
      // …and the mirror (overflow:hidden) reserves the same 8px as
      // padding, so wrap positions match past the 200px scroll cap.
      const gutterRule = css
        .slice(
          css.indexOf(".prompt-mirror-gutter"),
          css.indexOf("}", css.indexOf(".prompt-mirror-gutter")),
        )
        .replace(/\/\*[\s\S]*?\*\//g, "");
      expect(gutterRule).toMatch(/padding-right:\s*8px\s*;/);
    });

    it("the DOM wires the gutter classes onto the mirror pair", () => {
      const { container } = setup();
      const textarea = screen.getByLabelText(/Reply to OnyxAgent/);
      fireEvent.change(textarea, { target: { value: "hi" } });
      const mirror = container.querySelector(".prompt-mirror-gutter");
      expect(mirror).toBeTruthy();
      expect(textarea.className).toContain("prompt-mirror-scroll");
    });

    it("external value changes (dictation/quote/command reset) sync the boundary — the next keystroke must not compare against a stale prev", () => {
      // Regression shape: the value can change WITHOUT a change event —
      // dictation appends via setMessage, a quoted reply lands from the
      // store. The old code kept prevRef from the last keystroke, so the
      // next keystroke's typed-tail check ran against an ancient value
      // (re-animating already-shown chars / colliding span keys).
      //
      // Harness mirrors the real owner (ChatInput): value lives in a
      // parent, typing arrives as a textarea CHANGE event, external
      // changes arrive as parent state updates — the two paths the
      // boundary sync must tell apart.
      let setText: (v: string) => void = () => {};
      function Harness() {
        const [text, set] = React.useState("hello");
        setText = set;
        return React.createElement(PromptTypingMirror, {
          textareaRef: { current: null },
          value: text,
          onChange: set,
          onKeyDown: () => {},
          ariaLabel: "test",
        });
      }
      render(React.createElement(Harness));
      const textarea = screen.getByLabelText("test");

      // 1) TYPING: "h","e"… already past ("hello"), then type "!" → the
      //    keystroke path animates the fresh char.
      act(() => {
        fireEvent.change(textarea, { target: { value: "hello!" } });
      });
      expect(document.querySelectorAll(".prompt-char-in").length).toBe(1);

      // 2) EXTERNAL: dictation appends a chunk via setMessage — NOT a
      //    change event. The boundary must swallow it (static, no burst)
      //    and, critically, sync prevRef.
      act(() => {
        setText("hello! here is a long dictation transcript");
      });
      expect(document.querySelectorAll(".prompt-char-in").length).toBe(0);

      // 3) TYPING AGAIN after the external change: with the stale-prevRef
      //    bug, "…transcript" + "!" failed the typed-tail check against
      //    "hello!" and the boundary jumped mid-word. With the sync, the
      //    new keystroke animates exactly the fresh char.
      act(() => {
        fireEvent.change(textarea, {
          target: { value: "hello! here is a long dictation transcript!" },
        });
      });
      const spans = document.querySelectorAll(".prompt-char-in");
      expect(spans.length).toBe(1);
      expect(spans[0]!.textContent).toBe("!");
    });
  });
});
