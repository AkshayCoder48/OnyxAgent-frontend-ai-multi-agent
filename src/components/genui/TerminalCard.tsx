"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { GenUIComponentProps, str, arr, obj } from "./helpers";

interface TerminalLine {
  text?: string;
  type?: "input" | "output" | "error";
}

/**
 * `terminal_card` — terminal output display.
 *
 * Props:
 *   - title (string, default "Terminal")
 *   - prompt (string, default "$") — prefix for input lines
 *   - lines (Array<{ text, type }>) — terminal lines
 */
export function TerminalCard({ props, streaming }: GenUIComponentProps) {
  const title = str(props.title, "Terminal");
  const prompt = str(props.prompt, "$");
  const linesRaw = arr<Record<string, unknown>>(props.lines);
  const lines: TerminalLine[] = linesRaw.map((l) => {
    const o = obj(l);
    return {
      text: str(o.text),
      type: (str(o.type, "output") as TerminalLine["type"]) || "output",
    };
  });

  if (streaming && lines.length === 0) {
    return (
      <div className="bg-zinc-950 rounded-xl border border-zinc-800 p-3">
        <div className="space-y-1.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-3 w-full animate-pulse rounded bg-zinc-800" style={{ width: `${80 - i * 10}%` }} />
          ))}
        </div>
      </div>
    );
  }

  if (lines.length === 0) return null;

  return (
    <div className="bg-zinc-950 overflow-hidden rounded-xl border border-zinc-800">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <div className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-500/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-green-500/80" />
        </div>
        <span className="text-zinc-400 ml-2 font-mono text-[10px] tracking-wider uppercase">
          {title}
        </span>
      </div>
      <div className="scrollbar-thin max-h-80 overflow-y-auto p-3 font-mono text-[12.5px] leading-relaxed">
        {lines.map((l, i) => (
          <div
            key={i}
            className={cn(
              "whitespace-pre-wrap break-words",
              l.type === "error" && "text-red-400",
              l.type === "input" && "text-zinc-100",
              (!l.type || l.type === "output") && "text-zinc-300",
            )}
          >
            {l.type === "input" && (
              <span className="text-green-400 mr-1.5 select-none">{prompt}</span>
            )}
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

export default TerminalCard;
