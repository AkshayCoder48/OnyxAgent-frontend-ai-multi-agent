// ============================================================================
// POST /api/composio/session — session maintenance actions ("More options").
//
//   Body: { action: "create" | "reset" | "reconnect_all" | "disconnect_all" }
//   Headers: x-composio-key, x-composio-user
//
//   create / reset       → brand-new tool-router session for the user; the
//                          browser persists the returned session id.
//   reconnect_all        → for every currently-connected toolkit, initiate a
//                          FRESH OAuth link (force reconnect) and return the
//                          redirect URLs for the user to open.
//   disconnect_all       → DELETE every connected account of the user on
//                          Composio (explicit, destructive — UI confirms).
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { authComposio, composioErrorResponse, readJsonBody, runWithSession } from "@/lib/composio/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const a = authComposio(req);
  if ("error" in a) return a.error;
  const { client, sessionId, composioUserId } = a;

  const body = await readJsonBody(req);
  const action = typeof body.action === "string" ? body.action : "";
  const userId = composioUserId || "onyxagent";

  try {
    switch (action) {
      case "create":
      case "reset": {
        const session = await client.createSession(userId);
        return NextResponse.json({
          ok: true,
          sessionId: session.session_id,
          mcpUrl: session.mcp?.url ?? null,
        });
      }

      case "reconnect_all": {
        const accounts = await client.listConnectedAccounts({ userId });
        const toolkits = [...new Set(accounts.items.map((acc) => acc.toolkitSlug).filter(Boolean))];
        // Ensure a live session first (auto-create/heal), then link through it.
        const { sessionId: sid } = await runWithSession(client, sessionId, composioUserId, async (s) => s);
        const links: Array<{ toolkit: string; redirectUrl: string | null }> = [];
        for (const toolkit of toolkits) {
          try {
            const link = await client.initiateSessionLink(sid, { toolkit });
            links.push({ toolkit, redirectUrl: link.redirect_url ?? null });
          } catch {
            links.push({ toolkit, redirectUrl: null });
          }
        }
        return NextResponse.json({ ok: true, sessionId: sid, links });
      }

      case "disconnect_all": {
        const accounts = await client.listConnectedAccounts({ userId });
        let removed = 0;
        const failures: string[] = [];
        for (const acc of accounts.items) {
          try {
            await client.deleteConnectedAccount(acc.id);
            removed++;
          } catch {
            failures.push(acc.toolkitSlug);
          }
        }
        return NextResponse.json({
          ok: true,
          removed,
          total: accounts.items.length,
          ...(failures.length ? { failures } : {}),
        });
      }

      default:
        return NextResponse.json(
          {
            ok: false,
            error: "UNKNOWN_ACTION",
            message: `Unknown action: ${action || "(none)"} — use create | reset | reconnect_all | disconnect_all.`,
          },
          { status: 400 },
        );
    }
  } catch (e) {
    return composioErrorResponse(e);
  }
}
