/**
 * advanceEventCursor — the replay-cursor semantics shared by the SSE bridge
 * and the agent_events action. The cursor is the 1-based event id of the
 * last delivered event (the SSE id: value / Last-Event-ID / after= param).
 *
 * Regression: the old bridge treated the cursor as a 0-based LINE index
 * while sending 1-based ids in id: — every cursor replay SKIPPED the first
 * event after the cursor (one dropped event per reconnect).
 */
import { describe, expect, it } from "vitest";
import { advanceEventCursor } from "./event-cursor";

const log = (...ids: number[]) => ids.map((i) => JSON.stringify({ i, type: "t", data: {} }));
const torn = ['{"i": 9, "type": "t", "data": {"text": "partial"}']; // no closing brace

describe("advanceEventCursor", () => {
  it("fresh cursor (-1) forwards every event with its 1-based id", () => {
    const step = advanceEventCursor(log(1, 2, 3), -1);
    expect(step.events.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(step.cursor).toBe(3);
    expect(step.torn).toBe(false);
  });

  it("cursor=7 forwards from id 8 — NOT id 9 (the off-by-one regression)", () => {
    const lines = log(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
    const step = advanceEventCursor(lines, 7);
    expect(step.events.map((e) => e.id)).toEqual([8, 9, 10]);
    expect(step.cursor).toBe(10);
  });

  it("cursor equal to the last id forwards nothing and keeps the cursor", () => {
    const step = advanceEventCursor(log(1, 2, 3), 3);
    expect(step.events).toEqual([]);
    expect(step.cursor).toBe(3);
  });

  it("an empty log is a valid answer (pre-start run)", () => {
    const step = advanceEventCursor([], -1);
    expect(step.events).toEqual([]);
    expect(step.cursor).toBe(-1);
    expect(step.torn).toBe(false);
  });

  it("a torn trailing line stops the walk WITHOUT advancing the cursor", () => {
    const lines = [...log(1, 2), ...torn];
    const step = advanceEventCursor(lines, -1);
    expect(step.events.map((e) => e.id)).toEqual([1, 2]);
    expect(step.cursor).toBe(2); // the torn event re-reads once complete
    expect(step.torn).toBe(true);
  });

  it("a torn line after the cursor does not advance past the last complete event", () => {
    const lines = [...log(1, 2, 3, 4), ...torn];
    const step = advanceEventCursor(lines, 2);
    expect(step.events.map((e) => e.id)).toEqual([3, 4]);
    expect(step.cursor).toBe(4);
    expect(step.torn).toBe(true);
  });

  it("dense logs skip the prefix in O(tail) but gapped logs are still safe", () => {
    // Gapped: line 0 has id 5, line 1 has id 9 — cursor 5 must forward only 9.
    const gapped = [JSON.stringify({ i: 5 }), JSON.stringify({ i: 9 })];
    const step = advanceEventCursor(gapped, 5);
    expect(step.events.map((e) => e.id)).toEqual([9]);
  });

  it("lines without an i fall back to their 1-based line index", () => {
    const lines = [JSON.stringify({ type: "t" }), JSON.stringify({ type: "t" })];
    const step = advanceEventCursor(lines, -1);
    expect(step.events.map((e) => e.id)).toEqual([1, 2]);
  });
});
