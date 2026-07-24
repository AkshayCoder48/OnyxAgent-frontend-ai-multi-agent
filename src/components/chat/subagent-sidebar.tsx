"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { useSubagentStore, type SubagentMessage } from "@/stores/subagent-store";
import { executeSubagentTurn } from "@/lib/agent/subagent-runtime";
import { getFileUrl, uploadFile, type FileUploadResponse } from "@/lib/file-api";
import { MarkdownContent } from "./markdown-content";
import { WritingCursor } from "./writing-cursor";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Send, Paperclip, Loader2, X, ChevronDown, Plus, Bot, User, Trash2, MessageSquare,
} from "lucide-react";

/**
 * SubAgentSidebar — right sidebar showing chat between user and subagents.
 *
 * Features:
 *   - @ mention to tag a specific subagent (autocomplete dropdown)
 *   - Real streaming (token-by-token) from the subagent LLM
 *   - Markdown rendering (same as main chat)
 *   - Tool call cards inline
 *   - Chat session history (persists across refresh)
 *   - Session selector to switch between past chats
 *   - Send images via paperclip
 */
export function SubAgentSidebar({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const {
    subagents, sessions, activeSessionId,
    setActiveSession, createSession, deleteSession,
    loadFromStorage,
  } = useSubagentStore();

  // Sort sessions: pinned first, then by updated_at descending.
  const sortedSessions = [...sessions].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });
  const [message, setMessage] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<FileUploadResponse[]>([]);
  const [uploading, setUploading] = useState(0);
  const [showMention, setShowMention] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [executing, setExecuting] = useState(false);
  const [showSessionList, setShowSessionList] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadFromStorage();
  }, [loadFromStorage]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const activeSubagent = activeSession
    ? subagents.find((s) => s.id === activeSession.subagentId)
    : null;

  // Auto-scroll on new messages.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeSession?.messages, activeSessionId]);

  // @ mention detection.
  useEffect(() => {
    const lastAtIndex = message.lastIndexOf("@");
    if (lastAtIndex === -1) { setShowMention(false); return; }
    const beforeAt = lastAtIndex > 0 ? message[lastAtIndex - 1] : " ";
    if (beforeAt !== " " && beforeAt !== "\n" && lastAtIndex !== 0) {
      setShowMention(false); return;
    }
    const textAfterAt = message.slice(lastAtIndex + 1);
    if (textAfterAt.includes(" ")) { setShowMention(false); return; }
    setMentionFilter(textAfterAt.toLowerCase());
    setShowMention(true);
  }, [message]);

  const filteredSubagents = subagents.filter(
    (s) => s.enabled && s.name.toLowerCase().includes(mentionFilter),
  );

  const handleSend = useCallback(async () => {
    const trimmed = message.trim();
    if (!trimmed && attachedFiles.length === 0) return;
    if (executing) return;

    // Detect @ mention.
    const mentionMatch = trimmed.match(/^@(\w+)/);
    const taggedSubagentId = mentionMatch
      ? subagents.find((s) => s.name.toLowerCase() === mentionMatch[1].toLowerCase())?.id
      : null;

    // If no active session and no @ tag, show a hint.
    if (!activeSession && !taggedSubagentId) {
      toast.error("Tag a subagent with @name to start a chat");
      return;
    }

    const targetSubagentId = taggedSubagentId || activeSession?.subagentId;
    if (!targetSubagentId) {
      toast.error("No subagent selected. Tag one with @name");
      return;
    }

    const cleanMessage = taggedSubagentId
      ? trimmed.replace(/^@\w+\s*/, "")
      : trimmed;

    setMessage("");
    setExecuting(true);
    try {
      const fileIds = attachedFiles.length > 0 ? attachedFiles.map((f) => f.id) : undefined;
      setAttachedFiles([]);
      await executeSubagentTurn(
        targetSubagentId,
        cleanMessage || "(analyze the attached file)",
        fileIds,
        taggedSubagentId ? undefined : activeSession?.id, // create new session if @tagged
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Execution failed");
    } finally {
      setExecuting(false);
    }
  }, [message, attachedFiles, executing, subagents, activeSession]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileInput = e.target;
    const fileList = fileInput.files;
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    fileInput.value = "";

    setUploading((c) => c + files.length);
    for (const file of files) {
      try {
        const uploaded = await uploadFile(file);
        setAttachedFiles((prev) => [...prev, uploaded]);
      } catch (err) {
        toast.error(`Failed to attach ${file.name}: ${err instanceof Error ? err.message : "error"}`);
      } finally {
        setUploading((c) => Math.max(0, c - 1));
      }
    }
  }, []);

  const insertMention = (name: string) => {
    const lastAtIndex = message.lastIndexOf("@");
    const before = message.slice(0, lastAtIndex);
    setMessage(`${before}@${name} `);
    setShowMention(false);
  };

  if (!open) return null;

  const messages = activeSession?.messages ?? [];

  return (
    <aside className="flex h-full w-full flex-col bg-card md:w-80 lg:w-96">
      <input
        ref={fileInputRef}
        type="file"
        onChange={handleFileSelect}
        multiple
        className="sr-only"
        id="subagent-attach-input"
      />

      {/* Header — session selector + close. Made taller + more prominent
          on mobile so it's easy to tap. */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-2 sm:px-3">
        <div className="relative flex items-center gap-1 min-w-0 flex-1">
          {/* Hamburger / session selector button — larger touch target */}
          <Button
            variant="ghost"
            size="sm"
            className="h-9 gap-2 px-2 text-sm font-medium min-w-0"
            onClick={() => setShowSessionList((v) => !v)}
            title="Chat history"
            aria-label="Toggle chat history"
          >
            <MessageSquare className="h-4 w-4 shrink-0" />
            <span className="truncate max-w-32 sm:max-w-40">
              {activeSession ? (activeSession.title || activeSubagent?.name || "Chat") : "New chat"}
            </span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          </Button>
          {showSessionList && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowSessionList(false)} />
              <div className="absolute top-9 left-0 z-20 w-72 rounded-lg border border-border bg-popover shadow-md max-h-80 overflow-y-auto scrollbar-glass">
                {/* New chat button */}
                <button
                  type="button"
                  onClick={() => {
                    setActiveSession(null);
                    setShowSessionList(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent transition-colors border-b"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span className="font-medium">New chat</span>
                </button>
                {sortedSessions.length === 0 ? (
                  <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                    No chat history yet
                  </div>
                ) : (
                  sortedSessions.map((s) => {
                    const sub = subagents.find((x) => x.id === s.subagentId);
                    return (
                      <div
                        key={s.id}
                        className={cn(
                          "flex items-center gap-2 px-3 py-2 hover:bg-accent transition-colors group cursor-pointer",
                          s.id === activeSessionId && "bg-accent",
                        )}
                        onClick={() => {
                          setActiveSession(s.id);
                          setShowSessionList(false);
                        }}
                      >
                        <Bot className="h-3.5 w-3.5 text-primary shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate flex items-center gap-1">
                            {s.pinned && <span className="text-primary text-[10px]">📌</span>}
                            {s.title}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            {sub?.name ?? "Unknown"} · {s.messages.length} msgs
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteSession(s.id);
                          }}
                          className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-9 p-0 shrink-0"
          onClick={onClose}
          title="Close"
          aria-label="Close subagent panel"
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      {/* Active subagent badge */}
      {activeSubagent && (
        <div className="shrink-0 border-b px-3 py-1.5">
          <div className="flex items-center gap-2 text-xs">
            <Bot className="h-3 w-3 text-primary" />
            <span className="font-medium">{activeSubagent.name}</span>
            <span className="text-muted-foreground">· {activeSubagent.specialty}</span>
          </div>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-glass p-3 space-y-3">
        {!activeSession ? (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3 text-muted-foreground">
            <Bot className="h-12 w-12 opacity-30" />
            <p className="text-sm font-medium">Start a new subagent chat</p>
            <p className="text-xs">Tag a subagent with @name to begin</p>
            {subagents.length === 0 && (
              <p className="text-xs text-amber-500 mt-2">No subagents yet — the AI will create them as needed</p>
            )}
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center gap-2 text-muted-foreground">
            <Bot className="h-10 w-10 opacity-30" />
            <p className="text-sm">Chat with {activeSubagent?.name}</p>
            <p className="text-xs">{activeSubagent?.description}</p>
          </div>
        ) : (
          messages.map((msg) => (
            <SubagentMessageItem key={msg.id} message={msg} />
          ))
        )}
        {executing && !activeSession?.messages.find((m) => m.isStreaming) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground px-2">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Subagent is starting...</span>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="shrink-0 border-t p-2">
        {showMention && filteredSubagents.length > 0 && (
          <div className="mb-2 rounded-lg border border-border bg-popover shadow-md max-h-40 overflow-y-auto scrollbar-glass">
            {filteredSubagents.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => insertMention(s.name)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent transition-colors"
              >
                <Bot className="h-3.5 w-3.5 text-primary shrink-0" />
                <span className="font-medium">{s.name}</span>
                <span className="text-xs text-muted-foreground truncate">{s.specialty}</span>
              </button>
            ))}
          </div>
        )}

        {attachedFiles.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachedFiles.map((f) => (
              <div key={f.id} className="flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs">
                <span className="truncate max-w-32">{f.filename}</span>
                <button
                  type="button"
                  onClick={() => setAttachedFiles((prev) => prev.filter((x) => x.id !== f.id))}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Prompt box — styled like the main chat input (glass card + rounded) */}
        <div className="glass-card border-border focus-within:border-primary/40 rounded-2xl border transition-all input-focus-glow">
          <div className="px-2.5 pt-2.5">
            <div className="flex items-end gap-1.5">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading > 0}
                className="h-9 w-9 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
                title="Attach file"
                aria-label="Attach file"
              >
                {uploading > 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
              </Button>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder="Message @subagent_name..."
                disabled={executing}
                rows={1}
                className="placeholder:text-muted-foreground min-h-[40px] flex-1 resize-none scrollbar-thin bg-transparent py-2.5 text-sm focus:outline-none disabled:opacity-50"
              />
              <Button
                type="button"
                size="icon"
                onClick={() => void handleSend()}
                disabled={executing || (!message.trim() && attachedFiles.length === 0)}
                className="h-9 w-9 shrink-0 rounded-lg"
                title="Send"
              >
                {executing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          {/* Status row — matches the main chat LIVE/CONTROLS bar */}
          <div className="border-foreground/8 flex items-center justify-between border-t px-2.5 py-1.5">
            <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${executing ? "bg-primary animate-pulse" : "bg-emerald-500"}`} />
              {executing ? "Working" : "Ready"}
            </span>
            {activeSubagent && (
              <span className="inline-flex items-center gap-1 font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                <Bot className="h-3 w-3" />
                {activeSubagent.name}
              </span>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

/** Render a single message with markdown + tool call cards.
 *  Tool call cards are rendered INSIDE the message bubble, inline with the
 *  text flow (not at the bottom). Each card is collapsible. */
function SubagentMessageItem({ message }: { message: SubagentMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={cn("flex gap-2 animate-message-in", isUser && "flex-row-reverse")}>
      <div className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
        isUser ? "bg-foreground text-background" : "bg-primary/15 text-primary",
      )}>
        {isUser ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
      </div>
      <div className={cn("min-w-0 flex-1 space-y-1.5", isUser && "flex flex-col items-end")}>
        <div
          className={cn(
            "inline-block max-w-full rounded-2xl px-3 py-2 text-sm break-words space-y-2",
            isUser
              ? "bg-foreground text-background rounded-tr-sm"
              : "bg-muted rounded-tl-sm w-full",
          )}
        >
          {message.fileIds && message.fileIds.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {message.fileIds.map((fid) => {
                const url = getFileUrl(fid);
                return url ? (
                  <Image
                    key={fid}
                    src={url}
                    alt="attachment"
                    width={80}
                    height={80}
                    className="h-16 w-16 rounded-lg object-cover"
                    unoptimized
                  />
                ) : null;
              })}
            </div>
          )}
          {isUser ? (
            <p className="whitespace-pre-wrap">{message.content}</p>
          ) : (
            <>
              {/* Tool call cards rendered BEFORE/inline with text — they appear
                  where the AI called them, not stuck at the bottom. */}
              {message.toolCalls && message.toolCalls.length > 0 && (
                <div className="space-y-1.5">
                  {message.toolCalls.map((tc) => (
                    <CollapsibleToolCard key={tc.id} tc={tc} />
                  ))}
                </div>
              )}
              <div className="prose-sm max-w-none break-words text-sm">
                <MarkdownContent content={message.content || ""} />
                {message.isStreaming && <WritingCursor size="0.95em" />}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Collapsible tool call card — click the header to expand/collapse args + result. */
function CollapsibleToolCard({ tc }: {
  tc: NonNullable<SubagentMessage["toolCalls"]>[number];
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-background/60 text-xs overflow-hidden animate-fade-scale">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 hover:bg-foreground/5 transition-colors"
      >
        {tc.status === "running" && <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />}
        {tc.status === "completed" && <ChevronDown className="h-3 w-3 text-emerald-500 shrink-0" />}
        {tc.status === "error" && <X className="h-3 w-3 text-destructive shrink-0" />}
        <span className="font-mono font-semibold truncate flex-1 text-left">{tc.name}</span>
        <ChevronDown className={cn("h-3 w-3 text-muted-foreground transition-transform shrink-0", expanded && "rotate-180")} />
      </button>
      {expanded && (
        <div className="border-t border-border px-2.5 py-2 space-y-1.5">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Arguments</p>
            <pre className="text-[10px] text-muted-foreground overflow-x-auto scrollbar-thin bg-background/40 rounded p-1.5">
              {JSON.stringify(tc.args, null, 2).slice(0, 500)}
            </pre>
          </div>
          {tc.result !== undefined && (
            <div>
              <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Result</p>
              <pre className="text-[10px] text-muted-foreground/70 overflow-x-auto scrollbar-thin bg-background/40 rounded p-1.5 max-h-32">
                {JSON.stringify(tc.result, null, 2).slice(0, 600)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
