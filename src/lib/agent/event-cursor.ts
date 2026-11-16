/**
 * Replay-cursor semantics for /api/sandbox?stream=1 (the SSE bridge) and the
 * `agent_events` action — shared so the two readers can never disagree.
 *
 * The cursor is "the 1-based event id (`i`) of the last event the client
 * processed" — the same value the SSE `id:` field carries, the value
 * EventSource returns as the Last-Event-ID header on auto-reconnect, and the
 * value the client's `after=` URL param uses on manual reopens. -1 means
 * nothing delivered yet (full replay).
 *
 * The bridge used to treat the cursor as a 0-based LINE index while sending
 * 1-based event ids in the SSE `id:` field — every cursor replay (a browser
 * reconnect after the serverless function died, a manual reopen) silently
 * SKIPPED the first event after the cursor. This module is the fix: forward
 * exactly the events whose `i` is greater than the cursor, and stop on a
 * torn (mid-append) line WITHOUT advancing the cursor so the completed line
 * re-reads on the next poll.
 */

export interface ForwardedEvent {
  /** The raw JSONL line to forward verbatim. */
  line: string;
  /** The 1-based event id (`i`) — the SSE id and the next cursor value. */
  id: number;
}

export interface EventCursorAdvance {
  /** Events to forward, in order. */
  events: ForwardedEvent[];
  /** The new cursor (1-based id of the last forwarded event; unchanged when
   *  nothing new was forwarded or the walk stopped on a torn line). */
  cursor: number;
  /** True when the walk stopped on an unparseable (mid-append) trailing
   *  line — the completed line re-reads on the next poll. */
  torn: boolean;
}

/**
 * Walk the (already filtered to non-empty) log lines and return the events
 * strictly after `cursor`. Lines are tiny (batched deltas) and the polls are
 * ~1.4/s, so the full walk with the `id <= cursor` guard is both cheap and
 * safe for gapped logs — no line-index arithmetic to get wrong.
 */
export function advanceEventCursor(all: string[], cursor: number): EventCursorAdvance {
  const events: ForwardedEvent[] = [];
  let next = cursor;
  let torn = false;
  for (let li = 0; li < all.length; li++) {
    const line = all[li]!;
    let parsed: { i?: number };
    try {
      parsed = JSON.parse(line) as { i?: number };
    } catch {
      torn = true;
      break;
    }
    const id = typeof parsed.i === "number" ? parsed.i : li + 1;
    if (id <= next) continue; // already delivered
    events.push({ line, id });
    next = id;
  }
  return { events, cursor: next, torn };
}
