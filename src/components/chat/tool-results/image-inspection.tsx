"use client";

import { Eye } from "lucide-react";

/**
 * inspect_image result payload (see src/lib/tools/inspect_image.ts) —
 * Runtime PRD §54 + §111: the user SEES which image the AI is analyzing
 * (thumbnail + mono source path) together with the vision model's
 * description beneath it.
 */

export interface ImageInspectionPayload {
  kind: "image_inspection";
  source: string;
  /** The (possibly downscaled) data URL that was analyzed. */
  url: string;
  alt?: string;
  description: string;
}

export function parseImageInspectionResult(result: unknown): ImageInspectionPayload | null {
  try {
    const p = typeof result === "string" ? JSON.parse(result) : result;
    if (
      p &&
      typeof p === "object" &&
      (p as { kind?: string }).kind === "image_inspection" &&
      typeof (p as { url?: unknown }).url === "string"
    ) {
      return p as ImageInspectionPayload;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * Inline card for `inspect_image`: lazy-loaded thumbnail, the mono source
 * path, and the description paragraph. Parses the tool result internally
 * and renders nothing for unparsable results (e.g. honest error envelopes
 * fall through to the generic card).
 */
export function ImageInspectionResult({ result }: { result: unknown }) {
  const data = parseImageInspectionResult(result);
  if (!data) return null;

  return (
    <div className="space-y-2.5 py-1">
      <div className="flex flex-wrap items-center gap-2">
        <Eye className="text-primary h-4 w-4 shrink-0" aria-hidden />
        <span className="text-foreground text-sm font-semibold">Image inspection</span>
        <span className="text-muted-foreground truncate font-mono text-[10px]">
          {data.source}
        </span>
      </div>

      <figure className="overflow-hidden rounded-xl border border-border">
        {/* data URL resolved from the workspace — next/image adds nothing here */}
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/no-noninteractive-element-interactions -- raw <img> for workspace-sourced data URLs; onError is a load-failure handler, not an interaction */}
        <img
          src={data.url}
          alt={data.alt || data.source || "Inspected image"}
          className="max-w-full"
          style={{ maxHeight: "420px" }}
          loading="lazy"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
        {data.source ? (
          <figcaption className="text-muted-foreground truncate px-2.5 py-1.5 font-mono text-[10px]">
            {data.source}
          </figcaption>
        ) : null}
      </figure>

      {data.description ? (
        <div className="border-foreground/10 bg-foreground/[0.02] scrollbar-thin max-h-64 overflow-y-auto rounded-xl border p-2.5">
          <p className="text-foreground/80 whitespace-pre-wrap text-[11px] leading-relaxed">
            {data.description}
          </p>
        </div>
      ) : null}
    </div>
  );
}
