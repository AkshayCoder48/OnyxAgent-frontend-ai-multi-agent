import { describe, expect, it } from "vitest";
import { filterReplayEvents } from "./background-turn";
import type { BgEvent } from "@/lib/e2b/background-agent";

/**
 * REGRESSION TESTS — the "repeated initial AI text" bug (leave the app
 * mid-generation, come back, the same first words duplicate again and again).
 *
 * Root causes fixed alongside these tests:
 *   1. processEvents had NO client-side dedupe — any server-side re-delivery
 *      (overlap, stale segment, the legacy bg-state.json path that returns
 *      the WHOLE un-seq'd event log on every poll) was re-APPENDED.
 *   2. The seq cursor lived in localStorage while the content lived in Dexie —
 *      a kill between the two writes made the resume replay
 *      already-checkpointed events. (Fixed separately: the cursor now rides
 *      the checkpoint row itself + resume takes max(row, localStorage).)
 *
 * These tests pin the dedupe rules so neither can regress.
 */
describe("filterReplayEvents (bg replay dedupe)", () => {
  const text = (seq: number, content: string): BgEvent =>
    ({ t: "text_delta", seq, content, round: 1 }) as BgEvent;

  it("keeps events strictly above the cursor", () => {
    const events = [text(11, " world"), text(12, "!")];
    expect(filterReplayEvents(events, 10, false)).toEqual(events);
  });

  it("skips events at or below the cursor (no duplicate re-append)", () => {
    // A stale segment redelivers seq 8-10 that were already consumed.
    const events = [text(8, "Letme try "), text(9, "applying "), text(10, "this approach"), text(11, " now")];
    const kept = filterReplayEvents(events, 10, false);
    expect(kept).toEqual([text(11, " now")]);
  });

  it("skips seq-less (v1-legacy) events on RESUME — the infinite replay loop", () => {
    // The legacy server path returns the whole un-seq'd log on EVERY poll;
    // the resume consumer must drop them (the checkpoint already has them).
    const legacy = [
      { t: "text", content: "Letme try applying this approach" },
      { t: "text", content: " again" },
    ] as BgEvent[];
    expect(filterReplayEvents(legacy, 0, false)).toEqual([]);
  });

  it("keeps seq-less events on a LIVE run (they arrived first-hand)", () => {
    const legacy = [{ t: "text", content: "fresh from the live launch" }] as BgEvent[];
    expect(filterReplayEvents(legacy, 0, true)).toEqual(legacy);
  });

  it("terminal done/error events are still subject to the seq guard", () => {
    const done = { t: "done", seq: 5, content: "final" } as BgEvent;
    // Already-consumed done (seq 5 <= cursor 5) must not re-fire finalization.
    expect(filterReplayEvents([done], 5, false)).toEqual([]);
    expect(filterReplayEvents([done], 4, false)).toEqual([done]);
  });

  it("cursor 0 on a fresh live run keeps everything sequenced", () => {
    const events = [text(1, "a"), text(2, "b")];
    expect(filterReplayEvents(events, 0, true)).toEqual(events);
  });
});
