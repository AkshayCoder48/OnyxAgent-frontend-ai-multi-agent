/**
 * eventsToMessage — reduce a background run's events.jsonl (BgEvent[]) into
 * an assistant ChatMessage-like record, server-side.
 *
 * Mirrors the browser's part-building rules (use-chat/event-processor) in
 * simplified form so a scheduled/telegram run's result renders in the chat
 * with the same structure the user sees during live turns:
 *   - round_start → new round (parts of different rounds never merge)
 *   - reasoning_delta → one reasoning part per round-episode, merged while
 *     consecutive; roundStartedAt from the round's first ts
 *   - text_delta → merged text part for the round; when the round already has
 *     tool parts the text is inserted BEFORE the first tool part of the round
 *   - tool_call → tool part + ToolCall {status: "running", startedAt}
 *   - tool_result → the matching tool part/ToolCall gets
 *     {status: "completed", result (parsed JSON when the string parses),
 *     endedAt}
 *   - done/error → roundEndedAt stamped on the unstamped parts of the last
 *     round; errors append "\n\n❌ Error: <msg>" to the text
 *
 * SERVER-SAFE: no React imports; the only imports are TYPE-ONLY (erased at
 * compile time), so this module runs cleanly inside API routes.
 */

import type { BgEvent } from "@/lib/e2b/background-agent";
import type { MessagePart, ToolCall } from "@/types";

export interface EventsToMessageResult {
  /** Flat text aggregate (concat of all text deltas). */
  content: string;
  thinking?: string;
  reasoning?: string;
  /** Ordered turn timeline (reasoning / text / tool parts). */
  parts?: MessagePart[];
  toolCalls?: ToolCall[];
}

/** Parse a tool_result string into a JSON value when it parses (the runner
 *  stringifies object results — mirror background-turn's re-parse). */
function parseToolResult(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? "";
  const t = raw.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return raw;
  try {
    return JSON.parse(t);
  } catch {
    return raw;
  }
}

function eventTs(ev: BgEvent, fallback: number): number {
  return typeof ev.ts === "number" ? ev.ts : fallback;
}

export function eventsToMessage(events: BgEvent[]): EventsToMessageResult {
  const parts: MessagePart[] = [];
  const toolCalls: ToolCall[] = [];
  let partSeq = 0;
  const nextPartId = (): string => `p_${partSeq++}`;

  let currentRound = 0;
  let now = Date.now();
  /** ts of the first event seen in the current round. */
  let roundStartTs: number | undefined;
  const roundHasFirstPart = new Set<number>();

  let textAgg = "";
  let reasoningAgg = "";

  /** Stamp roundEndedAt on the unstamped parts of a round. */
  const stampRoundEnd = (round: number, ts: number): void => {
    if (round <= 0) return;
    for (const p of parts) {
      if (p.round === round && p.roundEndedAt === undefined) p.roundEndedAt = ts;
    }
  };

  /** Stamp reasoningEndedAt on still-streaming reasoning parts of a round —
   *  the first text delta or tool call after reasoning ends the panel. */
  const stampReasoningEnded = (round: number, ts: number): void => {
    for (const p of parts) {
      if (
        p.round === round &&
        p.type === "reasoning" &&
        p.reasoningEndedAt === undefined &&
        p.roundEndedAt === undefined
      ) {
        p.reasoningEndedAt = ts;
      }
    }
  };

  const beginRound = (round: number, ts: number): void => {
    if (round === currentRound) return;
    if (currentRound > 0) stampRoundEnd(currentRound, ts);
    currentRound = round;
    roundStartTs = ts;
    roundHasFirstPart.delete(round);
  };

  /** Stamp roundStartedAt on the round's first part (browser convention —
   *  the ROUND's first event ts, i.e. the round_start ts). */
  const markFirstPart = (part: MessagePart, round: number, ts: number): void => {
    if (!roundHasFirstPart.has(round)) {
      part.roundStartedAt = roundStartTs ?? ts;
      roundHasFirstPart.add(round);
    } else if (roundStartTs !== undefined && part.roundStartedAt === undefined) {
      part.roundStartedAt = roundStartTs;
    }
  };

  const addReasoning = (round: number, text: string, ts: number): void => {
    if (!text) return;
    // Merge consecutive same-round reasoning deltas into one part.
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]!;
      if (p.round !== round) break;
      if (p.type === "reasoning" && p.roundEndedAt === undefined) {
        p.content = (p.content ?? "") + text;
        reasoningAgg += text;
        return;
      }
    }
    const part: MessagePart = { id: nextPartId(), type: "reasoning", content: text, round };
    markFirstPart(part, round, ts);
    parts.push(part);
    reasoningAgg += text;
  };

  const addText = (round: number, text: string, ts: number): void => {
    if (!text) return;
    stampReasoningEnded(round, ts);
    // Merge into the round's existing text part (the round keeps ONE text
    // part, placed before its tool parts).
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]!;
      if (p.round !== round) break;
      if (p.type === "text") {
        p.content = (p.content ?? "") + text;
        textAgg += text;
        return;
      }
    }
    const part: MessagePart = { id: nextPartId(), type: "text", content: text, round };
    markFirstPart(part, round, ts);
    const toolIdx = parts.findIndex((p) => p.round === round && p.type === "tool");
    if (toolIdx >= 0) parts.splice(toolIdx, 0, part);
    else parts.push(part);
    textAgg += text;
  };

  /** Find the tool part + ToolCall entry for an incoming tool event. */
  const findToolEntry = (round: number, id: string | undefined, name: string | undefined): [MessagePart, ToolCall] | null => {
    if (id) {
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]!;
        if (p.type === "tool" && p.toolCall && p.toolCall.id === id) return [p, p.toolCall];
      }
    }
    if (name) {
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]!;
        if (
          p.type === "tool" &&
          p.toolCall &&
          p.toolCall.status !== "completed" &&
          p.round === round &&
          (p.toolCall.name === name || p.toolCall.name.startsWith("pending-"))
        ) {
          return [p, p.toolCall];
        }
      }
    }
    return null;
  };

  const addToolCall = (round: number, ev: BgEvent, ts: number): void => {
    const preemit = (ev as { _preemit?: boolean })._preemit === true;
    const id = ev.id ?? `bg_${round}_${partSeq}`;
    const name = ev.name ?? "unknown";
    const existing = findToolEntry(round, ev.id, ev.name);
    if (existing) {
      // The real call after a pre-emit (or a duplicate) — keep startedAt.
      const [part, tc] = existing;
      tc.name = name;
      if (!preemit) tc.args = ev.args ?? {};
      part.toolCall = tc;
      return;
    }
    const tc: ToolCall = {
      id,
      name,
      args: ev.args ?? {},
      status: "running",
      startedAt: ts,
    };
    toolCalls.push(tc);
    const part: MessagePart = { id: nextPartId(), type: "tool", toolCall: tc, round };
    markFirstPart(part, round, ts);
    parts.push(part);
  };

  const applyToolResult = (round: number, ev: BgEvent, ts: number): void => {
    const existing = findToolEntry(round, ev.id, ev.name);
    const result = parseToolResult(ev.result);
    if (existing) {
      const [, tc] = existing;
      tc.status = "completed";
      tc.result = result;
      tc.endedAt = ts;
      return;
    }
    // Result without a call event (partial log) — synthesize the entry.
    const tc: ToolCall = {
      id: ev.id ?? `bg_${round}_${partSeq}`,
      name: ev.name ?? "unknown",
      args: {},
      status: "completed",
      result,
      startedAt: ts,
      endedAt: ts,
    };
    toolCalls.push(tc);
    const part: MessagePart = { id: nextPartId(), type: "tool", toolCall: tc, round };
    markFirstPart(part, round, ts);
    parts.push(part);
  };

  let doneContent = "";
  let errorText = "";

  for (const ev of events ?? []) {
    if (!ev || typeof ev.t !== "string") continue;
    const ts = eventTs(ev, now);
    now = Math.max(now, ts);
    const round = typeof ev.round === "number" && ev.round > 0 ? ev.round : Math.max(1, currentRound);

    switch (ev.t) {
      case "round_start":
        beginRound(round, ts);
        break;
      case "reasoning":
      case "reasoning_delta":
        if (currentRound === 0) beginRound(round, ts);
        addReasoning(round, ev.content ?? "", ts);
        break;
      case "text":
      case "text_delta":
        if (currentRound === 0) beginRound(round, ts);
        addText(round, ev.content ?? "", ts);
        break;
      case "tool_call":
        if (currentRound === 0) beginRound(round, ts);
        stampReasoningEnded(round, ts);
        addToolCall(round, ev, ts);
        break;
      case "tool_result":
        if (currentRound === 0) beginRound(round, ts);
        applyToolResult(round, ev, ts);
        break;
      case "done":
        doneContent = ev.content ?? "";
        stampRoundEnd(currentRound, ts);
        break;
      case "error":
        errorText = ev.message ?? ev.content ?? "The agent runner ended with an error.";
        stampRoundEnd(currentRound, ts);
        break;
      default:
        // tool_call_delta / status / todo_event / browser_tool_call —
        // superseded by the concrete tool_call/tool_result events or carry no
        // message content.
        break;
    }
  }

  // Errors append the failure note to the flat text + the last round's text.
  if (errorText) {
    const suffix = `\n\n❌ Error: ${errorText}`;
    textAgg += suffix;
    let stamped = false;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]!;
      if (p.round === currentRound && p.type === "text") {
        p.content = (p.content ?? "") + suffix;
        stamped = true;
        break;
      }
    }
    if (!stamped && currentRound > 0) {
      const part: MessagePart = { id: nextPartId(), type: "text", content: suffix, round: currentRound };
      markFirstPart(part, currentRound, now);
      parts.push(part);
    }
  }

  const content = textAgg || doneContent || "";

  const result: EventsToMessageResult = { content };
  if (reasoningAgg) result.reasoning = reasoningAgg;
  if (parts.length) result.parts = parts;
  if (toolCalls.length) result.toolCalls = toolCalls;
  return result;
}
