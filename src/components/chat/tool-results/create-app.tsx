"use client";

import { Boxes, CheckCircle2, FileCode2, TerminalSquare } from "lucide-react";

/** OnyxCode `create_app` result payload (see src/lib/tools/code_app.ts). */
export interface CreateAppPayload {
  kind: "create_app";
  ok: boolean;
  name: string;
  framework: string;
  frameworkLabel: string;
  path: string;
  files: string[];
  fileCount: number;
  hasServer: boolean;
  instructions: string;
  error?: string;
}

/** Parse a structured `create_app` tool result, or null if it isn't one. */
export function parseCreateAppResult(result: unknown): CreateAppPayload | null {
  try {
    const p =
      typeof result === "string" ? JSON.parse(result) : result;
    if (p && typeof p === "object" && (p as { kind?: string }).kind === "create_app") {
      return p as CreateAppPayload;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * Rich card for the OnyxCode `create_app` tool (extension PRD §3.7):
 * framework chip, scaffolded file list, project path, and the next
 * suggested action (start the live preview).
 */
export function CreateAppResult({ data }: { data: CreateAppPayload }) {
  return (
    <div className="space-y-2.5 py-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="bg-primary/10 text-primary inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold">
          <Boxes className="h-3 w-3" aria-hidden />
          {data.frameworkLabel}
        </span>
        <span className="text-foreground text-sm font-semibold">{data.name}</span>
        <span className="text-muted-foreground font-mono text-[10px]">{data.path}</span>
      </div>

      {data.ok ? (
        <>
          <div className="border-foreground/10 divide-foreground/8 divide-y overflow-hidden rounded-xl border">
            <div className="text-muted-foreground flex items-center gap-2 px-3 py-1.5 font-mono text-[10px] tracking-wider uppercase">
              <FileCode2 className="h-3 w-3" aria-hidden />
              {data.fileCount} file{data.fileCount === 1 ? "" : "s"} scaffolded
            </div>
            <div className="max-h-40 overflow-y-auto scrollbar-thin">
              {data.files.slice(0, 12).map((f) => (
                <div key={f} className="text-foreground/70 hover:bg-foreground/[0.03] flex items-center gap-2 px-3 py-1 font-mono text-[11px]">
                  <CheckCircle2 className="text-primary h-3 w-3 shrink-0" aria-hidden />
                  {f}
                </div>
              ))}
              {data.files.length > 12 && (
                <div className="text-muted-foreground px-3 py-1 font-mono text-[11px]">
                  + {data.files.length - 12} more…
                </div>
              )}
            </div>
          </div>
          {data.hasServer ? (
            <p className="text-muted-foreground flex items-start gap-1.5 text-[11px] leading-relaxed">
              <TerminalSquare className="text-primary mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              {data.instructions}
            </p>
          ) : (
            <p className="text-muted-foreground text-[11px] leading-relaxed">{data.instructions}</p>
          )}
        </>
      ) : (
        <p className="text-destructive text-xs">{data.error ?? "Scaffolding failed."}</p>
      )}
    </div>
  );
}
