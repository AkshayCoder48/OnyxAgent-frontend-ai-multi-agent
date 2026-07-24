"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Button, Spinner } from "@/components/ui";
import { Loader2, Paperclip, Send } from "lucide-react";
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
  // Tracks per-file upload progress so we can show a small spinner on the
  // paperclip button while files are being persisted to OPFS.
  const [uploadingCount, setUploadingCount] = useState(0);
  // Slash-command palette state. Open while message starts with "/" and the
  // caller wired a context — without one, commands have nothing to do.
  const [paletteIndex, setPaletteIndex] = useState(0);
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
      // send-as-message — replace the slash with the canned prompt and send
      // through the normal flow so it lands as a regular user turn.
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
        // Tab autocompletes to the highlighted command name.
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

  // File attach handler — opens the native file picker, uploads each file to
  // OPFS via uploadFile (which also writes a Dexie metadata row), then adds
  // the FileUploadResponse to attachedFiles so it shows as a chip and is sent
  // with the next message.
  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileInput = e.target;
    const fileList = fileInput.files;
    if (!fileList || fileList.length === 0) return;
    // Convert to array BEFORE clearing the input — some browsers nullify
    // the FileList reference when value is set to "".
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

  return (
    <form
      onSubmit={handleSubmit}
      className="relative"
    >
      {/* Hidden file input — sr-only (NOT display:none) so .click() works
         * reliably across all browsers + mobile WebViews. */}
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
      {attachedFiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pb-2 animate-fade-in">
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

      <div className="flex items-end gap-1.5 sm:gap-2">
        {/* File attach button — paperclip */}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || uploadingCount > 0}
          className="h-9 w-9 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
          title="Attach file"
          aria-label="Attach file"
        >
          {uploadingCount > 0 ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Paperclip className="h-4 w-4" />
          )}
        </Button>

        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          disabled={disabled}
          rows={1}
          className="placeholder:text-muted-foreground min-h-[40px] flex-1 resize-none scrollbar-thin bg-transparent py-2.5 text-sm focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 sm:text-base"
        />

        <div className="flex shrink-0 items-center gap-0.5 pb-1">
          {isProcessing && onStop ? (
            <Button
              type="button"
              size="icon"
              onClick={onStop}
              className="h-9 w-9 rounded-lg"
              title="Stop generating"
            >
              <span className="h-3 w-3 rounded-[3px] bg-current" aria-hidden="true" />
              <span className="sr-only">Stop generating</span>
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              disabled={disabled || (!message.trim() && attachedFiles.length === 0)}
              className="h-9 w-9 rounded-lg"
            >
              {isProcessing ? <Spinner className="h-4 w-4" /> : <Send className="h-4 w-4" />}
              <span className="sr-only">Send message</span>
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
