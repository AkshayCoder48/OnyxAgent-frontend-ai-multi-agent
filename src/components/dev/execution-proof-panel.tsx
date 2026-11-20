"use client";

import { useEffect, useState } from "react";
import { Activity, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { useExecutionProofStore } from "@/lib/agent/execution-proof";

/**
 * ExecutionProofPanel — the PRD §8 diagnostics surface (DEV MODE ONLY).
 *
 * Every row is REAL backend telemetry, never a fabricated state:
 *   · Sandbox process — the runner's own pid + heartbeat age (v7 heartbeat
 *     rewrites agent_status.json every 10s while alive; a stale heartbeat
 *     with a "running" status is a dead process, not a working one).
 *   · Provider request / stream — the id of the last OBSERVED provider
 *     request from inside E2B and its wire state (connecting / streaming /
 *     non_stream / failed).
 *   · Token generation — time since the last OBSERVED token fragment
 *     (first_token_at/last_token_at are stamped by arrived chunks).
 *   · Tool dispatcher — the in-flight tool's idempotency key + dispatch
 *     confirmation (texec_<call_id>, tool.dispatched events).
 *   · Event persistence / SSE bridge — the replay cursor (last_event_id)
 *     and the actual events the bridge delivered.
 *
 * Hidden in production builds; nothing here can mutate execution state.
 */

function age(msSince: number | null): string {
  if (msSince == null) return "—";
  const s = Math.max(0, Math.round(msSince / 1000));
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ${s % 60}s ago`;
}

/** Tracks WHEN last_update last CHANGED (browser clock) — the skew-proof
 *  liveness signal for the process row (sandbox clock ≠ browser clock). */
const procTracker: { lastUpdate: number | null; changedAt: number } = {
  lastUpdate: null,
  changedAt: 0,
};

interface Row {
  label: string;
  value: string;
  tone: "ok" | "warn" | "bad" | "idle";
}

function deriveRows(): Row[] {
  const { status, statusAt, events } = useExecutionProofStore.getState();
  const now = Date.now();
  const last = events[events.length - 1];

  // Sandbox process — CLOCK-SKEW-PROOF liveness: the runner's timestamps
  // come from the sandbox clock (observed ~40s behind the browser), so an
  // absolute age would always read stale. Liveness = last_update ADVANCING
  // between polls (the v7 heartbeat rewrites it every 10s while alive).
  let proc: Row = { label: "Sandbox process", value: "no run observed", tone: "idle" };
  if (status) {
    const lu = status.last_update ?? 0;
    if (lu !== procTracker.lastUpdate) {
      procTracker.lastUpdate = lu;
      procTracker.changedAt = now;
    }
    const secsSinceChange = Math.round((now - procTracker.changedAt) / 1000);
    const changedRecently = secsSinceChange <= 25;
    const pid = status.runner_pid ? `pid ${status.runner_pid}` : "pid ?";
    proc = {
      label: "Sandbox process",
      value: `${status.status}${status.stage ? ` · ${status.stage}` : ""} · ${pid} · status updating (${secsSinceChange}s)`,
      tone: changedRecently
        ? "ok"
        : status.status === "running" || status.status === "starting"
          ? "bad"
          : "idle",
    };
    if (!changedRecently) {
      proc.value = `${status.status} · ${pid} · status FROZEN ${secsSinceChange}s (heartbeat dead?)`;
    }
  }

  // Provider request + stream state.
  const req: Row = status?.provider_request_id
    ? {
        label: "Provider request",
        value: `${status.provider_request_id} · ${status.provider_stream ?? "?"}${status.current_tool ? "" : ""}`,
        tone: status.provider_stream === "streaming" ? "ok" : status.provider_stream === "failed" ? "bad" : "idle",
      }
    : { label: "Provider request", value: "—", tone: "idle" };

  // Token generation — SANDBOX-CLOCK-RELATIVE (last_token_at vs the status's
  // own last_update — both runner-stamped, so browser↔sandbox skew cancels
  // out): a small gap means tokens were arriving when the heartbeat fired.
  const tokGap =
    status?.last_token_at && status?.last_update
      ? status.last_update - status.last_token_at
      : null;
  const tok: Row =
    tokGap != null
      ? {
          label: "Token generation",
          value: tokGap < 15_000 ? `receiving · last token ${Math.round(tokGap / 1000)}s before the heartbeat` : `quiet/stalled · ${Math.round(tokGap / 1000)}s since the last token`,
          tone: tokGap < 15_000 ? "ok" : "warn",
        }
      : { label: "Token generation", value: "no tokens yet", tone: "idle" };

  // Tool dispatcher.
  const tool: Row = status?.current_tool
    ? {
        label: "Tool dispatcher",
        value: `${status.current_tool} · ${status.current_tool_execution_id ?? "no execution id"}`,
        tone: "ok",
      }
    : { label: "Tool dispatcher", value: "idle", tone: "idle" };

  // Event persistence + SSE bridge (observed deliveries).
  const evt: Row = {
    label: "Events / bridge",
    value: `cursor ${status?.last_event_id ?? last?.i ?? 0} · ${events.length} delivered${last ? ` · last: ${last.type}` : ""}`,
    tone: events.length > 0 ? "ok" : "idle",
  };

  return [proc, req, tok, tool, evt];
}

const TONE_CLASS: Record<Row["tone"], string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-red-600 dark:text-red-400",
  idle: "text-muted-foreground",
};

export function ExecutionProofPanel() {
  // DEV MODE ONLY — the PRD §8 panel is a development surface. Production
  // builds render nothing (the hook-order-safe early return below).
  const [dev, setDev] = useState(false);
  useEffect(() => {
    setDev(process.env.NODE_ENV === "development");
  }, []);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [tick, setTick] = useState(0);

  // Re-derive every second (ages) and on every store change.
  useEffect(() => {
    if (!dev) return;
    const unsub = useExecutionProofStore.subscribe(() => setRows(deriveRows()));
    const timer = setInterval(() => {
      setRows(deriveRows());
      setTick((t) => t + 1);
    }, 1000);
    setRows(deriveRows());
    return () => {
      unsub();
      clearInterval(timer);
    };
  }, [dev]);

  if (!dev) return null;
  const view = rows ?? deriveRows();

  return (
    <div
      data-proof-tick={tick}
      className="fixed bottom-20 right-3 z-50 w-80 rounded-lg border bg-background/95 p-2 text-[11px] shadow-lg backdrop-blur sm:bottom-3"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 font-medium hover:bg-accent"
      >
        <span className="flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5" aria-hidden />
          Execution proof (dev)
        </span>
        {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronUp className="h-3.5 w-3.5" aria-hidden />}
      </button>
      {open ? (
        <table className="mt-1 w-full border-collapse">
          <tbody>
            {view.map((r) => (
              <tr key={r.label} className="align-top">
                <td className="w-28 py-0.5 pr-1 font-medium text-muted-foreground">{r.label}</td>
                <td className={cn("py-0.5 font-mono break-all", TONE_CLASS[r.tone])}>{r.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
