"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { stripFunctionCallTags } from "@/lib/text-sanitizer";
import { RatingValue, type ChatMessage, type ChatMessageFile } from "@/types";
import { ToolCallCard } from "./tool-call-card";
import { BrowserUseGroup } from "./tool-results/use-browser";
import { mapBrowserRunStarts } from "@/lib/browser-run-group";
import { deriveAgentPhase } from "@/lib/agent/timeline";
import { useTypewriter } from "@/components/assistant-ui/elements/letter-stream";
import { RESEARCH_TOOL_NAMES } from "./research-panel";
import { MarkdownContent } from "./markdown-content";
import { useFilePreviewStore } from "@/stores";
import { useSourcesPanelStore } from "@/stores/sources-panel-store";
import { ChevronRight, Copy, Check, CornerDownLeft, Pencil, Quote } from "lucide-react";
import { getFileUrl, loadFileUrls } from "@/lib/file-api";
import { extractSources } from "@/lib/chat-sources";
import type { SourceItem } from "@/lib/chat-sources";
import { statusCaptionFor } from "@/hooks/use-status-caption";
import { FileCard, FileCardImage } from "./file-card";
import { CitationsFooter } from "./citations";
import { FilesFooter, deriveStreamingTree } from "./streaming-file-tree";
import { formatDuration } from "./tool-duration";
import {
  CollapsePanel,
  ghostButtonClass,
  iconSwapClass,
  iconSwapInClass,
  MessageActions,
  ThinkingIndicator,
  ThinkingReasoning,
  type Reaction,
} from "@/components/assistant-ui/elements";
import { ResearchPanel } from "./research-panel";
import { GenUICreationGate } from "@/components/genui/GenUICreationGate";
import { useGenUIFromText } from "@/hooks/useGenUIStream";
import { extractGenUINodes } from "@/lib/genui/stream-parser";
import type { GenUINode } from "@/lib/genui/types";
import { useChatStore } from "@/stores/chat-store";
import { useAuthStore, useQuoteStore } from "@/stores";
import { stripUploadTags } from "@/lib/uploads/registry";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

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
 * ThinkingBlock / ReasoningBlock — the LEGACY (tool-less, pre-parts)
 * reasoning display: the full ThinkingReasoning element with its own
 * header. THE CIRCLE STAYS when real thinking starts streaming (user
 * directive: the pulsing dot that shows "just before thinking" must NOT
 * be removed after the AI really starts thinking) — the live header is
 * the SAME dot+label indicator, and it only swaps its label at settle.
 * NO AUTO-COLLAPSE for tool-less turns (user directive): the block rests
 * expanded with its "Thought for Ns" summary; the user folds manually.
 */
function ReasoningPanel({
  text,
  isStreaming,
  variant,
  ranTools = false,
}: {
  text: string;
  isStreaming: boolean;
  variant: "thinking" | "reasoning";
  /** Turns that ran tool calls keep the classic auto-fold (the host
   *  WorkingPanel owns the collapse); tool-less turns rest expanded. */
  ranTools?: boolean;
}) {
  const isThinking = variant === "thinking";

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
        keepOpenOnDone={!ranTools}
        // CIRCLE CONTINUITY: the live header is the SAME dot+label indicator
        // shown before the first sentence arrived — the pulsing dot stays
        // beside the caption for the whole thinking stream (never removed
        // when real thinking starts).
        headerNode={
          isStreaming ? (
            <ThinkingIndicator
              label={isThinking ? "Thinking" : "Reasoning"}
              className="min-w-0"
            />
          ) : undefined
        }
      />
    </div>
  );
}

function ThinkingBlock(props: {
  text: string;
  isStreaming: boolean;
  ranTools?: boolean;
}) {
  return <ReasoningPanel {...props} variant="thinking" />;
}

function ReasoningBlock(props: {
  text: string;
  isStreaming: boolean;
  ranTools?: boolean;
}) {
  return <ReasoningPanel {...props} variant="reasoning" />;
}

/**
 * AgentStatusLine — THE one in-place execution status for a STREAMING
 * assistant message WITHOUT a host panel (pure-text classic flow and the
 * legacy fallback). Exactly one instance per message, rendered at the END
 * of the parts flow; it never stacks with itself across transitions — the
 * label updates in place:
 *
 *   Thinking  — the model is generating (opening text or the answer).
 *   Writing   — the answer text is actively streaming at the tail.
 *
 * CAPTION GENERATION (user directive: "re add it into that circle (caption)
 * just like thinking"): the pulsing-dot circle's label is a GENERATED
 * caption derived from the turn's live parts — the circle NEVER disappears
 * and its caption narrates the real activity (Thinking / Writing / …).
 * Turns whose thinking/tools render inside a panel show no second status
 * row (the panel trigger owns the circle). Settled messages render
 * nothing.
 */
function AgentStatusLine({ message }: { message: ChatMessage }) {
  const phase = deriveAgentPhase(message);
  if (!phase) return null;
  const caption = statusCaptionFor(message) ?? (phase === "working" ? "Working" : "Thinking");
  return (
    <div
      className="flex min-h-8 items-center gap-2.5 px-1"
      role="status"
      aria-live="polite"
    >
      <ThinkingIndicator label={caption} className="min-w-0" />
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
  /** True for the message that owns the live todo plan — the inline
   *  ResearchPanel renders at the exact position where the todo tool ran
   *  inside this message's part flow (not stuck at the thread bottom). */
  showTodoPanel?: boolean;
  /** Wired to the inline todo panel's "Cut" (dismiss) button. */
  onTodoDismiss?: () => void;
  /** Message-action row (assistant-ui "Message actions"): re-run the turn
   *  that produced an assistant message. */
  onRegenerate?: (assistantMessageId: string) => void;
  /** User-message actions: edit a sent prompt + re-run the turn from it. */
  onEditUserMessage?: (userMessageId: string, newContent: string) => void;
}

// ---------------------------------------------------------------------------
// MESSAGE ACTION ROWS — the assistant-ui "Message actions" element (copy /
// rate / regenerate / more under an assistant reply) + the user-message row
// (copy / edit). Both rows are ALWAYS VISIBLE — no opacity-0 hover games
// (the Realtime PRD removed invisible hitboxes entirely): quiet muted
// glyphs that confirm THEMSELVES in place (copy swaps to a check + emerald
// tint, a rating fills in, regenerate spins while it runs).
// ---------------------------------------------------------------------------

/** The copyable text of an assistant message — exactly what's rendered
 *  (function-call sanitizer applied; parts text join as the fallback). */
function assistantCopyText(message: ChatMessage): string {
  const fromParts = (message.parts ?? [])
    .filter((p) => p.type === "text" && p.content)
    .map((p) => p.content ?? "")
    .join("\n\n");
  return stripFunctionCallTags(message.content || fromParts).trim();
}

function AssistantMessageActions({
  message,
  onRegenerate,
}: {
  message: ChatMessage;
  onRegenerate?: (assistantMessageId: string) => void;
}) {
  const { copy, copied } = useCopyToClipboard();
  const [reaction, setReaction] = React.useState<Reaction>(null);
  const [ratingReady, setRatingReady] = React.useState(false);
  const [regenerating, setRegenerating] = React.useState(false);
  const [moreOpen, setMoreOpen] = React.useState(false);
  const setQuote = useQuoteStore((s) => s.setQuote);
  const text = React.useMemo(() => assistantCopyText(message), [message]);

  // Persisted rating (local-first Dexie): hydrate once per message, then
  // apply visual state ONLY after a write actually succeeded (the same
  // "never confirm an action that didn't happen" discipline RatingButtons
  // uses).
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const userId = useAuthStore.getState().user?.id;
        if (userId) {
          const { ratingService } = await import("@/lib/services");
          const r = await ratingService.getMessageRatings(message.id, userId);
          if (alive) {
            setReaction(
              r.user_rating === RatingValue.LIKE
                ? "up"
                : r.user_rating === RatingValue.DISLIKE
                  ? "down"
                  : null,
            );
          }
        }
      } catch {
        /* no stored rating — stays null */
      } finally {
        if (alive) setRatingReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [message.id]);

  const handleReaction = (next: Reaction) => {
    if (!ratingReady || next === reaction) return;
    void (async () => {
      const userId = useAuthStore.getState().user?.id;
      if (!userId) return;
      try {
        const { ratingService } = await import("@/lib/services");
        if (next === null) {
          await ratingService.remove(message.id, userId);
        } else {
          await ratingService.rate(
            message.id,
            userId,
            next === "up" ? RatingValue.LIKE : RatingValue.DISLIKE,
          );
        }
        setReaction(next);
      } catch {
        /* write failed — keep the current state */
      }
    })();
  };

  const handleRegenerate = () => {
    if (regenerating || !onRegenerate) return;
    setRegenerating(true);
    onRegenerate(message.id);
    // The re-run replaces this message almost immediately; the reset only
    // matters when the regenerate was silently blocked (a live execution)
    // so the spinner can never stick.
    window.setTimeout(() => setRegenerating(false), 1500);
  };

  const menuItemClass =
    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-foreground/85 transition-colors hover:bg-accent hover:text-foreground";

  return (
    <div className="relative -ml-1">
      <MessageActions
        copied={copied}
        reaction={reaction}
        regenerating={regenerating}
        onCopy={() => {
          if (text) void copy(text);
        }}
        onReactionChange={handleReaction}
        onRegenerate={handleRegenerate}
        onMore={() => setMoreOpen((v) => !v)}
      />
      {moreOpen ? (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setMoreOpen(false)}
          />
          <div
            role="menu"
            aria-label="More response actions"
            className="animate-slide-up-fade absolute top-full right-0 z-50 mt-1 w-52 overflow-hidden rounded-lg border border-border bg-background p-1 shadow-lg"
          >
            <button
              type="button"
              role="menuitem"
              className={menuItemClass}
              onClick={() => {
                if (text) setQuote(text);
                setMoreOpen(false);
              }}
            >
              <Quote className="h-3.5 w-3.5 shrink-0" aria-hidden /> Quote reply
            </button>
            <button
              type="button"
              role="menuitem"
              className={menuItemClass}
              onClick={() => {
                if (text) void copy(text);
                setMoreOpen(false);
              }}
            >
              <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden /> Copy as Markdown
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Copy + edit row under a USER message (the visible text never carries the
 *  hidden upload tags — copy/edit operate on the stripped prompt). */
function UserMessageActions({
  message,
  onStartEdit,
}: {
  message: ChatMessage;
  onStartEdit: () => void;
}) {
  const { copy, copied } = useCopyToClipboard();
  const displayText = React.useMemo(
    () => stripUploadTags(message.content || "").trim(),
    [message.content],
  );
  return (
    <div data-slot="user-message-actions" className="-mr-1 flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => {
          if (displayText) void copy(displayText);
        }}
        aria-label={copied ? "Copied message" : "Copy message"}
        title={copied ? "Copied" : "Copy"}
        className={cn(
          ghostButtonClass,
          "h-7 w-7",
          copied && "text-emerald-600 dark:text-emerald-400",
        )}
      >
        <span key={copied ? "check" : "copy"} className={iconSwapClass}>
          <span className={iconSwapInClass}>
            {copied ? (
              <Check className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden />
            )}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onStartEdit}
        aria-label="Edit message"
        title="Edit & resubmit"
        className={cn(ghostButtonClass, "h-7 w-7")}
      >
        <Pencil className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

/** Inline editor that replaces the user bubble while editing — Enter
 *  resubmits (the turn re-runs from the edited prompt), Esc cancels. */
function UserMessageEditor({
  initial,
  onCancel,
  onSave,
}: {
  initial: string;
  onCancel: () => void;
  onSave: (text: string) => void;
}) {
  const [text, setText] = React.useState(initial);
  const taRef = React.useRef<HTMLTextAreaElement | null>(null);

  React.useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const canSave = text.trim().length > 0;
  return (
    <div className="w-full min-w-0">
      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (canSave) onSave(text);
          }
        }}
        rows={Math.max(2, Math.min(8, initial ? initial.split("\n").length : 2))}
        aria-label="Edit message"
        className="mb-height w-full resize-none rounded-2xl rounded-tr-sm border border-border bg-background px-3.5 py-2.5 text-sm leading-relaxed text-foreground shadow-sm outline-none transition-colors focus:border-primary/50"
      />
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <span className="text-muted-foreground mr-auto text-[11px]">
          Enter to resubmit · Esc to cancel
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onSave(text)}
          disabled={!canSave}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <CornerDownLeft className="h-3.5 w-3.5" aria-hidden /> Save &amp; submit
        </button>
      </div>
    </div>
  );
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
  // Web page tools (web_fetch / fetch_url / use_browser) are deliberately
  // NOT here anymore: the live page preview lives INSIDE the tool call's
  // disclosure — visible only after the user enlarges the tool call, never
  // always-on in the chat flow. A settled web turn force-collapses its
  // "Worked Ns" panel like any other tool turn.
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

/** "Thought {time}" resting summary for a tool-less turn — total live
 *  thinking/reasoning time, from the processor-stamped part windows. */
function thoughtSeconds(message: ChatMessage): number {
  let total = 0;
  for (const p of message.parts ?? []) {
    if (p.type !== "thinking" && p.type !== "reasoning") continue;
    const start = p.roundStartedAt;
    const end = p.reasoningEndedAt;
    if (typeof start === "number" && typeof end === "number" && end > start) {
      total += end - start;
    }
  }
  return total / 1000;
}

/**
 * WorkingPanel — ONE collapsible unit owning the ENTIRE pre-answer phase
 * of an assistant turn (user directive: "all this pre-have inside a
 * collapsible panel"):
 *
 *   ● Thinking / Browsing perchance.org / Writing — while the turn
 *   streams, the trigger is the pulsing-dot circle + a GENERATED caption
 *   (statusCaptionFor — the circle is NEVER removed, and its caption
 *   narrates the real activity just like "Thinking" did). One line,
 *   updating in place, never a second status row. The live reasoning
 *   STREAMS VISIBLY inside (letter by letter, headerless); each round's
 *   thinking then folds into its own "Thought for Ns" row the moment it
 *   ends. All tool calls, inner thinking and texts generated during the
 *   process live inside — strict chronological order (timeline PRD §25:
 *   array position is the truth).
 *
 *   AUTO-COLLAPSE RULE (user directive: "if no tool ran, auto detect and
 *   remove auto collapsing"): the panel force-collapses into its resting
 *   row at settle ONLY when the turn ran tool calls (or holds a
 *   deliverable that would keep it open). A tool-less turn rests
 *   EXPANDED — “Thought {time}” — and the user folds it manually.
 */
function WorkingPanel({
  message,
  hasDeliverables,
  ranTools,
  children,
}: {
  message: ChatMessage;
  /** A payload tool (chart / download / preview / Q&A) or the live plan
   *  panel keeps the panel from force-collapsing at settle — they must
   *  stay visible. */
  hasDeliverables: boolean;
  /** True when the turn made at least one (non-research) tool call —
   *  gates the auto-collapse-at-settle + the "Worked" resting label. */
  ranTools: boolean;
  /** The process content — thinking runs, tool cards, texts. */
  children: React.ReactNode;
}) {
  const streaming = Boolean(message.isStreaming);
  // CAPTION GENERATION: the live trigger label narrates the turn's real
  // activity (Thinking → Browsing … → Writing). Falls back to Thinking.
  const caption = streaming ? (statusCaptionFor(message) ?? "Thinking") : null;

  // INITIAL STATE: expanded while streaming, for tool-less turns, AND for
  // turns holding a DELIVERABLE — a message can mount ALREADY SETTLED (chat
  // history loaded from the database, restored conversations), and the
  // web page preview / chart / download inside must never be born hidden
  // under a collapsed "Worked Ns" row.
  const [expanded, setExpanded] = React.useState(streaming || !ranTools || hasDeliverables);
  const [userToggled, setUserToggled] = React.useState(false);
  // AUTO EXPAND/COLLAPSE (render-time adjustment — no effect, no cascading
  // renders): expanded for the whole live stream; at settle the panel
  // force-collapses ONLY when the turn ran tools (or carries a
  // deliverable, which keeps it open regardless). Tool-less turns keep
  // resting EXPANDED — no auto-collapse. A manual toggle during the
  // stream wins until settle; after settle the user is free again.
  const autoTarget = streaming;
  const [prevAuto, setPrevAuto] = React.useState(autoTarget);
  if (autoTarget !== prevAuto) {
    setPrevAuto(autoTarget);
    if (autoTarget) {
      if (!userToggled) setExpanded(true);
    } else if (ranTools && !hasDeliverables) {
      setExpanded(false);
      setUserToggled(false);
    }
  }

  const worked = workedSummary(message);
  const thoughtTime = ranTools ? null : formatDuration(thoughtSeconds(message)) || null;

  return (
    <div className="mb-2 min-w-0 max-w-full">
      {/* ONE trigger line — the live circle+caption while streaming, the
          resting summary after settle. */}
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={
          streaming
            ? `Agent is ${(caption ?? "thinking").toLowerCase()} (toggle process details)`
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
          // THE CIRCLE + GENERATED CAPTION (user directives: the circle
          // stays for the whole stream; caption generation re-added into
          // that circle, just like thinking). Static label text — it fades
          // once whenever the caption changes. No shimmer, no cycling.
          <ThinkingIndicator label={caption ?? "Thinking"} className="min-w-0" />
        ) : ranTools ? (
          <span className="text-sm font-medium text-foreground/90">
            Worked{worked.time ? ` ${worked.time}` : ""}
          </span>
        ) : (
          <span className="text-sm font-medium text-foreground/90">
            Thought{thoughtTime ? ` ${thoughtTime}` : ""}
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
  showTodoPanel = false,
  onTodoDismiss,
  onRegenerate,
  onEditUserMessage,
}: MessageItemProps) {
  const isUser = message.role === "user";
  const openPreview = useFilePreviewStore((s) => s.open);
  const openSources = useSourcesPanelStore((s) => s.open);
  const isGrouped = groupPosition && groupPosition !== "single";

  // USER-MESSAGE EDITING (assistant-ui "Edit user message" flow): while
  // editing, the bubble is replaced by the inline editor (see the legacy
  // render path below) and the copy/edit row hides.
  const [editingUser, setEditingUser] = React.useState(false);

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

  // COPY TEXT was the old footer's clipboard payload — the footer (and the
  // copy action) are gone entirely (Realtime PRD §20–§21), so the memo went
  // with them.

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
        {/* Realtime PRD §18–§19: NO assistant identity header/logo — the
            companion is the visual identity; responses start directly with
            their content. */}
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
          // UNIFIED PANEL FLOW (user directive: "all this pre-have inside a
          // collapsible panel"): a turn with ANY pre-answer process — tool
          // calls OR thinking/reasoning runs — renders ONE collapsible
          // WorkingPanel owning that whole process: every round's inner
          // thinking (live while it streams, then a "Thought for Ns" row),
          // every tool call and every text generated along the way, in
          // strict chronological order. The panel trigger is the
          // pulsing-dot circle + a generated caption (Thinking / Browsing …
          // / Writing) and rests as "Worked {time}" (tools ran) or
          // "Thought {time}" — auto-collapsed ONLY when tools ran. Pure-text
          // turns (no tools, no thinking) keep the frameless flow + the one
          // AgentStatusLine.

          // ── Legacy fallback: user / pre-parts messages. ────────────────
          if (!useParts) {
            const legacyRanTools = !!(message.toolCalls && message.toolCalls.length > 0);
            return (
              <>
                {!isUser && message.thinking && (
                  <ThinkingBlock
                    text={message.thinking}
                    isStreaming={Boolean(message.isStreaming)}
                    ranTools={legacyRanTools}
                  />
                )}
                {!isUser && message.reasoning && (
                  <ReasoningBlock
                    text={message.reasoning}
                    isStreaming={Boolean(message.isStreaming)}
                    ranTools={legacyRanTools}
                  />
                )}
                {isUser && editingUser ? (
                  <UserMessageEditor
                    initial={stripUploadTags(message.content || "")}
                    onCancel={() => setEditingUser(false)}
                    onSave={(text) => {
                      setEditingUser(false);
                      onEditUserMessage?.(message.id, text);
                    }}
                  />
                ) : message.content ? (
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
                ) : null}
                {message.toolCalls && message.toolCalls.length > 0 && (
                  <div className="w-full space-y-2">
                    {(() => {
                      // Consecutive use_browser calls collapse into ONE
                      // BrowserUseGroup frame (run start renders the group,
                      // continuations render nothing); every other tool
                      // keeps its own ToolCallCard.
                      const browserRuns = mapBrowserRunStarts(message.toolCalls ?? []);
                      return (message.toolCalls ?? []).map((toolCall) => {
                        const run = browserRuns.runStartedBy(toolCall.id);
                        if (run) return <BrowserUseGroup key={toolCall.id} toolCalls={run} />;
                        if (browserRuns.isContinuation(toolCall.id)) return null;
                        return <ToolCallCard key={toolCall.id} toolCall={toolCall} />;
                      });
                    })()}
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

          // Browser-run grouping: consecutive use_browser TOOL items with no
          // other item (thinking or text) between them render as ONE
          // BrowserUseGroup at the run's FIRST item; continuations render
          // nothing. The items array itself is untouched — browser items
          // still count as tool items for every index computation below
          // (boundaryIdx, processItems, trailingItems, todoSplice).
          const browserRuns = mapBrowserRunStarts(
            items.map((it) => (it.kind === "tool" ? it.toolCall : null)),
          );

          // PROCESS/ANSWER BOUNDARY. With tools: the LAST TOOL item — text
          // after it is the final answer. Tool-less (thinking-only) turns:
          // the LAST THINKING item — the answer is the text that follows
          // the thinking. While the turn streams, answer text stays at the
          // tail of the process (inside the panel — a tool or thinking run
          // arriving later simply appends after it, so nothing ever jumps
          // mid-stream); when the turn settles it renders BELOW the panel
          // as the message body.
          let lastToolItemIdx = -1;
          let lastThinkingItemIdx = -1;
          for (let i = 0; i < items.length; i++) {
            const kind = items[i]!.kind;
            if (kind === "tool") lastToolItemIdx = i;
            if (kind === "thinking") lastThinkingItemIdx = i;
          }
          const ranTools = lastToolItemIdx >= 0;
          const boundaryIdx = ranTools ? lastToolItemIdx : lastThinkingItemIdx;
          // NO process (pure-text answer) → no panel: the frameless flow +
          // the AgentStatusLine (the circle + caption at the streaming
          // tail). Any thinking or tool run → the unified panel.
          const hasPanel = boundaryIdx >= 0;

          const processItems = hasPanel
            ? items.filter(
                (it, i) =>
                  it.kind !== "text" || i < boundaryIdx || streaming,
              )
            : items;
          const trailingItems =
            hasPanel && !streaming
              ? items.filter(
                  (it, i) => it.kind === "text" && i > boundaryIdx,
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
              const run = browserRuns.runStartedBy(it.toolCall.id);
              if (run) {
                return (
                  <div key={it.partId} className="w-full">
                    <BrowserUseGroup toolCalls={run} />
                  </div>
                );
              }
              if (browserRuns.isContinuation(it.toolCall.id)) return null;
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
                <WorkingPanel
                  message={message}
                  hasDeliverables={hasDeliverables}
                  ranTools={ranTools}
                >
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

          // ── CLASSIC PATH (pure-text answer — no tools, no thinking):
          // frameless editorial flow + the one status line. ──────────────
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

        {/* MESSAGE ACTION ROWS (assistant-ui "Message actions" + user
            edit/copy): always visible once the turn settles — each action
            confirms itself in place (copy → check + emerald, rating fills,
            regenerate spins). No hover-only opacity games (Realtime PRD
            §20–§21: no invisible hitboxes). */}
        {!isUser && !message.isStreaming && (
          <AssistantMessageActions message={message} onRegenerate={onRegenerate} />
        )}
        {isUser && !editingUser && (
          <UserMessageActions
            message={message}
            onStartEdit={() => setEditingUser(true)}
          />
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
  //   - groupPosition / onTodoDismiss (parent props)
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
    prev.groupPosition === next.groupPosition &&
    prev.showTodoPanel === next.showTodoPanel &&
    prev.onTodoDismiss === next.onTodoDismiss &&
    prev.onRegenerate === next.onRegenerate &&
    prev.onEditUserMessage === next.onEditUserMessage
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
