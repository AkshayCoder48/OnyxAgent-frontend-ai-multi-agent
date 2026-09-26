"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bug,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Copy,
  Info,
  Search,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useLogStore, type LogEntry, type LogLevel } from "@/stores/log-store";

/**
 * LogsViewer — the in-app devtools console. Renders the log store's ring
 * buffer (newest first) with level/source filters, a search box, and
 * expandable entries showing the FULL error body (provider response text,
 * stacks, request context). Used both by the chat page's docked Logs panel
 * and the global floating button's Sheet, so every surface in the app can
 * read the same entries.
 */

type LevelFilter = "all" | LogLevel;

const LEVEL_ICONS: Record<LogLevel, typeof CircleAlert> = {
  error: CircleAlert,
  warn: TriangleAlert,
  info: Info,
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Flatten entries to plain text — the "Copy all" payload for bug reports. */
export function logsToPlainText(logs: LogEntry[]): string {
  return logs
    .map((e) => {
      const ctx = e.context
        ? " " +
          Object.entries(e.context)
            .filter(([, v]) => v !== undefined && v !== "")
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")
        : "";
      const detail = e.detail ? `\n--- detail ---\n${e.detail}` : "";
      return `[${e.timestamp}] [${e.level.toUpperCase()}] [${e.source}]${ctx} ${e.message}${detail}`;
    })
    .join("\n\n");
}

function LogEntryCard({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false);
  const Icon = LEVEL_ICONS[entry.level];
  const contextPairs = Object.entries(entry.context ?? {}).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );

  return (
    <div className="border-border/70 bg-card/50 hover:bg-card rounded-lg border transition-colors">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start gap-2 p-2.5 text-left"
      >
        <Icon
          className={cn(
            "mt-0.5 h-3.5 w-3.5 shrink-0",
            entry.level === "error" && "text-destructive",
            entry.level === "warn" && "text-amber-500",
            entry.level === "info" && "text-muted-foreground",
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-muted-foreground/80 text-[10px] leading-4 tracking-wide">
            {formatTime(entry.timestamp)}
            <span className="mx-1.5 text-border">·</span>
            <span className="text-foreground/70 uppercase">{entry.source}</span>
          </p>
          <p className="mt-0.5 line-clamp-3 text-[13px] leading-snug break-words">
            {entry.message}
          </p>
        </div>
        <ChevronDown
          className={cn(
            "text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {open && (contextPairs.length > 0 || entry.detail) && (
        <div className="border-t border-border/60 px-2.5 pt-2 pb-2.5">
          {contextPairs.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {contextPairs.map(([k, v]) => (
                <span
                  key={k}
                  className="bg-foreground/5 text-muted-foreground rounded border px-1.5 py-0.5 font-mono text-[10px]"
                >
                  {k}: <span className="text-foreground/80">{String(v)}</span>
                </span>
              ))}
            </div>
          )}
          {entry.detail && (
            <div className="bg-background/70 rounded-md border p-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
                  Details
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-6 w-6 p-0"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(entry.detail ?? "")
                      .then(() => toast.success("Details copied"))
                      .catch(() => toast.error("Failed to copy"));
                  }}
                  aria-label="Copy details"
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
              <pre className="text-muted-foreground max-h-56 overflow-y-auto font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
                {entry.detail}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function LogsViewer({ className }: { className?: string }) {
  const logs = useLogStore((s) => s.logs);
  const clear = useLogStore((s) => s.clear);
  const markSeen = useLogStore((s) => s.markSeen);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [query, setQuery] = useState("");

  // While ANY logs surface is open, newly arriving errors count as seen —
  // the badge only tracks errors the user hasn't laid eyes on.
  useEffect(() => {
    if (useLogStore.getState().unseenErrors > 0) markSeen();
  }, [logs, markSeen]);

  const counts = useMemo(() => {
    const c = { error: 0, warn: 0, info: 0, all: logs.length };
    for (const l of logs) c[l.level] += 1;
    return c;
  }, [logs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter((e) => {
      if (level !== "all" && e.level !== level) return false;
      if (
        q &&
        !e.message.toLowerCase().includes(q) &&
        !(e.detail ?? "").toLowerCase().includes(q) &&
        !e.source.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [logs, level, query]);

  const copyAll = () => {
    const text = logsToPlainText(filtered);
    navigator.clipboard
      .writeText(text || "(no logs)")
      .then(() => toast.success(`Copied ${filtered.length} log entries`))
      .catch(() => toast.error("Failed to copy logs"));
  };

  const FILTERS: { key: LevelFilter; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "error", label: "Errors", count: counts.error },
    { key: "warn", label: "Warnings", count: counts.warn },
    { key: "info", label: "Info", count: counts.info },
  ];

  return (
    <div className={cn("bg-background flex h-full min-h-0 flex-col", className)}>
      {/* Panel header */}
      <div className="border-border/70 flex shrink-0 flex-col gap-2 border-b p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Bug className="text-foreground/70 h-4 w-4" aria-hidden />
            <h2 className="text-[13px] font-semibold tracking-tight">Error logs</h2>
            {counts.error > 0 && (
              <span className="bg-destructive/12 text-destructive rounded-full px-1.5 py-px font-mono text-[10px] font-medium">
                {counts.error}
              </span>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={copyAll}
              className="text-muted-foreground hover:text-foreground h-7 px-2 text-xs"
              title="Copy all entries as text"
            >
              <Copy className="h-3.5 w-3.5" />
              Copy
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                clear();
                toast.success("Logs cleared");
              }}
              className="text-muted-foreground hover:text-foreground h-7 px-2 text-xs"
              title="Clear all entries"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* Level filter chips */}
        <div className="flex gap-1" role="tablist" aria-label="Filter by level">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={level === f.key}
              onClick={() => setLevel(f.key)}
              className={cn(
                "rounded-md border px-2 py-1 font-mono text-[10.5px] transition-colors",
                level === f.key
                  ? "bg-foreground/8 text-foreground border-foreground/20"
                  : "text-muted-foreground hover:text-foreground border-transparent hover:border-foreground/10",
              )}
            >
              {f.label} <span className="opacity-60">{f.count}</span>
            </button>
          ))}
        </div>

        <div className="relative">
          <Search className="text-muted-foreground/60 absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search logs…"
            className="h-8 pl-8 text-xs"
            aria-label="Search logs"
          />
        </div>
      </div>

      {/* Entries */}
      <div className="scrollbar-thin min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
        {filtered.length === 0 ? (
          <div className="text-muted-foreground flex h-full min-h-40 flex-col items-center justify-center gap-2 text-center">
            <CircleCheck className="h-6 w-6 opacity-50" aria-hidden />
            <p className="text-sm">
              {logs.length === 0 ? "No errors logged yet" : "No entries match this filter"}
            </p>
            <p className="max-w-52 text-xs opacity-70">
              Every LLM, network, and runtime failure lands here with full details.
            </p>
          </div>
        ) : (
          filtered.map((entry) => <LogEntryCard key={entry.id} entry={entry} />)
        )}
      </div>
    </div>
  );
}
