// ============================================================================
// GET /api/composio/connections — the user's connected accounts.
//
//   Headers: x-composio-key, x-composio-user (Composio user id — the
//   OnyxAgent user id used when the session was created)
//
// Proxies GET /api/v3/connected_accounts?user_ids=… with the credentials
// SANITIZED server-side: the raw records carry OAuth tokens/secrets in
// `state`/`data` — only the safe projection (id, toolkit, alias, status,
// timestamps) ever leaves this route.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { authComposio, composioErrorResponse } from "@/lib/composio/server";
import { connectionStateOf } from "@/lib/composio/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const a = authComposio(req);
  if ("error" in a) return a.error;
  const { client, composioUserId } = a;

  try {
    const accounts = await client.listConnectedAccounts({ userId: composioUserId ?? undefined });
    return NextResponse.json({
      ok: true,
      items: accounts.items.map((acc) => ({
        id: acc.id,
        toolkit: acc.toolkitSlug,
        alias: acc.alias ?? null,
        status: acc.status,
        state: connectionStateOf(acc.status),
        createdAt: acc.createdAt ?? null,
        updatedAt: acc.updatedAt ?? null,
      })),
      total: accounts.total_items ?? accounts.items.length,
    });
  } catch (e) {
    return composioErrorResponse(e);
  }
}
