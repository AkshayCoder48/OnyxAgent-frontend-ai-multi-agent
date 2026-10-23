"use client";

/**
 * Business Mode — BrowserPanel (Task 4-c).
 *
 * Right-hand sheet listing REAL browser.activity events (web research run by
 * agents during turns): query, result count, up to three result links, the
 * agent that searched and the task it belonged to. Never fabricates entries.
 */

import { useMemo } from "react";
import { ExternalLink, Globe, Search } from "lucide-react";

import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

import { AgentLogo } from "@/components/business/agent-logos";
import { bt } from "@/lib/business/ui-text";
import { useBusinessStore } from "@/stores/business-store";
import { timeAgo } from "@/lib/utils";

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function BrowserPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const events = useBusinessStore((s) => s.events);
  const agents = useBusinessStore((s) => s.agents);
  const tasks = useBusinessStore((s) => s.tasks);

  const browserEvents = useMemo(
    () => events.filter((e) => e.event_type === "browser.activity"),
    [events],
  );

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <div className="flex min-w-0 items-center gap-3">
            <Globe className="size-5 shrink-0 text-primary" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate">{bt("browser.title")}</SheetTitle>
              <SheetDescription className="truncate text-xs">
                {bt("browser.subtitle")}
              </SheetDescription>
            </div>
            <SheetClose onClick={() => onOpenChange(false)} aria-label={bt("common.close")} />
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-4">
          {browserEvents.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-14 text-center">
              <Globe className="size-10 text-muted-foreground/60" aria-hidden="true" />
              <p className="max-w-xs text-sm text-muted-foreground">{bt("browser.empty")}</p>
            </div>
          ) : (
            <ol className="flex flex-col gap-3">
              {browserEvents.map((e) => {
                const query = typeof e.payload?.query === "string" ? e.payload.query : "";
                const resultCount = asNumber(e.payload?.resultCount);
                const topUrls = asStringArray(e.payload?.topUrls).slice(0, 3);
                const agent = e.agent_id ? (agentById.get(e.agent_id) ?? null) : null;
                const task = e.task_id ? (taskById.get(e.task_id) ?? null) : null;
                return (
                  <li key={e.id} className="rounded-xl border p-4">
                    <div className="flex items-start gap-2.5">
                      <Search className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-sm font-medium">
                          {bt("browser.query")}: {query || "—"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {resultCount !== null ? `${resultCount} · ` : ""}
                          {agent && (
                            <span className="inline-flex items-center gap-1.5">
                              <AgentLogo logo={agent.svg_logo} className="size-5" />
                              {agent.name}
                            </span>
                          )}
                          {task ? ` · ${task.title}` : ""}
                          {" · "}
                          {timeAgo(e.created_at)}
                        </p>
                      </div>
                    </div>
                    {topUrls.length > 0 && (
                      <ul className="mt-2.5 flex flex-col gap-1 border-t pt-2.5">
                        {topUrls.map((url, i) => (
                          <li key={`${i}-${url}`} className="min-w-0">
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="flex min-h-9 items-center gap-1.5 truncate text-xs text-muted-foreground transition-colors hover:text-primary"
                            >
                              <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                              <span className="truncate">{url}</span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
