"use client";

import { Image as ImageIcon } from "lucide-react";
import type { ToolResultData } from "@/components/terra/types";

/**
 * inspect_image result — the actual image the vision model analyzed, so the
 * user sees exactly what the AI looked at (never "I can see it" without the
 * picture being on screen).
 */
export function ImageResult({ data }: { data: ToolResultData }) {
  const src = typeof data.payload.src === "string" ? data.payload.src : "";
  const path = typeof data.payload.path === "string" ? data.payload.path : "";
  const mime = typeof data.payload.mime === "string" ? data.payload.mime : "";
  const bytes = typeof data.payload.bytes === "number" ? data.payload.bytes : 0;
  const kb = bytes > 0 ? `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB` : "";

  return (
    <div className="flex items-start gap-3">
      {src ? (
        <img
          src={src}
          alt={`Image analyzed by the agent: ${path}`}
          loading="lazy"
          decoding="async"
          className="h-20 w-20 shrink-0 rounded-lg border border-hairline/60 bg-background object-cover"
        />
      ) : (
        <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg border border-hairline/60 bg-background">
          <ImageIcon className="h-6 w-6 text-ink-muted" aria-hidden />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 font-mono text-[11px] text-ink">
          <ImageIcon className="h-3.5 w-3.5 shrink-0 text-terra" aria-hidden />
          <span className="truncate">{path}</span>
        </p>
        <p className="mt-1 text-[11px] text-ink-muted">
          {[mime, kb].filter(Boolean).join(" · ") || "image"}
        </p>
      </div>
    </div>
  );
}
