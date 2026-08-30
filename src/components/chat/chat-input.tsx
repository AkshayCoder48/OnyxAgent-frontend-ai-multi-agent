"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui";
import { Loader2, Paperclip, Send, Square, Sparkles, Zap } from "lucide-react";
import { type FileUploadResponse, uploadFile } from "@/lib/file-api";
import {
  BUILTIN_COMMANDS,
  searchCommands,
  type SlashCommand,
  type SlashCommandContext,
} from "./slash-commands";
import { SlashCommandPalette } from "./slash-command-palette";
import { FileCard, FileCardImage } from "./file-card";
import { getFileUrl } from "@/lib/file-api";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface ChatInputProps {
  onSend: (message: string, fileIds?: string[], files?: FileUploadResponse[]) => void;
  disabled?: boolean;
  isProcessing?: boolean;
  /** When set, a stop control replaces the send button while processing. */
  onStop?: () => void;
  /** Local actions for slash commands. Wire from <ChatContainer>. */
  slashContext?: SlashCommandContext;
  /** Effective slash commands (built-ins + user customs, after overrides). */
  commands?: SlashCommand[];
  /** Single-round mode state — shows a visual indicator when active. */
  singleRoundMode?: boolean;
  /** Toggle single-round mode. */
  onToggleSingleRound?: () => void;
}

/**
 * Modern chat input — inspired by prompt-kit's architecture.
 *
 * Features:
 * - Auto-resizing textarea (min 40px, max 200px)
 * - File attachments with image previews
 * - Slash command palette
 * - Single-round mode toggle (Zap icon)
 * - Send / Stop button with smooth state transition
 * - Keyboard shortcuts: Enter to send, Shift+Enter for newline
 * - Focus glow effect via parent wrapper
 * - Fully theme-aware (uses semantic color tokens)
 */
export function ChatInput({
  onSend,
  disabled,
  isProcessing,
  onStop,
  slashContext,
  commands,
  singleRoundMode,
  onToggleSingleRound,
}: ChatInputProps) {
  const [message, setMessage] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<FileUploadResponse[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [isFocused, setIsFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showPalette = !!slashContext && message.startsWith("/") && !message.includes("\n");
  const allCommands = commands ?? BUILTIN_COMMANDS;
  const filteredCommands = useMemo(
    () => (showPalette ? searchCommands(allCommands, message) : []),
    [showPalette, message, allCommands],
  );

  useEffect(() => {
    setPaletteIndex(0);
  }, [filteredCommands.length, message]);

  useEffect(() => {
    if (!isProcessing && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isProcessing]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [message]);

  const runSlashCommand = useCallback(
    (cmd: SlashCommand) => {
      if (cmd.action.kind === "client") {
        cmd.action.run(slashContext!);
        setMessage("");
        return;
      }
      const fileIds = attachedFiles.length > 0 ? attachedFiles.map((f) => f.id) : undefined;
      const files = attachedFiles.length > 0 ? attachedFiles : undefined;
      onSend(cmd.action.replaceWith, fileIds, files);
      setMessage("");
      setAttachedFiles([]);
    },
    [attachedFiles, onSend, slashContext],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (showPalette && filteredCommands[paletteIndex]) {
      runSlashCommand(filteredCommands[paletteIndex]);
      return;
    }
    const trimmed = message.trim();
    if (!trimmed && attachedFiles.length === 0) return;
    if (disabled) return;

    const fileIds = attachedFiles.length > 0 ? attachedFiles.map((f) => f.id) : undefined;
    const files = attachedFiles.length > 0 ? attachedFiles : undefined;
    onSend(trimmed || "Analyze the attached file(s)", fileIds, files);
    setMessage("");
    setAttachedFiles([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showPalette && filteredCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPaletteIndex((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPaletteIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const cmd = filteredCommands[paletteIndex];
        if (cmd) setMessage("/" + cmd.name + " ");
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMessage("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const removeFile = (fileId: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== fileId));
  };

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileInput = e.target;
    const fileList = fileInput.files;
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    fileInput.value = "";

    setUploadingCount((c) => c + files.length);
    let success = 0;
    let failed = 0;
    for (const file of files) {
      try {
        const uploaded = await uploadFile(file);
        setAttachedFiles((prev) => [...prev, uploaded]);
        success++;
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error("[chat-input] Failed to upload file:", file.name, err);
        toast.error(`Failed to attach ${file.name}: ${msg}`);
      } finally {
        setUploadingCount((c) => Math.max(0, c - 1));
      }
    }
    if (success > 0 && failed === 0) {
      toast.success(`Attached ${success} file${success !== 1 ? "s" : ""}`);
    } else if (failed > 0 && success > 0) {
      toast.message(`Attached ${success}, failed ${failed}`);
    }
  }, []);

  const canSend = message.trim().length > 0 || attachedFiles.length > 0;

  return (
    <form onSubmit={handleSubmit} className="relative">
      <input
        ref={fileInputRef}
        type="file"
        onChange={handleFileSelect}
        multiple
        className="sr-only"
        id="chat-attach-input"
      />
      {showPalette && (
        <SlashCommandPalette
          commands={filteredCommands}
          selectedIndex={paletteIndex}
          onSelectIndex={setPaletteIndex}
          onPick={runSlashCommand}
        />
      )}

      {/* Attachment preview row */}
      {attachedFiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pb-2.5 animate-fade-in">
          {attachedFiles.map((file) => {
            const previewUrl = getFileUrl(file.id);
            const isImage = file.file_type === "image" && previewUrl;
            return isImage ? (
              <FileCardImage
                key={file.id}
                filename={file.filename}
                previewUrl={previewUrl}
                size={file.size}
                onRemove={() => removeFile(file.id)}
              />
            ) : (
              <FileCard
                key={file.id}
                filename={file.filename}
                size={file.size}
                mimeType={file.mime_type}
                onRemove={() => removeFile(file.id)}
              />
            );
          })}
        </div>
      )}

      {/* Main input row */}
      <div className="flex items-end gap-1.5 sm:gap-2">
        {/* Left: Attach button */}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || uploadingCount > 0}
          className="h-9 w-9 shrink-0 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted/60"
          title="Attach file"
          aria-label="Attach file"
        >
          {uploadingCount > 0 ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Paperclip className="h-4 w-4" />
          )}
        </Button>

        {/* Center: Textarea */}
        <div className="relative flex-1 min-w-0">
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder="Ask anything, or type / for commands..."
            disabled={disabled}
            rows={1}
            className={cn(
              "placeholder:text-muted-foreground/60 min-h-[40px] w-full resize-none scrollbar-thin bg-transparent py-2.5 text-sm leading-relaxed transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 sm:text-[15px]",
              isFocused && "placeholder:text-muted-foreground/40",
            )}
          />
        </div>

        {/* Right: Single-round toggle + Send/Stop */}
        <div className="flex shrink-0 items-center gap-1 pb-0.5">
          {onToggleSingleRound && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={onToggleSingleRound}
              disabled={disabled}
              className={cn(
                "h-9 w-9 shrink-0 rounded-xl transition-all",
                singleRoundMode
                  ? "bg-primary/10 text-primary hover:bg-primary/20"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
              )}
              title={singleRoundMode ? "Single-round mode ON — click to turn off" : "Enable single-round mode"}
              aria-label="Toggle single-round mode"
              aria-pressed={singleRoundMode}
            >
              <Zap className={cn("h-4 w-4", singleRoundMode && "fill-current")} />
            </Button>
          )}
          {isProcessing && onStop ? (
            <Button
              type="button"
              size="icon"
              onClick={onStop}
              className="h-9 w-9 shrink-0 rounded-xl"
              title="Stop generating"
              aria-label="Stop generating"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              disabled={disabled || !canSend}
              className={cn(
                "h-9 w-9 shrink-0 rounded-xl transition-all",
                canSend && !disabled && "shadow-sm",
              )}
              title="Send message"
              aria-label="Send message"
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Subtle hint row — shows when input is focused and empty */}
      {isFocused && !message && attachedFiles.length === 0 && (
        <div className="flex items-center gap-1.5 pt-1 text-[10px] text-muted-foreground/50 animate-fade-in">
          <Sparkles className="h-2.5 w-2.5" />
          <span>Enter to send • Shift+Enter for newline • / for commands</span>
        </div>
      )}
    </form>
  );
}
