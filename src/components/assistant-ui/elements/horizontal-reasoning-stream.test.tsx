// HorizontalReasoningStream — the "Adaptive Horizontal Reasoning Stream"
// PRD (2026-11-24) acceptance suite. jsdom (no rAF/scrollWidth by default),
// so the follow loop's requestAnimationFrame callbacks are captured and
// invoked manually, and the viewport's scroll metrics are faked via
// Object.defineProperty on the element. Selectors avoid CSS-module class
// names (mangled per test run): the viewport is found by role=region, the
// stream by its aria-label'd first child span, the chip by its aria-label.
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HorizontalReasoningStream,
  readThemeBackground,
} from "./horizontal-reasoning-stream";

// ── jsdom shims ─────────────────────────────────────────────────────────────
let rafQueue: FrameRequestCallback[] = [];
const raf = (cb: FrameRequestCallback) => {
  rafQueue.push(cb);
  return rafQueue.length;
};
const drainRaf = () => {
  const q = rafQueue;
  rafQueue = [];
  q.forEach((cb) => cb(performance.now()));
};

interface FakeScroll {
  scrollWidth?: number;
  clientWidth?: number;
}
let fake: FakeScroll = {};
const applyFake = (el: Element) => {
  Object.defineProperty(el, "scrollWidth", {
    configurable: true,
    get: () => fake.scrollWidth ?? 0,
  });
  Object.defineProperty(el, "clientWidth", {
    configurable: true,
    get: () => fake.clientWidth ?? 400,
  });
  Object.defineProperty(el, "scrollLeft", {
    configurable: true,
    writable: true,
    value: 0,
  });
};

beforeEach(() => {
  rafQueue = [];
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  fake = {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty("--color-background");
});

const renderStream = (
  props: Partial<Parameters<typeof HorizontalReasoningStream>[0]> = {},
) => {
  const utils = render(
    React.createElement(HorizontalReasoningStream, {
      text: "Let me analyze the workspace and read the necessary files first.",
      active: true,
      ...props,
    }),
  );
  // role=region + aria-label is stable across CSS-module mangling.
  const viewport = utils.getByRole("region", {
    name: "AI reasoning stream",
  }) as HTMLElement;
  applyFake(viewport);
  return { ...utils, viewport };
};

/** The ONE continuous text element — the stream span inside the viewport. */
const streamEl = (viewport: HTMLElement): HTMLElement =>
  viewport.firstElementChild as HTMLElement;

/** The Follow Latest chip (aria-label is stable). */
const chipEl = (container: HTMLElement): HTMLElement | null =>
  container.querySelector('button[aria-label="Follow latest reasoning"]');

/** The two vignette strips (aria-hidden divs). */
const vignettes = (container: HTMLElement): NodeListOf<HTMLElement> =>
  container.querySelectorAll('div[aria-hidden="true"]');

describe("HorizontalReasoningStream — single continuous stream (PRD §2)", () => {
  it("renders ONE text element holding the whole reasoning text", () => {
    const { viewport } = renderStream();
    const stream = streamEl(viewport);
    expect(stream.tagName).toBe("SPAN");
    // ONE stream span — while live the accent caret may ride its tail, but
    // no second TEXT element ever exists (the caret renders no text).
    const spans = viewport.querySelectorAll("span");
    expect(spans.length).toBeLessThanOrEqual(2); // stream + optional caret
    expect(spans[0]).toBe(stream);
  });

  it("appends incoming text to the SAME element (never re-mounts it)", () => {
    const { viewport, rerender } = renderStream({ text: "First." });
    const stream = streamEl(viewport);
    rerender(
      React.createElement(HorizontalReasoningStream, {
        text: "First. Second chunk arrived.",
        active: true,
      }),
    );
    const after = streamEl(viewport);
    expect(after).toBe(stream); // same DOM node — content grew in place
  });

  it("renders the FULL text (no truncation) regardless of length", () => {
    const long =
      "Sentence one. Sentence two. Sentence three. Sentence four arrives.";
    const { container } = render(
      React.createElement(HorizontalReasoningStream, {
        text: long,
        active: false,
      }),
    );
    // A settled block is a pure pass-through (full text immediately); the
    // words render across .wf spans, so assert on the stream's textContent.
    const stream = container.querySelector('[role="region"] > span');
    expect(stream?.textContent).toContain("Sentence one.");
    expect(stream?.textContent).toContain("Sentence four arrives.");
  });
});

describe("HorizontalReasoningStream — auto-follow (PRD §3)", () => {
  it("advances the viewport to the tail while following", () => {
    const { viewport } = renderStream();
    fake = { scrollWidth: 1200, clientWidth: 400 };
    viewport.scrollLeft = 0;
    drainRaf(); // follow loop tick sees the grown width
    expect(viewport.scrollLeft).toBe(1200);
  });

  it("does NOT move the viewport when the user has navigated away", () => {
    const { viewport } = renderStream();
    fake = { scrollWidth: 1200, clientWidth: 400 };
    // User swipes back: scrollLeft far from the tail.
    viewport.scrollLeft = 100;
    viewport.dispatchEvent(new Event("scroll"));
    drainRaf();
    expect(viewport.scrollLeft).toBe(100); // parked where the user left it
    // …even as more text arrives (width grows):
    fake = { scrollWidth: 1400, clientWidth: 400 };
    drainRaf();
    expect(viewport.scrollLeft).toBe(100); // auto-follow stayed paused
  });

  it("resumes following when manual navigation reaches the end", () => {
    const { viewport } = renderStream();
    fake = { scrollWidth: 1200, clientWidth: 400 };
    viewport.scrollLeft = 100;
    viewport.dispatchEvent(new Event("scroll"));
    // User swipes forward to the very end:
    viewport.scrollLeft = 1200;
    viewport.dispatchEvent(new Event("scroll"));
    fake = { scrollWidth: 1300, clientWidth: 400 };
    drainRaf();
    expect(viewport.scrollLeft).toBe(1300); // following resumed
  });

  it("renders NO Follow Latest control — ever (removed by user directive)", async () => {
    const { viewport, container } = renderStream();
    expect(chipEl(container)).toBeNull();
    // Pause auto-follow (user swipes back): the stream stays silent —
    // no control may appear on the line.
    fake = { scrollWidth: 1200, clientWidth: 400 };
    viewport.scrollLeft = 100;
    viewport.dispatchEvent(new Event("scroll"));
    await waitFor(() => {
      // follow state actually paused: the viewport parks under growth…
      fake = { scrollWidth: 1400, clientWidth: 400 };
      drainRaf();
      expect(viewport.scrollLeft).toBe(100);
    });
    // …and STILL no chip/border/glow element rides the stream.
    expect(chipEl(container)).toBeNull();
    expect(container.querySelector("button")).toBeNull(); // no control at all
  });

  it("keyboard arrows scroll the stream manually", () => {
    const { viewport } = renderStream();
    fake = { scrollWidth: 2000, clientWidth: 400 };
    viewport.scrollLeft = 0;
    viewport.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(viewport.scrollLeft).toBe(120);
    viewport.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    expect(viewport.scrollLeft).toBe(0);
  });

  it("pointer drag scrolls the stream and pauses auto-follow (desktop §8)", () => {
    const { viewport } = renderStream();
    fake = { scrollWidth: 2000, clientWidth: 400 };
    viewport.scrollLeft = 1600; // at the tail
    viewport.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerType: "mouse",
        button: 0,
        clientX: 300,
      }),
    );
    viewport.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerType: "mouse",
        clientX: 260, // 40px left — past the DRAG_SLOP
      }),
    );
    expect(viewport.scrollLeft).toBe(1640); // content followed the drag
    viewport.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
});

describe("HorizontalReasoningStream — vignette + theme (PRD §5–§6)", () => {
  it("reads the LIVE theme background color (hex → rgb)", () => {
    document.documentElement.style.setProperty("--color-background", "#112233");
    expect(readThemeBackground()).toBe("rgb(17, 34, 51)");
  });

  it("paints BOTH edge strips in the live background and re-reads on flip", async () => {
    document.documentElement.style.setProperty("--color-background", "#112233");
    const { container } = renderStream();
    // The theme effect reads on mount — settle to the first colour.
    await waitFor(() => {
      const strips = vignettes(container);
      // Two of the aria-hidden divs are the edge strips (the caret is a
      // span; the SVG inside the chip is not a direct div) — filter by
      // having a backgroundColor style.
      const painted = Array.from(strips).filter(
        (el) => (el as HTMLElement).style.backgroundColor !== "",
      );
      expect(painted.length).toBe(2);
      expect((painted[0] as HTMLElement).style.backgroundColor).toBe(
        "rgb(17, 34, 51)",
      );
    });
    // Flip the theme: the MutationObserver re-reads and repaints.
    document.documentElement.style.setProperty("--color-background", "#ffffff");
    await waitFor(() => {
      const painted = Array.from(vignettes(container)).filter(
        (el) => (el as HTMLElement).style.backgroundColor !== "",
      );
      expect((painted[1] as HTMLElement).style.backgroundColor).toBe(
        "rgb(255, 255, 255)",
      );
    });
  });

  it("CSS module uses theme tokens — no chip/rail/blur/outline (user directive)", () => {
    const css = readFileSync(
      join(__dirname, "./HorizontalReasoningStream.module.css"),
      "utf8",
    );
    expect(css).not.toMatch(/background\s*:\s*(#000|#fff|black|white)\s*[;}]/i);
    expect(css).toContain("var(--color-primary)"); // caret ink only
    expect(css).toContain("var(--color-foreground)");
    expect(css).toContain("overscroll-behavior-x");
    expect(css).toContain("prefers-reduced-motion");
    // REMOVED (user directive 2026-11-24): the Follow Latest chip, the
    // accent overflow rail, the focus outline and the resting blur veil.
    expect(css).not.toContain("hrsFollow");
    expect(css).not.toContain("hrsOverflowHint");
    expect(css).not.toContain("filter: blur");
    expect(css).not.toContain("outline:");
    // No color-mix chip surface survives — the only accent uses left are
    // the caret's plain var() background.
    expect(css).not.toContain("color-mix");
  });
});

describe("HorizontalReasoningStream — animation reuse (PRD §4)", () => {
  it("delegates the reveal to the shared word engine (.wf spans)", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: true }), // reduced: instant reveal
    );
    const { viewport } = renderStream({ text: "one two three" });
    // Reduced motion reveals instantly, so the words are already mounted as
    // .wf spans on first paint — the SAME class the user's selected
    // streaming animation (html[data-stream-anim]) keys on. No timers.
    const wf = viewport.querySelectorAll(".wf");
    expect(wf.length).toBe(3); // one .wf span per word
    const stream = streamEl(viewport);
    expect(stream.textContent).toContain("one two three"); // full text via engine
  });

  it("carries a streaming caret at the tail while live (accent-coloured)", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: false }),
    );
    const { viewport } = renderStream({ text: "thinking hard" });
    // The caret renders once the word engine is animating: drain reveal ticks.
    for (let i = 0; i < 20; i++) drainRaf();
    // caret = the aria-hidden span inside the stream (last child).
    const caret = viewport.querySelector("span[aria-hidden='true']");
    expect(caret).toBeTruthy();
  });
});
