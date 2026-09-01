"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { stripFunctionCallTags } from "@/lib/text-sanitizer";
import type { ChatMessage, ChatMessageFile } from "@/types";
import { ToolCallCard } from "./tool-call-card";
import { RESEARCH_TOOL_NAMES } from "./research-panel";
import { MarkdownContent } from "./markdown-content";
import { CopyButton } from "./copy-button";
import { useFilePreviewStore } from "@/stores";
import { useSourcesPanelStore } from "@/stores/sources-panel-store";
import { ChevronDown, FileText, Globe, RefreshCw } from "lucide-react";
import { RatingButtons } from "./rating-buttons";
import { getFileUrl } from "@/lib/file-api";
import { extractSources } from "@/lib/chat-sources";
import type { SourceItem } from "@/lib/chat-sources";
import { FileCard, FileCardImage } from "./file-card";
import {
  ShimmerLabel,
  ThinkingIndicator,
  ThinkingReasoning,
  Orb,
} from "@/components/assistant-ui/elements";
import { ResearchPanel } from "./research-panel";
import { GenUIBlock } from "@/components/genui/GenUIBlock";
import { useGenUIFromText } from "@/hooks/useGenUIStream";
import { segmentText } from "@/lib/genui/stream-parser";
import { validateSpec } from "@/lib/genui/validate";
import type { GenUINode } from "@/lib/genui/types";
import { useChatStore } from "@/stores/chat-store";

/**
 * Extract + validate GenUI nodes from a message's full text (content + parts).
 * Returns null if no `<<<genui>>>` sentinel is present. Used to populate
 * `message.genui` for persistence when streaming completes.
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
  const seg = segmentText(text);
  if (seg.blocks.length === 0) return null;
  const allNodes: GenUINode[] = [];
  for (const b of seg.blocks) for (const n of b.nodes) allNodes.push(n);
  const validated = validateSpec({ nodes: allNodes });
  return validated.nodes.length > 0 ? validated.nodes : null;
}

/**
 * ThinkingBlock / ReasoningBlock — collapsible reasoning display.
 *
 * Built on the assistant-ui "ThinkingReasoning" element (AICSS recipe): a
 * shimmering label expands to reveal the agent's reasoning sentences, then
 * folds into a "Thought for Ns" / "Reasoned for Ns" summary once the turn
 * settles. Frameless basic-text UI — no card, no border — per the reference
 * design. Elapsed seconds are measured locally from the moment streaming
 * starts until it ends.
 */
function ReasoningPanel({
  text,
  open: _open,
  isStreaming,
  variant,
}: {
  text: string;
  open: boolean;
  isStreaming: boolean;
  variant: "thinking" | "reasoning";
}) {
  const isThinking = variant === "thinking";

  // Split the (possibly still-streaming) reasoning text into sentences —
  // the element reveals them row by row with a 40px row height.
  const sentences = React.useMemo(() => {
    const trimmed = (text ?? "").trim();
    if (!trimmed) return [] as string[];
    return trimmed
      .split(/(?<=[.!?;])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }, [text]);

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
      />
    </div>
  );
}

function ThinkingBlock(props: { text: string; open: boolean; isStreaming: boolean }) {
  return <ReasoningPanel {...props} variant="thinking" />;
}

function ReasoningBlock(props: { text: string; open: boolean; isStreaming: boolean }) {
  return <ReasoningPanel {...props} variant="reasoning" />;
}

function TextBubble({
  text,
  showCursor,
  isUser,
  onCiteClick,
  genuiNodes,
  isStreaming,
}: {
  text: string;
  showCursor: boolean;
  isUser: boolean;
  onCiteClick?: (index: number) => void;
  /** Persisted GenUI nodes (set when streaming completes). When present AND
   *  the text no longer contains sentinels, these are used to render the
   *  GenUI block. During streaming, the live-parsed spec takes precedence. */
  genuiNodes?: GenUINode[];
  /** True while the message is actively streaming. Drives the GenUIBlock's
   *  shimmer placeholder. */
  isStreaming?: boolean;
}) {
  // Parse the text for `<<<genui>>>` sentinels. Returns ordered segments
  // (text / genui / text / genui / ...) so interleaved text between multiple
  // GenUI blocks is preserved.
  const { segments } = useGenUIFromText(text);

  if (isUser) {
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
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap overflow-wrap-anywhere text-inherit">{text}</p>
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
  if (segments.length === 0 && !persistedSpec) {
    return (
      <div className="relative w-full max-w-full break-words">
        <div
          className={cn(
            "prose-sm assistant-prose max-w-none break-words text-[15px] leading-[1.68]",
            !isStreaming && "prose-sm-static",
            isStreaming && "stream-reveal stream-batch-fade",
          )}
        >
          <MarkdownContent
            content={stripFunctionCallTags(text)}
            onCiteClick={onCiteClick}
            showCursor={showCursor}
            streaming={isStreaming}
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
      ? [{ type: "text" as const, text }, { type: "genui" as const, spec: persistedSpec, streaming: false }]
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
                !isStreaming && "prose-sm-static",
                isStreaming && "stream-reveal stream-batch-fade",
              )}
            >
              <MarkdownContent
                content={stripFunctionCallTags(seg.text || "")}
                onCiteClick={onCiteClick}
                showCursor={showCursor && isLast}
                streaming={isStreaming && isLast}
              />
            </div>
          );
        }
        // GenUI segment
        return (
          <div key={i} className={cn(i > 0 && "mt-3")}>
            <GenUIBlock spec={seg.spec!} streaming={seg.streaming} />
          </div>
        );
      })}
    </div>
  );
}

function SourcesButton({ sources, onClick }: { sources: SourceItem[]; onClick: () => void }) {
  const ragCount = sources.filter((s) => s.type === "rag").length;
  const webCount = sources.filter((s) => s.type === "web").length;

  return (
    <button
      type="button"
      onClick={onClick}
      className="border-foreground/15 bg-background hover:border-foreground/30 hover:bg-foreground/5 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors"
    >
      <span className="flex -space-x-1">
        {ragCount > 0 && (
          <span className="bg-muted border-background inline-flex h-4 w-4 items-center justify-center rounded-full border">
            <FileText className="text-foreground/60 h-2.5 w-2.5" />
          </span>
        )}
        {webCount > 0 && (
          <span className="bg-muted border-background inline-flex h-4 w-4 items-center justify-center rounded-full border">
            <Globe className="text-foreground/60 h-2.5 w-2.5" />
          </span>
        )}
      </span>
      <span className="text-foreground/60 text-[11px] font-medium">
        {sources.length} source{sources.length !== 1 ? "s" : ""}
      </span>
    </button>
  );
}

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
}

/**
 * CollapsibleToolGroup — when 2+ consecutive tool calls happen without any
 * text between them, they're collapsed into a single disclosure line showing
 * "N tool calls" with an expand chevron. Click to expand/collapse.
 *
 * Design: matches the simple tool-name disclosure style — no card chrome,
 * just a chevron, a quiet label, and a failure count when present.
 */
function CollapsibleToolGroup({ parts }: { parts: import("@/types/chat").MessagePart[] }) {
  const [expanded, setExpanded] = React.useState(false);
  const toolParts = parts.filter((p) => p.type === "tool" && p.toolCall);
  const anyRunning = toolParts.some((p) => p.toolCall?.status === "running" || p.toolCall?.status === "pending");
  const errorCount = toolParts.filter((p) => p.toolCall?.status === "error").length;

  return (
    <div className="mb-1.5">
      {/* Collapsed line — simple disclosure row, same anatomy as a single
          tool call: chevron · label · status. */}
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left text-sm transition-colors hover:bg-accent/40"
      >
        <ChevronDown
          className={cn(
            "text-muted-foreground h-3.5 w-3.5 shrink-0 transition-transform duration-200",
            expanded && "rotate-180",
          )}
          aria-hidden
        />
        {anyRunning ? (
          <ShimmerLabel className="text-sm font-medium text-foreground/90">
            {toolParts.length} tool calls
          </ShimmerLabel>
        ) : (
          <span className="text-foreground/90 text-sm font-medium">
            {toolParts.length} tool calls
          </span>
        )}
        {errorCount > 0 && (
          <span className="text-destructive text-xs font-medium">
            {errorCount} failed
          </span>
        )}
      </button>

      {/* Expanded tool disclosures */}
      {expanded && (
        <div className="mt-1 space-y-1 border-l border-border/70 pl-2">
          {toolParts.map((part) => (
            <div key={part.id} className="w-full">
              <ToolCallCard toolCall={part.toolCall!} />
            </div>
          ))}
        </div>
      )}
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
}: MessageItemProps) {
  const isUser = message.role === "user";
  const openPreview = useFilePreviewStore((s) => s.open);
  const openSources = useSourcesPanelStore((s) => s.open);
  const isGrouped = groupPosition && groupPosition !== "single";

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
  // The flow parts (tools-not-research + text) in original order, so the
  // panel can be spliced in at its generation position.
  const flowParts = React.useMemo(
    () =>
      (message.parts ?? []).filter(
        (p) =>
          (p.type === "text" && p.content) ||
          (p.type === "tool" &&
            p.toolCall &&
            !RESEARCH_TOOL_NAMES.has(p.toolCall.name)),
      ),
    [message.parts],
  );
  // Index (into flowParts) where the inline todo panel goes: right before
  // the first flow part that comes AFTER the last research part in the
  // original parts order. When every research part trails the flow, the
  // panel lands at the end (after all rendered content).
  const todoInsertIndex = React.useMemo(() => {
    if (!showTodoPanel || !lastResearchPartId) return -1;
    let seenResearch = false;
    for (const p of message.parts ?? []) {
      if (p.id === lastResearchPartId) {
        seenResearch = true;
        continue;
      }
      if (seenResearch && (flowParts.includes(p))) {
        return flowParts.indexOf(p);
      }
    }
    return flowParts.length;
  }, [showTodoPanel, lastResearchPartId, message.parts, flowParts]);

  // Parts flow rendering applies when there are non-research parts, OR when
  // this message owns the live todo plan (a research-only message still
  // renders the inline panel through the flow path below).
  const useParts =
    !isUser &&
    (parts.length > 0 || (showTodoPanel && lastResearchPartId !== null));

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
                  att.kind === "image" ? (
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

          // "Thinking…" placeholder — shown until anything streams in.
          // SIMPLE THINKING TEXT: the orb lattice glyph leading the
          // shimmering "Thinking" label on one baseline-aligned row (no
          // large card, no fading placeholder lines — the old boxed
          // treatment with three shimmer bars is gone).
          const showPlaceholder =
            !isUser &&
            message.isStreaming &&
            !message.content &&
            parts.length === 0 &&
            (!message.toolCalls || message.toolCalls.length === 0);

          return (
            <>
              {showPlaceholder && (
                <div
                  className="flex h-7 items-center gap-2.5 px-1"
                  role="status"
                  aria-live="polite"
                >
                  <Orb variant="S1" size={18} className="shrink-0" />
                  <ThinkingIndicator label="Thinking" showDot={false} />
                </div>
              )}

              {useParts ? (
                /* Chronological timeline: reasoning/thinking blocks first (at
                 * top), then tool calls + text interleaved in their ORIGINAL
                 * order. Consecutive tool calls (without text between them)
                 * are grouped into a collapsible "N Tool Calls" bar. */
                (() => {
                  // Merge consecutive thinking/reasoning parts of the same type
                  // into a single part. This prevents multiple "Thinking" bars
                  // from appearing when the AI generates thinking across
                  // multiple rounds split by tool calls.
                  const rawThinkingParts = parts.filter((p) => (p.type === "thinking" || p.type === "reasoning") && p.content);
                  const thinkingParts: typeof rawThinkingParts = [];
                  for (const p of rawThinkingParts) {
                    const last = thinkingParts[thinkingParts.length - 1];
                    if (last && last.type === p.type && last.content) {
                      last.content += "\n" + p.content;
                    } else {
                      thinkingParts.push({ ...p });
                    }
                  }
                  const chronologicalParts = flowParts;
                  const lastPart = parts[parts.length - 1];
                  const isLastStreaming = Boolean(message.isStreaming);

                  // Group consecutive tool calls into collapsible groups.
                  // A group is 2+ consecutive tool parts with no text between.
                  // Single tool calls are rendered as-is (no collapse).
                  type RenderItem =
                    | { kind: "text"; part: typeof chronologicalParts[0]; isLast: boolean }
                    | { kind: "tool"; part: typeof chronologicalParts[0]; isLast: boolean }
                    | { kind: "toolGroup"; parts: typeof chronologicalParts; isLast: boolean }
                    | { kind: "todoPanel"; isLast: boolean };

                  const renderItems: RenderItem[] = [];
                  let i = 0;
                  // Splice the inline todo plan panel in at its generation
                  // position: after `todoInsertIndex` flow items have been
                  // emitted, inject the panel marker (only when this message
                  // owns the live plan — showTodoPanel).
                  const emitTodoAt =
                    todoInsertIndex >= 0 && showTodoPanel ? todoInsertIndex : Number.POSITIVE_INFINITY;
                  let todoEmitted = false;
                  const emitTodoIfDue = (emittedCount: number, isLast: boolean) => {
                    if (!todoEmitted && emittedCount >= emitTodoAt) {
                      renderItems.push({ kind: "todoPanel", isLast });
                      todoEmitted = true;
                    }
                  };
                  while (i < chronologicalParts.length) {
                    emitTodoIfDue(renderItems.length, i === chronologicalParts.length - 1);
                    const part = chronologicalParts[i]!;
                    const isLast = i === chronologicalParts.length - 1;
                    if (part.type === "tool" && part.toolCall) {
                      // Start collecting consecutive tool parts
                      const group: typeof chronologicalParts = [];
                      while (i < chronologicalParts.length && chronologicalParts[i]!.type === "tool") {
                        group.push(chronologicalParts[i]!);
                        i++;
                      }
                      if (group.length >= 2) {
                        // 2+ consecutive tools → collapsible group
                        renderItems.push({ kind: "toolGroup", parts: group, isLast: i === chronologicalParts.length });
                      } else {
                        // Single tool → render as-is
                        renderItems.push({ kind: "tool", part: group[0]!, isLast: i === chronologicalParts.length });
                      }
                    } else {
                      // Text part
                      renderItems.push({ kind: "text", part, isLast });
                      i++;
                    }
                  }
                  // Panel generated after every flow part → append at the end.
                  emitTodoIfDue(renderItems.length, true);

                  return (
                    <>
                      {/* Reasoning/Thinking blocks (all at top) */}
                      {thinkingParts.map((part, j) => {
                        const isLast = j === thinkingParts.length - 1 && chronologicalParts.length === 0;
                        if (part.type === "thinking") {
                          return <ThinkingBlock key={part.id} text={part.content ?? ""} open={isLastStreaming && isLast} isStreaming={isLastStreaming} />;
                        }
                        return <ReasoningBlock key={part.id} text={part.content ?? ""} open={isLastStreaming && isLast} isStreaming={isLastStreaming} />;
                      })}

                      {/* Tool calls + text in chronological order, with the
                          inline todo plan panel spliced in exactly where the
                          todo tool ran (not stuck at the thread bottom). */}
                      {renderItems.map((item) => {
                        if (item.kind === "todoPanel") {
                          return (
                            <div key="inline-todo-panel" className="w-full">
                              <ResearchPanel onDismiss={onTodoDismiss} />
                            </div>
                          );
                        }
                        if (item.kind === "toolGroup") {
                          return (
                            <CollapsibleToolGroup key={`group-${item.parts[0]!.id}`} parts={item.parts} />
                          );
                        }
                        if (item.kind === "tool" && item.part.toolCall) {
                          return (
                            <div key={item.part.id} className="w-full">
                              <ToolCallCard toolCall={item.part.toolCall} />
                            </div>
                          );
                        }
                        // Text part
                        return (
                          <TextBubble
                            key={item.part.id}
                            text={item.part.content ?? ""}
                            showCursor={isLastStreaming && item.isLast && lastPart?.type === "text"}
                            isUser={isUser}
                            onCiteClick={onCiteClick}
                            genuiNodes={!message.isStreaming ? message.genui : undefined}
                            isStreaming={isLastStreaming && item.isLast}
                          />
                        );
                      })}
                    </>
                  );
                })()
              ) : (
                /* Legacy fallback: user / pre-parts messages. */
                <>
                  {!isUser && message.thinking && (
                    <ThinkingBlock
                      text={message.thinking}
                      open={Boolean(message.isStreaming)}
                      isStreaming={Boolean(message.isStreaming)}
                    />
                  )}
                  {!isUser && message.reasoning && (
                    <ReasoningBlock
                      text={message.reasoning}
                      open={Boolean(message.isStreaming)}
                      isStreaming={Boolean(message.isStreaming)}
                    />
                  )}
                  {message.content && (
                    <TextBubble
                      text={message.content}
                      showCursor={!isUser && Boolean(message.isStreaming)}
                      isUser={isUser}
                      onCiteClick={onCiteClick}
                      genuiNodes={!message.isStreaming ? message.genui : undefined}
                      isStreaming={Boolean(message.isStreaming)}
                    />
                  )}
                  {message.toolCalls && message.toolCalls.length > 0 && (
                    <div className="w-full space-y-2">
                      {message.toolCalls.map((toolCall) => (
                        <ToolCallCard key={toolCall.id} toolCall={toolCall} />
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          );
        })()}

        {hasSources && !isUser && (
          <div className="mt-1">
            <SourcesButton sources={sources} onClick={() => openSources(sources, null)} />
          </div>
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
              text={
                message.content ||
                (message.parts ?? [])
                  .filter((p) => p.type === "text" && p.content)
                  .map((p) => p.content)
                  .join("\n\n")
              }
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
                title="Regenerate response"
                aria-label="Regenerate response"
                className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors"
              >
                <RefreshCw className="h-3.5 w-3.5" />
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
    prev.groupPosition === next.groupPosition &&
    prev.showFooter === next.showFooter &&
    prev.showTodoPanel === next.showTodoPanel &&
    prev.onTodoDismiss === next.onTodoDismiss &&
    prev.onRegenerate === next.onRegenerate
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
