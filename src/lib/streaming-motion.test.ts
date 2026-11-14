// @vitest-environment jsdom
// Streaming motion — the 24 selectable word-streaming animations
// (uploaded "Streaming Motion Lab" spec): registry integrity, persistence
// and the html[data-stream-anim] application contract.
import { describe, it, expect, beforeEach } from "vitest";
import {
  STREAMING_ANIMATIONS,
  STREAMING_ANIM_STORAGE_KEY,
  isValidStreamingAnim,
  applyStreamingAnim,
  selectStreamingAnim,
  readPersistedStreamingAnim,
  applyPersistedStreamingAnim,
  resetStreamingAnim,
} from "@/lib/streaming-motion";

describe("streaming-motion · registry (the motion lab's 24)", () => {
  it("exposes exactly 24 animations with unique ids and labels", () => {
    expect(STREAMING_ANIMATIONS.length).toBe(24);
    const ids = new Set(STREAMING_ANIMATIONS.map((a) => a.id));
    const labels = new Set(STREAMING_ANIMATIONS.map((a) => a.label));
    expect(ids.size).toBe(24);
    expect(labels.size).toBe(24);
    // ids follow the lab's a1…a24 numbering.
    expect(STREAMING_ANIMATIONS[0]).toEqual({ id: "a1", label: "Soft Dissolve" });
    expect(STREAMING_ANIMATIONS[23]).toEqual({ id: "a24", label: "Breathing Text" });
  });

  it("validates ids strictly (unknown/null/empty are not selections)", () => {
    expect(isValidStreamingAnim("a1")).toBe(true);
    expect(isValidStreamingAnim("a24")).toBe(true);
    expect(isValidStreamingAnim("a25")).toBe(false);
    expect(isValidStreamingAnim("word-settle-in")).toBe(false);
    expect(isValidStreamingAnim("")).toBe(false);
    expect(isValidStreamingAnim(null)).toBe(false);
    expect(isValidStreamingAnim(undefined)).toBe(false);
  });
});

describe("streaming-motion · apply / persist / reset", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.streamAnim;
  });

  it("applyStreamingAnim sets html[data-stream-anim]; null clears it", () => {
    applyStreamingAnim("a12");
    expect(document.documentElement.dataset.streamAnim).toBe("a12");
    applyStreamingAnim(null);
    expect(document.documentElement.dataset.streamAnim).toBeUndefined();
  });

  it("INVALID selections fall back to the default — never a broken attribute", () => {
    applyStreamingAnim("a99");
    expect(document.documentElement.dataset.streamAnim).toBeUndefined();
    applyStreamingAnim("a5");
    applyStreamingAnim("not-an-anim"); // a bad value is "no selection", not a stale one
    expect(document.documentElement.dataset.streamAnim).toBeUndefined();
  });

  it("selectStreamingAnim persists; readPersistedStreamingAnim round-trips", () => {
    selectStreamingAnim("a3");
    expect(localStorage.getItem(STREAMING_ANIM_STORAGE_KEY)).toBe("a3");
    expect(readPersistedStreamingAnim()).toBe("a3");
  });

  it("selecting null (the default settle) clears storage + attribute", () => {
    selectStreamingAnim("a7");
    selectStreamingAnim(null);
    expect(localStorage.getItem(STREAMING_ANIM_STORAGE_KEY)).toBe(null);
    expect(readPersistedStreamingAnim()).toBe(null);
    expect(document.documentElement.dataset.streamAnim).toBeUndefined();
  });

  it("boot applier restores the persisted selection", () => {
    localStorage.setItem(STREAMING_ANIM_STORAGE_KEY, "a20");
    applyPersistedStreamingAnim();
    expect(document.documentElement.dataset.streamAnim).toBe("a20");
  });

  it("boot with a corrupted value falls back to the default settle", () => {
    localStorage.setItem(STREAMING_ANIM_STORAGE_KEY, "garbage");
    applyPersistedStreamingAnim();
    expect(document.documentElement.dataset.streamAnim).toBeUndefined();
  });

  it("resetStreamingAnim wipes both the attribute and storage", () => {
    selectStreamingAnim("a21");
    resetStreamingAnim();
    expect(localStorage.getItem(STREAMING_ANIM_STORAGE_KEY)).toBe(null);
    expect(document.documentElement.dataset.streamAnim).toBeUndefined();
  });
});
