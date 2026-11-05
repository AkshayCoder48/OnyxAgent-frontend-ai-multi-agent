"use client";

import * as React from "react";
import { Code2, ExternalLink, MonitorPlay } from "lucide-react";

import { CustomHTML } from "@/components/genui/CustomHTML";
import { CollapsePanel } from "@/components/assistant-ui/elements/surfaces";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * preview_html result card — renders the tool's payload LIVE in the chat
 * through the GenUI custom_html machinery (sandboxed iframe, allow-scripts
 * only, theme-synced). Plus an "Open in new tab" escape hatch (blob URL —
 * same sandbox guarantee is dropped there: it is a plain browser tab) and
 * a source-code disclosure.
 *
 * Payload (src/lib/tools/preview_html.ts): { html, title, height, source,
 * error? } — `source` is the workspace path or "inline".
 */

export interface PreviewHtmlPayload {
  html: string;
  title: string;
  height: number;
  source: string;
  truncated?: boolean;
  error?: string;
}

export function parsePreviewHtmlResult(result: unknown): PreviewHtmlPayload | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.html !== "string" && typeof r.error !== "string") return null;
  return {
    html: typeof r.html === "string" ? r.html : "",
    title: typeof r.title === "string" ? r.title : "Preview",
    height: typeof r.height === "number" ? r.height : 420,
    source: typeof r.source === "string" ? r.source : "",
    truncated: r.truncated === true,
    error: typeof r.error === "string" ? r.error : undefined,
  };
}

export function PreviewHtmlResult({ data }: { data: PreviewHtmlPayload }) {
  const [codeOpen, setCodeOpen] = React.useState(false);

  if (data.error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        <span className="font-medium">Preview failed:</span> {data.error}
      </div>
    );
  }

  const openInTab = () => {
    try {
      const blob = new Blob([data.html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      // Revoke later — the tab needs time to load the blob.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      // best-effort escape hatch
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <MonitorPlay className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
          <span className="truncate">
            {data.title}
            {data.source && data.source !== "inline" ? (
              <span className="font-mono text-muted-foreground/70"> · {data.source}</span>
            ) : null}
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-expanded={codeOpen}
            onClick={() => setCodeOpen((v) => !v)}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <Code2 className="h-3 w-3" aria-hidden />
            {codeOpen ? "Hide source" : "Source"}
          </button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={openInTab}>
            <ExternalLink className="h-3 w-3" aria-hidden />
            Open
          </Button>
        </div>
      </div>
      <CollapsePanel open={codeOpen}>
        <pre
          className={cn(
            "scrollbar-thin max-h-56 overflow-auto rounded-lg border border-border/60 bg-background/70 p-2.5 font-mono text-[11px] leading-relaxed",
          )}
        >
          {data.html.slice(0, 20_000)}
          {data.html.length > 20_000 ? "\n… (truncated for display)" : ""}
        </pre>
      </CollapsePanel>
      <div className="overflow-hidden rounded-lg border border-border/70">
        <CustomHTML
          props={{
            html: data.html,
            title: "",
            height: data.height,
          }}
          streaming={false}
        />
      </div>
    </div>
  );
}
