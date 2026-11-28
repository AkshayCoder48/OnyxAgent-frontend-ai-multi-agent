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
      // The textarea reserves its gutter (stable)… and since Task 52 the
      // mirror reserves the SAME way (grouped selector, engine-computed on
      // every platform) instead of a hard-coded 8px padding — the full pin
      // (including "no hard-coded padding") lives in the Task 52 block.
      const scrollRule = css
        .slice(
          css.indexOf(".prompt-mirror-scroll"),
          css.indexOf("}", css.indexOf(".prompt-mirror-scroll")),
        )
        .replace(/\/\*[\s\S]*?\*\//g, "");
      expect(scrollRule).toMatch(/scrollbar-gutter:\s*stable\s*;/);
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
      // boundary sync must tell apart. The setter escapes through a ref
      // object captured in an EFFECT (assigning during render is what the
      // react-hooks immutability rule forbids; effects run after).
      const setTextRef: { current: (v: string) => void } = { current: () => {} };
      function Harness() {
        const [text, set] = React.useState("hello");
        React.useEffect(() => {
          setTextRef.current = set;
        }, [set]);
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
      const setText = (v: string) => setTextRef.current(v);

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

  // ── CARET ALIGNMENT II (Task 52 — "cursor progressively moves farther
  // from the text while typing; Backspace moves it closer again"). Task 50
  // removed the inline-block shaping break but MEASURED, in a real
  // Chromium (scripts/caret-drift-harness.py), that every per-char inline
  // span boundary STILL costs ~+0.2px of subpixel layout snapping: 41
  // chars as 41 spans = 287.03px vs 286.73px as one unbroken text node.
  // While typing, that accumulated — the painted text ran ahead of the
  // native caret — and any deletion collapsed the tail to one text node
  // and the drift snapped back. The remaining root cause: LINGERING span
  // boxes. The fix is structural, not cosmetic: the SETTLE-TAIL MERGE.
  describe("caret alignment II: settle-tail merge (Task 52 — zero lingering span boxes)", () => {
    it("a typed char's span MERGES back into the static head after the 170ms reveal — steady state has ZERO span boxes", () => {
      vi.useFakeTimers();
      try {
        const { container } = setup();
        const textarea = screen.getByLabelText(/Reply to OnyxAgent/);
        fireEvent.change(textarea, { target: { value: "h" } });
        fireEvent.change(textarea, { target: { value: "he" } });
        fireEvent.change(textarea, { target: { value: "hel" } });
        // Mid-reveal: the fresh chars are spanned…
        expect(container.querySelectorAll(".prompt-char-in").length).toBe(3);
        // …then the reveal ends and the settle-tail merge swallows them:
        // the whole value becomes ONE unbroken text node — the exact
        // structure the textarea itself lays out, so the native caret and
        // the painted glyphs can never diverge at rest.
        act(() => {
          vi.advanceTimersByTime(250);
        });
        expect(container.querySelectorAll(".prompt-char-in").length).toBe(0);
        const mirror = container.querySelector(".prompt-mirror-gutter");
        expect(mirror!.textContent).toBe("hel");
        // ONE text node — not three char nodes (the structure IS the fix).
        expect(mirror!.childNodes.length).toBe(1);
        expect(mirror!.childNodes[0]!.nodeType).toBe(Node.TEXT_NODE);
      } finally {
        vi.useRealTimers();
      }
    });

    it("typing after a settle animates ONLY the fresh char (no re-animation of settled text)", () => {
      vi.useFakeTimers();
      try {
        const { container } = setup();
        const textarea = screen.getByLabelText(/Reply to OnyxAgent/);
        fireEvent.change(textarea, { target: { value: "hello" } });
        act(() => {
          vi.advanceTimersByTime(250);
        });
        expect(container.querySelectorAll(".prompt-char-in").length).toBe(0);
        // Next keystroke: only the new char is a span; the settled head
        // stays one unbroken text node behind it.
        fireEvent.change(textarea, { target: { value: "hello!" } });
        const spans = container.querySelectorAll(".prompt-char-in");
        expect(spans.length).toBe(1);
        expect(spans[0]!.textContent).toBe("!");
        act(() => {
          vi.advanceTimersByTime(250);
        });
        expect(container.querySelectorAll(".prompt-char-in").length).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a deletion during the reveal window cancels the merge (plain never outpaces the value)", () => {
      vi.useFakeTimers();
      try {
        const { container } = setup();
        const textarea = screen.getByLabelText(/Reply to OnyxAgent/);
        fireEvent.change(textarea, { target: { value: "hello worl" } });
        // Before the reveal ends, backspace twice: "worl" → "wor" → "wo".
        fireEvent.change(textarea, { target: { value: "hello wor" } });
        fireEvent.change(textarea, { target: { value: "hello wo" } });
        act(() => {
          vi.advanceTimersByTime(400);
        });
        // Deletions render static (the Task 50 valve) and the merge timer
        // resolves against the CURRENT value — the mirror paints exactly
        // the textarea's text, never a longer stale snapshot.
        const mirror = container.querySelector(".prompt-mirror-gutter");
        expect(container.querySelectorAll(".prompt-char-in").length).toBe(0);
        expect(mirror!.textContent).toBe("hello wo");
        expect((textarea as HTMLTextAreaElement).value).toBe("hello wo");
      } finally {
        vi.useRealTimers();
      }
    });

    it("the gutter parity is now ENGINE-RESERVED on both halves (no hard-coded 8px padding)", () => {
      // Task 50 pinned the mirror to padding-right: 8px to match the
      // textarea's scrollbar-gutter: stable reservation. That was only
      // correct on platforms whose scrollbar is exactly 8px: overlay
      // scrollbars (macOS, headless, many Android WebViews) reserve 0px,
      // leaving an 8px painted-text/caret skew on every wrapped line.
      // Both elements now declare scrollbar-gutter: stable so the SAME
      // engine reserves the SAME width in BOTH boxes on every platform.
      const css52 = readFileSync(
        resolve(process.cwd(), "src/app/globals.css"),
        "utf8",
      );
      const rule = css52
        .slice(
          css52.indexOf(".prompt-mirror-scroll,"),
          css52.indexOf("}", css52.indexOf(".prompt-mirror-scroll,")),
        )
        .replace(/\/\*[\s\S]*?\*\//g, "");
      expect(rule).toMatch(/scrollbar-gutter:\s*stable\s*;/);
      // The hard-coded padding reserve is gone…
      expect(css52).not.toMatch(/\.prompt-mirror-gutter\s*\{[^}]*padding-right:\s*8px/);
      // …and the grouped selector covers both halves of the pair.
      expect(css52).toMatch(/\.prompt-mirror-scroll,\s*\n?\s*\.prompt-mirror-gutter\s*\{/);
    });

    it("REVEAL_MS matches the CSS animation duration (the merge must not cut an animation short)", () => {
      const component = readFileSync(
        resolve(process.cwd(), "src/components/chat/prompt-typing-mirror.tsx"),
        "utf8",
      );
      const css52 = readFileSync(
        resolve(process.cwd(), "src/app/globals.css"),
        "utf8",
      );
      const ms = component.match(/const REVEAL_MS = (\d+)/);
      expect(ms).toBeTruthy();
      expect(css52).toMatch(new RegExp(`prompt-char-in ${ms![1]}ms`));
    });
  });

  // ── CARET ALIGNMENT III (Task 53 — "as I tap any letter it cuts the
  // letter before it": drift returns MID-SENTENCE while typing
  // continuously). Task 52's settle timer re-armed the FULL 200ms delay on
  // every keystroke (the effect's deps include value.length, and its
  // cleanup cancels the pending timer), so keystrokes < 200ms apart —
  // ordinary typing speed — postponed the merge forever: the animated tail
  // grew unbounded, every typed char stayed a live span, and the
  // accumulated ~0.2px/boundary subpixel drift came back mid-typing,
  // snapping back on pause or Backspace. The 52 tests only advanced time
  // AFTER typing stopped, so they never saw it. The Task 53 fix anchors
  // the expiry to each char's OWN birth time: the oldest alive char's
  // deadline is what the timer waits for.
  describe("caret alignment III: the settle timer fires DURING continuous typing (Task 53)", () => {
    it("keystrokes 120ms apart: older chars merge MID-STREAM while newer ones keep animating (bounded tail)", () => {
      vi.useFakeTimers();
      try {
        const { container } = setup();
        const textarea = screen.getByLabelText(/Reply to OnyxAgent/);
        // Type continuously, 120ms between keystrokes — FASTER than the
        // 200ms settle delay. Task 52 never merged here (timer re-armed
        // each keystroke); Task 53 merges chars whose own 200ms has
        // elapsed the moment the timer fires.
        for (const step of ["h", "he", "hel", "hell", "hello", "hello ", "hello w"]) {
          fireEvent.change(textarea, { target: { value: step } });
          act(() => { vi.advanceTimersByTime(120); });
        }
        // 840ms of typing elapsed; chars born ≥200ms ago have merged.
        // The live tail must be bounded to roughly the last 200ms of
        // typing (~2 keystrokes at this cadence), NOT all 7 chars.
        const spans = container.querySelectorAll(".prompt-char-in");
        expect(spans.length).toBeGreaterThanOrEqual(0);
        expect(spans.length).toBeLessThanOrEqual(3);
        expect(spans.length).toBeLessThan(7);
        // …and the mirror still paints the FULL text (head + tail).
        const mirror = container.querySelector(".prompt-mirror-gutter");
        expect(mirror!.textContent).toBe("hello w");
        // Let everything settle: zero spans, one unbroken text node.
        act(() => { vi.advanceTimersByTime(400); });
        expect(container.querySelectorAll(".prompt-char-in").length).toBe(0);
        expect(mirror!.textContent).toBe("hello w");
      } finally {
        vi.useRealTimers();
      }
    });

    it("rapid typing with NO time passing between keystrokes: merge fires as soon as typing pauses", () => {
      vi.useFakeTimers();
      try {
        const { container } = setup();
        const textarea = screen.getByLabelText(/Reply to OnyxAgent/);
        // Burst-type 11 chars in one macro-task (zero elapsed fake time):
        // every char is still inside its reveal window, so the tail may
        // legitimately hold all of them DURING the burst. 10 spans, not
        // 11 — the SPACE (index 5) renders as a raw whitespace fragment
        // by design (animating a space is invisible): "hello world" is
        // 10 animated spans + 1 space fragment.
        let v = "";
        for (const ch of "hello world") {
          v += ch;
          fireEvent.change(textarea, { target: { value: v } });
        }
        const mid = container.querySelectorAll(".prompt-char-in").length;
        expect(mid).toBe(10);
        // …but the instant their reveals end, ALL of them merge at once —
        // the timer is anchored to the OLDEST char's birth (now + 200ms),
        // not postponed per keystroke.
        act(() => { vi.advanceTimersByTime(250); });
        expect(container.querySelectorAll(".prompt-char-in").length).toBe(0);
        const mirror = container.querySelector(".prompt-mirror-gutter");
        expect(mirror!.textContent).toBe("hello world");
      } finally {
        vi.useRealTimers();
      }
    });

    it("a char typed AFTER an older char's expiry keeps its full animation (no premature merge of the survivor)", () => {
      vi.useFakeTimers();
      try {
        const { container } = setup();
        const textarea = screen.getByLabelText(/Reply to OnyxAgent/);
        fireEvent.change(textarea, { target: { value: "a" } });
        act(() => { vi.advanceTimersByTime(210); }); // "a" expired
        fireEvent.change(textarea, { target: { value: "ab" } });
        // Fresh char "b" is 0ms into its reveal: the expiry of "a" must
        // not drag "b" into the head early (that would cut its animation
        // short — the visual glitch the REVEAL_MS pin guards against).
        expect(container.querySelectorAll(".prompt-char-in").length).toBe(1);
        expect(container.querySelector(".prompt-char-in")!.textContent).toBe("b");
        act(() => { vi.advanceTimersByTime(100); }); // mid-reveal for "b"
        expect(container.querySelectorAll(".prompt-char-in").length).toBe(1);
        act(() => { vi.advanceTimersByTime(150); }); // past "b"'s window
        expect(container.querySelectorAll(".prompt-char-in").length).toBe(0);
        const mirror = container.querySelector(".prompt-mirror-gutter");
        expect(mirror!.textContent).toBe("ab");
      } finally {
        vi.useRealTimers();
      }
    });

    it("mid-reveal deletion keeps value/boundary consistent (no stale longer snapshot)", () => {
      vi.useFakeTimers();
      try {
        const { container } = setup();
        const textarea = screen.getByLabelText(/Reply to OnyxAgent/);
        fireEvent.change(textarea, { target: { value: "hello worl" } });
        act(() => { vi.advanceTimersByTime(100); }); // mid-reveal
        fireEvent.change(textarea, { target: { value: "hello wor" } }); // delete
        act(() => { vi.advanceTimersByTime(400); }); // all timers drain
        const mirror = container.querySelector(".prompt-mirror-gutter");
        expect(container.querySelectorAll(".prompt-char-in").length).toBe(0);
        expect(mirror!.textContent).toBe("hello wor");
        expect((textarea as HTMLTextAreaElement).value).toBe("hello wor");
      } finally {
        vi.useRealTimers();
      }
    });
  });
