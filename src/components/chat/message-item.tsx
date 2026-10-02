"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { stripFunctionCallTags } from "@/lib/text-sanitizer";
import type { ChatMessage, ChatMessageFile } from "@/types";
import { ToolCallCard } from "./tool-call-card";
import { deriveAgentPhase } from "@/lib/agent/timeline";
import { useTypewriter } from "@/components/assistant-ui/elements/letter-stream";
import { RESEARCH_TOOL_NAMES } from "./research-panel";
import { MarkdownContent } from "./markdown-content";
import { CopyButton } from "./copy-button";
import { useFilePreviewStore } from "@/stores";
import { useSourcesPanelStore } from "@/stores/sources-panel-store";
import { ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { RatingButtons } from "./rating-buttons";
import { getFileUrl, loadFileUrls } from "@/lib/file-api";
import { extractSources } from "@/lib/chat-sources";
import type { SourceItem } from "@/lib/chat-sources";
import { FileCard, FileCardImage } from "./file-card";
import { CitationsFooter } from "./citations";
import { FilesFooter, deriveStreamingTree } from "./streaming-file-tree";
import { formatDuration } from "./tool-duration";
import {
  CollapsePanel,
  Orb,
  ThinkingIndicator,
  ThinkingReasoning,
} from "@/components/assistant-ui/elements";
import { currentResponseOrb } from "@/components/assistant-ui/elements/response-orb";
import { ResearchPanel } from "./research-panel";
import { GenUICreationGate } from "@/components/genui/GenUICreationGate";
import { useGenUIFromText } from "@/hooks/useGenUIStream";
import { extractGenUINodes, buildTextSegments } from "@/lib/genui/stream-parser";
import type { GenUINode } from "@/lib/genui/types";
import { useChatStore } from "@/stores/chat-store";
import { useAiStatusPhrases } from "@/hooks/use-ai-status-phrases";
import { stripUploadTags } from "@/lib/uploads/registry";

/**
 * Extract + validate GenUI nodes from a message's full text (content + parts).
 * Returns null if no `<<<genui>>>` sentinel is present. Used to populate
 * `message.genui` for persistence when streaming completes.
 *
 * COMPLETE-MODE: uses the shared parser with complete=true, so a block whose
 * closing marker was written incorrectly (`<<<genui>>>` instead of
 * `<<</genui>>>`) still parses — the raw JSON never leaks into the chat
 * after a refresh.
 */
function extractGenUIFromMessage(message: ChatMessage): GenUINode[] | null {
  const text = message.content ||
    (Array.isArray(message.parts)
      ? message.parts
          .filter((p) => p.type === "text" && p.content)
          .map((p) => p.content ?? "")
          .join("\n\n")
      : "");
  if (!text || !text.includes("<<<genui>>>")) return null;
  return extractGenUINodes(text);
}

/**
 * ThinkingBlock / ReasoningBlock — the CLASSIC (tool-less) reasoning
 * display: the full ThinkingReasoning element with its own header — the
 * live reasoning streams visibly, letter by letter ("Thinking…" header),
 * then folds into a "Thought for Ns" / "Reasoned for Ns" summary once
 * the stream ends. Turns WITH tool calls stream their reasoning inside
 * the WorkingPanel instead (PanelThinkingRun, headerless live mode).
 * Elapsed seconds are measured locally from the moment streaming starts
 * until it ends.
 */
function ReasoningPanel({
  text,
  isStreaming,
  variant,
}: {
  text: string;
  isStreaming: boolean;
  variant: "thinking" | "reasoning";
}) {
  const isThinking = variant === "thinking";

  // AI-written follow-up phrases for the bare thinking line (per-turn,
  // from the backend LLM — see AgentStatusLine).
  const taskText = useLastUserTaskText();
  const aiPhrases = useAiStatusPhrases({
    activity: isThinking ? "thinking" : "reasoning",
    task: taskText,
    enabled: isStreaming,
  });

  // Split the (possibly still-streaming) reasoning text into sentences —
  // the element reveals them row by row. PRD §5 (reasoning formatting):
  // normalize ONLY unintended repeated whitespace — never a blanket trim
  // on the raw stream, which would damage legitimate formatting.
  const sentences = React.useMemo(() => splitReasoningSentences(text), [text]);

  // Measure how long the block has been / was streaming so the settled
  // summary can say "Thought for Ns".
  const startedAtRef = React.useRef<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  React.useEffect(() => {
    if (isStreaming) {
      if (startedAtRef.current === null) startedAtRef.current = Date.now();
      const id = window.setInterval(() => {
        if (startedAtRef.current !== null) {
          setElapsedSeconds((Date.now() - startedAtRef.current) / 1000);
        }
      }, 500);
      return () => window.clearInterval(id);
    }
    if (startedAtRef.current !== null) {
      setElapsedSeconds((Date.now() - startedAtRef.current) / 1000);
      startedAtRef.current = null;
    }
  }, [isStreaming]);

  // While streaming with no text yet, show the bare thinking indicator
  // line instead of an empty collapsible.
  if (sentences.length === 0) {
    if (!isStreaming) return null;
    return (
      <ThinkingIndicator
        label={isThinking ? "Thinking" : "Reasoning"}
        phrases={aiPhrases ?? undefined}
        className="mb-2"
      />
    );
  }

  return (
    <div className="mb-2 min-w-0 max-w-full">
      <ThinkingReasoning
        sentences={sentences}
        phase={isStreaming ? "thinking" : "done"}
        elapsedSeconds={elapsedSeconds}
        verb={isThinking ? "Thought" : "Reasoned"}
        activeLabel={isThinking ? "Thinking…" : "Reasoning…"}
        // THINKING-TEXT CONTINUITY: the live header is the SAME cycling
        // indicator shown before the first sentence arrived — the status
        // text no longer swaps to a different static label the moment real
        // reasoning starts streaming.
        headerNode={
          isStreaming ? (
            <ThinkingIndicator
              showDot={false}
              label={isThinking ? "Thinking" : "Reasoning"}
              phrases={aiPhrases ?? undefined}
              className="min-w-0"
            />
          ) : undefined
        }
      />
    </div>
  );
}

function ThinkingBlock(props: { text: string; isStreaming: boolean }) {
  return <ReasoningPanel {...props} variant="thinking" />;
}

function ReasoningBlock(props: { text: string; isStreaming: boolean }) {
  return <ReasoningPanel {...props} variant="reasoning" />;
}

/**
 * Random response orb glyph (PRD §25–§28): the 25-variant pick made once
 * when this AI response began (see response-orb.ts). Rendered at 28px —
 * noticeably larger than the old 18px — and leading the thinking label on
 * ONE items-center flex row so the text sits on the lattice midline.
 * Reading the singleton via useMemo means only this glyph re-renders when
 * the response's orb is chosen — never the app, chat, or message list.
 */
function ResponseOrbGlyph({ size = 28 }: { size?: number }) {
  const variant = React.useMemo(() => currentResponseOrb(), []);
  return <Orb variant={variant} size={size} className="shrink-0" />;
}

/** The conversation's LAST user message (the current task), bounded —
 *  context for the AI-written status phrases. The selector returns a
 *  primitive, so this only re-renders the host when the task text actually
 *  changes (a new user message), never per streaming token. */
function useLastUserTaskText(): string {
  return useChatStore((s) => {
    for (let i = s.messages.length - 1; i >= 0; i--) {
      const m = s.messages[i]!;
      if (m.role === "user" && m.content) return m.content.slice(0, 400);
    }
    return "";
  });
}

/**
 * AgentStatusLine — THE one in-place execution status for a STREAMING
 * assistant message WITHOUT tool calls (the classic flow and the legacy
 * fallback). Exactly one instance per message, rendered at the END of the
 * parts flow; it never stacks with itself across transitions — the label
 * updates in place:
 *
 *   Thinking  — the model is generating (opening text or the answer).
 *   Working   — a tool call is executing / its result is being awaited.
 *
 * Turns WITH tool calls render the WorkingPanel instead — its trigger
 * line IS the Thinking ⇄ Working status (plus "Worked {time}" at rest).
 * While a live reasoning stream is open the ThinkingReasoning panel
 * header IS the “Thinking…” status, so this line hides (no duplicate
 * status components). Settled messages render nothing (completed state).
 */
function AgentStatusLine({ message }: { message: ChatMessage }) {
  const phase = deriveAgentPhase(message);
  // AI-WRITTEN STATUS TEXT (user directive): the follow-up phrases cycling
  // under "Working/Thinking" are generated per-turn by the backend LLM
  // (/api/status-caption) from the user's request — never the old canned
  // "Reading the context" rotation.
  const taskText = useLastUserTaskText();
  const aiPhrases = useAiStatusPhrases({
    activity: phase === "working" ? "working" : "thinking",
    task: taskText,
    enabled: phase !== null,
  });
  if (!phase) return null;
  const nothingStreamed =
    (message.parts ?? []).length === 0 && !message.content;
  return (
    <div
      className="flex min-h-8 items-center gap-2.5 px-1"
      role="status"
      aria-live="polite"
    >
      <ResponseOrbGlyph size={nothingStreamed ? 28 : 22} />
      <ThinkingIndicator
        showDot={false}
        label={phase === "working" ? "Working" : "Thinking"}
        phrases={aiPhrases ?? undefined}
        className="min-w-0"
      />
    </div>
  );
}

function TextBubble({
  text,
  showCursor,
  isUser,
  onCiteClick,
  sources,
  genuiNodes,
  isStreaming,
  identityKey,
}: {
  text: string;
  showCursor: boolean;
  isUser: boolean;
  onCiteClick?: (index: number) => void;
  /** Beta V1.2: sources for the citation chips' tooltips. */
  sources?: readonly SourceItem[];
  /** Persisted GenUI nodes (set when streaming completes). When present AND
   *  the text no longer contains sentinels, these are used to render the
   *  GenUI block. During streaming, the live-parsed spec takes precedence. */
  genuiNodes?: GenUINode[];
  /** True while the message is actively streaming. Drives the GenUI creation
   *  gate ("Creating …" line → cross-fade into the rendered block). */
  isStreaming?: boolean;
  /** Stable identity of this text stream (message/part id) — lets the
   *  typewriter resume instead of replaying after a mid-stream remount
   *  (reconnect / route change, OnyxAgent stream spec §24). */
  identityKey?: string;
}) {
  // SINGLE-LETTER STREAMING (OnyxAgent stream spec): while this bubble
  // streams, the text is buffered and revealed CHARACTER BY CHARACTER —
  // one continuous character flow regardless of how the SSE chunks
  // arrived. Freshly revealed characters render at FULL INK immediately
  // (NO per-word / per-character blur or fade — the reveal pacing is the
  // motion). Settled/hydrated messages are a pure pass-through (no timers,
  // full text immediately — spec §23).
  //
  // FINISH, DON'T FLUSH (round-end rule): when the stream settles mid-
  // reveal — the AI stops, the round ends, or the turn's trailing text is
  // relocated out of the WorkingPanel (which REMOUNTS this bubble as
  // "settled") — the typewriter seeds from the identity reveal cache and
  // keeps pacing the remaining backlog out at catch-up speed. The text
  // that was already streamed but not yet revealed is NEVER dumped at
  // once.
  //
  // The markdown variant runs a BATCHED reveal (40ms tick vs the 20ms
  // default): a markdown re-parse is far heavier than a plain-text render.
  const { text: revealedText, animating } = useTypewriter(
    text,
    Boolean(isStreaming),
    { identityKey, tickMs: 40 },
  );

  // STREAM GRACE: keep the streaming render ~620ms past the reveal so the
  // settled swap (prose-sm → prose-sm-static, code-block colors) happens
  // only after the last characters are on screen — never a hard pop at
  // stream end.
  const [streamGrace, setStreamGrace] = React.useState(false);
  React.useEffect(() => {
    if (isStreaming || animating) {
      setStreamGrace(true);
      return;
    }
    const t = window.setTimeout(() => setStreamGrace(false), 620);
    return () => window.clearTimeout(t);
  }, [isStreaming, animating]);
  const streamActive = Boolean(isStreaming) || streamGrace;

  // Parse the text for `<<<genui>>>` sentinels. Returns ordered segments
  // (text / genui / text / genui / ...) so interleaved text between multiple
  // GenUI blocks is preserved.
  //
  // COMPLETE-MODE: while this text is streaming, unterminated blocks stay
  // open (waiting for the close marker). Once streaming ends — including
  // persisted messages re-rendered after a refresh — an unterminated block
  // is treated as CLOSED so a wrongly-written close marker still renders
  // the card instead of leaking raw `<<<genui>>>` JSON as markdown.
  const { segments } = useGenUIFromText(revealedText, !isStreaming);

  if (isUser) {
    // HIDDEN UPLOAD TAGS (File Persistence PRD §30): persisted user messages
    // carry internal `<user_uploaded_file …/>` (and legacy `<@…>`) markup for
    // the AI + attachment reconstruction. The user must NEVER see it — the
    // bubble renders the stripped text; the FileCard chips render above it.
    const displayText = stripUploadTags(text);
    // QUOTED REPLY (assistant-ui "Quote" element flow): a message sent via
    // the quote toolbar carries the quoted assistant text as leading
    // markdown `> ` blockquote lines. Render them as a styled quote block
    // (left accent bar, italic, muted) instead of literal ">" characters.
    const quoteMatch = displayText.match(/^((?:>[^\n]*\n?)+)([\s\S]*)$/);
    const quotedLines = quoteMatch?.[1];
    const restText = quoteMatch?.[2]?.replace(/^\n+/, "") ?? displayText;
    const quotedBlock = quotedLines
      ?.split("\n")
      .map((l) => l.replace(/^>\s?/, ""))
      .join("\n")
      .trim();
    // User turn — right-aligned soft-terracotta card with a small tail
    // (Terra spec: #F0E3D5 fill, #EAD6C4 hairline, ink text, rounded-tr-sm).
    return (
      <div
        className={cn(
          "relative max-w-full break-words rounded-2xl rounded-tr-sm border px-3.5 py-2.5 sm:px-4",
        )}
        style={{
          backgroundColor: "var(--chat-user-bg, var(--color-accent))",
          borderColor: "var(--chat-user-border, var(--color-border))",
          color: "var(--chat-user-fg, var(--color-foreground))",
        }}
      >
        {quotedBlock ? (
          <blockquote
            className="mb-1.5 rounded-r-md border-l-2 border-l-primary/70 bg-background/40 py-1 pr-2 pl-2.5 text-[13px] leading-relaxed italic opacity-80"
          >
            <p className="line-clamp-4 break-words whitespace-pre-wrap">{quotedBlock}</p>
          </blockquote>
        ) : null}
        {restText ? (
          <p className="text-sm leading-relaxed break-words whitespace-pre-wrap overflow-wrap-anywhere text-inherit">{restText}</p>
        ) : !quotedBlock ? (
          <p className="text-sm leading-relaxed break-words whitespace-pre-wrap overflow-wrap-anywhere text-inherit">
            <span className="opacity-70">Sent an attachment</span>
          </p>
        ) : null}
      </div>
    );
  }

  // If there are no live sentinels but we have persisted genuiNodes, use those
  // as a single GenUI block after the full text.
  const hasLiveSentinels = segments.some((s) => s.type === "genui");
  const persistedSpec =
    !hasLiveSentinels && genuiNodes && genuiNodes.length > 0
      ? { nodes: genuiNodes }
      : null;

  // If no segments and no persisted spec, just render the full text as markdown.
  // Assistant turns are FRAMELESS (Terra spec) — no bubble, editorial text on
  // the cream canvas with serif-numeral ordered lists.
  //
  // PLAIN PACED REVEAL (animation state ≠ text state): NO whole-block dim
  // and NO per-character fade spans exist — the old `.response-live`
  // opacity/blur wrapper leaked into the final state whenever a streaming
  // flag stuck (the "grey text" bug), and the `.letter-in` per-char
  // blur/fade was removed per user spec. Revealed text renders at natural
  // styles (opacity 1, no filter, theme foreground); the typewriter paces
  // the reveal and the message-level entrance fade handles the
  // whole-response fade-in.
  if (segments.length === 0 && !persistedSpec) {
    return (
      <div className="relative w-full max-w-full break-words">
        <div
          className={cn(
            "prose-sm assistant-prose max-w-none break-words text-[15px] leading-[1.68]",
            !streamActive && "prose-sm-static",
          )}
        >
          <MarkdownContent
            content={stripFunctionCallTags(revealedText)}
            onCiteClick={onCiteClick}
            sources={sources}
            showCursor={showCursor}
            streaming={streamActive}
          />
        </div>
      </div>
    );
  }

  // Render segments in order — alternating text (markdown) and GenUI blocks.
  // If persisted spec exists (no live sentinels), render full text + persisted spec.
  const renderSegments = hasLiveSentinels
    ? segments
    : persistedSpec
      ? [{ type: "text" as const, text: revealedText }, { type: "genui" as const, spec: persistedSpec, streaming: false }]
      : segments;

  // Determine if cursor should show on the last text segment
  const lastTextIdx = renderSegments.map((s) => s.type).lastIndexOf("text");

  return (
    <div className="relative w-full max-w-full break-words">
      {renderSegments.map((seg, i) => {
        if (seg.type === "text") {
          const isLast = i === lastTextIdx;
          return (
            <div
              key={i}
              className={cn(
                "prose-sm assistant-prose max-w-none break-words text-[15px] leading-[1.68]",
                i > 0 && "mt-3",
                !streamActive && "prose-sm-static",
              )}
            >
              <MarkdownContent
                content={stripFunctionCallTags(seg.text || "")}
                onCiteClick={onCiteClick}
                sources={sources}
                showCursor={showCursor && isLast}
                streaming={streamActive && isLast}
              />
            </div>
          );
        }
        // GenUI segment — PRD §21 creation gate: while the block streams, a
        // thinking-UI-style "Creating …" line stands in (NO shimmer
        // placeholder card); when the spec completes it cross-fades into the
        // rendered block (creation line blurs out as the block blur-in).
        return (
          <div key={i} className={cn(i > 0 && "mt-3")}>
            <GenUICreationGate spec={seg.spec} streaming={seg.streaming} />
          </div>
        );
      })}
    </div>
  );
}

/* SourcesButton — replaced by the Beta V1.2 CitationsFooter (the compact
 * numbered source list under the answer). Kept out of the tree; the chip
 * click + the panel zoom survive via onCiteClick. */

interface MessageItemProps {
  message: ChatMessage;
  groupPosition?: "first" | "middle" | "last" | "single";
  /** When false, hides the footer (copy/timestamp/regenerate). Used for
   *  grouped messages where only the last message should show the footer. */
  showFooter?: boolean;
  /** True for the message that owns the live todo plan — the inline
   *  ResearchPanel renders at the exact position where the todo tool ran
   *  inside this message's part flow (not stuck at the thread bottom). */
  showTodoPanel?: boolean;
  /** Wired to the inline todo panel's "Cut" (dismiss) button. */
  onTodoDismiss?: () => void;
  onRegenerate?: () => void;
  /** True while a (re)generation turn is running — disables the regenerate
   *  button and swaps its icon for a spinner (PRD §6: the button must show
   *  a loading state and never fire a duplicate regeneration). */
  isRegenerating?: boolean;
}

// ---------------------------------------------------------------------------
// WORKING PANEL (user spec, 2026-09-27) — ONE collapsible unit owning the
// ENTIRE generation process of an assistant turn. See WorkingPanel below.
// ---------------------------------------------------------------------------

/** Content-payload tools that render a deliverable inline in their card
 *  (charts, downloads, image previews, Q&A). A process holding one of
 *  these does NOT force-collapse at settle — the deliverable must stay
 *  visible (the same exception the old tool stacks had). */
const PAYLOAD_TOOL_NAMES = new Set([
  "create_chart",
  "send_file",
  "send_folder",
  "preview_image",
  "ask_user",
]);

/** One chronological step of the generation process, built by walking the
 *  message parts (the execution timeline). Runs of consecutive thinking /
 *  reasoning parts merge into ONE item while the run is open; tool and
 *  text parts stay in place. Research/todo tools are already filtered out
 *  of `parts` (they surface as the inline ResearchPanel instead). */
type FlowItem =
  | {
      kind: "thinking";
      partId: string;
      text: string;
      variant: "thinking" | "reasoning";
      /** The reasoning stream is still open (no reasoningEndedAt stamp). */
      open: boolean;
      /** Round start stamp — drives the "Thought for Ns" duration. */
      startedAt?: number;
      /** reasoningEndedAt stamp of the run's last part. */
      endedAt?: number;
    }
  | { kind: "tool"; partId: string; toolCall: import("@/types").ToolCall }
  | { kind: "text"; partId: string; text: string };

/** Walk the message parts into chronological FlowItems. A closed reasoning
 *  run is never merged into — the next round's thinking starts a fresh
 *  row (each "Thought for Ns" belongs to its own round). */
function buildFlowItems(
  parts: readonly import("@/types/chat").MessagePart[],
): FlowItem[] {
  const items: FlowItem[] = [];
  for (const p of parts) {
    if ((p.type === "thinking" || p.type === "reasoning") && p.content) {
      const last = items[items.length - 1];
      if (
        last &&
        last.kind === "thinking" &&
        last.variant === p.type &&
        last.open
      ) {
        last.text += "\n" + p.content;
        last.open = p.reasoningEndedAt === undefined;
        if (p.reasoningEndedAt !== undefined) last.endedAt = p.reasoningEndedAt;
        if (p.roundStartedAt !== undefined && last.startedAt === undefined) {
          last.startedAt = p.roundStartedAt;
        }
        continue;
      }
      items.push({
        kind: "thinking",
        partId: p.id,
        text: p.content,
        variant: p.type,
        open: p.reasoningEndedAt === undefined,
        startedAt: p.roundStartedAt,
        endedAt: p.reasoningEndedAt,
      });
    } else if (p.type === "tool" && p.toolCall) {
      items.push({ kind: "tool", partId: p.id, toolCall: p.toolCall });
    } else if (p.type === "text" && p.content) {
      items.push({ kind: "text", partId: p.id, text: p.content });
    }
  }
  return items;
}

/** Split reasoning text into sentences for the ThinkingReasoning element
 *  (timeline PRD §5: normalize ONLY unintended whitespace — 3+ blank lines
 *  → one paragraph break, long space runs → one space — never a blanket
 *  trim on the raw stream, which would damage legitimate formatting). */
function splitReasoningSentences(text: string): string[] {
  const normalized = (text ?? "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[^\S\n]{2,}/g, " ")
    .trim();
  if (!normalized) return [];
  return normalized
    .split(/(?<=[.!?;])\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

/**
 * A reasoning run INSIDE the WorkingPanel. While the stream is open the
 * sentences stream LIVE, letter by letter — HEADERLESS (the panel's own
 * trigger line owns the "Thinking" status, so the two shimmer labels never
 * stack). The moment reasoning ends, the same element folds into its
 * "Thought for Ns" summary row (collapsed, expandable to re-read).
 */
function PanelThinkingRun({
  item,
  streaming,
}: {
  item: Extract<FlowItem, { kind: "thinking" }>;
  streaming: boolean;
}) {
  const sentences = React.useMemo(
    () => splitReasoningSentences(item.text),
    [item.text],
  );
  if (sentences.length === 0) return null;
  const open = streaming && item.open;
  const elapsed =
    item.startedAt !== undefined && item.endedAt !== undefined
      ? Math.max(0, (item.endedAt - item.startedAt) / 1000)
      : 0;
  return (
    <ThinkingReasoning
      sentences={sentences}
      phase={open ? "thinking" : "done"}
      elapsedSeconds={elapsed}
      verb={item.variant === "thinking" ? "Thought" : "Reasoned"}
      activeLabel={item.variant === "thinking" ? "Thinking…" : "Reasoning…"}
      headerlessLive
    />
  );
}

/** "Worked {time}" resting summary for a settled turn. Prefers the
 *  processor-stamped `generation` window; falls back to the part stamps
 *  (legacy rows); a turn with no timing at all still says "Worked". */
function workedSummary(message: ChatMessage): {
  time: string | null;
  failed: boolean;
  stopped: boolean;
} {
  const g = message.generation;
  if (g) {
    return {
      time: formatDuration(g.durationMs) || null,
      failed: Boolean(g.failed),
      stopped: Boolean(g.stopped),
    };
  }
  let start: number | undefined;
  let end: number | undefined;
  for (const p of message.parts ?? []) {
    if (p.roundStartedAt !== undefined && (start === undefined || p.roundStartedAt < start)) {
      start = p.roundStartedAt;
    }
    if (p.roundEndedAt !== undefined && (end === undefined || p.roundEndedAt > end)) {
      end = p.roundEndedAt;
    }
    if (p.reasoningEndedAt !== undefined && (end === undefined || p.reasoningEndedAt > end)) {
      end = p.reasoningEndedAt;
    }
    if (p.type === "tool" && p.toolCall) {
      if (p.toolCall.startedAt !== undefined && (start === undefined || p.toolCall.startedAt < start)) {
        start = p.toolCall.startedAt;
      }
      if (p.toolCall.endedAt !== undefined && (end === undefined || p.toolCall.endedAt > end)) {
        end = p.toolCall.endedAt;
      }
    }
  }
  return {
    time:
      start !== undefined && end !== undefined
        ? formatDuration(Math.max(0, end - start)) || null
        : null,
    failed: false,
    stopped: false,
  };
}

/**
 * WorkingPanel — ONE collapsible unit owning the ENTIRE generation process
 * of an assistant turn (user spec, 2026-09-27):
 *
 *   Thinking ⇄ Working — while the turn streams, the trigger label is the
 *   live phase: "Thinking" while the model reasons or generates, "Working"
 *   while a tool executes — one line, switching in place, never a second
 *   status row. The live reasoning STREAMS VISIBLY inside (letter by
 *   letter, headerless); each round's thinking then folds into its own
 *   "Thought for Ns" row the moment it ends. All tool calls, inner
 *   thinking and texts generated during the process live inside — strict
 *   chronological order (timeline PRD §25: array position is the truth).
 *
 *   The final answer (text after the last tool) streams at the tail of the
 *   process while live — no mid-stream jumps: a tool arriving later simply
 *   appends after it — then renders BELOW the panel once the turn settles
 *   and the panel collapses into its "Worked {time}" resting row. No
 *   PROCESS divider or label — nothing but the real event renderers.
 */
function WorkingPanel({
  message,
  hasDeliverables,
  children,
}: {
  message: ChatMessage;
  /** A payload tool (chart / download / preview / Q&A) or the live plan
   *  panel keeps the panel from force-collapsing at settle. */
  hasDeliverables: boolean;
  /** The process content — thinking runs, tool cards, texts. */
  children: React.ReactNode;
}) {
  const streaming = Boolean(message.isStreaming);
  // Live phase: deriveAgentPhase returns null while a reasoning stream is
  // open (the classic flow's ThinkingReasoning header owns the status
  // there) — inside the panel the trigger owns it, so null ⇒ "Thinking".
  const phase = streaming ? (deriveAgentPhase(message) ?? "thinking") : null;

  // AI-written follow-up phrases for the live Thinking ⇄ Working trigger
  // (per-turn, backend LLM — see AgentStatusLine). The panel's own label
  // always leads the rotation; the AI phrases follow it.
  const taskText = useLastUserTaskText();
  const aiPhrases = useAiStatusPhrases({
    activity: phase === "working" ? "working" : "thinking",
    task: taskText,
    enabled: streaming,
  });

  const [expanded, setExpanded] = React.useState(streaming || hasDeliverables);
  const [userToggled, setUserToggled] = React.useState(false);
  // AUTO EXPAND/COLLAPSE (render-time adjustment — no effect, no cascading
  // renders): expanded for the whole live stream, force-collapsed the
  // moment the turn settles ("collapsed at end") — unless the process
  // carries a deliverable, which must stay visible. A manual toggle during
  // the stream wins until settle; after settle the user is free again.
  const autoTarget = streaming;
  const [prevAuto, setPrevAuto] = React.useState(autoTarget);
  if (autoTarget !== prevAuto) {
    setPrevAuto(autoTarget);
    if (autoTarget) {
      if (!userToggled) setExpanded(true);
    } else if (!hasDeliverables) {
      setExpanded(false);
      setUserToggled(false);
    }
  }

  const worked = workedSummary(message);

  return (
    <div className="mb-2 min-w-0 max-w-full">
      {/* ONE trigger line — the live Thinking/Working status while
          streaming, the "Worked {time}" resting summary after settle. */}
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={
          streaming
            ? phase === "working"
              ? "Agent is working (toggle process details)"
              : "Agent is thinking (toggle process details)"
            : "Toggle work summary"
        }
        onClick={() => {
          setUserToggled(true);
          setExpanded((o) => !o);
        }}
        className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-sm transition-colors hover:bg-accent/50"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
            expanded && "rotate-90",
          )}
          aria-hidden
        />
        {streaming ? (
          // ThinkingIndicator without its dot: a keyed shimmer label —
          // the fade replays every time Thinking switches to Working and
          // back, per the spec. The follow-up phrases are AI-written.
          <ThinkingIndicator
            showDot={false}
            label={phase === "working" ? "Working" : "Thinking"}
            phrases={aiPhrases ?? undefined}
            className="min-w-0"
          />
        ) : (
          <span className="text-sm font-medium text-foreground/90">
            Worked{worked.time ? ` ${worked.time}` : ""}
          </span>
        )}
        {worked.failed && (
          <span className="text-sm font-medium text-destructive/90">· Failed</span>
        )}
        {!worked.failed && worked.stopped && (
          <span className="text-sm font-medium text-muted-foreground">· Stopped</span>
        )}
      </button>
      <CollapsePanel open={expanded}>
        {/* The whole process, on one timeline rail — no PROCESS label,
            no divider: thinking rows, tool cards and texts in the exact
            order they happened. */}
        <div className="mt-1 ml-1.5 space-y-1.5 border-l border-border/70 pl-3">
          {children}
        </div>
      </CollapsePanel>
    </div>
  );
}

export const MessageItem = React.memo(function MessageItem({
  message,
  groupPosition,
  showFooter = true,
  showTodoPanel = false,
  onTodoDismiss,
  onRegenerate,
  isRegenerating = false,
}: MessageItemProps) {
  const isUser = message.role === "user";
  const openPreview = useFilePreviewStore((s) => s.open);
  const openSources = useSourcesPanelStore((s) => s.open);
  const isGrouped = groupPosition && groupPosition !== "single";

  // ATTACHMENT URL WARM-UP (File Persistence PRD §25): after a refresh the
  // blob-URL cache is cold — image previews (and file-preview opens) need
  // `loadFileUrls()` to repopulate it from persistent OPFS storage. Fire-and-
  // forget, once per attachment set; the cache write triggers the store
  // subscription cycle and the next render shows the preview.
  const warmedAttachmentKeyRef = React.useRef<string>("");
  React.useEffect(() => {
    const ids = message.files?.map((f) => f.id) ?? message.fileIds ?? [];
    if (ids.length === 0) return;
    const key = ids.join(",");
    if (warmedAttachmentKeyRef.current === key) return;
    warmedAttachmentKeyRef.current = key;
    void loadFileUrls(ids);
  }, [message.files, message.fileIds]);

  // PERF: Memoize extractSources + parts filtering so they don't re-run on
  // every parent re-render. These were previously called inline on every
  // render, causing O(n) work per message per store update.
  const sources = React.useMemo(
    () => (!isUser ? extractSources(message) : []),
    [isUser, message],
  );
  const hasSources = sources.length > 0 && !message.isStreaming;
  const onCiteClick = React.useMemo(
    () => (hasSources ? (index: number) => openSources(sources, index) : undefined),
    [hasSources, sources, openSources],
  );

  // PERF: Memoize the filtered parts array (removes research/todo tool calls
  // from the TOOL rendering flow — they surface as the inline plan panel
  // instead, injected at their original position below).
  // Previously this filter ran on every render for every message.
  const parts = React.useMemo(
    () =>
      (message.parts ?? []).filter(
        (p) => !(p.type === "tool" && p.toolCall && RESEARCH_TOOL_NAMES.has(p.toolCall.name)),
      ),
    [message.parts],
  );

  // COPY TEXT (PRD §4: "copy the actual message text, not rendered HTML or
  // hidden UI content"). GenUI widget specs live inline in the raw content
  // between <<<genui>>> … <<</genui>>> sentinels — the clipboard gets the
  // plain text the user actually SEES, with the raw JSON specs stripped.
  // Upload tags are equally internal — they never reach the clipboard.
  const copyText = React.useMemo(() => {
    const raw =
      message.content ||
      (message.parts ?? [])
        .filter((p) => p.type === "text" && p.content)
        .map((p) => p.content)
        .join("\n\n");
    if (!raw) return "";
    if (raw.includes("<<<genui>>>")) {
      const segments = buildTextSegments(raw, undefined, true);
      return segments
        .filter((s) => s.type === "text")
        .map((s) => s.text ?? "")
        .join("\n\n")
        .trim();
    }
    return stripUploadTags(raw);
  }, [message.content, message.parts]);

  // Id of the LAST research/todo tool part in the original parts order —
  // the inline plan panel renders exactly there ("on the response bar where
  // it was really generated"), not stuck at the thread bottom.
  const lastResearchPartId = React.useMemo(() => {
    let last: string | null = null;
    for (const p of message.parts ?? []) {
      if (p.type === "tool" && p.toolCall && RESEARCH_TOOL_NAMES.has(p.toolCall.name)) {
        last = p.id;
      }
    }
    return last;
  }, [message.parts]);

  // Parts flow rendering applies when there are non-research parts, OR when
  // this message owns the live todo plan (a research-only message still
  // renders the inline panel through the flow path below).
  const useParts =
    !isUser &&
    (parts.length > 0 || (showTodoPanel && lastResearchPartId !== null));

  // GenUI HOST (user fix, 2026-09-29 — "gen ui is duplicating in every round
  // inside worked panel"): the persisted `message.genui` nodes must render
  // on EXACTLY ONE text part — the part that actually carries the
  // `<<<genui>>>` sentinel. (When no part carries the sentinel — legacy
  // messages whose text was sanitized — the LAST text part hosts the
  // fallback render.) Previously the nodes were handed to EVERY round's
  // TextBubble, so after the turn settled each round inside the
  // WorkingPanel rendered its own duplicate of the GenUI card.
  const genuiHostPartId = React.useMemo(() => {
    if (isUser || !message.genui || message.genui.length === 0) return null;
    const textParts = (parts as readonly { id: string; type: string; content?: string }[]).filter(
      (p) => p.type === "text" && typeof p.content === "string" && p.content.length > 0,
    );
    if (textParts.length === 0) return null;
    const withSentinel = textParts.find((p) => p.content!.includes("<<<genui>>>"));
    const host = withSentinel ?? textParts[textParts.length - 1]!;
    return host.id;
  }, [isUser, message.genui, parts]);

  // Persist GenUI nodes when streaming completes. Once `isStreaming` flips
  // to false, if the message text contains `<<<genui>>>` sentinels but
  // `message.genui` isn't set yet, parse + validate the spec and store it
  // via `updateMessage`. This makes the spec survive reloads (it's saved to
  // Dexie by the chat store's persist middleware).
  const updateMessage = useChatStore((s) => s.updateMessage);
  React.useEffect(() => {
    if (isUser) return;
    if (message.isStreaming) return;
    if (message.genui && message.genui.length > 0) return;
    const extracted = extractGenUIFromMessage(message);
    if (extracted && extracted.length > 0) {
      updateMessage(message.id, (msg) => ({
        ...msg,
        genui: extracted,
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id, message.isStreaming, message.content, message.parts, isUser]);

  // END-OF-TURN FILES FOOTER (Beta V1.3): the compact "Files · N" card in
  // the CitationsFooter visual language — derived from the turn's file tool
  // calls but rendered ONLY after the turn settles (never while streaming,
  // same gate as the sources footer). The live growing tree was retired:
  // the story of "what changed" belongs at the end, compact, not a growing
  // panel that fights the streaming answer for space.
  const streamTree = React.useMemo(() => {
    if (isUser || message.isStreaming) return null;
    const toolCalls = message.parts?.length
      ? message.parts
          .filter((p) => p.type === "tool" && p.toolCall)
          .map((p) => p.toolCall!)
      : (message.toolCalls ?? []);
    if (toolCalls.length === 0) return null;
    const derived = deriveStreamingTree(toolCalls);
    return derived.fileCount > 0 ? derived : null;
  }, [isUser, message.isStreaming, message.parts, message.toolCalls]);

  return (
    <div
      className={cn(
        "group relative flex overflow-visible",
        isGrouped ? "py-1.5 sm:py-2" : "py-3 sm:py-4",
        // Terra asymmetric turns: user right-aligned, assistant left/frameless.
        isUser ? "justify-end" : "justify-start",
        // Entrance animation: AI messages blur+fade in from top, user
        // messages slide in from the right. Both use spring easing.
        isUser ? "bubble-user-in" : "bubble-ai-in",
      )}
    >
      <div
        data-quoteable={isUser ? undefined : "true"}
        className={cn(
          "min-w-0 space-y-2",
          isUser
            ? "flex max-w-[90%] flex-col items-end sm:max-w-[85%]"
            : "w-full max-w-full",
        )}
      >
        {/* Assistant identity — small terracotta mark + serif-italic name
            (Terra spec). Only on the first message of a consecutive group. */}
        {!isUser && (!isGrouped || groupPosition === "first") && (
          <div className="flex items-center gap-1.5">
            <span className="inline-flex h-4 w-4 items-center justify-center text-primary" aria-hidden>
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current">
                <path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" />
              </svg>
            </span>
            <span className="assistant-name text-[15px] leading-none">OnyxAgent</span>
          </div>
        )}
        {isUser &&
          (() => {
            const attachments: AttachmentDisplay[] =
              message.files && message.files.length > 0
                ? message.files.map((f) => ({ kind: kindFor(f), file: f }))
                : (message.fileIds ?? []).map((id) => ({ kind: "unknown" as const, id }));
            if (attachments.length === 0) return null;
            return (
              <div className="flex flex-wrap gap-2">
                {attachments.map((att) =>
                  att.kind === "image" && getFileUrl(att.file.id) ? (
                    <FileCardImage
                      key={att.file.id}
                      filename={att.file.filename}
                      previewUrl={getFileUrl(att.file.id)}
                      size={att.file.size}
                      onClick={() => openPreview(att.file)}
                    />
                  ) : "file" in att ? (
                    <FileCard
                      key={att.file.id}
                      filename={att.file.filename}
                      size={att.file.size}
                      mimeType={att.file.mime_type}
                      onClick={() => openPreview(att.file)}
                    />
                  ) : (
                    <FileCard
                      key={att.id}
                      filename="Attached file"
                      href={getFileUrl(att.id) || "#"}
                    />
                  ),
                )}
              </div>
            );
          })()}

        {(() => {
          // `parts` is memoized at the top of the component (above).
          //
          // WORKING-PANEL FLOW (user spec, 2026-09-27): a turn that made
          // tool calls renders ONE collapsible WorkingPanel owning the
          // whole process — every round's inner thinking (live while it
          // streams, then a "Thought for Ns" row), every tool call and
          // every text generated along the way, in strict chronological
          // order. The trigger label switches Thinking ⇄ Working in place
          // and the panel collapses into "Worked {time}" when the turn
          // settles. The final answer (text after the last tool) renders
          // below the panel. Tool-less turns keep the classic frameless
          // flow (thinking block → text) + the one AgentStatusLine.

          // ── Legacy fallback: user / pre-parts messages. ────────────────
          if (!useParts) {
            return (
              <>
                {!isUser && message.thinking && (
                  <ThinkingBlock
                    text={message.thinking}
                    isStreaming={Boolean(message.isStreaming)}
                  />
                )}
                {!isUser && message.reasoning && (
                  <ReasoningBlock
                    text={message.reasoning}
                    isStreaming={Boolean(message.isStreaming)}
                  />
                )}
                {message.content && (
                  <TextBubble
                    text={message.content}
                    showCursor={!isUser && Boolean(message.isStreaming)}
                    isUser={isUser}
                    onCiteClick={onCiteClick}
                    sources={sources}
                    genuiNodes={!message.isStreaming ? message.genui : undefined}
                    isStreaming={Boolean(message.isStreaming)}
                    identityKey={message.id}
                  />
                )}
                {message.toolCalls && message.toolCalls.length > 0 && (
                  <div className="w-full space-y-2">
                    {message.toolCalls.map((toolCall) => (
                      <ToolCallCard key={toolCall.id} toolCall={toolCall} />
                    ))}
                  </div>
                )}
                {/* ONE in-place status line — the model is generating. */}
                {!isUser && <AgentStatusLine message={message} />}
              </>
            );
          }

          // ── Walk the timeline into chronological process items. ────────
          const items = buildFlowItems(parts);
          const streaming = Boolean(message.isStreaming);

          // Last TOOL item — the process/final-answer boundary. Text
          // generated after the last tool is the FINAL ANSWER: while the
          // turn streams it stays at the tail of the process (inside the
          // panel — a tool arriving later simply appends after it, so
          // nothing ever jumps mid-stream); when the turn settles it
          // renders BELOW the collapsed panel as the message body.
          let lastToolItemIdx = -1;
          for (let i = 0; i < items.length; i++) {
            if (items[i]!.kind === "tool") lastToolItemIdx = i;
          }
          const hasPanel = lastToolItemIdx >= 0;

          const processItems = hasPanel
            ? items.filter(
                (it, i) =>
                  it.kind !== "text" || i < lastToolItemIdx || streaming,
              )
            : items;
          const trailingItems =
            hasPanel && !streaming
              ? items.filter(
                  (it, i) => it.kind === "text" && i > lastToolItemIdx,
                )
              : [];

          // The text part currently streaming (the active tail), if any.
          const lastItem = items[items.length - 1];
          const streamingTextTailId =
            streaming && lastItem && lastItem.kind === "text"
              ? lastItem.partId
              : null;

          // Todo-panel splice (legacy research tools): the inline plan
          // renders right before the first part that follows the last
          // research part in the original order, or at the very end when
          // every research part trails the flow.
          const todoSplice: { beforePartId?: string; atEnd?: boolean } | null =
            (() => {
              if (!showTodoPanel || !lastResearchPartId) return null;
              let seen = false;
              for (const p of message.parts ?? []) {
                if (p.id === lastResearchPartId) {
                  seen = true;
                  continue;
                }
                if (
                  seen &&
                  (((p.type === "text" || p.type === "thinking" || p.type === "reasoning") &&
                    p.content) ||
                    (p.type === "tool" && p.toolCall))
                ) {
                  return { beforePartId: p.id };
                }
              }
              return { atEnd: true };
            })();

          const renderTodoPanel = (key: string) => (
            <div key={key} className="w-full">
              <ResearchPanel onDismiss={onTodoDismiss} />
            </div>
          );

          // Render one process item. `inPanel` decides the two
          // Working/classic differences: live reasoning streams HEADERLESS
          // inside the panel (the trigger owns the "Thinking" status) but
          // with its own header in the classic flow; process text is
          // slightly muted inside the panel.
          const renderItem = (it: FlowItem, inPanel: boolean) => {
            if (it.kind === "thinking") {
              if (inPanel) {
                return <PanelThinkingRun key={it.partId} item={it} streaming={streaming} />;
              }
              const openNow = streaming && it.open;
              return openNow ? (
                <ThinkingBlock key={it.partId} text={it.text} isStreaming />
              ) : (
                <PanelThinkingRun key={it.partId} item={it} streaming={false} />
              );
            }
            if (it.kind === "tool") {
              return (
                <div key={it.partId} className="w-full">
                  <ToolCallCard toolCall={it.toolCall} turnId={message.conversationId} />
                </div>
              );
            }
            const isTail = it.partId === streamingTextTailId;
            const bubble = (
              <TextBubble
                text={it.text}
                showCursor={isTail}
                isUser={false}
                onCiteClick={onCiteClick}
                sources={sources}
                genuiNodes={!streaming && it.partId === genuiHostPartId ? message.genui : undefined}
                isStreaming={isTail}
                identityKey={it.partId}
              />
            );
            if (!inPanel) return <React.Fragment key={it.partId}>{bubble}</React.Fragment>;
            // FULL INK (no opacity-85 wrapper): intermediate text inside the
            // WorkingPanel is real assistant text — a persistent parent-level
            // opacity leak here kept it permanently grey/dim after completion
            // (a child can never be full-white under a faded parent).
            return (
              <div key={it.partId} className="w-full">
                {bubble}
              </div>
            );
          };

          // ── PANEL PATH: one WorkingPanel + the final answer below it. ──
          if (hasPanel) {
            // Deliverables (charts, downloads, previews, Q&A, live plan)
            // keep the panel from force-collapsing at settle — they must
            // stay visible.
            const hasDeliverables =
              processItems.some(
                (it) => it.kind === "tool" && PAYLOAD_TOOL_NAMES.has(it.toolCall.name),
              ) || todoSplice !== null;

            return (
              <>
                <WorkingPanel message={message} hasDeliverables={hasDeliverables}>
                  {processItems.map((it) => (
                    <React.Fragment key={it.partId}>
                      {todoSplice?.beforePartId === it.partId
                        ? renderTodoPanel(`todo-${it.partId}`)
                        : null}
                      {renderItem(it, true)}
                    </React.Fragment>
                  ))}
                </WorkingPanel>
                {trailingItems.map((it) => (
                  <React.Fragment key={it.partId}>
                    {todoSplice?.beforePartId === it.partId
                      ? renderTodoPanel(`todo-${it.partId}`)
                      : null}
                    {renderItem(it, false)}
                  </React.Fragment>
                ))}
                {todoSplice?.atEnd ? renderTodoPanel("todo-end") : null}
                {/* NO AgentStatusLine — the WorkingPanel trigger IS the
                    live status for the whole turn. */}
              </>
            );
          }

          // ── CLASSIC PATH (no tool calls): frameless editorial flow. ────
          return (
            <>
              {items.map((it) => (
                <React.Fragment key={it.partId}>
                  {todoSplice?.beforePartId === it.partId
                    ? renderTodoPanel(`todo-${it.partId}`)
                    : null}
                  {renderItem(it, false)}
                </React.Fragment>
              ))}
              {todoSplice?.atEnd ? renderTodoPanel("todo-end") : null}
              {/* ONE in-place status line — the model is generating. */}
              {!isUser && <AgentStatusLine message={message} />}
            </>
          );
        })()}

        {/* Beta V1.2 — compact source footer (AICSS "Inline Citations"): a
            numbered `n · Title · host ↗` list under the answer. Web rows open
            the source directly; RAG rows open the sources panel. */}
        {hasSources && !isUser && (
          <CitationsFooter sources={sources} onOpenPanel={(i) => openSources(sources, i)} />
        )}

        {/* FILES FOOTER — Beta V1.3: the compact end-of-turn "Files · N" card
            (same visual language + same post-stream gate as the sources
            footer). Never appears while streaming. */}
        {streamTree && (
          <FilesFooter
            nodes={streamTree.root}
            fileCount={streamTree.fileCount}
            totalAdditions={streamTree.totalAdditions}
            totalDeletions={streamTree.totalDeletions}
          />
        )}

        {/* Footer (copy/timestamp/regenerate) — only shown ONCE for the entire
            multi-round response, after all parts are complete. Hidden for
            non-last grouped messages (showFooter=false from MessageList). */}
        {showFooter && !message.isStreaming && (message.content || (message.parts ?? []).some((p) => p.type === "text" && p.content)) && (
          <div
            className={cn(
              "flex flex-wrap items-center gap-0.5 transition-opacity duration-150",
              // Subtle hover action row (Terra spec) — always visible on touch.
              "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100",
              isUser && "flex-row-reverse",
            )}
          >
            {message.timestamp && (
              <span className="text-muted-foreground mr-1 text-[10px]">
                {new Date(message.timestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            )}
            <CopyButton
              text={copyText}
              className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground h-7 w-7 rounded-md bg-transparent"
            />
            {!isUser && message.conversationId && (
              <RatingButtons
                messageId={message.id}
                conversationId={message.conversationId}
                currentRating={message.user_rating ?? null}
                ratingCount={message.rating_count ?? undefined}
                onRatingChange={(d) =>
                  updateMessage(message.id, (m) => ({
                    ...m,
                    user_rating: d.rating,
                    rating_count: d.rating_count,
                  }))
                }
                isAssistant
              />
            )}
            {!isUser && onRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                disabled={isRegenerating}
                title={isRegenerating ? "Regenerating…" : "Regenerate response"}
                aria-label={isRegenerating ? "Regenerating response" : "Regenerate response"}
                className={cn(
                  "text-muted-foreground hover:bg-foreground/5 hover:text-foreground inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors",
                  isRegenerating && "cursor-not-allowed opacity-60",
                )}
              >
                {isRegenerating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}, (prev, next) => {
  // PERF: Custom comparator — only re-render when the message content or
  // streaming state actually changed. This is the single biggest win: without
  // it, every 30ms text-delta flush re-renders ALL messages in the list (even
  // ones that haven't changed). With it, only the streaming message re-renders.
  //
  // We compare the fields that affect rendering:
  //   - message.content (the text — changes on every delta for the streaming msg)
  //   - message.isStreaming (toggles once at start/end)
  //   - message.parts (array — shallow ref check; the store creates a new array
  //     only for the changed message, so ref equality is sufficient)
  //   - message.toolCalls (same — new array only when changed)
  //   - groupPosition / showFooter / onRegenerate (parent props)
  //
  // If any of these differ, re-render. Otherwise skip.
  return (
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message.isStreaming === next.message.isStreaming &&
    prev.message.parts === next.message.parts &&
    prev.message.toolCalls === next.message.toolCalls &&
    prev.message.genui === next.message.genui &&
    // "Worked {time}" panel summary — stamped on settle; without this the
    // memo blocked the re-render and the panel never appeared.
    prev.message.generation === next.message.generation &&
    // Rating feedback mutates ONLY these two fields — without them in the
    // comparator the memo blocked the re-render and the selected thumb never
    // appeared (the "rating does nothing" half of the actions bug).
    prev.message.user_rating === next.message.user_rating &&
    prev.message.rating_count === next.message.rating_count &&
    prev.groupPosition === next.groupPosition &&
    prev.showFooter === next.showFooter &&
    prev.showTodoPanel === next.showTodoPanel &&
    prev.onTodoDismiss === next.onTodoDismiss &&
    prev.onRegenerate === next.onRegenerate &&
    prev.isRegenerating === next.isRegenerating
  );
});

type AttachmentDisplay =
  | { kind: "image"; file: ChatMessageFile }
  | { kind: "file"; file: ChatMessageFile }
  | { kind: "unknown"; id: string };

function kindFor(file: ChatMessageFile): "image" | "file" {
  if (file.file_type === "image") return "image";
  if (file.mime_type.startsWith("image/")) return "image";
  return "file";
}
