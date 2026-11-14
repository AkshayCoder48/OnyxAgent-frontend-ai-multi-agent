// ============================================================================
// Background Task Execution Framework — /api/tasks/prewarm (startup warm).
//
// User directive 2026-11-14: "make it loading on app or web startup so no
// delay" — the app fires this GET once on web-app startup (mount +
// visibilitychange cadence via prewarmCloudHandoff), so the FIRST real
// background dispatch of a session hits warm infrastructure instead of
// paying cold-start costs at decision time:
//
//   · getCloudConfig()  — primes the 30s config cache (sealed key decrypt +
//     Prisma row read happen HERE, not on the first /api/tasks/trigger).
//   · probeWorkerLiveness() — triggers the worker's `health` task and waits
//     for it: the Trigger.dev queue is warm, the deployed task version is
//     verified, and the operator's cloud API TLS session is established.
//     THROTTLED to once per PREWARM_PROBE_MIN_MS (10 min) per server
//     instance — repeated app loads / tab focus never spam health runs.
//   · startSchedulerLoop() — re-arms the 60s schedule tick singleton (same
//     re-arm every other /api/tasks/* route does).
//
// The client call is fire-and-forget (never awaited by the UI), so the ~1-6s
// probe absorbs into page load. Unconfigured servers answer instantly.
// ============================================================================
import { NextResponse } from "next/server";
import { getCloudConfig, probeWorkerLiveness } from "@/lib/tasks/trigger-cloud";
import { startSchedulerLoop } from "@/lib/tasks/cron-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Per-instance probe throttle — one health probe per 10 minutes. */
const PREWARM_PROBE_MIN_MS = 10 * 60 * 1000;

const g = globalThis as unknown as {
  __onyxPrewarmProbeAt?: number;
};

export async function GET() {
  try {
    const config = await getCloudConfig();
    if (!config) {
      // Nothing connected — answer instantly; the client's own mirror-key
      // auto-reconnect (use-cloud-orchestrator) will configure + warm later.
      return NextResponse.json({ ok: true, mode: "off", warmed: false });
    }

    const probedRecently =
      g.__onyxPrewarmProbeAt !== undefined &&
      Date.now() - g.__onyxPrewarmProbeAt < PREWARM_PROBE_MIN_MS;

    let liveness: Awaited<ReturnType<typeof probeWorkerLiveness>> = "unknown";
    if (!probedRecently) {
      g.__onyxPrewarmProbeAt = Date.now();
      // Awaited on purpose: on serverless a fire-and-forget promise can be
      // killed when the response flushes — the warm must actually happen.
      liveness = await probeWorkerLiveness(config).catch(() => "unknown" as const);
    }

    startSchedulerLoop();

    return NextResponse.json({
      ok: true,
      mode: "cloud",
      warmed: true,
      probed: !probedRecently,
      ...(probedRecently ? {} : { liveness }),
    });
  } catch {
    // Never surface warmup failures — prewarm is best-effort by contract.
    return NextResponse.json({ ok: true, mode: "unknown", warmed: false });
  }
}
