// ============================================================================
// Server-side helpers for the /api/composio/* routes.
//
// Auth model (mirrors /api/scheduler/tasks — the removed Telegram flow):
// this app is backendless; the Composio API key lives AES-GCM-encrypted in
// the user's browser vault (Dexie `user_settings.extra.composio_api_key_
// encrypted`). The browser decrypts it transiently and sends it with every
// request as the `x-composio-key` header; the server route uses it for one
// Composio call and forgets it — never persisted, never logged, never
// returned. The tool-router session id travels the same way via
// `x-composio-session` (it is not a secret), and the Composio user id via
// `x-composio-user` (connected accounts are keyed by it, so it must stay
// stable — it's the OnyxAgent user id).
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { ComposioClient, ComposioError } from "./client";

/** Resolve the Composio API key: request header (browser, vault-decrypted)
 *  → server env (forward-compat for server-side triggers). Null when
 *  unconfigured. */
export function resolveComposioKey(headerKey: string | null | undefined): string | null {
  const fromHeader = (headerKey ?? "").trim();
  if (fromHeader) return fromHeader;
  const fromEnv = (process.env.COMPOSIO_API_KEY ?? "").trim();
  return fromEnv || null;
}

export interface ComposioRouteAuth {
  client: ComposioClient;
  sessionId: string | null;
  composioUserId: string | null;
}

/** Standard auth for composio routes. Returns a 503 response when no key is
 *  available. NEVER echoes the key back. */
export function authComposio(req: NextRequest): ComposioRouteAuth | { error: NextResponse } {
  const key = resolveComposioKey(req.headers.get("x-composio-key"));
  if (!key) {
    return {
      error: NextResponse.json(
        {
          ok: false,
          error: "NOT_CONFIGURED",
          message:
            "Composio isn't connected yet. Add your Composio API key in Settings → Integrations.",
        },
        { status: 503 },
      ),
    };
  }
  const sessionId = (req.headers.get("x-composio-session") ?? "").trim() || null;
  const composioUserId = (req.headers.get("x-composio-user") ?? "").trim() || null;
  return { client: new ComposioClient(key), sessionId, composioUserId };
}

/** Map a ComposioError to a JSON response with a stable `error` code the
 *  browser + agent tools can branch on. */
export function composioErrorResponse(e: unknown): NextResponse {
  if (e instanceof ComposioError) {
    if (e.isAuthError) {
      return NextResponse.json(
        {
          ok: false,
          error: "INVALID_API_KEY",
          message: "Composio rejected the API key. Re-enter it in Settings → Integrations.",
          detail: e.suggestedFix,
        },
        { status: 401 },
      );
    }
    if (e.isSessionMissing) {
      return NextResponse.json(
        {
          ok: false,
          error: "SESSION_EXPIRED",
          message: "The Composio session no longer exists. A new one will be created on the next call.",
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: e.slug ?? "COMPOSIO_ERROR",
        message: e.message,
        ...(e.requestId ? { requestId: e.requestId } : {}),
        ...(e.suggestedFix ? { detail: e.suggestedFix } : {}),
      },
      { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
    );
  }
  return NextResponse.json(
    {
      ok: false,
      error: "COMPOSIO_UNREACHABLE",
      message: e instanceof Error ? e.message : "Composio request failed",
    },
    { status: 502 },
  );
}

/** Parse a JSON body defensively ({} on invalid JSON). */
export async function readJsonBody(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed = await req.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Session auto-heal
// ---------------------------------------------------------------------------

/** Stable fallback for Composio `user_id` when the caller didn't send one
 *  (connected accounts are keyed by user id, so this must NEVER be random). */
const FALLBACK_COMPOSIO_USER = "onyxagent";

/**
 * Run a session-scoped Composio operation with auto-heal:
 *  - no session id yet → create one first;
 *  - the referenced session was deleted/expired (Composio 404) → create a
 *    fresh one and retry the operation ONCE.
 * Returns the operation result plus the (possibly new) session id — routes
 * echo it so the browser can persist it in settings (plain, not a secret).
 */
export async function runWithSession<T>(
  client: ComposioClient,
  sessionId: string | null,
  composioUserId: string | null,
  op: (sessionId: string) => Promise<T>,
): Promise<{ result: T; sessionId: string; recreated: boolean }> {
  const userId = composioUserId || FALLBACK_COMPOSIO_USER;
  if (!sessionId) {
    const created = await client.createSession(userId);
    return { result: await op(created.session_id), sessionId: created.session_id, recreated: true };
  }
  try {
    return { result: await op(sessionId), sessionId, recreated: false };
  } catch (e) {
    if (e instanceof ComposioError && e.isSessionMissing) {
      const created = await client.createSession(userId);
      return { result: await op(created.session_id), sessionId: created.session_id, recreated: true };
    }
    throw e;
  }
}
