"use client";
import type { ToolCall } from "@/types";
import { CopyButton } from "../copy-button";

/** Pretty-print tool args. Handles three shapes:
 *  - object → JSON.stringify with indent
 *  - JSON-string (e.g. raw streaming payload) → parse then pretty-print
 *  - plain non-JSON string → return as-is
 */
function formatArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return args;
    }
  }
  return JSON.stringify(args, null, 2);
}

function isEmptyArgs(args: unknown): boolean {
  if (args === null || args === undefined) return true;
  if (typeof args === "string") return args.trim() === "" || args.trim() === "{}";
  if (typeof args === "object") return Object.keys(args).length === 0;
  return false;
}

/** Raw view: arguments + the exact tool output, monospace, unparsed. */
export function RawToolView({ toolCall, resultText }: { toolCall: ToolCall; resultText: string }) {
  return (
    <div className="space-y-3">
      {isEmptyArgs(toolCall.args) ? (
        <p className="text-muted-foreground text-xs italic">No arguments</p>
      ) : (
        <div className="group relative">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-foreground/55 font-mono text-[10px] tracking-wider uppercase">
              Arguments
            </p>
            <CopyButton
              text={formatArgs(toolCall.args)}
              className="opacity-0 group-hover:opacity-100"
            />
          </div>
          <pre className="border-foreground/10 bg-background/60 scrollbar-thin overflow-x-auto rounded-lg border p-2.5 font-mono text-[11px] leading-relaxed">
            {formatArgs(toolCall.args)}
          </pre>
        </div>
      )}
      {toolCall.result !== undefined && resultText !== "" && (
        <div className="group relative">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-foreground/55 font-mono text-[10px] tracking-wider uppercase">
              Result
            </p>
            <CopyButton text={resultText} className="opacity-0 group-hover:opacity-100" />
          </div>
          <pre className="border-foreground/10 bg-background/60 max-h-72 scrollbar-thin overflow-x-auto overflow-y-auto rounded-lg border p-2.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap">
            {resultText}
          </pre>
        </div>
      )}
    </div>
  );
}

/** Simple-mode result (tool-display-store "simple"): plain language only.
 *  Plain-text output renders as readable prose; JSON output carries no
 *  prose, so it collapses to a friendly "Done." line. Arguments are never
 *  shown. Errors render as one reassuring sentence — the agent narrates the
 *  retry, not the stack trace. */
export function SimpleToolResult({
  toolCall,
  resultText,
}: {
  toolCall: ToolCall;
  resultText: string;
}) {
  if (toolCall.status === "error") {
    return (
      <p className="text-destructive/90 py-2 text-[13px] leading-relaxed">
        This step didn&apos;t work — the agent will try another way.
      </p>
    );
  }
  if (toolCall.status !== "completed" || !resultText) {
    return (
      <p className="text-muted-foreground py-2 text-[13px] italic">Working…</p>
    );
  }
  // JSON results (objects/arrays) have no readable prose → friendly done.
  let isJson = false;
  try {
    const parsed = JSON.parse(resultText);
    isJson = parsed !== null && typeof parsed === "object";
  } catch {
    /* plain text */
  }
  if (isJson) {
    return <p className="text-foreground/70 py-2 text-[13px]">Done.</p>;
  }
  // Plain-text output — readable prose, capped so huge dumps stay sane.
  const clipped =
    resultText.length > 600 ? `${resultText.slice(0, 600).trimEnd()}…` : resultText;
  return (
    <p className="text-foreground/80 scrollbar-thin max-h-40 overflow-y-auto py-2 text-[13px] leading-relaxed break-words whitespace-pre-wrap">
      {clipped}
    </p>
  );
}

/** Default formatted view for any tool without a specialized renderer.
 *  Pretty-prints JSON output, otherwise shows readable wrapped text — so a
 *  newly added backend tool renders sensibly with no frontend changes. */
export function GenericToolResult({
  toolCall,
  resultText,
}: {
  toolCall: ToolCall;
  resultText: string;
}) {
  let prettyJson: string | null = null;
  try {
    const parsed = JSON.parse(resultText);
    if (parsed && typeof parsed === "object") {
      prettyJson = JSON.stringify(parsed, null, 2);
    }
  } catch {
    /* not JSON — render as text */
  }

  if (toolCall.status !== "completed" && !resultText) {
    return (
      <p className="text-muted-foreground py-2 text-xs italic">
        {toolCall.status === "error" ? "Tool failed." : "Running…"}
      </p>
    );
  }

  return (
    <div className="space-y-3 py-1">
      {!isEmptyArgs(toolCall.args) && (
        <div className="group relative">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-foreground/55 font-mono text-[10px] tracking-wider uppercase">
              Arguments
            </p>
            <CopyButton
              text={formatArgs(toolCall.args)}
              className="opacity-0 group-hover:opacity-100"
            />
          </div>
          <pre className="border-foreground/10 bg-background/60 scrollbar-thin overflow-x-auto rounded-lg border p-2.5 font-mono text-[11px] leading-relaxed">
            {formatArgs(toolCall.args)}
          </pre>
        </div>
      )}
      {resultText &&
        (prettyJson ? (
          <pre className="border-foreground/10 bg-background/60 max-h-80 scrollbar-thin overflow-x-auto overflow-y-auto rounded-lg border p-2.5 font-mono text-[11px] leading-relaxed">
            {prettyJson}
          </pre>
        ) : (
          <p className="text-foreground/80 max-h-80 overflow-y-auto text-[13px] leading-relaxed break-words whitespace-pre-wrap">
            {resultText}
          </p>
        ))}
    </div>
  );
}
