import type { ChatMessage, MessagePart, ToolCall, WSEvent } from "@/types";

/**
 * AgentTimeline — the event-normalization layer between the provider/SSE
 * stream and the UI (timeline PRD §2–§7).
 *
 *   Provider/SSE Events → Event Parser → Event Normalizer →
 *   Execution Timeline → Deduplication → UI State Derivation → Renderer
 *
 * The renderer must never consume raw provider events. This module turns
 * them into a small set of canonical events with STABLE IDs and a
 * monotonically increasing SEQUENCE assigned at ingestion time, resolves
 * tool-call identity deterministically (one underlying execution → one UI
 * component), filters internal lifecycle markers (PROCESS et al.) at the
 * parsing layer, and derives the Thinking/Working state machine.
 *
 * The execution store's `parts` array IS the timeline — array position is
 * the sequence, every part id is a stable React key, and chronological
 * execution order always wins over component type (§25).
 */

// ---------------------------------------------------------------------------
// Canonical events (§3).
// ---------------------------------------------------------------------------

export type AgentStatus = "thinking" | "working" | "completed" | "error";

export type AgentEvent =
  | { type: "assistant_text"; id: string; content: string; sequence: number; round: number }
  | { type: "thinking"; id: string; content: string; sequence: number; round: number }
  | { type: "tool_call"; id: string; toolCallId: string; toolName: string; arguments?: unknown; sequence: number; round: number; preemit: boolean }
  | { type: "tool_result"; id: string; toolCallId: string; result?: unknown; sequence: number; round: number }
  | { type: "status"; id: string; status: AgentStatus; sequence: number };

// ---------------------------------------------------------------------------
// Dev diagnostics (§26) — never in production.
// ---------------------------------------------------------------------------

const DEBUG = process.env.NODE_ENV !== "production";

export function timelineDebug(...args: unknown[]): void {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console -- dev-only diagnostics (§26)
  console.debug("[AgentTimeline]", ...args);
}

// ---------------------------------------------------------------------------
// Internal lifecycle markers (§8) — removed at the parsing layer, never CSS.
// ---------------------------------------------------------------------------

/** Marker words that are internal control/status vocabulary. They must
 *  NEVER surface as user-facing assistant content. Matched as WHOLE LINES
 *  only — a sentence that merely contains the word "process" in prose is
 *  legitimate content and stays. */
const INTERNAL_MARKER_LINES = new Set([
  "process",
  "processing",
  "process_started",
  "process_start",
  "process_end",
  "process_end",
  "internal_process",
  "execution_process",
  "tool started",
  "tool finished",
  "calling tool",
  "executing tool",
]);

/** True when a text chunk is NOTHING BUT an internal lifecycle marker
 *  (after trimming, case-folding and stripping trailing ':'/'_' noise).
 *  Such chunks are dropped at ingestion — the tool UI owns that
 *  information. */
export function isInternalMarkerLine(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[:_]+$/, "");
  return INTERNAL_MARKER_LINES.has(normalized);
}

/** Strip whole-line internal markers from a text delta. When marker lines
 *  are dropped from the HEAD of the chunk, the leftover leading newline is
 *  trimmed so the following content starts cleanly. Prose that merely
 *  contains a marker word stays untouched. */
export function stripInternalMarkers(text: string): string {
  if (!text) return text;
  const trimmed = text.trim();
  const folded = trimmed.toLowerCase().replace(/[:_]+$/, "");
  if (!trimmed.includes("\n") && INTERNAL_MARKER_LINES.has(folded)) return "";
  // Multi-line chunk: drop lines that are pure markers.
  const lines = text.split("\n");
  const kept = lines.filter((l) => !isInternalMarkerLine(l));
  if (kept.length === lines.length) return text;
  let out = kept.join("\n");
  if (isInternalMarkerLine(lines[0] ?? "")) out = out.replace(/^\n+/, "");
  return out;
}

/** Index up to which a text buffer is safe to flush: a trailing line that
 *  is a STRICT PREFIX of an internal marker ("PROC" → "process") is held
 *  back so a marker split across SSE chunks is still recognized whole by
 *  the next pass. The final/boundary flush always releases everything. */
export function markerHoldbackIndex(text: string): number {
  const lastNl = text.lastIndexOf("\n");
  const tail = text.slice(lastNl + 1);
  if (!tail) return text.length;
  const lower = tail.toLowerCase();
  for (const marker of INTERNAL_MARKER_LINES) {
    if (lower.length < marker.length && marker.startsWith(lower)) {
      return lastNl + 1;
    }
  }
  return text.length;
}

// ---------------------------------------------------------------------------
// Tool-call identity + deduplication (§6, §17).
// ---------------------------------------------------------------------------

/** What the processor should do with an incoming tool_call event. */
export type ToolCallResolution =
  | { action: "update"; toolCallId: string }
  | { action: "adopt"; partId: string }
  | { action: "create"; identityId: string };

export interface ToolCallPartStub {
  partId: string;
  toolCall: ToolCall;
}

/** Placeholder card names that adopt any finalized call (fence/DSML
 *  "Composing…" cards and unnamed accumulator pre-emits). */
export function isPlaceholderToolName(name: string | undefined): boolean {
  if (!name) return true;
  return (
    name === "tool" ||
    name.startsWith("pending-") ||
    name.startsWith("dsml_composing_") ||
    name.startsWith("fence_composing_") ||
    name.startsWith("dsml_") && name.includes("composing")
  );
}

/**
 * Resolve an incoming `tool_call` event against the message's existing tool
 * parts — deterministic, in this order (§6/§17):
 *
 *  1. EXACT toolCallId match → update that part in place (replayed events
 *     and pre-emit→final rounds never create a second card).
 *  2. Final (non-preemit) call with no exact match → ADOPT the oldest
 *     queued pre-emit placeholder whose name matches, else the oldest
 *     generic placeholder. Adoption re-identifies the placeholder with the
 *     provider's toolCallId — one underlying execution, one UI component.
 *  3. Nothing to match → create exactly one new part.
 *
 * Matching by tool NAME alone never merges two different calls
 * (read_file(a) vs read_file(b) stay separate — §6) because adoption only
 * consumes pre-emit placeholders (which are by definition unfinished) and
 * consumes each placeholder at most once.
 */
export function resolveToolCall(options: {
  toolCallId: string;
  toolName: string;
  preemit: boolean;
  /** Tool parts of the streaming message, in timeline order. */
  toolParts: readonly ToolCallPartStub[];
  /** Part ids of pre-emit placeholders still awaiting adoption, in order. */
  preemitQueue: readonly string[];
}): ToolCallResolution {
  const { toolCallId, toolName, preemit, toolParts, preemitQueue } = options;

  // 1. Exact id — the common case (pre-emit used the provider id, or the
  //    event is a replay of one we already applied).
  const exact = toolParts.find((p) => p.toolCall.id === toolCallId);
  if (exact) {
    return { action: "update", toolCallId };
  }

  // Pre-emit with a fresh id → will create its placeholder card below.
  if (preemit) {
    return { action: "create", identityId: toolCallId };
  }

  // 2. Finalized call → deterministic placeholder adoption.
  const byPartId = new Map(toolParts.map((p) => [p.partId, p] as const));
  const findQueued = (pred: (stub: ToolCallPartStub) => boolean): string | null => {
    for (const partId of preemitQueue) {
      const stub = byPartId.get(partId);
      if (stub && pred(stub)) return partId;
    }
    return null;
  };
  // a) a queued placeholder whose name already matches this call,
  const nameMatch = findQueued((s) => s.toolCall.name === toolName && !!toolName);
  if (nameMatch) return { action: "adopt", partId: nameMatch };
  // b) the oldest generic placeholder (name unknown at pre-emit time),
  if (isPlaceholderToolName(toolName)) {
    const generic = findQueued((s) => isPlaceholderToolName(s.toolCall.name));
    if (generic) return { action: "adopt", partId: generic };
  }
  // c) any queued placeholder whose name is generic (fence/DSML composing).
  const anyGeneric = findQueued((s) => isPlaceholderToolName(s.toolCall.name));
  if (anyGeneric) return { action: "adopt", partId: anyGeneric };

  // 3. First sight of this execution → one new part.
  return { action: "create", identityId: toolCallId };
}

// ---------------------------------------------------------------------------
// Thinking vs Working state machine (§12–§14).
// ---------------------------------------------------------------------------

export type AgentPhase = "thinking" | "working" | null;

/**
 * Derive the CURRENT execution phase for a streaming assistant message.
 * Explicit precedence (§13): a live reasoning stream wins (its panel header
 * IS the "Thinking" status — returning null here prevents a duplicate
 * status component), then any running/pending tool → "Working", and
 * otherwise the model itself is generating (final answer after tools,
 * opening text before tools, or the gap while the next round is awaited)
 * → "Thinking". Settled messages return null (completed/normal state).
 *
 * A tool call must NOT cause "Thinking" unless the model is genuinely
 * producing reasoning at that moment — reasoning parts are stamped
 * `reasoningEndedAt` the instant a tool call or text delta follows them,
 * so this stays exact.
 */
export function deriveAgentPhase(message: ChatMessage): AgentPhase {
  if (message.role !== "assistant" || !message.isStreaming) return null;
  const parts = message.parts ?? [];
  if (parts.length === 0) return "thinking";

  // Model actively reasoning → the ThinkingReasoning panel header shows
  // "Thinking…" at the reasoning's own timeline position. No second line.
  const reasoningOpen = parts.some(
    (p) =>
      (p.type === "thinking" || p.type === "reasoning") &&
      p.reasoningEndedAt === undefined,
  );
  if (reasoningOpen) return null;

  // Tools executing / awaiting their result → Working.
  const toolRunning = parts.some(
    (p) =>
      p.type === "tool" &&
      p.toolCall != null &&
      (p.toolCall.status === "running" || p.toolCall.status === "pending"),
  );
  if (toolRunning) return "working";

  // Model generating (reasoning settled, text streaming or next round
  // being awaited) → Thinking.
  return "thinking";
}

// ---------------------------------------------------------------------------
// Text aggregation rules (§23) — pure predicates shared by the store.
// ---------------------------------------------------------------------------

/**
 * True when a new text delta may MERGE into the message's last text part:
 * only when that text part is the LAST part overall (adjacent chunks of
 * the same round). Text NEVER merges across a tool boundary and is never
 * re-ordered above an earlier tool part — `text → tool → text` stays
 * `text → tool → text`.
 */
export function canMergeIntoLastTextPart(parts: readonly MessagePart[], round: number): boolean {
  const last = parts[parts.length - 1];
  if (!last || last.type !== "text") return false;
  return (last.round ?? 0) === (round ?? 0);
}

/**
 * Sequence source for normalized events: providers rarely send one, so the
 * processor stamps arrival order at ingestion (§4).
 */
export class SequenceCounter {
  private next = 0;
  take(): number {
    this.next += 1;
    return this.next;
  }
  peek(): number {
    return this.next;
  }
}

/** Stable event id for an incoming WSEvent (dedup key, §17). */
export function eventId(wsEvent: WSEvent, fallbackIndex: number): string {
  const data = (wsEvent.data ?? {}) as { tool_call_id?: string; event_id?: string };
  if (data.event_id && typeof data.event_id === "string") return data.event_id;
  if (data.tool_call_id && typeof data.tool_call_id === "string") {
    return `${wsEvent.type}:${data.tool_call_id}`;
  }
  return `${wsEvent.type}:${fallbackIndex}`;
}
