// ============================================================================
// Scheduler tick — the authoritative scheduler heartbeat.
//
// Triggered by:
//  - the client heartbeat (60s while the app is open)
//  - the Vercel cron job (vercel.json — Hobby plan: once/day floor)
//  - ANY external pinger (cron-job.org etc.) — a plain GET is enough
//
// Idempotent: overlapping triggers collapse via the KV tick lock; each task
// occurrence has a deterministic run id, so double ticks can never double-run
// a task. No secrets are exposed in responses.
//
// IN-PROCESS COLLAPSE (the scheduler request-storm / navigation-lag fix):
// the KV lock alone could not keep up with several open clients — every
// overlapping tick still ran the FULL evaluation (14-18s of sequential
// OnyxBase roundtrips + E2B lists), and those slow responses held the
// browser's per-origin connection pool until route navigations (Agent ⇄
// Settings) queued 20-40s behind them. This route now collapses
// per OnyxBase key: an in-flight tick is SHARED (concurrent callers await
// the same evaluation), and a fresh memo (55s, mirroring the engine's
// TICK_LOCK_MS) answers immediately. `force` bypasses both.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { SchedulerKV, cachedSchedulerKv, resolveSchedulerKey } from "@/lib/scheduler/server-kv";
import { tick } from "@/lib/scheduler/engine";
import type { TickResult } from "@/lib/scheduler/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Mirrors the engine's TICK_LOCK_MS (55s) — one full evaluation per minute. */
const TICK_MEMO_MS = 55_000;

interface TickMemo {
  at: number;
  result: TickResult;
}

/** Module-level, per OnyxBase key (users never share evaluations). */
const tickMemos = new Map<string, TickMemo>();
const tickInFlight = new Map<string, Promise<TickResult>>();

async function runTick(req: NextRequest, trigger: string, force: boolean): Promise<NextResponse> {
  // Key: browser ops send the vault key in the header; cron/external pingers
  // rely on the server env key. Either way, the scheduler state lives in the
  // same OnyxBase account.
  const key = resolveSchedulerKey(req.headers.get("x-onyxbase-key"));
  if (!key) {
    return NextResponse.json(
      { ok: false, error: "NOT_CONFIGURED", message: "No OnyxBase scheduler key configured (neither request header nor server env)." },
      { status: 503 },
    );
  }

  // In-process collapse — cheap answers for the storm of overlapping
  // heartbeats. `force` (manual ticks) always evaluates fresh.
  if (!force) {
    const memo = tickMemos.get(key);
    if (memo && Date.now() - memo.at < TICK_MEMO_MS) {
      return NextResponse.json({ ...memo.result, skipped: "recent-tick" });
    }
    const inFlight = tickInFlight.get(key);
    if (inFlight) {
      // Share the running evaluation — every concurrent caller sees the
      // same outcome (a fired toast, a finalized count) at no extra cost.
      return NextResponse.json(await inFlight);
    }
  }

  const evaluation = (async (): Promise<TickResult> => {
    const kv: SchedulerKV = cachedSchedulerKv(key);
    return tick(kv, { trigger, force });
  })();

  if (!force) {
    tickInFlight.set(key, evaluation);
  }
  try {
    const result = await evaluation;
    if (!force) tickMemos.set(key, { at: Date.now(), result });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "TICK_FAILED", message: e instanceof Error ? e.message : "tick failed" },
      { status: 500 },
    );
  } finally {
    if (!force) tickInFlight.delete(key);
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const trigger = req.headers.get("x-trigger-source") ?? "external";
  return runTick(req, trigger, false);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let trigger = "manual";
  let force = false;
  try {
    const body = (await req.json()) as { trigger?: string; force?: boolean };
    trigger = body.trigger ?? "manual";
    force = body.force === true;
  } catch {
    /* defaults */
  }
  return runTick(req, trigger, force);
}
