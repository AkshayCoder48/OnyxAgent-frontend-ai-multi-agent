"use client";

import { useMemo } from "react";
import { Camera, Download, ExternalLink, Globe } from "lucide-react";
import type { ToolCall } from "@/types";
import { cn } from "@/lib/utils";

/**
 * use_browser results — the ONE browser tool's compact card (🌐 Browser
 * identity, never a Composio integration): the action line, the page
 * URL/title, the tab count, and the screenshot inline when one was
 * captured. The narration sentence itself ("Opened example.com",
 * "Clicked “Sign in”") is handled by friendlyStep — this is the payload
 * beneath it.
 */

/** use_browser result payload (see src/lib/e2b/browser-driver.ts). */
export interface BrowserPayload {
  kind: "browser";
  success?: boolean;
  action?: string;
  sessionId?: string;
  runtime?: string;
  url?: string;
  title?: string | null;
  tabs?: Array<{ tabId: string; index: number; url: string; title: string; active: boolean }>;
  activeTab?: number;
  tabCount?: number;
  status?: number | null;
  text?: string;
  elements?: Array<{ ref: string; tag: string; role?: string | null; text?: string | null; selector: string }>;
  count?: number;
  value?: unknown;
  dataUrl?: string;
  path?: string;
  file?: string;
  name?: string;
  message?: string;
  error?: { type: string; message: string; recoverable?: boolean };
}

export function parseBrowserResult(result: unknown): BrowserPayload | null {
  try {
    const p = typeof result === "string" ? JSON.parse(result) : result;
    if (p && typeof p === "object" && (p as { kind?: string }).kind === "browser") {
      return p as BrowserPayload;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

const ACTION_LABELS: Record<string, string> = {
  navigate: "Opened",
  click: "Clicked",
  type: "Typed",
  press: "Pressed",
  scroll: "Scrolled",
  wait: "Waited",
  screenshot: "Screenshot",
  get_page: "Page",
  get_elements: "Elements",
  evaluate: "Evaluated",
  select: "Selected",
  upload: "Uploaded",
  download: "Downloaded",
  new_tab: "New tab",
  switch_tab: "Switched tab",
  close_tab: "Closed tab",
  go_back: "Back",
  go_forward: "Forward",
  refresh: "Refreshed",
};

export function BrowserResult({ toolCall }: { toolCall: ToolCall }) {
  const payload = useMemo(() => parseBrowserResult(toolCall.result), [toolCall]);
  if (!payload) return null;

  const ok = payload.success !== false;
  const action = payload.action ?? "";
  const label = ACTION_LABELS[action] ?? "Browser";
  const tabs = Array.isArray(payload.tabs) ? payload.tabs : [];
  const text = typeof payload.text === "string" ? payload.text : null;
  const elements = Array.isArray(payload.elements) ? payload.elements : null;

  return (
    <div className="space-y-2.5 px-1.5 py-1 sm:px-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* Browser identity — the globe glyph + "Browser", NEVER the
            generic agent icon or a Composio logo. */}
        <span className="bg-primary/10 text-primary inline-flex h-5 items-center gap-1 rounded-full px-2 text-[10px] font-semibold tracking-wide uppercase">
          <Globe className="h-3 w-3" aria-hidden />
          Browser
        </span>
        <span className="text-foreground text-sm font-semibold">{label}</span>
        {payload.url && (
          <a
            href={payload.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground inline-flex min-w-0 items-center gap-1 truncate font-mono text-[10px] transition-colors"
          >
            <span className="truncate">{payload.url}</span>
            <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
          </a>
        )}
        {typeof payload.status === "number" && (
          <span className="bg-foreground/[0.05] text-muted-foreground rounded-full px-2 py-0.5 font-mono text-[10px]">
            HTTP {payload.status}
          </span>
        )}
        {tabs.length > 1 && (
          <span className="bg-foreground/[0.05] text-muted-foreground rounded-full px-2 py-0.5 font-mono text-[10px]">
            {tabs.length} tabs
          </span>
        )}
      </div>

      {payload.title ? (
        <p className="text-foreground/80 truncate text-sm font-medium">{payload.title}</p>
      ) : null}

      {/* Error — structured, never silent (PRD §27). */}
      {!ok && payload.error ? (
        <p className="text-destructive text-xs">
          <span className="font-mono">{payload.error.type}</span> — {payload.error.message}
        </p>
      ) : null}

      {/* Captured download → the workspace file it landed as. */}
      {ok && action === "download" && payload.file ? (
        <p className="text-muted-foreground inline-flex items-center gap-1.5 font-mono text-[11px]">
          <Download className="h-3.5 w-3.5" aria-hidden />
          {payload.file}
        </p>
      ) : null}

      {/* get_page — the visible text excerpt. */}
      {ok && text ? (
        <p className="text-muted-foreground line-clamp-6 rounded-lg border-border bg-foreground/[0.02] border p-2.5 text-xs leading-relaxed whitespace-pre-wrap">
          {text.slice(0, 1500)}
          {text.length > 1500 ? "\n…" : ""}
        </p>
      ) : null}

      {/* get_elements — a compact element list (refs the AI used). */}
      {ok && elements && elements.length > 0 ? (
        <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border-border bg-foreground/[0.02] border p-2">
          {elements.slice(0, 40).map((el) => (
            <p key={el.ref} className="flex items-baseline gap-2 font-mono text-[10px] leading-relaxed">
              <span className="text-primary shrink-0">{el.ref}</span>
              <span className="text-foreground/70 shrink-0">{el.tag}</span>
              {el.text ? <span className="text-muted-foreground min-w-0 truncate">{el.text}</span> : null}
            </p>
          ))}
          {elements.length > 40 ? (
            <p className="text-muted-foreground text-[10px]">+{elements.length - 40} more…</p>
          ) : null}
        </div>
      ) : null}

      {/* evaluate — the returned value. */}
      {ok && action === "evaluate" && payload.value !== undefined ? (
        <pre className="text-muted-foreground max-h-40 overflow-auto rounded-lg border-border bg-foreground/[0.02] border p-2.5 font-mono text-[11px] whitespace-pre-wrap">
          {typeof payload.value === "string" ? payload.value : JSON.stringify(payload.value, null, 2)}
        </pre>
      ) : null}

      {/* Screenshot — the captured page, inline. */}
      {payload.dataUrl ? (
        <figure className="overflow-hidden rounded-lg border-border border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={payload.dataUrl}
            alt={payload.title ? `Screenshot of ${payload.title}` : "Browser screenshot"}
            className="w-full"
          />
          <figcaption className="text-muted-foreground flex items-center gap-1.5 bg-foreground/[0.02] px-2.5 py-1.5 font-mono text-[10px]">
            <Camera className="h-3 w-3" aria-hidden />
            {payload.path ?? "screenshot.png"}
          </figcaption>
        </figure>
      ) : null}

      {ok && payload.message && !text && !elements && !payload.dataUrl ? (
        <p className={cn("text-muted-foreground text-xs")}>{payload.message}</p>
      ) : null}
    </div>
  );
}
