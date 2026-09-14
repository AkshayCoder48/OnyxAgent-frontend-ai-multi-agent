// ============================================================================
// GET /api/onyxai/bridge/req?reqId=<id>
//
// The BROWSER's pickup endpoint: returns the FULL OpenAI request body (the
// messages + tools the sandbox assembled — far too big for a KV value) by
// reading the request file straight out of the execution sandbox. This is
// the only payload path that touches the sandbox: everything after this is
// browser → local QVAC → KV deltas.
//
// AUTH: `X-OnyxBase-Key` (the browser's vault key — the same pattern as
// every /api/scheduler route) or the server env key. The queue record must
// exist and still be pending/running.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { Sandbox } from "@e2b/code-interpreter";
import { bridgeKV, readBridgeRequest } from "@/lib/onyxai/bridge-server";
import { BRIDGE_REQ_TTL_MS } from "@/lib/onyxai/bridge-protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function e2bKey(): string | null {
  const k = (process.env.E2B_API_KEY ?? "").trim();
  return k || null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const headerKey = req.headers.get("x-onyxbase-key");
  const kv = bridgeKV(headerKey);
  if (!kv) {
    return NextResponse.json({ ok: false, error: "OnyxBase key not configured" }, { status: 503 });
  }
  const reqId = (req.nextUrl.searchParams.get("reqId") ?? "").trim();
  if (!reqId || reqId.length > 120) {
    return NextResponse.json({ ok: false, error: "reqId required" }, { status: 400 });
  }
  const rec = await readBridgeRequest(kv, reqId);
  if (!rec) {
    return NextResponse.json({ ok: false, error: "request not found" }, { status: 404 });
  }
  if (Date.now() - rec.createdAt > BRIDGE_REQ_TTL_MS) {
    return NextResponse.json({ ok: false, error: "request expired" }, { status: 410 });
  }
  if (rec.status === "done") {
    return NextResponse.json({ ok: false, error: "request already completed" }, { status: 409 });
  }

  const apiKey = e2bKey();
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "E2B key not configured" }, { status: 503 });
  }
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.connect(rec.sandboxId, { apiKey });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: "sandbox unreachable: " + msg }, { status: 502 });
  }
  try {
    const raw = await sandbox.files.read(rec.reqPath, { format: "text" });
    const body = JSON.parse(raw) as Record<string, unknown>;
    return NextResponse.json({
      ok: true,
      reqId,
      model: rec.model,
      round: rec.round ?? null,
      body,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: "failed to read request file: " + msg }, { status: 502 });
  }
}
