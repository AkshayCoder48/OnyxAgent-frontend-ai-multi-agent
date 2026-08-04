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
import { Bot, ChevronDown, ChevronUp, FileText, Globe, Loader2, Paperclip, RefreshCw, User, Wrench } from "lucide-react";
import Image from "next/image";
import { useAuthStore } from "@/stores";
import { getFileUrl } from "@/lib/file-api";
import { extractSources } from "@/lib/chat-sources";
import type { SourceItem } from "@/lib/chat-sources";
import { FileCard, FileCardImage } from "./file-card";

/**
 * ThinkingBlock / ReasoningBlock — collapsible reasoning display.
 *
 * Visual design goals:
 *   - Match the polished "empty-state Thinking bar" look (Bot avatar +
 *     shimmer skeleton bars + streaming dots) so the filled reasoning
 *     panel doesn't feel like a step down in quality.
 *   - When `text` is empty but `isStreaming` is true, render the same
 *     shimmer-skeleton placeholder the chat shows before the first token.
 *   - When `text` arrives, seamlessly cross-fade from the shimmer
 *     placeholder into the real content (no jarring swap).
 *   - Stronger contrast than the old `text-foreground/55` dull look —
 *     use `text-foreground/80` for the label and `text-foreground/90`
 *     for content so the panel reads as a first-class surface, not a
 *     faded footnote.
 *
 * The empty → filled transition is driven by `reasoning-panel-fill` /
 * `reasoning-skeleton-out` keyframes (defined in globals.css) which
 * animate opacity + a subtle scale so the swap reads as a single
 * fluid motion instead of a hard cut.
 */
function ReasoningPanel({
  text,
  open,
  isStreaming,
  variant,
}: {
  text: string;
  open: boolean;
  isStreaming: boolean;
  variant: "thinking" | "reasoning";
}) {
  const [internalOpen, setInternalOpen] = React.useState(open);
  React.useEffect(() => {
    if (isStreaming) setInternalOpen(true);
  }, [isStreaming]);
  // Once the user collapses/expands, respect their choice.
  React.useEffect(() => {
    setInternalOpen(open);
  }, [open]);

  const label = variant === "thinking" ? "Thinking" : "Reasoning";
  const isEmpty = !text || text.trim().length === 0;
  const showSkeleton = isStreaming && isEmpty;

  return (
    <div
      className={cn(
        "reasoning-panel group relative mb-2 block w-full overflow-hidden rounded-2xl rounded-tl-sm border transition-colors duration-300",
        variant === "thinking"
          ? "border-foreground/10 bg-muted/50"
          : "border-foreground/10 border-dashed bg-muted/40",
        // Subtle elevation when streaming — reads as "active".
        isStreaming && "ring-1 ring-primary/15",
      )}
      style={{ width: "100%" }}
    >
      {/* Header — always visible. Clicking toggles the body. */}
      <button
        type="button"
        onClick={() => setInternalOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left sm:px-4"
        aria-expanded={internalOpen}
      >
        <span
          className="inline-flex h-3 w-3 shrink-0 items-center justify-center"
          aria-hidden="true"
        >
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full transition-colors duration-300",
              isStreaming ? "bg-primary" : "bg-foreground/40",
              isStreaming && "animate-pulse",
            )}
          />
        </span>
        <span className="text-foreground/80 font-mono text-[10px] font-medium tracking-wider uppercase">
          {label}
        </span>
        {isStreaming && (
          <span className="streaming-dots" aria-hidden="true">
            <span /> <span /> <span />
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {text && (
            <span className="text-foreground/45 font-mono text-[10px] tabular-nums">
              {text.length} chars
            </span>
          )}
          <ChevronDown
            className={cn(
              "text-foreground/50 h-3.5 w-3.5 transition-transform duration-300",
              internalOpen && "rotate-180",
            )}
          />
        </span>
      </button>

      {/* Body — two layers that cross-fade:
          1. Skeleton shimmer (only while streaming + empty).
          2. Real content (fades in once `text` arrives). */}
      <div className="relative block w-full">
        {/* Skeleton layer */}
        <div
          className={cn(
            "px-3 pb-3 sm:px-4 sm:pb-4",
            showSkeleton
              ? "reasoning-skeleton-in"
              : isEmpty
                ? "hidden"
                : "reasoning-skeleton-out",
          )}
          aria-hidden={!showSkeleton}
        >
          <div className="flex flex-col gap-1.5">
            <div className="shimmer h-2 w-[90%] rounded-full" />
            <div className="shimmer h-2 w-[75%] rounded-full" />
            <div className="shimmer h-2 w-[82%] rounded-full" />
            <div className="shimmer h-2 w-[60%] rounded-full" />
          </div>
        </div>

        {/* Content layer — text centered within the box */}
        {!isEmpty && (
          <div
            className={cn(
              "reasoning-panel-fill border-foreground/8 flex w-full items-center justify-center border-t",
              internalOpen ? "flex" : "hidden",
            )}
            style={{ width: "100%" }}
          >
            <pre
              className="text-foreground/85 m-0 block max-h-80 w-full max-w-full overflow-y-auto px-3 py-2.5 text-left font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words sm:px-4"
              style={{
                width: "100%",
                textAlign: "left",
                margin: 0,
                maxWidth: "100%",
              }}
            >
              {text}
            </pre>
          </div>
        )}
      </div>
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
}: {
  text: string;
  showCursor: boolean;
  isUser: boolean;
  onCiteClick?: (index: number) => void;
}) {
  return (
    <div
      className={cn(
        "relative max-w-full break-words rounded-2xl px-3 py-2 sm:px-4 sm:py-2.5",
        isUser
          ? "text-background rounded-tr-sm"
          : "rounded-tl-sm w-full",
        // Streaming AI bubbles get: glow + shimmer sweep + animated border
        !isUser && showCursor && "streaming-glow streaming-shimmer streaming-border",
      )}
      style={
        isUser
          ? { backgroundColor: "var(--chat-user-bg, var(--color-foreground))" }
          : { backgroundColor: "var(--chat-assistant-bg, var(--color-muted))" }
      }
    >
      {isUser ? (
        <p className="text-sm break-words whitespace-pre-wrap overflow-wrap-anywhere">{text}</p>
      ) : (
        // Assistant message: render via MarkdownContent so markdown formatting
        // shows during both streaming and after completion. The text is
        // sanitized to strip raw function-call XML tags.
        <div
          className={cn(
            "prose-sm max-w-none break-words text-sm",
            // PERF: Apply `content-visibility: auto` ONLY to non-streaming
            // messages. On streaming messages it causes re-layout on every
            // 30ms text-delta flush (height changes → intrinsic-size recalc).
            !showCursor && "prose-sm-static",
            showCursor && "stream-reveal stream-batch-fade",
          )}
        >
          <MarkdownContent
            content={stripFunctionCallTags(text)}
            onCiteClick={onCiteClick}
            showCursor={showCursor}
          />
        </div>
      )}
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
  onRegenerate?: () => void;
}

/**
 * CollapsibleToolGroup — when 2+ consecutive tool calls happen without any
 * text between them, they're collapsed into a single bar showing
 * "N Tool Calls" with an expand arrow. Click to expand/collapse.
 *
 * Design: matches the tool call card style — rounded, subtle background,
 * uses CSS variables so it works with ALL color schemes.
 */
function CollapsibleToolGroup({ parts }: { parts: import("@/types/chat").MessagePart[] }) {
  const [expanded, setExpanded] = React.useState(false);
  const toolParts = parts.filter((p) => p.type === "tool" && p.toolCall);
  const allDone = toolParts.every((p) => p.toolCall?.status === "completed" || p.toolCall?.status === "error");
  const anyRunning = toolParts.some((p) => p.toolCall?.status === "running" || p.toolCall?.status === "pending");
  const errorCount = toolParts.filter((p) => p.toolCall?.status === "error").length;

  return (
    <div className="mb-2">
      {/* Collapsed bar */}
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg border px-4 py-2.5 text-left transition-all duration-200",
          anyRunning
            ? "border-primary/10 bg-primary/5"
            : "border-foreground/8 bg-muted/30 hover:bg-muted/50",
        )}
      >
        <div
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
            anyRunning ? "bg-primary/10" : "bg-foreground/5",
          )}
        >
          {anyRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          ) : (
            <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </div>
        <span className="text-foreground/90 text-sm font-medium">
          {toolParts.length} Tool Calls
        </span>
        {errorCount > 0 && (
          <span className="text-destructive text-xs font-medium">
            {errorCount} failed
          </span>
        )}
        {anyRunning && (
          <span className="streaming-dots" aria-hidden="true">
            <span /> <span /> <span />
          </span>
        )}
        <div className="ml-auto text-muted-foreground">
          {expanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </div>
      </button>

      {/* Expanded tool cards */}
      {expanded && (
        <div className="mt-2 space-y-2 pl-2 border-l-2 border-foreground/8">
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
  onRegenerate,
}: MessageItemProps) {
  const isUser = message.role === "user";
  const openPreview = useFilePreviewStore((s) => s.open);
  const openSources = useSourcesPanelStore((s) => s.open);
  const { user: authUser, avatarVersion } = useAuthStore();
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

  // PERF: Memoize the filtered parts array (removes research/todo tool calls).
  // Previously this filter ran on every render for every message.
  const parts = React.useMemo(
    () =>
      (message.parts ?? []).filter(
        (p) => !(p.type === "tool" && p.toolCall && RESEARCH_TOOL_NAMES.has(p.toolCall.name)),
      ),
    [message.parts],
  );
  const useParts = !isUser && parts.length > 0;

  return (
    <div
      className={cn(
        "group relative flex gap-2 overflow-visible sm:gap-4",
        isGrouped ? "py-2 sm:py-3" : "py-3 sm:py-4",
        isUser && "flex-row-reverse",
        // Entrance animation: AI messages blur+fade in from top, user
        // messages slide in from the right. Both use spring easing.
        isUser ? "bubble-user-in" : "bubble-ai-in",
      )}
    >
      {" "}
      {isGrouped && !isUser && (
        <div
          className="bg-border absolute left-[15px] w-0.5 sm:left-[17px]"
          style={
            groupPosition === "first"
              ? { top: "24px", bottom: "0" }
              : groupPosition === "last"
                ? { top: "0", height: "24px" }
                : { top: "0", bottom: "0" }
          }
        />
      )}
      <div
        className={cn(
          "z-10 flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded-full sm:h-9 sm:w-9",
          isUser ? "bg-foreground text-background" : "bg-muted text-foreground",
          isGrouped && !isUser && "ring-background ring-2",
        )}
      >
        {isUser && authUser?.avatar_url ? (
          <Image
            src={`/api/users/avatar/${authUser.id}?v=${avatarVersion}`}
            alt=""
            width={36}
            height={36}
            className="h-full w-full object-cover"
            unoptimized
          />
        ) : isUser ? (
          <User className="h-4 w-4" />
        ) : (
          <Bot className="h-4 w-4 sm:h-5 sm:w-5" />
        )}
      </div>
      <div
        className={cn(
          "min-w-0 flex-1 space-y-2",
          isUser ? "max-w-[90%] sm:max-w-[85%] flex flex-col items-end" : "w-full max-w-full",
        )}
      >
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
          // `parts` is now memoized at the top of the component (above).
          const usePartsLocal = useParts;

          // "Thinking…" placeholder — shown until anything streams in.
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
                  className="reasoning-panel group relative mb-2 block w-full overflow-hidden rounded-2xl rounded-tl-sm border border-foreground/10 bg-muted/50 ring-1 ring-primary/15"
                  role="status"
                  aria-live="polite"
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left sm:px-4"
                  >
                    <span className="inline-flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden="true">
                      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                    </span>
                    <span className="text-foreground/80 font-mono text-[10px] font-medium tracking-wider uppercase">
                      Thinking
                    </span>
                    <span className="streaming-dots" aria-hidden="true">
                      <span /> <span /> <span />
                    </span>
                  </button>
                  <div className="px-3 pb-3 sm:px-4 sm:pb-4">
                    <div className="flex flex-col gap-1.5">
                      <div className="shimmer h-2 w-[90%] rounded-full" />
                      <div className="shimmer h-2 w-[75%] rounded-full" />
                      <div className="shimmer h-2 w-[82%] rounded-full" />
                      <div className="shimmer h-2 w-[60%] rounded-full" />
                    </div>
                  </div>
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
                  const chronologicalParts = parts.filter(
                    (p) => (p.type === "tool" && p.toolCall) || (p.type === "text" && p.content),
                  );
                  const lastPart = parts[parts.length - 1];
                  const isLastStreaming = Boolean(message.isStreaming);

                  // Group consecutive tool calls into collapsible groups.
                  // A group is 2+ consecutive tool parts with no text between.
                  // Single tool calls are rendered as-is (no collapse).
                  type RenderItem =
                    | { kind: "text"; part: typeof chronologicalParts[0]; isLast: boolean }
                    | { kind: "tool"; part: typeof chronologicalParts[0]; isLast: boolean }
                    | { kind: "toolGroup"; parts: typeof chronologicalParts; isLast: boolean };

                  const renderItems: RenderItem[] = [];
                  let i = 0;
                  while (i < chronologicalParts.length) {
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

                  return (
                    <>
                      {/* Reasoning/Thinking blocks (all at top) */}
                      {thinkingParts.map((part, j) => {
                        const isLast = j === thinkingParts.length - 1 && chronologicalParts.length === 0;
                        if (part.type === "thinking") {
                          return <ThinkingBlock key={part.id} text={part.content ?? ""} open={isLastStreaming && isLast} isStreaming={isLastStreaming} />;
                        }
                        return <ThinkingBlock key={part.id} text={part.content ?? ""} open={isLastStreaming && isLast} isStreaming={isLastStreaming} />;
                      })}

                      {/* Tool calls + text in chronological order */}
                      {renderItems.map((item) => {
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
          <div className={cn("flex flex-wrap items-center gap-1.5", isUser && "flex-row-reverse")}>
            {message.timestamp && (
              <span className="text-muted-foreground text-[10px]">
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
              className={cn(
                "h-7 w-7 rounded-md",
                isUser ? "bg-secondary hover:bg-secondary/80" : "bg-muted hover:bg-muted/80",
              )}
            />
            {!isUser && onRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                title="Regenerate response"
                aria-label="Regenerate response"
                className="bg-muted hover:bg-muted/80 text-foreground/70 hover:text-foreground inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors"
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
    prev.groupPosition === next.groupPosition &&
    prev.showFooter === next.showFooter &&
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

function FileChip({
  filename,
  hint,
  size,
  onClick,
  href,
}: {
  filename: string;
  hint?: string;
  size?: number;
  /** When provided, clicking opens the file in the preview panel. */
  onClick?: () => void;
  /** Fallback for legacy attachments without full metadata — opens in new tab. */
  href?: string;
}) {
  const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : null;
  const sizeStr =
    size != null
      ? size < 1024
        ? `${size} B`
        : size < 1024 * 1024
          ? `${(size / 1024).toFixed(1)} KB`
          : `${(size / (1024 * 1024)).toFixed(1)} MB`
      : null;
  const className =
    "border-foreground/15 bg-card hover:border-foreground/40 inline-flex max-w-xs items-center gap-2 rounded-xl border px-3 py-2 transition-colors text-left";
  const inner = (
    <>
      <span className="bg-foreground/8 text-foreground/65 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
        <FileText className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm font-medium">{filename}</span>
        <span className="text-foreground/55 font-mono text-[10px] tracking-wider uppercase">
          {ext}
          {sizeStr ? ` · ${sizeStr}` : ""}
        </span>
      </span>
      <Paperclip className="text-foreground/40 h-3.5 w-3.5 shrink-0" />
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className} title={hint ?? filename}>
        {inner}
      </button>
    );
  }
  return (
    <a
      href={href ?? "#"}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      title={hint ?? filename}
    >
      {inner}
    </a>
  );
}
