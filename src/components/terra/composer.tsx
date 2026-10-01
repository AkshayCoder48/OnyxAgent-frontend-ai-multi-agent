"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Paperclip, Square } from "lucide-react";
import { toast } from "sonner";
import { ModelChip } from "./model-chip";
import { useTerra } from "./store";

export function Composer() {
  const [value, setValue] = useState("");
  const appMode = useTerra((s) => s.appMode);
  const send = useTerra((s) => s.send);
  const sending = useTerra((s) => s.sending);
  const stop = useTerra((s) => s.stop);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea between 44px and 200px.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const canSend = value.trim().length > 0 && !sending;

  const submit = () => {
    const text = value.trim();
    if (!text || sending) return;
    setValue("");
    void send(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="terra-glass sticky bottom-0 z-10 px-4 pb-3 pt-2">
      <div className="mx-auto w-full max-w-[760px]">
        <div className="rounded-2xl border border-hairline bg-background p-2 shadow-[0_2px_12px_rgba(26,26,26,0.05)]">
          <label htmlFor="terra-composer" className="sr-only">
            Reply to Terra
          </label>
          <textarea
            id="terra-composer"
            ref={textareaRef}
            rows={1}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={appMode === "code" ? "Reply to OnyxCode…" : "Reply to Terra…"}
            aria-label={appMode === "code" ? "Message to OnyxCode" : "Message to Terra"}
            className="terra-scroll block max-h-[200px] min-h-[44px] w-full resize-none bg-transparent px-3 py-2.5 caret-terra text-[15px] leading-relaxed text-ink placeholder:text-ink-muted/80 focus:outline-none"
          />
          <div className="flex items-center gap-1.5 pt-1">
            <button
              type="button"
              onClick={() => toast("Attachments are on the roadmap.")}
              aria-label="Attach a file"
              title="Attach"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-terra-soft hover:text-terra"
            >
              <Paperclip className="h-[18px] w-[18px]" aria-hidden />
            </button>
            <ModelChip />
            <span className="ml-auto hidden pr-1 text-[11px] whitespace-nowrap text-ink-muted sm:block" aria-hidden>
              {sending ? "streaming…" : "⏎ to send"}
            </span>
            {sending ? (
              <button
                type="button"
                onClick={stop}
                aria-label="Stop generating"
                title="Stop"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-terra-soft-border bg-terra-soft text-terra-deep transition-colors hover:bg-terra-soft/70"
              >
                <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                aria-label="Send message"
                title="Send"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-terra text-white shadow-[0_1px_3px_rgba(166,63,26,0.35)] transition-colors hover:bg-terra-deep disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ArrowUp className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>
        </div>
        <p className="pt-2 text-center text-[11px] text-ink-muted">
          Terra can make mistakes. Double-check important info.
        </p>
      </div>
    </div>
  );
}
