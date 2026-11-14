// @vitest-environment jsdom
// StreamingAnimPicker — the Settings → Appearance control: 25 options
// (Default + the motion lab's 24), a live preview pane using the REAL
// engine markup (.wf spans under data-stream-anim), replay, persistence.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import React from "react";
import { StreamingAnimPicker } from "./streaming-anim-picker";
import {
  STREAMING_ANIMATIONS,
  STREAMING_ANIM_STORAGE_KEY,
  readPersistedStreamingAnim,
} from "@/lib/streaming-motion";

// jsdom has no matchMedia by default — the picker's reduced-motion probe.
beforeEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.streamAnim;
  if (!("matchMedia" in window)) {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  }
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("StreamingAnimPicker (motion lab options)", () => {
  it("renders Default + all 24 animation chips", () => {
    const { getByText } = render(<StreamingAnimPicker />);
    expect(getByText("Default")).toBeTruthy();
    for (const anim of STREAMING_ANIMATIONS) {
      expect(getByText(anim.label)).toBeTruthy();
    }
  });

  it("the preview pane carries the real engine markup (.wf spans)", async () => {
    const { container } = render(<StreamingAnimPicker />);
    // Words reveal on the stagger — advance past the first tick.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    const words = container.querySelectorAll(".wf");
    expect(words.length).toBeGreaterThanOrEqual(1);
    // Each revealed word carries the inline duration the engine bakes.
    const first = words[0] as HTMLElement;
    expect(first.style.animationDuration).toBeTruthy();
  });

  it("picking an animation applies html[data-stream-anim] + persists", () => {
    const { getByText } = render(<StreamingAnimPicker />);
    fireEvent.click(getByText("Blur Wave"));
    expect(document.documentElement.dataset.streamAnim).toBe("a12");
    expect(readPersistedStreamingAnim()).toBe("a12");
    expect(localStorage.getItem(STREAMING_ANIM_STORAGE_KEY)).toBe("a12");
    // The preview pane switches to the selected animation's attribute.
    expect(getByText("Selected:").textContent).toContain("Blur Wave");
  });

  it("Default chip clears the override (back to the mixed settle)", () => {
    const { getByText } = render(<StreamingAnimPicker />);
    fireEvent.click(getByText("Velvet Fade"));
    expect(document.documentElement.dataset.streamAnim).toBe("a2");
    fireEvent.click(getByText("Default"));
    expect(document.documentElement.dataset.streamAnim).toBeUndefined();
    expect(readPersistedStreamingAnim()).toBe(null);
  });

  it("replay restarts the cascade from the first word", () => {
    const { container, getByText } = render(<StreamingAnimPicker />);
    act(() => {
      vi.advanceTimersByTime(1000); // full cascade
    });
    const full = container.querySelectorAll(".wf").length;
    expect(full).toBeGreaterThan(5);
    fireEvent.click(getByText("Replay"));
    act(() => {
      vi.advanceTimersByTime(0); // the first word only
    });
    expect(container.querySelectorAll(".wf").length).toBeLessThan(full);
  });

  it("a persisted selection is reflected on mount (chip + preview attr)", () => {
    localStorage.setItem(STREAMING_ANIM_STORAGE_KEY, "a5");
    const { container } = render(<StreamingAnimPicker />);
    // Flush the deferred mount read (setTimeout 0 in the picker).
    act(() => {
      vi.advanceTimersByTime(0);
    });
    // The Floating Rise chip reads as pressed (queried by its numbered
    // title — the "Selected:" line also spells the label).
    const chip = container.querySelector('[title="05 · Floating Rise"]') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    // The preview pane carries the animation attribute.
    const pane = container.querySelector("[data-stream-anim]");
    expect(pane?.getAttribute("data-stream-anim")).toBe("a5");
  });
});
