// ============================================================================
// GET /api/composio/status — masked connection status.
//
//   Headers: x-composio-key (vault-decrypted), x-composio-session?,
//            x-composio-user?
//
// Verifies the key with a REAL Composio call, verifies the stored session
// still exists (404 → session: null so the UI knows to re-create), and
// summarizes connected accounts (sanitized — no OAuth state ever leaves the
// server). "Connected" is only ever reported after a successful API call.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { authComposio, composioErrorResponse } from "@/lib/composio/server";
import { connectionStateOf } from "@/lib/composio/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const a = authComposio(req);
  if ("error" in a) return a.error;
  const { client, sessionId, composioUserId } = a;

  try {
    // 1) REAL key validation (401 for bad keys — no fake "Connected ✓").
    const validation = await client.validateKey();

    // 2) Session — verify it still exists (missing → null, UI re-creates).
    let session: { sessionId: string; mcpUrl: string | null } | null = null;
    if (sessionId) {
      try {
        const s = await client.getSession(sessionId);
        session = { sessionId: s.session_id, mcpUrl: s.mcp?.url ?? null };
      } catch {
        session = null; // expired/deleted session — not a status failure
      }
    }

    // 3) Connected-accounts summary (sanitized server-side).
    let connections: { total: number; active: number; items: Array<Record<string, unknown>> } = {
      total: 0,
      active: 0,
      items: [],
    };
    try {
      const accounts = await client.listConnectedAccounts({ userId: composioUserId ?? undefined });
      const safeItems = accounts.items.map((acc) => ({
        id: acc.id,
        toolkit: acc.toolkitSlug,
        alias: acc.alias ?? null,
        status: acc.status,
        state: connectionStateOf(acc.status),
        createdAt: acc.createdAt ?? null,
      }));
      connections = {
        total: safeItems.length,
        active: safeItems.filter((i) => i.state === "active").length,
        items: safeItems,
      };
    } catch {
      // Account listing failing shouldn't fail the whole status — the key
      // and session are the critical bits.
    }

    return NextResponse.json({
      ok: true,
      connected: true,
      totalToolkits: validation.totalItems,
      session,
      connections,
    });
  } catch (e) {
    return composioErrorResponse(e);
  }
}
