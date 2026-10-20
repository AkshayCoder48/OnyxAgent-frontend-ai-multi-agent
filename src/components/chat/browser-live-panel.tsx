"use client";

import {
  AlertTriangle,
  Globe,
  Loader2,
  MonitorPlay,
  Radio,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useBrowserLive } from "@/hooks/use-browser-live";
import { useConversationStore } from "@/stores/conversation-store";
import { useSettings } from "@/hooks/use-data";

/**
 * BrowserLivePanel — the LIVE BROWSER VIEW (user directive 2026-10-21:
 * a Browser tab on the chat header). The `use_browser` tool stays a plain
 * tool call + output in the chat flow; the real browser is WATCHED here —
 * a JPEG screencast of the sandbox browser's active tab (CloakBrowser,
 * headed under Xvfb), streamed over SSE from the driver's CDP
 * Page.startScreencast, plus the live interaction state (url, title, tabs).
 *
 * The panel is event-honest: while no browser session exists it shows a
 * waiting state ("starts when the agent uses the browser"), and every frame
 * shown was really rendered by the sandbox browser.
 */
export function BrowserLivePanel() {
  const currentConversationId = useConversationStore((s) => s.currentConversationId);
  const { settings } = useSettings();
  const mode = settings?.sandbox_mode ?? "shared";

  const live = useBrowserLive({
    enabled: true,
    conversationId: currentConversationId,
    mode,
  });

  const state = live.state;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Status row */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <span
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[10px] font-semibold tracking-wide uppercase",
            live.phase === "live" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
            live.phase === "connecting" && "bg-primary/10 text-primary",
            live.phase === "closed" && "bg-foreground/[0.05] text-muted-foreground",
            live.phase === "error" && "bg-destructive/10 text-destructive",
          )}
        >
          {live.phase === "live" ? (
            <Radio className="h-3 w-3" aria-hidden />
          ) : live.phase === "connecting" ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          ) : live.phase === "error" ? (
            <XCircle className="h-3 w-3" aria-hidden />
          ) : (
            <Globe className="h-3 w-3" aria-hidden />
          )}
          {live.phase === "live"
            ? "Live"
            : live.phase === "connecting"
              ? "Connecting"
              : live.phase === "closed"
                ? "Session closed"
                : "Error"}
        </span>
        {state?.runtime ? (
          <span className="rounded-full bg-foreground/[0.05] px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
            {state.runtime === "cloakbrowser" ? "cloak" : state.runtime}
          </span>
        ) : null}
        {typeof state?.tabCount === "number" && state.tabCount > 0 ? (
          <span className="rounded-full bg-foreground/[0.05] px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
            {state.tabCount} tab{state.tabCount === 1 ? "" : "s"}
          </span>
        ) : null}
        {state?.action ? (
          <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/80">
            · {state.action}
          </span>
        ) : null}
      </div>

      {/* The live frame — the sandbox browser's active tab. */}
      <div className="min-h-0 flex-1 overflow-hidden px-3">
        <div className="relative h-full w-full overflow-hidden rounded-lg border border-border bg-foreground/[0.02]">
          {live.frameUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={live.frameUrl}
              alt={
                state?.title
                  ? `Live view — ${state.title}`
                  : "Live view of the sandbox browser"
              }
              className="h-full w-full object-contain object-top"
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center">
              {live.phase === "error" ? (
                <>
                  <AlertTriangle className="h-6 w-6 text-destructive/70" aria-hidden />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {live.error ?? "The live browser stream failed."}
                  </p>
                  <p className="text-[10px] leading-relaxed text-muted-foreground/70">
                    The browser needs an E2B Sandbox API key — add one in Settings →
                    Config → E2B Sandbox, then reopen this panel.
                  </p>
                </>
              ) : (
                <>
                  <MonitorPlay className="h-6 w-6 text-muted-foreground/60" aria-hidden />
                  <p className="text-xs font-medium text-foreground/70">
                    Waiting for the browser…
                  </p>
                  <p className="max-w-52 text-[10px] leading-relaxed text-muted-foreground/80">
                    The live view starts automatically when the agent uses the
                    browser tool in this chat.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Page identity */}
      <div className="px-3 pt-2 pb-3">
        {state?.url ? (
          <p className="truncate font-mono text-[10px] text-muted-foreground" title={state.url}>
            {state.url}
          </p>
        ) : null}
        {state?.title ? (
          <p className="truncate text-xs font-medium text-foreground/80" title={state.title}>
            {state.title}
          </p>
        ) : null}
        <p className="pt-1 text-[10px] text-muted-foreground/60">
          The view follows the agent&apos;s active tab.
        </p>
      </div>
    </div>
  );
}
