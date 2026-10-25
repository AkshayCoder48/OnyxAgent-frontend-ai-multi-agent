"use client";

/**
 * BusinessAgentCard — the Business-mode agent's "browser" for the Browser
 * tab (Task 1-c). Business agents do NOT run E2B sandbox browsers; their
 * web interaction is recorded as `browser.activity` events (query, result
 * count, top result URLs) during turns. This card lists an agent's most
 * recent real events — never fabricates entries (mirrors the
 * browser-panel.tsx philosophy).
 */

import { ExternalLink, Globe, Search } from "lucide-react";

import { AgentLogo } from "@/components/business/agent-logos";
import type { BusinessAgentRow, BusinessEventRow } from "@/lib/business/types";
import { timeAgo } from "@/lib/utils";

/** Max recent browser.activity entries shown per agent card. */
const MAX_ENTRIES = 3;

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface BusinessAgentCardProps {
  agent: BusinessAgentRow;
  /** Business name for the subtitle (agent rows only carry business_id). */
  businessName: string;
  /** This agent's browser.activity events, NEWEST first (already filtered). */
  events: BusinessEventRow[];
}

export function BusinessAgentCard({ agent, businessName, events }: BusinessAgentCardProps) {
  const entries = events.slice(0, MAX_ENTRIES);

  return (
    <article className="flex h-full flex-col rounded-xl border bg-card p-4 text-card-foreground">
      {/* Agent identity */}
      <div className="flex items-start gap-2.5">
        <AgentLogo logo={agent.svg_logo} className="size-8" label={agent.name} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground" title={agent.name}>
            {agent.name}
          </h3>
          <p className="truncate text-xs text-muted-foreground" title={businessName}>
            {businessName} · {agent.role}
          </p>
        </div>
      </div>

      {entries.length === 0 ? (
        // Honest empty state — no browsing has happened for this agent yet.
        <div className="mt-3 flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center">
          <Globe className="h-5 w-5 text-muted-foreground/60" aria-hidden />
          <p className="text-xs font-medium text-foreground/70">No browsing yet</p>
          <p className="max-w-52 text-[10px] leading-relaxed text-muted-foreground/80">
            This agent&apos;s web research appears here as soon as it searches during a
            turn.
          </p>
        </div>
      ) : (
        <ol className="mt-3 flex flex-col gap-2.5">
          {entries.map((e) => {
            const query = typeof e.payload?.query === "string" ? e.payload.query : "";
            const resultCount = asNumber(e.payload?.resultCount);
            const topUrls = asStringArray(e.payload?.topUrls).slice(0, 3);
            return (
              <li key={e.id} className="rounded-lg bg-foreground/[0.03] p-2.5">
                <div className="flex items-start gap-2">
                  <Search className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-xs font-medium text-foreground" title={query}>
                      {query || "—"}
                    </p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      {resultCount !== null ? `${resultCount} results · ` : ""}
                      {timeAgo(e.created_at)}
                    </p>
                  </div>
                </div>
                {topUrls.length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-0.5 border-t pt-1.5">
                    {topUrls.map((url, i) => (
                      <li key={`${i}-${url}`} className="min-w-0">
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex min-h-11 items-center gap-1.5 rounded-md px-1 text-xs text-muted-foreground transition-colors hover:text-primary"
                        >
                          <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                          <span className="truncate">{url}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </article>
  );
}
