"use client";

/**
 * AgentBrowserCard — one agent's live browser view for the Browser tab
 * (Task 1-c). Mirrors the visual language of the chat workspace's
 * BrowserLivePanel (status pill, screencast frame, url/title footer,
 * event-honest waiting + error states), but as a self-contained card.
 *
 * Two modes of transport, decided by the PARENT:
 *
 *  - `live` prop  — the parent hoisted ONE `useBrowserLive` stream and
 *    passes its result down (the "shared" sandbox mode, where every
 *    conversation drives the SAME sandbox browser — one SSE stream for
 *    the whole grid, never N identical ones).
 *  - `conversationId` prop — the card mounts its OWN `useBrowserLive`
 *    stream scoped to that conversation (the "separate" sandbox mode,
 *    where each agent really has a different browser).
 */

import {
  AlertTriangle,
  Globe,
  Loader2,
  MonitorPlay,
  Radio,
  Users,
  XCircle,
} from "lucide-react";

import { useBrowserLive, type BrowserLive, type BrowserLivePhase } from "@/hooks/use-browser-live";
import { cn } from "@/lib/utils";

export interface AgentBrowserCardProps {
  /** Card title — the conversation / agent name. */
  title: string;
  /** Optional second line (project name, "updated 2h ago", …). */
  subtitle?: string;
  /** Hoisted live result (shared sandbox mode) — takes precedence. */
  live?: BrowserLive;
  /** Own conversation whose sandbox browser this card streams
   *  (separate sandbox mode). */
  conversationId?: string;
  /** Sandbox allocation mode for the card's own stream. */
  mode?: "shared" | "separate";
  /** Show the "shared sandbox" hint chip (shared mode only). */
  shared?: boolean;
}

function StatusPill({ phase }: { phase: BrowserLivePhase }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[10px] font-semibold tracking-wide uppercase",
        phase === "live" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        phase === "connecting" && "bg-primary/10 text-primary",
        phase === "closed" && "bg-foreground/[0.05] text-muted-foreground",
        phase === "error" && "bg-destructive/10 text-destructive",
      )}
    >
      {phase === "live" ? (
        <Radio className="h-3 w-3" aria-hidden />
      ) : phase === "connecting" ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      ) : phase === "error" ? (
        <XCircle className="h-3 w-3" aria-hidden />
      ) : (
        <Globe className="h-3 w-3" aria-hidden />
      )}
      {phase === "live"
        ? "Live"
        : phase === "connecting"
          ? "Connecting"
          : phase === "closed"
            ? "Session closed"
            : "Error"}
    </span>
  );
}

export function AgentBrowserCard({
  title,
  subtitle,
  live: liveProp,
  conversationId,
  mode = "shared",
  shared = false,
}: AgentBrowserCardProps) {
  // Own stream only when the parent did NOT hoist one for us. The hook is
  // mounted unconditionally (rules of hooks) but `enabled: false` keeps it
  // a complete no-op — no SSE connection, no frame URLs.
  const ownLive = useBrowserLive({
    enabled: !liveProp && !!conversationId,
    conversationId: conversationId ?? null,
    mode,
  });
  const live = liveProp ?? ownLive;
  const state = live.state;

  return (
    <article className="flex flex-col overflow-hidden rounded-xl border bg-card text-card-foreground">
      {/* Title row + status pill */}
      <div className="flex items-start justify-between gap-2 p-4 pb-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground" title={title}>
            {title}
          </h3>
          {subtitle ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={subtitle}>
              {subtitle}
            </p>
          ) : null}
        </div>
        <StatusPill phase={live.phase} />
      </div>

      {/* Shared-sandbox hint chip (shared mode: every card shows the same browser) */}
      {shared ? (
        <div className="px-4 pb-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/[0.05] px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            <Users className="h-3 w-3" aria-hidden />
            Shared sandbox — agents share one browser
          </span>
        </div>
      ) : null}

      {/* The live frame — the sandbox browser's active tab. */}
      <div className="px-4">
        <div className="relative h-56 w-full overflow-hidden rounded-lg border border-border bg-foreground/[0.02] sm:h-64">
          {live.frameUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={live.frameUrl}
              alt={
                state?.title
                  ? `Live view of ${title} — ${state.title}`
                  : `Live view of ${title} — the sandbox browser`
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
                    Config → E2B Sandbox, then reopen this view.
                  </p>
                </>
              ) : (
                <>
                  <MonitorPlay className="h-6 w-6 text-muted-foreground/60" aria-hidden />
                  <p className="text-xs font-medium text-foreground/70">
                    Waiting for the browser…
                  </p>
                  <p className="max-w-56 text-[10px] leading-relaxed text-muted-foreground/80">
                    The live view starts when this agent uses its browser tool.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Page identity */}
      <div className="flex min-h-12 flex-col gap-0.5 p-4 pt-2">
        {state?.runtime ? (
          <span className="w-fit rounded-full bg-foreground/[0.05] px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
            {state.runtime === "cloakbrowser" ? "cloak" : state.runtime}
          </span>
        ) : null}
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
        {state?.action ? (
          <p
            className="truncate font-mono text-[10px] text-muted-foreground/80"
            title={state.action ?? undefined}
          >
            · {state.action}
          </p>
        ) : null}
        {!state?.url && !state?.title ? (
          <p className="text-[10px] text-muted-foreground/60">
            The view follows the agent&apos;s active tab.
          </p>
        ) : null}
      </div>
    </article>
  );
}
