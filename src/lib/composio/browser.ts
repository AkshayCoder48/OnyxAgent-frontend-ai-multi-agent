"use client";

// ============================================================================
// Composio browser service — the ONE place that resolves the vault key and
// talks to our /api/composio/* proxy routes.
//
// Flow (mirrors the removed Telegram flow's X-OnyxBase-Key pattern):
//   1. The API key is stored AES-GCM-encrypted in Dexie
//      (`user_settings.extra.composio_api_key_encrypted`).
//   2. On every call the browser decrypts it transiently and sends it as the
//      `x-composio-key` header; the server route uses it once and forgets it.
//      It is NEVER logged, NEVER put into tool arguments, and NEVER shown
//      again after save.
//   3. The tool-router session id (`trs_…`, not a secret) is stored PLAIN in
//      settings and travels via `x-composio-session` so the same session is
//      reused across prompts and page refreshes.
//   4. The Composio user id is the OnyxAgent user id — connected accounts
//      are keyed by it, so it must stay stable forever.
// ============================================================================

import { settingsService } from "@/lib/services";

/** Auth headers for a Composio proxy call (string map so it spreads
 *  cleanly into fetch inits). */
export type ComposioHeaders = Record<string, string>;

/** Structural check for Composio project API keys (opaque tokens). */
export function looksLikeComposioKey(key: string): boolean {
  return /^[A-Za-z0-9_\-]{10,}$/.test(key.trim());
}

/**
 * Resolve the auth headers for a Composio proxy call.
 * Returns null when Composio isn't connected (no stored key / vault locked).
 */
export async function resolveComposioHeaders(userId: string): Promise<ComposioHeaders | null> {
  let apiKey: string | null = null;
  try {
    apiKey = await settingsService.getDecryptedComposioApiKey(userId);
  } catch {
    apiKey = null;
  }
  if (!apiKey) return null;
  const settings = await settingsService.get(userId).catch(() => null);
  const sessionId = settings?.composio_session_id ?? null;
  const headers: ComposioHeaders = {
    "x-composio-key": apiKey,
    "x-composio-user": userId,
  };
  if (sessionId) headers["x-composio-session"] = sessionId;
  return headers;
}

/** Persist a (possibly new/healed) session id echoed by a proxy route. */
export async function persistComposioSessionId(userId: string, sessionId: string): Promise<void> {
  try {
    await settingsService.setComposioSessionId(userId, sessionId);
  } catch {
    // Non-fatal — the next call just heals the session again.
  }
}

// ---------------------------------------------------------------------------
// Typed responses (mirrors the routes)
// ---------------------------------------------------------------------------

export interface ComposioStatus {
  connected: boolean;
  totalToolkits: number;
  session: { sessionId: string; mcpUrl: string | null } | null;
  connections: {
    total: number;
    active: number;
    items: Array<{ id: string; toolkit: string; alias: string | null; status: string; state: string; createdAt: string | null }>;
  };
}

export interface ComposioToolkitCard {
  slug: string;
  name: string;
  description: string | null;
  logo: string | null;
  appUrl: string | null;
  categories: string[];
  toolsCount: number;
  noAuth: boolean;
}

export interface ComposioToolkitsResponse {
  ok: true;
  items: ComposioToolkitCard[];
  nextCursor: string | null;
  totalItems: number | null;
  categories?: Array<{ id: string; name: string }>;
  cached: boolean;
}

export interface ComposioConnectionItem {
  id: string;
  toolkit: string;
  alias: string | null;
  status: string;
  state: "active" | "initializing" | "expired" | "error" | string;
  createdAt: string | null;
}

interface ApiErrorShape {
  ok?: false;
  error?: string;
  message?: string;
}

async function jsonFetch<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => null)) as (T & ApiErrorShape) | null;
  if (!res.ok || !data || (data as { ok?: boolean }).ok === false) {
    const err = data as ApiErrorShape | null;
    throw new Error(err?.message || `Request failed (HTTP ${res.status})`);
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// API wrappers
// ---------------------------------------------------------------------------

/** POST /api/composio/connect — validate the typed key + create session. */
export async function apiComposioConnect(input: {
  apiKey: string;
  userId: string;
}): Promise<{ ok: true; totalToolkits: number; session: { sessionId: string; mcpUrl: string | null } }> {
  return jsonFetch("/api/composio/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** GET /api/composio/status — masked live status (requires headers). */
export async function apiComposioStatus(headers: ComposioHeaders): Promise<ComposioStatus> {
  return jsonFetch<ComposioStatus>("/api/composio/status", { headers, cache: "no-store" });
}

/** GET /api/composio/toolkits — catalog page (server-side search/pagination). */
export async function apiComposioToolkits(
  headers: ComposioHeaders,
  params: { cursor?: string; search?: string; category?: string; limit?: number; withCategories?: boolean } = {},
): Promise<ComposioToolkitsResponse> {
  const qs = new URLSearchParams();
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.search) qs.set("search", params.search);
  if (params.category) qs.set("category", params.category);
  qs.set("limit", String(params.limit ?? 100));
  if (params.withCategories) qs.set("withCategories", "1");
  const raw = await jsonFetch<{
    ok: true;
    items: Array<{
      slug: string;
      name: string;
      no_auth?: boolean;
      meta?: { description?: string; logo?: string; app_url?: string; categories?: Array<{ id: string }>; tools_count?: number };
    }>;
    nextCursor: string | null;
    totalItems: number | null;
    categories?: Array<{ id: string; name: string }>;
    cached: boolean;
  }>(`/api/composio/toolkits?${qs.toString()}`, { headers, cache: "no-store" });
  return {
    ok: true,
    items: raw.items.map((t) => ({
      slug: t.slug,
      name: t.name,
      description: t.meta?.description ?? null,
      logo: t.meta?.logo ?? null,
      appUrl: t.meta?.app_url ?? null,
      categories: (t.meta?.categories ?? []).map((c) => c.id),
      toolsCount: t.meta?.tools_count ?? 0,
      noAuth: t.no_auth === true,
    })),
    nextCursor: raw.nextCursor,
    totalItems: raw.totalItems,
    categories: raw.categories,
    cached: raw.cached,
  };
}

/** POST /api/composio/connect-platform — OAuth redirect URL for a toolkit. */
export async function apiComposioConnectPlatform(
  headers: ComposioHeaders,
  toolkitSlug: string,
): Promise<{ ok: true; sessionId: string; redirectUrl: string; connectedAccountId: string | null }> {
  return jsonFetch("/api/composio/connect-platform", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ toolkitSlug }),
  });
}

/** GET /api/composio/connections — sanitized connected accounts. */
export async function apiComposioConnections(
  headers: ComposioHeaders,
): Promise<{ ok: true; items: ComposioConnectionItem[]; total: number }> {
  return jsonFetch("/api/composio/connections", { headers, cache: "no-store" });
}

/** POST /api/composio/session — maintenance actions. */
export async function apiComposioSessionAction(
  headers: ComposioHeaders,
  action: "create" | "reset" | "reconnect_all" | "disconnect_all",
): Promise<{
  ok: true;
  sessionId?: string;
  mcpUrl?: string | null;
  links?: Array<{ toolkit: string; redirectUrl: string | null }>;
  removed?: number;
  total?: number;
}> {
  return jsonFetch("/api/composio/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ action }),
  });
}

/** POST /api/composio/tools/search — session tool discovery (agent path). */
export async function apiComposioToolSearch(
  headers: ComposioHeaders,
  query: string,
): Promise<{
  ok: true;
  sessionId: string;
  tools: Array<{ slug: string; toolkit: string | null; description: string | null; inputSchema: Record<string, unknown> | null }>;
  connections: Array<{ toolkit: string; connected: boolean; statusMessage: string | null }>;
  guidance?: string[];
}> {
  return jsonFetch("/api/composio/tools/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ query }),
  });
}

/** POST /api/composio/tools/execute — session-scoped tool execution. */
export async function apiComposioToolExecute(
  headers: ComposioHeaders,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; sessionId: string; data: unknown; logId?: string; toolError?: string }> {
  return jsonFetch("/api/composio/tools/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ toolName, args }),
  });
}
