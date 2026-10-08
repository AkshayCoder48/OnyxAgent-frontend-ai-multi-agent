"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui";
import { ArrowUp, Loader2, Paperclip, Square, Sparkles } from "lucide-react";
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
import {
  ComposerQuotePreview,
  ComposerVoice,
  ComposerVoiceButton,
} from "@/components/assistant-ui/elements";
import { useDictation } from "@/hooks/use-dictation";
import { useQuoteStore } from "@/stores";

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
}

/**
 * Modern chat input — inspired by prompt-kit's architecture.
 *
 * Features:
 * - Auto-resizing textarea (min 40px, max 200px)
 * - File attachments with image previews
 * - Slash command palette
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
}: ChatInputProps) {
  const [message, setMessage] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<FileUploadResponse[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [isFocused, setIsFocused] = useState(false);
  const [sendPulse, setSendPulse] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // QUOTED REPLY (assistant-ui "Quote" element flow): text quoted from an
  // assistant message rides above the composer until sent (or dismissed).
  const quote = useQuoteStore((s) => s.quote);
  const clearQuote = useQuoteStore((s) => s.clearQuote);

  // DICTATION (assistant-ui "Dictation" element, PRD §23): tapping the mic
  // swaps the textarea for a live waveform; the finalized transcript lands
  // as composer text after a brief "Transcribing" settle. `isProcessing`
  // deliberately does NOT gate the mic — users can compose the next message
  // while the AI works, same as typing.
  const handleDictationText = useCallback((text: string) => {
    setMessage((prev) => (prev ? `${prev} ${text}` : text));
    // The textarea remounts in the same commit — focus it once text lands.
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);
  const dictation = useDictation({ onFinalText: handleDictationText });

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

  // Auto-resize textarea — MEASURED HEIGHT, ANIMATED (PRD §20 seamless
  // motion: the resize must never snap). Two-phase write: restore the
  // previous px height, then flip to the newly measured one on the next
  // frame so the CSS height transition (.mb-height) interpolates between
  // the two instead of jumping (a direct auto→px flip can't transition).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const prev = el.style.height;
    el.style.height = "auto";
    const next = `${Math.min(el.scrollHeight, 200)}px`;
    if (prev && prev !== next) {
      el.style.height = prev;
      const raf = requestAnimationFrame(() => {
        el.style.height = next;
      });
      return () => cancelAnimationFrame(raf);
    }
    el.style.height = next;
    // Re-measure also when dictation toggles, so a remounted textarea (voice
    // surface swapped out) regains the height its content needs.
  }, [message, dictation.active]);

  // Prompt-submission pulse (PRD §20): a subtle scale/blur breath on the
  // composer as the message leaves (.mb-send-pulse). Toggling the class
  // off→on across two frames restarts the one-shot animation on every send.
  const pulseComposer = useCallback(() => {
    setSendPulse(false);
    requestAnimationFrame(() => requestAnimationFrame(() => setSendPulse(true)));
  }, []);

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
      pulseComposer();
    },
    [attachedFiles, onSend, slashContext, pulseComposer],
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

    // A quoted reply carries the quoted assistant text as a markdown
    // blockquote prefix — the user bubble renders it as a styled quote
    // block, and the AI sees exactly what's being referenced.
    const quotedPrefix = quote
      ? `> ${quote.text.replace(/\n/g, "\n> ")}\n\n`
      : "";
    const outgoing = `${quotedPrefix}${trimmed || "Analyze the attached file(s)"}`;

    const fileIds = attachedFiles.length > 0 ? attachedFiles.map((f) => f.id) : undefined;
    const files = attachedFiles.length > 0 ? attachedFiles : undefined;
    onSend(outgoing, fileIds, files);
    setMessage("");
    setAttachedFiles([]);
    clearQuote();
    pulseComposer();
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
    <form onSubmit={handleSubmit} className={cn("relative", sendPulse && "mb-send-pulse")}>
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

      {/* QUOTE PREVIEW — quoted assistant text rides above the composer
          (assistant-ui "Quote" element) until sent or dismissed. */}
      {quote && <ComposerQuotePreview quote={quote} onDismiss={clearQuote} className="pb-2" />}

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

        {/* Center: Textarea — replaced by the dictation voice surface
            while a session is live (assistant-ui "Dictation" element swap). */}
        <div className="relative min-w-0 flex-1">
          {dictation.active ? (
            <ComposerVoice
              recording={dictation.recording}
              seconds={dictation.seconds}
              interim={dictation.interim}
            />
          ) : (
            <textarea
              ref={textareaRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder="Reply to OnyxAgent… or type / for commands"
              disabled={disabled}
              rows={1}
              className={cn(
                "placeholder:text-muted-foreground/60 mb-height min-h-[40px] w-full resize-none scrollbar-thin bg-transparent py-2.5 text-sm leading-relaxed focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 sm:text-[15px]",
                isFocused && "placeholder:text-muted-foreground/40",
              )}
            />
          )}
        </div>

        {/* Right: Dictation mic + Send/Stop */}
        <div className="flex shrink-0 items-center gap-1 pb-0.5">
          {/* Mic hidden entirely where the Web Speech API is absent
              (PRD §24 approved behavior — nothing to explain). While a
              session is LIVE the stop button is NEVER disabled — the user
              must always be able to stop a recording (a socket drop or a
              pending question must not lock the waveform in place). */}
          {dictation.supported && (
            <ComposerVoiceButton
              active={dictation.active}
              onClick={dictation.active ? dictation.stop : dictation.start}
              disabled={disabled && !dictation.active}
              aria-label={dictation.active ? "Stop dictation" : "Start voice dictation"}
            />
          )}
          {isProcessing && onStop ? (
            <Button
              type="button"
              size="icon"
              onClick={onStop}
              className="h-9 w-9 shrink-0 rounded-full"
              title="Stop generating"
              aria-label="Stop generating"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </Button>
          ) : (
            /* Round terracotta send button with arrow-up (Terra spec). */
            <Button
              type="submit"
              size="icon"
              disabled={disabled || !canSend}
              className={cn(
                "h-9 w-9 shrink-0 rounded-full bg-primary text-primary-foreground transition-all hover:bg-brand-hover disabled:opacity-40",
                canSend && !disabled && "shadow-sm",
              )}
              title="Send message"
              aria-label="Send message"
            >
              <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
            </Button>
          )}
        </div>
      </div>

      {/* Dictation failure hint — inline, auto-dismisses (~4s) */}
      {dictation.error && (
        <p role="alert" className="animate-fade-in pt-1 text-[10px] text-muted-foreground/70">
          {dictation.error}
        </p>
      )}

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
