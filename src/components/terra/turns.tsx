"use client";

import { useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Check, Copy, Feather, RefreshCw, ThumbsDown, ThumbsUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./code-block";
import { Markdown } from "./markdown";
import { ToolCard } from "./tool-card";
import { useTerra } from "./store";
import type { Message } from "./types";

function AssistantHeader() {
  return (
    <header className="mb-2.5 flex items-center gap-2">
      <span
        className="flex h-5 w-5 items-center justify-center rounded-full border border-terra-soft-border bg-terra-soft"
        aria-hidden
      >
        <Feather className="h-3 w-3 text-terra" />
      </span>
      <span className="font-serif text-[15px] font-medium italic text-ink-soft">Terra</span>
    </header>
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

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: "easeOut" }}
      className="group"
    >
      <AssistantHeader />

      {message.isError ? (
        <p className="text-[14px] italic leading-relaxed text-terra-deep">
          {message.parts?.[0]?.type === "text" ? message.parts[0].text : message.text}
        </p>
      ) : (
        <div className="space-y-4">
          {message.parts?.map((part, index) => {
            if (part.type === "text") return <Markdown key={index}>{part.text}</Markdown>;
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
      )}

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
    </motion.article>
  );
}

export function TypingIndicator() {
  return (
    <div className="flex flex-col">
      <AssistantHeader />
      <div className="flex items-center gap-1.5 py-1.5" role="status" aria-label="Terra is typing">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="terra-dot h-1.5 w-1.5 rounded-full bg-terra"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </div>
    </div>
  );
}
