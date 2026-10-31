// ============================================================================
// Background Task Execution Framework — POST /api/tasks/schedules/tick
// (Trigger.dev PRD §3.4 — durable cron lane).
//
// The cloud-fired heartbeat: the deployed `scheduled-sweep` task calls this
// endpoint whenever a registered Trigger.dev schedule (mirroring a
// TaskSchedule row's cron + timezone) fires on the operator's cloud
// project. The endpoint authorizes with the SEALED WORKER TOKEN (constant
// time compare), then runs the same sweep the in-process 60s loop runs —
// atomically claim due schedules and dispatch them to the cloud with FRESH
// BYOK credentials (the app is the credential broker; keys are never frozen
// into schedule payloads).
//
// Fallbacks that keep firing schedules when the cloud cron is unavailable
// (read-only serverless filesystem → no sealed worker token → the sweep
// task degrades): the in-process scheduler loop + the throttled
// sweep-on-read touch() from client status polls.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { armDueSchedules, sweepSchedules } from "@/lib/tasks/cron-scheduler";
import { verifyWorkerToken } from "@/lib/tasks/trigger-cloud";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function unauthorized(): NextResponse {
  return NextResponse.json({ ok: false, error: "invalid worker token" }, { status: 401 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!presented || !(await verifyWorkerToken(presented))) {
    return unauthorized();
  }

  try {
    // Arm any schedule that lost its nextRunAt (fresh/recovered), then fire
    // every due occurrence — the same claim/dispatch path as the local loop.
    await armDueSchedules().catch(() => undefined);
    const fired = await sweepSchedules();
    return NextResponse.json({ ok: true, fired });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[tasks] cloud schedule tick failed: ${message.slice(0, 200)}`);
    return NextResponse.json({ ok: false, error: "tick failed" }, { status: 500 });
  }
}
