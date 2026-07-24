"use client";

import { cn } from "@/lib/utils";
import { stripFunctionCallTags } from "@/lib/text-sanitizer";
import type { ChatMessage, ChatMessageFile } from "@/types";
import { ToolCallCard } from "./tool-call-card";
import { RESEARCH_TOOL_NAMES } from "./research-panel";
import { MarkdownContent } from "./markdown-content";
import { CopyButton } from "./copy-button";
import { useFilePreviewStore } from "@/stores";
import { useSourcesPanelStore } from "@/stores/sources-panel-store";
import { Bot, FileText, Globe, Paperclip, RefreshCw, User } from "lucide-react";
import Image from "next/image";
import { useAuthStore } from "@/stores";
import { getFileUrl } from "@/lib/file-api";
import { extractSources } from "@/lib/chat-sources";
import type { SourceItem } from "@/lib/chat-sources";
import { FileCard, FileCardImage } from "./file-card";

function ThinkingBlock({
  text,
  open,
  isStreaming,
}: {
  text: string;
  open: boolean;
  isStreaming: boolean;
}) {
  return (
    <details
      className="border-foreground/10 bg-muted/40 group rounded-2xl rounded-tl-sm border px-3 py-2 sm:px-4"
      open={open}
    >
      <summary className="text-foreground/55 hover:text-foreground/80 flex cursor-pointer items-center gap-2 font-mono text-[10px] tracking-wider uppercase select-none">
        <span className="bg-foreground/30 inline-block h-1.5 w-1.5 rounded-full" />
        Thinking
        {isStreaming && (
          <span className="bg-foreground/40 inline-block h-1 w-1 animate-pulse rounded-full" />
        )}
      </summary>
      <pre className="text-foreground/65 mt-2 max-h-72 overflow-y-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {text}
      </pre>
    </details>
  );
}

function ReasoningBlock({
  text,
  open,
  isStreaming,
}: {
  text: string;
  open: boolean;
  isStreaming: boolean;
}) {
  return (
    <details
      className="border-foreground/10 bg-muted/30 group rounded-2xl rounded-tl-sm border border-dashed px-3 py-2 sm:px-4"
      open={open}
    >
      <summary className="text-foreground/55 hover:text-foreground/80 flex cursor-pointer items-center gap-2 font-mono text-[10px] tracking-wider uppercase select-none">
        <span className="bg-foreground/30 inline-block h-1.5 w-1.5 rounded-full" />
        Reasoning
        {isStreaming && (
          <span className="bg-foreground/40 inline-block h-1 w-1 animate-pulse rounded-full" />
        )}
      </summary>
      <pre className="text-foreground/65 mt-2 max-h-72 overflow-y-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {text}
      </pre>
    </details>
  );
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
            showCursor && "stream-reveal stream-batch-fade",
          )}
        >
          <MarkdownContent
            content={stripFunctionCallTags(text)}
            onCiteClick={onCiteClick}
          />
          {showCursor && (
            <span className="writing-cursor-inline" aria-hidden="true" />
          )}
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
  onRegenerate?: () => void;
}

export function MessageItem({ message, groupPosition, onRegenerate }: MessageItemProps) {
  const isUser = message.role === "user";
  const openPreview = useFilePreviewStore((s) => s.open);
  const openSources = useSourcesPanelStore((s) => s.open);
  const { user: authUser, avatarVersion } = useAuthStore();
  const isGrouped = groupPosition && groupPosition !== "single";

  const sources = !isUser ? extractSources(message) : [];
  const hasSources = sources.length > 0 && !message.isStreaming;
  const onCiteClick = hasSources ? (index: number) => openSources(sources, index) : undefined;

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
          const rawParts = message.parts ?? [];
          // Filter out todo-tool calls — they're aggregated in the live
          // ResearchPanel above the chat input instead of cluttering the
          // transcript with one card per `read_todos` / `add_todo` / etc.
          const parts = rawParts.filter(
            (p) => !(p.type === "tool" && p.toolCall && RESEARCH_TOOL_NAMES.has(p.toolCall.name)),
          );
          const useParts = !isUser && parts.length > 0;

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
                  className="bg-muted flex items-center gap-2 rounded-2xl rounded-tl-sm px-4 py-2.5"
                  role="status"
                  aria-live="polite"
                >
                  <div className="flex gap-1" aria-hidden="true">
                    <span className="bg-muted-foreground/40 h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:0ms]" />
                    <span className="bg-muted-foreground/40 h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:150ms]" />
                    <span className="bg-muted-foreground/40 h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:300ms]" />
                  </div>
                  <span className="text-muted-foreground text-xs">Thinking...</span>
                </div>
              )}

              {useParts ? (
                /* Grouped timeline: reasoning/thinking blocks first, then tool calls, then text.
                 * This prevents reasoning from appearing randomly between tool calls and text. */
                (() => {
                  const thinkingParts = parts.filter((p) => (p.type === "thinking" || p.type === "reasoning") && p.content);
                  const toolParts = parts.filter((p) => p.type === "tool" && p.toolCall);
                  const textParts = parts.filter((p) => p.type === "text" && p.content);
                  const lastPart = parts[parts.length - 1];
                  const isLastStreaming = Boolean(message.isStreaming);

                  return (
                    <>
                      {/* Reasoning/Thinking blocks (all at top) */}
                      {thinkingParts.map((part, i) => {
                        const isLast = i === thinkingParts.length - 1 && toolParts.length === 0 && textParts.length === 0;
                        if (part.type === "thinking") {
                          return <ThinkingBlock key={part.id} text={part.content} open={isLastStreaming && isLast} isStreaming={isLastStreaming} />;
                        }
                        return <ReasoningBlock key={part.id} text={part.content} open={isLastStreaming && isLast} isStreaming={isLastStreaming} />;
                      })}

                      {/* Tool calls (after reasoning) */}
                      {toolParts.map((part) => (
                        <div key={part.id} className="w-full">
                          <ToolCallCard toolCall={part.toolCall} />
                        </div>
                      ))}

                      {/* Text answer (after tools) — each text part is a
                       * separate TextBubble. Multi-round agent responses
                       * (text → tool → text) show each round's text as a
                       * distinct bubble. */}
                      {textParts.map((part, i) => (
                        <TextBubble
                          key={part.id}
                          text={part.content}
                          showCursor={isLastStreaming && i === textParts.length - 1 && lastPart?.type === "text"}
                          isUser={isUser}
                          onCiteClick={onCiteClick}
                        />
                      ))}
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

        {!message.isStreaming && message.content && (
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
              text={message.content}
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
}

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
