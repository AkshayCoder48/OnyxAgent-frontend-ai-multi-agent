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
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { SchedulerKV, resolveSchedulerKey } from "@/lib/scheduler/server-kv";
import { tick } from "@/lib/scheduler/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
  try {
    const kv = new SchedulerKV(key);
    const result = await tick(kv, { trigger, force });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "TICK_FAILED", message: e instanceof Error ? e.message : "tick failed" },
      { status: 500 },
    );
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
