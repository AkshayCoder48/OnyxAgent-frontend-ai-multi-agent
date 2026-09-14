// ============================================================================
// POST /api/onyxai/bridge/submit — the E2B sandbox enqueues one model call.
//
// The bg-agent runner (inside a scheduled/telegram execution sandbox) calls
// this when the provider is OnyxAI (a LOCAL base URL the sandbox can't
// reach): it writes the full OpenAI request body to a file in its own
// filesystem (no size limit), then submits a tiny queue record here. The
// user's browser (Browser Runtime ON) picks the record up, pulls the request
// body via /api/onyxai/bridge/req, runs it against the local QVAC server
// (localhost — reachable only from that browser) and streams deltas back
// through KV; the sandbox consumes them via /api/onyxai/bridge/stream.
//
// AUTH: the per-execution bridge token (`onyxai:bridge:auth:<token>`,
// written by the engine at launch, expiring with the run). The sandbox never
// holds the OnyxBase key.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { bridgeKV, checkBridgeToken } from "@/lib/onyxai/bridge-server";
import {
  bridgeReqKey,
  BRIDGE_REQ_TTL_MS,
  type BridgeRequestRecord,
} from "@/lib/onyxai/bridge-protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface SubmitBody {
  token?: string;
  reqId?: string;
  sandboxId?: string;
  reqPath?: string;
  model?: string;
  round?: number;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const kv = bridgeKV(null); // sandbox path — env key only
  if (!kv) {
    return NextResponse.json({ ok: false, error: "bridge not configured (no server OnyxBase key)" }, { status: 503 });
  }
  let body: SubmitBody | null = null;
  try {
    body = (await req.json()) as SubmitBody;
  } catch {
    body = null;
  }
  const token = (body?.token ?? "").trim();
  const check = await checkBridgeToken(kv, token);
  if (!check.ok) {
    return NextResponse.json({ ok: false, error: check.error ?? "unauthorized" }, { status: check.status });
  }

  const reqId = (body?.reqId ?? "").trim();
  const sandboxId = (body?.sandboxId ?? "").trim();
  const reqPath = (body?.reqPath ?? "").trim();
  const model = (body?.model ?? "").trim();
  if (!reqId || reqId.length > 120 || !sandboxId || !reqPath || !model) {
    return NextResponse.json({ ok: false, error: "reqId, sandboxId, reqPath and model are required" }, { status: 400 });
  }

  const rec: BridgeRequestRecord = {
    reqId,
    sandboxId,
    reqPath,
    model,
    ...(typeof body?.round === "number" ? { round: body.round } : {}),
    status: "pending",
    createdAt: Date.now(),
  };
  try {
    await kv.set(bridgeReqKey(reqId), JSON.stringify(rec));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: "kv write failed: " + msg }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    reqId,
    // The browser's GC removes the record after the call completes; the TTL
    // is only a safety net for crashed callers.
    ttlMs: BRIDGE_REQ_TTL_MS,
  });
}
