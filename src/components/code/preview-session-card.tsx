"use client";

import { MonitorPlay } from "lucide-react";

import { PreviewStopButton } from "@/components/chat/tool-results/preview";
import type { PreviewSession } from "@/stores/preview-session-store";
import { cn } from "@/lib/utils";

function ageLabel(createdAt: number): string {
  const s = Math.max(0, Math.round((Date.now() - createdAt) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function statusClasses(status: string): string {
  switch (status) {
    case "running":
      return "bg-primary/10 text-primary";
    case "stopped":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-destructive/10 text-destructive";
  }
}

/**
 * One running/stopped preview entry in the Preview tab's session list
 * (OnyxCode extension PRD §3.5): name/framework, status chip, truncated
 * URL, age, and the Stop/Remove control.
 */
export function PreviewSessionCard({
  session,
  selected,
  onSelect,
}: {
  session: PreviewSession;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-2.5 transition-colors",
        selected
          ? "border-primary/40 bg-primary/[0.04]"
          : "border-border bg-card hover:border-primary/30",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-start gap-2 text-left"
        aria-current={selected ? "true" : undefined}
      >
        <span
          className={cn(
            "mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
            session.status === "running" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
          )}
          aria-hidden
        >
          <MonitorPlay className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold">{session.name}</span>
            <span
              className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide", statusClasses(session.status))}
            >
              {session.status}
            </span>
          </span>
          <span className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-[10px]">
            <span className="truncate">{session.frameworkLabel}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{ageLabel(session.createdAt)}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0 font-mono">:{session.port}</span>
          </span>
          <span className="text-muted-foreground/70 mt-0.5 block truncate font-mono text-[10px]">
            {session.url.replace(/^https?:\/\//, "")}
          </span>
        </span>
      </button>
      <div className="mt-2 flex justify-end">
        <PreviewStopButton session={session} />
      </div>
    </div>
  );
}
