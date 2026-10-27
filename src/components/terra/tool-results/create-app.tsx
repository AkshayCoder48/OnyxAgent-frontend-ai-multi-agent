"use client";

import { useState } from "react";
import { FileCode2, Play, Rocket } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTerra } from "@/components/terra/store";
import type { ToolResultData } from "@/components/terra/types";

/**
 * create_app result — scaffold summary (framework, file tree) with a
 * one-click "Start preview" that takes the workspace live.
 */
export function CreateAppResult({ data, workspaceId }: { data: ToolResultData; workspaceId?: string }) {
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const setCodeTab = useTerra((s) => s.setCodeTab);

  const framework = typeof data.payload.framework === "string" ? data.payload.framework : "app";
  const name = typeof data.payload.name === "string" ? data.payload.name : "project";
  const description =
    typeof data.payload.description === "string" ? data.payload.description : "";
  const files = Array.isArray(data.payload.files)
    ? (data.payload.files as unknown[]).filter((f): f is string => typeof f === "string")
    : [];
  const fileCount = typeof data.payload.fileCount === "number" ? data.payload.fileCount : files.length;

  const startPreview = async () => {
    if (!workspaceId || starting) return;
    setStarting(true);
    try {
      const response = await fetch("/api/code/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, action: "start", name }),
      });
      const result = (await response.json()) as { ok?: boolean; url?: string; error?: string };
      if (!response.ok || !result.ok) {
        toast.error(result.error ?? "Could not start the preview.");
        return;
      }
      toast.success("Preview is live — opened the Preview tab.", {
        action: { label: "Open", onClick: () => setCodeTab("preview") },
      });
      setCodeTab("preview");
    } catch {
      toast.error("Could not reach the preview service.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="rounded-lg border border-hairline/60 bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-terra-soft px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-terra-deep">
          <Rocket className="h-3 w-3" aria-hidden />
          {framework}
        </span>
        <span className="font-mono text-[13px] font-medium text-ink">{name}</span>
        <span className="text-[11px] text-ink-muted">
          {fileCount} file{fileCount === 1 ? "" : "s"} scaffolded
        </span>
        {workspaceId && (
          <button
            type="button"
            onClick={() => void startPreview()}
            disabled={starting}
            className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-lg bg-terra px-2.5 text-[11px] font-semibold text-white transition-colors hover:bg-terra-deep disabled:opacity-50"
          >
            <Play className="h-3 w-3" aria-hidden />
            {starting ? "Starting…" : "Start preview"}
          </button>
        )}
      </div>
      {description && <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{description}</p>}
      {files.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted transition-colors hover:text-terra-deep"
          >
            <FileCode2 className="h-3 w-3" aria-hidden />
            {open ? "Hide files" : `Show ${files.length} files`}
          </button>
          <ul
            className={cn(
              "terra-scroll mt-2 grid gap-x-4 gap-y-1 overflow-y-auto rounded-md border border-hairline/60 bg-paper/60 p-2 font-mono text-[11px] text-ink-soft sm:grid-cols-2",
              open ? "max-h-48" : "hidden",
            )}
          >
            {files.map((file) => (
              <li key={file} className="truncate">
                {file}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
