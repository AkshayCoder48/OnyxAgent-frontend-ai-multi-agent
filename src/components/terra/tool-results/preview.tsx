"use client";

import { Check, Copy, ExternalLink, MonitorPlay } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { CODE_TAB_PATHS } from "@/components/code/code-paths";
import { useTerra } from "@/components/terra/store";
import type { ToolResultData } from "@/components/terra/types";

/**
 * start_preview result — the live preview URL with quick actions.
 */
export function PreviewResult({ data }: { data: ToolResultData }) {
  const [copied, setCopied] = useState(false);
  const router = useRouter();
  const setCodeTab = useTerra((s) => s.setCodeTab);

  const url = typeof data.payload.url === "string" ? data.payload.url : "";
  const name = typeof data.payload.name === "string" ? data.payload.name : "Preview";
  const status = typeof data.payload.status === "string" ? data.payload.status : "running";
  const absolute = url ? `${window.location.origin}${url}` : "";

  const copyUrl = async () => {
    if (!absolute) return;
    try {
      await navigator.clipboard.writeText(absolute);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable; ignore.
    }
  };

  return (
    <div className="rounded-lg border border-hairline/60 bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide",
            status === "running" ? "bg-terra-soft text-terra-deep" : "bg-paper text-ink-muted",
          )}
        >
          <MonitorPlay className="h-3 w-3" aria-hidden />
          {status}
        </span>
        <span className="text-[13px] font-medium text-ink">{name}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setCodeTab("preview");
              router.push(CODE_TAB_PATHS.preview);
            }}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-terra-soft-border bg-terra-soft px-2.5 text-[11px] font-semibold text-terra-deep transition-colors hover:bg-terra-soft/70"
          >
            <ExternalLink className="h-3 w-3" aria-hidden />
            Open in Preview tab
          </button>
          <button
            type="button"
            onClick={() => void copyUrl()}
            aria-label="Copy preview URL"
            title="Copy URL"
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-hairline bg-background text-ink-muted transition-colors hover:bg-terra-soft hover:text-terra-deep"
          >
            {copied ? <Check className="h-3 w-3 text-terra" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
          </button>
        </div>
      </div>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 block truncate rounded-md border border-hairline/60 bg-paper/60 px-2.5 py-1.5 font-mono text-[11px] text-terra-deep underline decoration-terra/30 underline-offset-2 hover:decoration-terra"
        >
          {absolute}
        </a>
      )}
    </div>
  );
}
