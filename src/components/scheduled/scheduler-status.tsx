"use client";

// ============================================================================
// SchedulerStatus — a compact status chip row + the "How triggering works"
// explainer. Shows last tick (relative), next due (relative + absolute in the
// browser zone), running count; lets the user run a tick NOW; and provides
// the copyable external-pinger URL (<origin>/api/scheduler/tick — a plain
// GET from any 1-minute cron service keeps the scheduler precise).
// ============================================================================

import { useState } from "react";
import { toast } from "sonner";
import {
  Activity,
  Check,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Info,
  Loader2,
  Play,
} from "lucide-react";
import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { tickHeartbeat } from "@/lib/scheduler/client";
import { formatNextRun, formatRelativeAgo } from "./time-format";

interface SchedulerStatusProps {
  /** Total task count. */
  taskCount: number;
  /** The tick record (null = never ticked). */
  tick: {
    lastTickAt: number | null;
    nextDueAt: number | null;
    running: number;
    fired: number;
    finalized: number;
    tasks: number;
  } | null;
  userId: string;
  onTicked: () => void;
}

export function SchedulerStatus({ taskCount, tick, userId, onTicked }: SchedulerStatusProps) {
  const [ticking, setTicking] = useState(false);
  const [showHow, setShowHow] = useState(false);
  const { copy, copied } = useCopyToClipboard();

  const pingerUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/scheduler/tick`
      : "/api/scheduler/tick";

  async function handleRunTick() {
    setTicking(true);
    try {
      const res = await tickHeartbeat(userId);
      if (!res) {
        toast.error("Tick failed — no OnyxBase key?", {
          description: "Cloud scheduling needs the key from Settings → Cloud Workspace.",
        });
        return;
      }
      if (res.ok && res.ticked) {
        toast.success("Scheduler ticked", {
          description:
            res.fired || res.finalized
              ? `${res.fired} task(s) fired · ${res.finalized} run(s) finalized.`
              : `Nothing due — ${res.tasks} task(s) tracked, ${res.running} running.`,
        });
        onTicked();
      } else if (res.ok && res.skipped) {
        toast("Tick skipped — one ran moments ago", {
          description: "Overlapping ticks collapse into one evaluation (the lock).",
        });
      } else {
        toast.error(res.errors?.[0] ?? "Tick failed");
      }
    } finally {
      setTicking(false);
    }
  }

  const lastTick = tick?.lastTickAt ? formatRelativeAgo(tick.lastTickAt) : "never";
  const nextDue = tick?.nextDueAt ?? null;

  return (
    <section className="rounded-xl border bg-card p-4 sm:p-5" aria-label="Scheduler status">
      {/* Status chips */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11.5px] text-muted-foreground">
          <Activity className="size-3 text-primary/70" aria-hidden />
          {taskCount} task{taskCount === 1 ? "" : "s"}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11.5px] text-muted-foreground">
          <Clock className="size-3" aria-hidden />
          Last tick: <span className="font-medium text-foreground/80">{lastTick}</span>
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11.5px] text-muted-foreground">
          Next due:{" "}
          <span className="font-medium text-foreground/80">
            {nextDue ? formatNextRun(nextDue) : "nothing scheduled"}
          </span>
        </span>
        {(tick?.running ?? 0) > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11.5px] text-amber-700 dark:text-amber-400">
            <Loader2 className="size-3 animate-spin" aria-hidden />
            {tick?.running} running
          </span>
        )}

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleRunTick}
          disabled={ticking}
          className="ml-auto h-11 min-w-[44px]"
        >
          {ticking ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />}
          Run tick now
        </Button>
      </div>

      {/* Collapsible explainer */}
      <button
        type="button"
        onClick={() => setShowHow((s) => !s)}
        aria-expanded={showHow}
        className="mt-3 flex items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", showHow && "rotate-90")} aria-hidden />
        How triggering works
      </button>

      {showHow && (
        <div className="mt-2 space-y-2.5 rounded-lg border bg-muted/25 p-3 text-[12.5px] leading-relaxed text-foreground/80">
          <p className="flex items-start gap-1.5">
            <Info className="mt-0.5 size-3.5 shrink-0 text-primary/70" aria-hidden />
            <span>
              The scheduler is server-side and persistent — schedules survive closed browsers and
              restarts. Tasks fire from any of these trigger sources:
            </span>
          </p>
          <ul className="ml-5 list-disc space-y-1">
            <li>
              <strong className="font-medium">Heartbeat</strong> — while the app is open, the browser
              pings the scheduler every 60 seconds.
            </li>
            <li>
              <strong className="font-medium">Daily cron</strong> — a Vercel cron job checks the
              schedule once a day.
            </li>
            <li>
              <strong className="font-medium">External pinger</strong> — optional, for precise
              minute-level timing: point any 1-minute cron service (e.g. cron-job.org, free) at the
              URL below — a plain GET works. Every tick is idempotent; overlaps collapse safely.
            </li>
          </ul>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={pingerUrl}
              aria-label="Scheduler tick URL"
              className="h-9 font-mono text-[11.5px]"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-11 min-w-[44px]"
              onClick={() => void copy(pingerUrl)}
            >
              {copied ? <Check className="size-4 text-emerald-500" aria-hidden /> : <Copy className="size-4" aria-hidden />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
            <ExternalLink className="size-3" aria-hidden />
            Missed occurrences catch up on the next tick — a task never silently disappears.
          </p>
        </div>
      )}
    </section>
  );
}
