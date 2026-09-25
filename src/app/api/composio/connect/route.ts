// ============================================================================
// POST /api/composio/connect — validate a Composio API key and create the
// tool-router session.
//
//   Body: { apiKey: string, userId?: string }
//   Headers (alternative key source): x-composio-key (vault-decrypted key
//   when re-validating an already-stored key)
//
// The key is validated with a REAL Composio call (GET /api/v3/toolkits
// limit=1) — no fake success (PRD §38). On success a session is created for
// the Composio user id (the OnyxAgent user id — connected accounts are keyed
// by it and must stay stable). The browser then persists the key
// (vault-encrypted, via settingsService) and the session id (plain).
// The key itself is NEVER echoed, logged, or stored server-side.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { ComposioClient } from "@/lib/composio/client";
import { composioErrorResponse, readJsonBody, resolveComposioKey } from "@/lib/composio/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await readJsonBody(req);
  const bodyKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const headerKey = resolveComposioKey(req.headers.get("x-composio-key"));
  const apiKey = bodyKey || headerKey;
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "BAD_REQUEST", message: "A Composio API key is required." },
      { status: 400 },
    );
  }

  const userId = typeof body.userId === "string" && body.userId.trim() ? body.userId.trim() : "onyxagent";

  try {
    const client = new ComposioClient(apiKey);
    // 1) REAL validation — Composio answers 401 for bad keys.
    const validation = await client.validateKey();
    // 2) Create the tool-router session for this user (reused across turns;
    //    the browser persists the returned session id).
    const session = await client.createSession(userId);
    return NextResponse.json({
      ok: true,
      totalToolkits: validation.totalItems,
      session: {
        sessionId: session.session_id,
        mcpUrl: session.mcp?.url ?? null,
      },
    });
  } catch (e) {
    return composioErrorResponse(e);
  }
}
