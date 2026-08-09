"use client";

import * as React from "react";
import { Globe, FileText } from "lucide-react";
import { GenUIComponentProps, str, arr, obj } from "./helpers";

interface SourceEntry {
  url?: string;
  domain?: string;
  title?: string;
  snippet?: string;
  favicon?: string;
  type?: string;
}

/**
 * `sources_panel` — list of sources with favicon / domain / title / snippet.
 *
 * Props:
 *   - title (string)
 *   - sources (Array<{ url, domain, title, snippet, favicon, type }>)
 */
export function SourcesPanel({ props, streaming }: GenUIComponentProps) {
  const title = str(props.title, "Sources");
  const sources = arr<Record<string, unknown>>(props.sources).map((s) => {
    const o = obj(s);
    return {
      url: str(o.url),
      domain: str(o.domain),
      title: str(o.title),
      snippet: str(o.snippet),
      favicon: str(o.favicon),
      type: str(o.type, "web"),
    } as SourceEntry;
  });

  if (streaming && sources.length === 0) {
    return (
      <div className="bg-card rounded-xl border p-4">
        <div className="shimmer mb-3 h-4 w-24 rounded" />
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="shimmer h-12 w-full rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (sources.length === 0) return null;

  return (
    <div className="bg-card rounded-xl border p-3">
      <div className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
        <Globe className="h-3.5 w-3.5" />
        {title}
      </div>
      <ul className="max-h-96 space-y-2 overflow-y-auto pr-1 scrollbar-thin">
        {sources.map((s, i) => {
          const domain = s.domain || (s.url ? safeHostname(s.url) : "");
          const isRag = s.type === "rag";
          const favicon = s.favicon || (domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32` : "");
          return (
            <li key={i}>
              <a
                href={s.url || "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:bg-muted/60 flex items-start gap-2.5 rounded-lg p-2 transition-colors"
              >
                <span className="bg-muted mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded">
                  {isRag ? (
                    <FileText className="text-muted-foreground h-3 w-3" />
                  ) : favicon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={favicon} alt="" className="h-4 w-4" />
                  ) : (
                    <Globe className="text-muted-foreground h-3 w-3" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-foreground block truncate text-sm font-medium">
                    {s.title || domain || s.url}
                  </span>
                  {domain && (
                    <span className="text-muted-foreground block truncate text-xs">
                      {domain}
                    </span>
                  )}
                  {s.snippet && (
                    <span className="text-muted-foreground mt-0.5 line-clamp-2 block text-xs leading-relaxed">
                      {s.snippet}
                    </span>
                  )}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export default SourcesPanel;
