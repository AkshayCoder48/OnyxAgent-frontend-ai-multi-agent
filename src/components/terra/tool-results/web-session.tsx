"use client";

import { Globe, ShieldCheck, ShieldX } from "lucide-react";
import type { ToolResultData } from "@/components/terra/types";

/**
 * start_web_session result — headless-browser session facts with an optional
 * real screenshot captured by the browser.
 */
export function WebSessionResult({ data }: { data: ToolResultData }) {
  const title = typeof data.payload.title === "string" ? data.payload.title : "";
  const url = typeof data.payload.url === "string" ? data.payload.url : "";
  const status = typeof data.payload.status === "number" ? data.payload.status : null;
  const excerpt = typeof data.payload.excerpt === "string" ? data.payload.excerpt : "";
  const screenshotUrl =
    typeof data.payload.screenshotUrl === "string" ? data.payload.screenshotUrl : null;
  const healthy = status !== null && status < 400;

  return (
    <div className="rounded-lg border border-hairline/60 bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${
            healthy ? "bg-terra-soft text-terra-deep" : "bg-paper text-ink-muted"
          }`}
        >
          {healthy ? <ShieldCheck className="h-3 w-3" aria-hidden /> : <ShieldX className="h-3 w-3" aria-hidden />}
          {status !== null ? `HTTP ${status}` : "no response"}
        </span>
        {title && <span className="truncate text-[13px] font-medium text-ink">“{title}”</span>}
      </div>
      {url && (
        <p className="mt-2 flex items-center gap-1.5 truncate font-mono text-[11px] text-ink-muted">
          <Globe className="h-3 w-3 shrink-0" aria-hidden />
          {url}
        </p>
      )}
      {excerpt && (
        <p className="mt-2 line-clamp-3 text-[12px] leading-relaxed text-ink-muted">{excerpt}</p>
      )}
      {screenshotUrl && (
        <a href={screenshotUrl} target="_blank" rel="noopener noreferrer" className="mt-2.5 block overflow-hidden rounded-md border border-hairline/60">
          <img
            src={screenshotUrl}
            alt={`Headless browser screenshot of ${title || url}`}
            className="block w-full"
            loading="lazy"
          />
        </a>
      )}
    </div>
  );
}
