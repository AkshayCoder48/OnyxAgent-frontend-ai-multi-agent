"use client";
import * as React from "react";
import type { ToolCall } from "@/types";
import { CopyButton } from "../copy-button";
import { LinkPreview, extractUrls } from "@/components/assistant-ui/elements";

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

  // LINK PREVIEWS (assistant-ui "Link preview" element): a URL the tool
  // returned (or the URL a fetch tool requested — args.url) unfurls into a
  // compact card with enough context to decide whether to open it.
  const previewUrls = React.useMemo(() => {
    if (toolCall.status !== "completed") return [];
    const urls: string[] = [];
    const argsUrl = toolCall.args?.url;
    if (typeof argsUrl === "string" && /^https?:\/\//i.test(argsUrl)) {
      urls.push(argsUrl);
    }
    for (const u of extractUrls(resultText, 3)) {
      if (!urls.includes(u)) urls.push(u);
    }
    return urls.slice(0, 3);
  }, [toolCall.status, toolCall.args, resultText]);

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
      {previewUrls.length > 0 && (
        <div className="flex flex-col gap-2">
          {previewUrls.map((url) => (
            <LinkPreview key={url} href={url} layout="compact" />
          ))}
        </div>
      )}
    </div>
  );
}
