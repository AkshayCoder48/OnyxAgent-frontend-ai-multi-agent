"use client";

import { Camera, Globe } from "lucide-react";

/** Web-session result payload (see src/lib/tools/web-session-driver.ts). */
export interface WebSessionPayload {
  kind: "web_session";
  ok: boolean;
  action: string;
  sessionId?: string;
  url?: string;
  title?: string | null;
  status?: number | null;
  text?: string;
  html?: string;
  dataUrl?: string;
  path?: string;
  alive?: boolean;
  message?: string;
  error?: string;
}

export function parseWebSessionResult(result: unknown): WebSessionPayload | null {
  try {
    const p = typeof result === "string" ? JSON.parse(result) : result;
    if (p && typeof p === "object" && (p as { kind?: string }).kind === "web_session") {
      return p as WebSessionPayload;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * Rich card for the web-session tools (start_web_session /
 * manage_web_session): the session's URL/title, extracted text, and the
 * latest screenshot thumbnail.
 */
export function WebSessionResult({ data }: { data: WebSessionPayload }) {
  return (
    <div className="space-y-2.5 py-1">
      <div className="flex flex-wrap items-center gap-2">
        <Globe className="text-primary h-4 w-4 shrink-0" aria-hidden />
        <span className="text-foreground text-sm font-semibold capitalize">
          {data.action === "start" ? "Web session" : data.action}
        </span>
        {data.url && (
          <span className="text-muted-foreground truncate font-mono text-[10px]">{data.url}</span>
        )}
        {typeof data.status === "number" && (
          <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 font-mono text-[10px]">
            HTTP {data.status}
          </span>
        )}
      </div>

      {!data.ok && data.error ? (
        <p className="text-destructive text-xs">{data.error}</p>
      ) : (
        <>
          {data.title ? (
            <p className="text-foreground/85 text-xs font-medium">“{data.title}”</p>
          ) : null}
          {data.text ? (
            <div className="border-foreground/10 bg-foreground/[0.02] max-h-40 overflow-y-auto scrollbar-thin rounded-xl border p-2.5">
              <p className="text-foreground/75 whitespace-pre-wrap text-[11px] leading-relaxed">
                {data.text.slice(0, 2000)}
                {data.text.length > 2000 ? "\n…" : ""}
              </p>
            </div>
          ) : null}
          {data.dataUrl ? (
            <figure className="overflow-hidden rounded-xl border border-border">
              {/* data URL from the sandbox — next/image brings nothing here */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={data.dataUrl}
                alt={`Screenshot of ${data.url ?? "the web session"}`}
                className="w-full"
              />
              <figcaption className="text-muted-foreground flex items-center gap-1.5 px-2.5 py-1.5 font-mono text-[10px]">
                <Camera className="h-3 w-3" aria-hidden />
                {data.path ?? "screenshot.png"}
              </figcaption>
            </figure>
          ) : null}
          {data.message ? (
            <p className="text-muted-foreground text-[11px]">{data.message}</p>
          ) : null}
        </>
      )}
    </div>
  );
}
