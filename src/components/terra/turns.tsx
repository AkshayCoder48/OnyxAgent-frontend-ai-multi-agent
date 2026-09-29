"use client";

import { useEffect, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  Copy,
  Feather,
  Loader2,
  RefreshCw,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./code-block";
import { Markdown } from "./markdown";
import { ToolCard } from "./tool-card";
import { useTerra } from "./store";
import type { Message, RouteInfo } from "./types";

function AssistantHeader({ route }: { route?: RouteInfo }) {
  return (
    <header className="mb-2.5 flex items-center gap-2">
      <span
        className="flex h-5 w-5 items-center justify-center rounded-full border border-terra-soft-border bg-terra-soft"
        aria-hidden
      >
        <Feather className="h-3 w-3 text-terra" />
      </span>
      <span className="font-serif text-[15px] font-medium italic text-ink-soft">Terra</span>
      {route && <RouteBadge route={route} />}
    </header>
  );
}

const ROUTE_DOT: Record<RouteInfo["route"], string> = {
  fast: "bg-[#8A7E6C]",
  balanced: "bg-terra",
  deep: "bg-terra-deep",
};

const ROUTE_TAG: Record<RouteInfo["route"], string> = {
  fast: "Fast",
  balanced: "Balanced",
  deep: "Deep reasoning",
};

function RouteBadge({ route }: { route: RouteInfo }) {
  return (
    <span
      className="ml-1 inline-flex max-w-full items-center gap-1.5 rounded-full border border-hairline bg-paper px-2 py-0.5"
      title={route.reason}
      aria-label={`Router: ${ROUTE_TAG[route.route]}. ${route.reason}`}
    >
      <span className={cn("h-[6px] w-[6px] shrink-0 rounded-full", ROUTE_DOT[route.route])} aria-hidden />
      <span className="truncate text-[11px] font-medium tracking-[0.02em] text-ink-muted">
        {ROUTE_TAG[route.route]}
      </span>
    </span>
  );
}

/** Forces a periodic re-render while `active` — works in background tabs. */
function useTick(active: boolean): void {
  const [, force] = useState(0);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      if (cancelled) return;
      force((n) => n + 1);
      timer = setTimeout(tick, 200);
    };
    timer = setTimeout(tick, 200);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active]);
}

function ThinkingBlock({ message }: { message: Message }) {
  const live = Boolean(message.streaming) && message.text.length === 0;
  useTick(live);
  // Snapshot the running timer once, then let the tick animate the clock.
  const [mounted] = useState(() => ({ at: Date.now(), base: message.thinkMs ?? 0 }));
  const [userToggle, setUserToggle] = useState<boolean | null>(null);
  const open = userToggle ?? live;

  const seconds = live
    ? (mounted.base + (Date.now() - mounted.at)) / 1000
    : (message.thinkMs ?? 0) / 1000;
  const label = live ? "Thinking…" : `Thought for ${seconds < 1 ? "under a second" : `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`}`;

  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-paper">
      <button
        type="button"
        onClick={() => setUserToggle(!open)}
        aria-expanded={open}
        className="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-terra-soft/50"
      >
        <Brain
          className={cn("h-4 w-4 shrink-0", live ? "animate-pulse text-terra" : "text-ink-muted")}
          aria-hidden
        />
        <span
          className={cn(
            "text-[12px] font-medium tracking-[0.02em]",
            live ? "text-terra-deep" : "text-ink-muted",
          )}
        >
          {label}
        </span>
        {live && (
          <span className="flex items-center gap-1 text-[11px] text-ink-muted" aria-hidden>
            <span className="terra-dot h-1 w-1 rounded-full bg-terra" />
            <span className="terra-dot h-1 w-1 rounded-full bg-terra" style={{ animationDelay: "0.15s" }} />
            <span className="terra-dot h-1 w-1 rounded-full bg-terra" style={{ animationDelay: "0.3s" }} />
          </span>
        )}
        <ChevronDown
          className={cn(
            "ml-auto h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform duration-200",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {open && message.reasoning && (
        <div className="terra-scroll max-h-64 overflow-y-auto border-t border-hairline px-4 py-3">
          <p className="whitespace-pre-wrap text-[13px] leading-[1.65] italic text-ink-muted">
            {message.reasoning}
          </p>
        </div>
      )}
    </div>
  );
}

export function UserCard({ message }: { message: Message }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: "easeOut" }}
      className="flex justify-end"
    >
      <div className="max-w-[85%] rounded-2xl rounded-tr-sm border border-terra-soft-border bg-terra-soft px-4 py-3">
        <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink">{message.text}</p>
      </div>
    </motion.div>
  );
}

function plainText(message: Message): string {
  const parts = message.parts ?? [];
  if (parts.length === 0) return message.text;
  return parts
    .map((p) =>
      p.type === "text" ? p.text : p.type === "code" ? p.code : `${p.tool.name} — ${p.tool.subtitle}`,
    )
    .join("\n\n");
}

interface TurnActionProps {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}

function TurnAction({ label, active, onClick, children }: TurnActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
        active ? "bg-terra-soft text-terra" : "text-ink-muted hover:bg-terra-soft hover:text-terra",
      )}
    >
      {children}
    </button>
  );
}

function StreamCursor() {
  return (
    <span
      className="terra-caret ml-0.5 inline-block h-[1.05em] w-[3px] translate-y-[2px] rounded-[1px] bg-terra align-baseline"
      aria-hidden
    />
  );
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1.5 py-1.5" role="status" aria-label="Terra is typing">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="terra-dot h-1.5 w-1.5 rounded-full bg-terra"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}

export function AssistantTurn({ message, isLast }: { message: Message; isLast: boolean }) {
  const setFeedback = useTerra((s) => s.setFeedback);
  const regenerate = useTerra((s) => s.regenerate);
  const sending = useTerra((s) => s.sending);
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(plainText(message));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable; ignore.
    }
  };

  const streaming = Boolean(message.streaming);
  const hasAnswer = (message.parts ?? []).some(
    (p) => p.type === "text" && p.text.trim().length > 0,
  );

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: "easeOut" }}
      className="group"
    >
      <AssistantHeader route={message.route} />

      {message.notice && (
        <p className="mb-2.5 flex items-center gap-1.5 text-[12px] italic text-ink-muted" role="status">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-terra" aria-hidden />
          {message.notice}
        </p>
      )}

      {message.isError ? (
        <div className="flex flex-col gap-2.5">
          <p className="flex items-start gap-2 text-[14px] italic leading-relaxed text-terra-deep">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{message.parts?.[0]?.type === "text" ? message.parts[0].text : message.text}</span>
          </p>
          <div>
            <button
              type="button"
              onClick={() => {
                if (!sending) void regenerate();
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-terra-soft-border bg-terra-soft px-3 text-[12px] font-medium text-terra-deep transition-colors hover:bg-terra-soft/70"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Retry
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {message.reasoning && <ThinkingBlock message={message} />}

          {message.parts?.length ? (
            <div className={cn("space-y-4", streaming && "terra-streaming")}>
              {message.parts.map((part, index) => {
                if (part.type === "text") {
                  const isLastPart = index === message.parts!.length - 1;
                  return (
                    <div key={index} className={isLastPart ? "terra-stream-last" : undefined}>
                      <Markdown>{part.text}</Markdown>
                      {streaming && isLastPart && part.text.trim().length > 0 && <StreamCursor />}
                    </div>
                  );
                }
                if (part.type === "code")
                  return (
                    <CodeBlock
                      key={index}
                      filename={part.filename}
                      language={part.language}
                      code={part.code}
                    />
                  );
                return <ToolCard key={index} tool={part.tool} />;
              })}
            </div>
          ) : streaming && !message.reasoning ? (
            <TypingDots />
          ) : null}

          {message.warn && (
            <p className="flex items-start gap-2 rounded-lg border border-hairline bg-paper px-3 py-2 text-[12px] italic leading-relaxed text-ink-muted">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-terra" aria-hidden />
              {message.warn}
            </p>
          )}
        </div>
      )}

      {!streaming && (
        <div className="mt-3 flex items-center gap-1 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
          <TurnAction label={copied ? "Copied" : "Copy reply"} active={copied} onClick={onCopy}>
            {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
          </TurnAction>
          <TurnAction
            label="Good reply"
            active={message.feedback === "up"}
            onClick={() => setFeedback(message.id, "up")}
          >
            <ThumbsUp className="h-4 w-4" aria-hidden />
          </TurnAction>
          <TurnAction
            label="Poor reply"
            active={message.feedback === "down"}
            onClick={() => setFeedback(message.id, "down")}
          >
            <ThumbsDown className="h-4 w-4" aria-hidden />
          </TurnAction>
          {isLast && (
            <TurnAction
              label="Regenerate reply"
              onClick={() => {
                if (!sending) void regenerate();
              }}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
            </TurnAction>
          )}
        </div>
      )}
      <span className="sr-only">{hasAnswer ? "" : "Terra is composing a reply"}</span>
    </motion.article>
  );
}
