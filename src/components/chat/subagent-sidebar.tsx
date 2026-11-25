"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { useSubagentStore, type SubagentMessage } from "@/stores/subagent-store";
import { executeSubagentTurn } from "@/lib/agent/subagent-runtime";
import { getFileUrl, uploadFile, type FileUploadResponse } from "@/lib/file-api";
import { MarkdownContent } from "./markdown-content";
import { OrbCursor } from "@/components/assistant-ui/elements";
import { ThinkingIndicator, ThinkingReasoning } from "@/components/assistant-ui/elements";
import { ToolCallCard } from "./tool-call-card";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Send, Paperclip, Loader2, X, ChevronDown, Plus, Bot, User, Trash2, MessageSquare,
} from "lucide-react";

/**
 * SubAgentSidebar — right sidebar showing chat between user and subagents.
 *
 * Mounted inside the DockedPanel container (docked column on lg+, drawer
 * below) — visibility/open-close is the container's job, so this component
 * only renders its content and reports close via `onClose`.
 *
 * RENDERING PARITY (Sub-Agent Chat PRD §2/§3/§6): the message renderer
 * REUSES the Main Chat components — the shared ToolCallCard (running /
 * completed / failed states, expand/collapse, output rendering, duration
 * badges) and the ThinkingReasoning + ThinkingIndicator thinking element —
 * instead of the old bespoke subagent-only tool card. No duplicate chat
 * rendering implementations.
 *
 * Features:
 *   - @ mention to tag a specific subagent (autocomplete dropdown)
 *   - Real streaming (token-by-token) from the subagent LLM
 *   - Markdown rendering (same as main chat)
 *   - Main-chat tool call cards inline
 *   - Thinking/reasoning blocks (same as main chat)
 *   - Chat session history (persists across refresh)
 *   - Session selector to switch between past chats
 *   - Send images via paperclip
 */
export function SubAgentSidebar({ onClose }: { onClose: () => void }) {
  // SELECTOR-BASED SUBSCRIPTIONS (render isolation): this sidebar stays
  // mounted while other panels are open and its store ticks during sub-agent
  // runs — the old no-selector call re-rendered it on EVERY store field
  // (sidebarOpen flips, unrelated registry updates). Only the exact fields
  // read here are subscribed; actions are stable references.
  const subagents = useSubagentStore((s) => s.subagents);
  const sessions = useSubagentStore((s) => s.sessions);
  const activeSessionId = useSubagentStore((s) => s.activeSessionId);
  const setActiveSession = useSubagentStore((s) => s.setActiveSession);
  const deleteSession = useSubagentStore((s) => s.deleteSession);
  const loadFromStorage = useSubagentStore((s) => s.loadFromStorage);

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
      ? subagents.find((s) => s.name.toLowerCase() === (mentionMatch[1] ?? "").toLowerCase())?.id
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

  const messages = activeSession?.messages ?? [];

  return (
    <div className="flex h-full w-full flex-col bg-card">
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
      <div className="fluid-bar flex h-12 shrink-0 items-center justify-between border-b px-2 sm:px-3">
        <div className="relative flex items-center gap-1 min-w-0 flex-1">
          {/* Hamburger / session selector button — larger touch target,
              fluid-chip background (active while the history list is open). */}
          <Button
            variant="ghost"
            size="sm"
            className="fluid-chip h-9 gap-2 px-2 text-sm font-medium min-w-0"
            onClick={() => setShowSessionList((v) => !v)}
            title="Chat history"
            aria-label="Toggle chat history"
            aria-expanded={showSessionList}
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
                {/* New chat button — glassy, no default border/outline */}
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
                          className="border-none bg-transparent p-1 text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded transition-opacity opacity-0 group-hover:opacity-100"
                          aria-label={`Delete chat ${s.title}`}
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
                className="flex w-full items-center gap-2 border-none bg-transparent px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded transition-colors"
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
                  className="border-none bg-transparent p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
                  aria-label={`Remove ${f.filename}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Prompt box — styled like the main chat input (glass card + rounded) */}
        <div className="composer-dock mb-morph rounded-2xl input-focus-glow">
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
    </div>
  );
}

/** Split reasoning text into sentences for the ThinkingReasoning element
 *  (same normalization as Main Chat's message-item). */
function splitReasoningSentences(text: string): string[] {
  if (!text) return [];
  return text
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.replace(/[ \t]{2,}/g, " "))
    .filter(Boolean);
}

/** Render a single message — REUSES the Main Chat rendering stack:
 *  ThinkingReasoning for reasoning, the shared ToolCallCard for tool
 *  calls, MarkdownContent for text. (Sub-Agent Chat PRD §2/§3/§6.) */
function SubagentMessageItem({ message }: { message: SubagentMessage }) {
  const isUser = message.role === "user";
  const ranTools = (message.toolCalls?.length ?? 0) > 0;

  // Sentences for the thinking element — same reveal as Main Chat.
  const reasoningSentences = useMemo(
    () => splitReasoningSentences(message.reasoning ?? ""),
    [message.reasoning],
  );

  // "Thought for Ns" timer — runs while the reasoning streams.
  const startedAtRef = useRef<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const reasoningLive = Boolean(message.isReasoningStreaming);
  useEffect(() => {
    if (reasoningLive) {
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
  }, [reasoningLive]);

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
              {/* PRD §3 — thinking/reasoning: the SAME ThinkingReasoning
                  element Main Chat uses. Never merged into the text; stays
                  visible when text or tool results arrive after it. */}
              {(message.reasoning || reasoningLive) && (
                <div className="mb-2 min-w-0 max-w-full">
                  {reasoningSentences.length === 0 ? (
                    <ThinkingIndicator label="Thinking" className="mb-2" />
                  ) : (
                    <ThinkingReasoning
                      sentences={reasoningSentences}
                      phase={reasoningLive ? "thinking" : "done"}
                      elapsedSeconds={elapsedSeconds}
                      verb="Thought"
                      activeLabel="Thinking…"
                      keepOpenOnDone={!ranTools}
                      headerNode={
                        reasoningLive ? (
                          <ThinkingIndicator label="Thinking" className="min-w-0" />
                        ) : undefined
                      }
                    />
                  )}
                </div>
              )}

              {/* PRD §2 — tool calls: the SAME ToolCallCard Main Chat uses
                  (running/completed/failed states, expand/collapse, output
                  rendering, duration badges, display-mode store). */}
              {message.toolCalls && message.toolCalls.length > 0 && (
                <div className="space-y-1.5">
                  {message.toolCalls.map((tc) => (
                    <ToolCallCard
                      key={tc.id}
                      toolCall={{
                        ...tc,
                        // The subagent store has no streamingOutput lane;
                        // the shared card reads it for live stdout only.
                        streamingOutput: undefined,
                      }}
                      turnId={null}
                    />
                  ))}
                </div>
              )}

              {/* PRD §1/§4 — the text body. Streaming appends here; prior
                  content is never replaced (runtime fix). */}
              <div className="prose-sm max-w-none break-words text-sm">
                <MarkdownContent content={message.content || ""} />
                {message.isStreaming && <OrbCursor variant="C2" size={14} />}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
