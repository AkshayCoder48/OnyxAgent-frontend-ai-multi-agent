// ============================================================================
// GET /api/onyxai/bridge/stream?token=<t>&reqId=<id>&after=<seq>
//
// The E2B sandbox's long-poll for ONE bridged model call: returns the delta
// batches newer than `after` (ascending seq), the terminal `final` when the
// browser finished the call, and `nextAfter` as the next cursor. When
// nothing new is available the invocation WAITS (polling KV every
// BRIDGE_STREAM_POLL_MS) up to BRIDGE_STREAM_WAIT_MS, then answers with the
// (possibly empty) snapshot — the caller immediately re-polls. Short
// invocations keep this inside serverless limits while model calls can take
// minutes.
//
// AUTH: the per-execution bridge token (same as /submit).
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import type { SchedulerKV } from "@/lib/scheduler/server-kv";
import { bridgeKV, checkBridgeToken } from "@/lib/onyxai/bridge-server";
import {
  BRIDGE_REQ_PREFIX,
  BRIDGE_STREAM_POLL_MS,
  BRIDGE_STREAM_WAIT_MS,
  bridgeEvKey,
  bridgeEvSeqOf,
  type BridgeDelta,
  type BridgeFinal,
  type BridgeStreamResponse,
} from "@/lib/onyxai/bridge-protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Snapshot {
  events: { seq: number; deltas: BridgeDelta[] }[];
  final: BridgeFinal | null;
  nextAfter: number;
  /** The queue record is gone (never submitted or GC'd) with no final. */
  gone: boolean;
}

/** Read the request's current state from KV (list keys → read new batches). */
async function snapshot(kv: SchedulerKV, reqId: string, after: number): Promise<Snapshot> {
  const prefix = BRIDGE_REQ_PREFIX + reqId;
  const keys = await kv.listKeys(prefix).catch(() => [] as string[]);
  const evSeqs: number[] = [];
  let final: BridgeFinal | null = null;
  let hasReqRecord = false;
  for (const key of keys) {
    if (key === prefix) {
      hasReqRecord = true;
      continue;
    }
    if (key === prefix + ":final") {
      const raw = await kv.get(key).catch(() => null);
      if (raw) {
        try {
          final = JSON.parse(raw) as BridgeFinal;
        } catch {
          final = null;
        }
      }
      continue;
    }
    const seq = bridgeEvSeqOf(key);
    if (seq !== null) evSeqs.push(seq);
  }
  evSeqs.sort((a, b) => a - b);
  const events: { seq: number; deltas: BridgeDelta[] }[] = [];
  let nextAfter = after;
  for (const seq of evSeqs) {
    if (seq <= after) continue;
    const raw = await kv.get(bridgeEvKey(reqId, seq)).catch(() => null);
    if (!raw) continue;
    try {
      const deltas = JSON.parse(raw) as BridgeDelta[];
      if (Array.isArray(deltas)) events.push({ seq, deltas });
    } catch {
      /* corrupt batch — skipped, but the seq is consumed either way */
    }
    nextAfter = Math.max(nextAfter, seq);
  }
  // gone: nothing at all remains of this request. While pending/running the
  // queue record exists; after completion the browser GC deletes record +
  // final TOGETHER (90s grace — every live poller sees `final` first).
  const gone = !hasReqRecord && !final && evSeqs.length === 0;
  return { events, final, nextAfter, gone };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const kvMaybe = bridgeKV(null); // sandbox path — env key only
  if (!kvMaybe) {
    return NextResponse.json({ ok: false, error: "bridge not configured" }, { status: 503 });
  }
  const kv: SchedulerKV = kvMaybe;
  const token = (req.nextUrl.searchParams.get("token") ?? "").trim();
  const check = await checkBridgeToken(kv, token);
  if (!check.ok) {
    return NextResponse.json({ ok: false, error: check.error ?? "unauthorized" }, { status: check.status });
  }
  const reqId = (req.nextUrl.searchParams.get("reqId") ?? "").trim();
  if (!reqId || reqId.length > 120) {
    return NextResponse.json({ ok: false, error: "reqId required" }, { status: 400 });
  }
  const afterRaw = Number.parseInt(req.nextUrl.searchParams.get("after") ?? "0", 10);
  const after = Number.isFinite(afterRaw) && afterRaw > 0 ? afterRaw : 0;

  const deadline = Date.now() + BRIDGE_STREAM_WAIT_MS;
  for (;;) {
    let snap: Snapshot;
    try {
      snap = await snapshot(kv, reqId, after);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ ok: false, error: "kv read failed: " + msg }, { status: 500 });
    }
    if (snap.final || snap.events.length || snap.gone || Date.now() >= deadline) {
      const payload: BridgeStreamResponse = {
        ok: true,
        events: snap.events,
        final: snap.final,
        nextAfter: snap.nextAfter,
        ...(snap.gone ? { gone: true } : {}),
      };
      return NextResponse.json(payload);
    }
    await new Promise((r) => setTimeout(r, BRIDGE_STREAM_POLL_MS));
  }
}
