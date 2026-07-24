"use client";

import * as React from "react";
import { decompressFromEncodedURIComponent } from "lz-string";
import { formatDistanceToNow } from "date-fns";
import {
  Bot,
  User as UserIcon,
  Share2,
  Sparkles,
  ArrowRight,
  Clock,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ErrorState } from "@/components/states/error-state";
import { LoadingState } from "@/components/states/loading-state";
import type { MessageRole, SharedConversationPayload } from "@/types";

export interface SharedViewProps {
  /** The raw compressed payload (typically `?share=` value). */
  compressed: string;
  /** Optional: called when the user dismisses the shared view. */
  onExit?: () => void;
}

type ParseState =
  | { status: "loading" }
  | { status: "ready"; payload: SharedConversationPayload }
  | { status: "error"; message: string };

function parsePayload(compressed: string): ParseState {
  try {
    const json = decompressFromEncodedURIComponent(compressed);
    if (!json) return { status: "error", message: "Empty payload" };
    const parsed = JSON.parse(json) as SharedConversationPayload;
    if (!parsed || typeof parsed !== "object") {
      return { status: "error", message: "Invalid payload shape" };
    }
    if (parsed.v !== 1) {
      return { status: "error", message: `Unsupported payload version: ${parsed.v}` };
    }
    if (!Array.isArray(parsed.messages)) {
      return { status: "error", message: "Missing messages array" };
    }
    return { status: "ready", payload: parsed };
  } catch (e) {
    return {
      status: "error",
      message: e instanceof Error ? e.message : "Parse failed",
    };
  }
}

/**
 * Read-only view for a shared conversation. Decompresses the URL payload and
 * renders the title + messages with no input, no rating buttons, no edits.
 */
export function SharedView({ compressed, onExit }: SharedViewProps) {
  // Defer parsing to after mount so SSR doesn't try to access window.
  const [state, setState] = React.useState<ParseState>({ status: "loading" });

  React.useEffect(() => {
    const parsed = parsePayload(compressed);
    // Use a microtask to avoid a synchronous state update in the effect.
    Promise.resolve().then(() => setState(parsed));
  }, [compressed]);

  function handleStartOwnChat() {
    // Clear the ?share= param and let the parent app route take over.
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("share");
      window.history.replaceState({}, "", url.toString());
    } catch {
      // Fallback: assign root path.
      window.location.href = window.location.origin;
    }
    onExit?.();
  }

  if (state.status === "loading") {
    return (
      <div className="flex min-h-[100vh] items-center justify-center">
        <LoadingState label="Loading shared conversation…" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex min-h-[100vh] items-center justify-center px-4">
        <Card className="w-full max-w-md">
          <CardContent className="py-8">
            <ErrorState
              title="Invalid or corrupted share link"
              message="We couldn’t decode this conversation. The link may have been truncated or modified."
            />
            <div className="mt-6 flex justify-center">
              <Button type="button" onClick={handleStartOwnChat}>
                Start your own chat
                <ArrowRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { payload } = state;
  const sharedAtRelative = (() => {
    try {
      return formatDistanceToNow(new Date(payload.shared_at), { addSuffix: true });
    } catch {
      return null;
    }
  })();

  return (
    <div className="flex min-h-[100vh] flex-col bg-background">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-3 sm:px-6">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Bot className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="gap-1 text-[11px]">
                <Share2 className="size-3" aria-hidden="true" />
                Shared conversation
              </Badge>
              {sharedAtRelative ? (
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Clock className="size-3" aria-hidden="true" />
                  {sharedAtRelative}
                </span>
              ) : null}
            </div>
            <h1 className="mt-0.5 truncate text-sm font-semibold text-foreground">
              {payload.title || "Untitled conversation"}
            </h1>
          </div>
        </div>
      </header>

      {/* Messages */}
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:px-6">
        {payload.messages.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            This conversation has no messages.
          </div>
        ) : (
          <ol className="space-y-4">
            {payload.messages.map((m, i) => (
              <SharedMessage
                key={`${i}-${m.created_at}`}
                role={m.role}
                content={m.content}
                modelName={m.model_name}
                createdAt={m.created_at}
              />
            ))}
          </ol>
        )}
      </main>

      <Separator />

      {/* Footer */}
      <footer className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
        <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:justify-between sm:text-left">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Sparkles className="size-3.5" aria-hidden="true" />
            Powered by Agent Chat (backendless)
          </div>
          <Button type="button" size="sm" onClick={handleStartOwnChat}>
            Start your own chat
            <ArrowRight className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </footer>
    </div>
  );
}

interface SharedMessageProps {
  role: MessageRole;
  content: string;
  modelName?: string | null;
  createdAt: string;
}

function SharedMessage({ role, content, modelName, createdAt }: SharedMessageProps) {
  const isUser = role === "user";
  const isSystem = role === "system";
  const isTool = role === "tool";

  const label = isUser
    ? "You"
    : isSystem
      ? "System"
      : isTool
        ? "Tool"
        : "Assistant";

  const Icon = isUser ? UserIcon : Bot;

  return (
    <li
      className={cn(
        "flex gap-3",
        isUser && "flex-row-reverse text-right",
      )}
    >
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md border",
          isUser
            ? "bg-primary text-primary-foreground border-transparent"
            : "bg-muted text-muted-foreground",
        )}
        aria-hidden="true"
      >
        <Icon className="size-4" />
      </div>
      <div
        className={cn(
          "min-w-0 flex-1 rounded-lg border px-4 py-3 text-sm leading-relaxed",
          isUser
            ? "bg-primary/5"
            : isSystem
              ? "bg-muted/50 italic"
              : "bg-card",
        )}
      >
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs font-semibold text-foreground">{label}</span>
          {modelName ? (
            <span className="truncate text-[10px] text-muted-foreground">
              {modelName}
            </span>
          ) : null}
          <span className="ml-auto text-[10px] text-muted-foreground">
            {(() => {
              try {
                return formatDistanceToNow(new Date(createdAt), {
                  addSuffix: true,
                });
              } catch {
                return null;
              }
            })()}
          </span>
        </div>
        <div className="whitespace-pre-wrap break-words text-foreground">
          {content}
        </div>
      </div>
    </li>
  );
}

export default SharedView;
