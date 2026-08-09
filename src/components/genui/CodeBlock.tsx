"use client";

import * as React from "react";
import { CopyButton } from "@/components/chat/copy-button";
import { GenUIComponentProps, str, bool } from "./helpers";

/**
 * `code_block` — syntax-highlighted code with copy button.
 *
 * Props:
 *   - code (string, required)
 *   - language (string) — shown as a label
 *   - filename (string) — shown as a label instead of language if present
 *   - showLineNumbers (boolean, default false)
 *
 * NOTE: We don't pull in a full highlighter (Prism/highlight.js) here to keep
 * the bundle small — code is rendered in a monospace block with subtle
 * styling. If a richer experience is needed later, swap `<pre>` for a lazy
 * loaded highlighter component.
 */
export function CodeBlock({ props, streaming }: GenUIComponentProps) {
  const code = str(props.code);
  const language = str(props.language);
  const filename = str(props.filename);
  const showLineNumbers = bool(props.showLineNumbers, false);

  if (streaming && !code) {
    return (
      <div className="bg-muted my-2 overflow-hidden rounded-xl border p-4">
        <div className="shimmer mb-3 h-3 w-20 rounded" />
        <div className="space-y-1.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="shimmer h-3 rounded" style={{ width: `${80 - i * 10}%` }} />
          ))}
        </div>
      </div>
    );
  }

  const label = filename || language || "code";
  const lines = code.split("\n");

  return (
    <div className="bg-muted group my-2 overflow-hidden rounded-xl border">
      <div className="border-foreground/8 text-foreground/60 flex items-center justify-between border-b px-3 py-1.5">
        <span className="font-mono text-[10px] tracking-wider uppercase">{label}</span>
        {code && <CopyButton text={code} className="opacity-100" />}
      </div>
      <pre className="scrollbar-thin max-w-full overflow-x-auto p-3.5 text-[12.5px] leading-relaxed">
        <code className="font-mono">
          {showLineNumbers ? (
            lines.map((line, i) => (
              <div key={i} className="flex">
                <span className="text-muted-foreground mr-3 inline-block w-8 select-none text-right">
                  {i + 1}
                </span>
                <span className="text-foreground flex-1 whitespace-pre">{line || " "}</span>
              </div>
            ))
          ) : (
            <span className="text-foreground whitespace-pre">{code}</span>
          )}
        </code>
      </pre>
    </div>
  );
}

export default CodeBlock;
