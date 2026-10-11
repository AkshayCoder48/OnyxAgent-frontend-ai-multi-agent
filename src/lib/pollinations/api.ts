"use client";

/**
 * Pollinations client API — thin fetch wrappers for OUR OWN server routes
 * (/api/pollinations/*). Every URL is RELATIVE (sandbox-gateway safe). The
 * user's BYOP key rides the Authorization header from the vault — it never
 * appears in a URL, and our routes forward it to the official provider
 * server-side.
 *
 * All model data comes LIVE from the provider through
 * GET /api/pollinations/models (no client-side catalogue caching beyond a
 * single in-flight dedupe — stale lists are a correctness bug here).
 */
import type { PollinationsModel, UsageRow } from "./types";

export class PollinationsApiError extends Error {
  code: string;
  status: number;
  retryAfter?: number;
  constructor(code: string, message: string, status: number, retryAfter?: number) {
    super(message);
    this.name = "PollinationsApiError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

interface ApiErrorShape {
  ok?: false;
  error?: { code?: string; message?: string; status?: number };
}

async function parseError(res: Response, fallback: string): Promise<PollinationsApiError> {
  let code = `HTTP_${res.status}`;
  let message = fallback;
  try {
    const body = (await res.json()) as ApiErrorShape;
    if (body?.error) {
      if (body.error.code) code = body.error.code;
      if (body.error.message) message = body.error.message;
    }
  } catch {
    /* keep fallback */
  }
  const retryAfterHeader = res.headers.get("retry-after");
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;
  return new PollinationsApiError(code, message, res.status, Number.isFinite(retryAfter) ? retryAfter : undefined);
}

// ---------------------------------------------------------------------------
// Live model catalogue.
// ---------------------------------------------------------------------------

let inFlightModels: Promise<PollinationsModel[]> | null = null;

/**
 * Fetch the LIVE catalogue. Fresh every call (server uses no-store); a
 * concurrent identical request is deduped but the NEXT call refetches.
 */
export async function fetchPollinationsModels(signal?: AbortSignal): Promise<PollinationsModel[]> {
  if (inFlightModels) return inFlightModels;
  inFlightModels = (async () => {
    try {
      const res = await fetch(`/api/pollinations/models`, { signal, cache: "no-store" });
      if (!res.ok) throw await parseError(res, "Could not load the Pollinations model catalogue.");
      const data = (await res.json()) as { ok?: boolean; models?: PollinationsModel[] };
      if (!Array.isArray(data.models)) throw new PollinationsApiError("BAD_BODY", "Malformed catalogue response.", 502);
      return data.models;
    } finally {
      inFlightModels = null;
    }
  })();
  return inFlightModels;
}

// ---------------------------------------------------------------------------
// OAuth (BYOP — official authorization-code + PKCE flow).
// ---------------------------------------------------------------------------

export interface OAuthStart {
  ok: boolean;
  authorizeUrl: string;
  redirectUri: string;
  clientIdConfigured: boolean;
  appOrigin: string;
  discoveryNote?: string;
}

export async function startOAuth(): Promise<OAuthStart> {
  const res = await fetch(`/api/pollinations/oauth/start`, { method: "POST", cache: "no-store" });
  if (!res.ok) throw await parseError(res, "Could not start the Pollinations connection flow.");
  return (await res.json()) as OAuthStart;
}

export interface OAuthComplete {
  ok: boolean;
  access_token: string;
  token_type: string;
  expires_at: string;
  scope: string;
  profile: { githubUsername?: string; name?: string; email?: string } | null;
}

export async function completeOAuth(code: string, state: string): Promise<OAuthComplete> {
  const res = await fetch(`/api/pollinations/oauth/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, state }),
    cache: "no-store",
  });
  if (!res.ok) throw await parseError(res, "Could not complete the Pollinations connection.");
  return (await res.json()) as OAuthComplete;
}

// ---------------------------------------------------------------------------
// Account (balance / usage / profile / publish — all through the account
// proxy with the caller's key).
// ---------------------------------------------------------------------------

export async function accountCall<T = unknown>(
  key: string,
  path: string,
  opts: { method?: "GET" | "POST" | "PATCH" | "DELETE"; query?: Record<string, string | number>; body?: unknown } = {},
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`/api/pollinations/account`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ path, method: opts.method ?? "GET", query: opts.query, body: opts.body }),
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw await parseError(res, `Pollinations account call failed (${path}).`);
  const data = (await res.json()) as { ok: boolean; result: T };
  return data.result;
}

export interface BalanceResult {
  balance: number;
  accountBalance?: { total: number; tier: number; paid: number };
}

export async function fetchBalance(key: string, signal?: AbortSignal): Promise<BalanceResult> {
  return accountCall<BalanceResult>(key, "/account/balance", {}, signal);
}

export async function fetchUsage(
  key: string,
  opts: { limit?: number; days?: number } = {},
  signal?: AbortSignal,
): Promise<UsageRow[]> {
  const data = await accountCall<{ usage?: UsageRow[] }>(
    key,
    "/account/usage",
    { query: { limit: opts.limit ?? 50, days: opts.days ?? 30 } },
    signal,
  );
  return Array.isArray(data?.usage) ? data.usage : [];
}

export async function fetchDailyUsage(
  key: string,
  opts: { days?: number } = {},
  signal?: AbortSignal,
): Promise<unknown> {
  return accountCall<unknown>(key, "/account/usage/daily", { query: { days: opts.days ?? 14 } }, signal);
}

export async function fetchProfile(
  key: string,
  signal?: AbortSignal,
): Promise<{ githubUsername?: string; name?: string; email?: string } | null> {
  try {
    return await accountCall<{ githubUsername?: string; name?: string; email?: string }>(
      key,
      "/account/profile",
      {},
      signal,
    );
  } catch {
    return null; // profile needs the `profile` scope — absence is non-fatal
  }
}

// ---------------------------------------------------------------------------
// Generation (the ONLY path for chargeable operations — always called after
// the user's explicit confirmation).
// ---------------------------------------------------------------------------

export interface GenerateResult {
  ok: boolean;
  url: string | null;
  b64?: string;
  contentType: string;
  sizeBytes?: number;
  timeMs: number;
  stored: "provider" | "upload" | "inline";
  usage?: Record<string, string> | null;
}

export async function generateMedia(
  key: string,
  kind: "image" | "video" | "audio" | "3d",
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  const res = await fetch(`/api/pollinations/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ kind, params }),
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw await parseError(res, `Pollinations ${kind} generation failed.`);
  return (await res.json()) as GenerateResult;
}

export interface ChatCompletionResult {
  ok: boolean;
  result: {
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    [key: string]: unknown;
  };
  usage?: Record<string, string> | null;
}

export async function generateText(
  key: string,
  params: {
    model: string;
    prompt?: string;
    messages?: Array<{ role: string; content: string }>;
    system?: string;
    temperature?: number;
    max_tokens?: number;
  },
  signal?: AbortSignal,
): Promise<ChatCompletionResult> {
  const res = await fetch(`/api/pollinations/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ kind: "text", params }),
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw await parseError(res, "Pollinations text generation failed.");
  return (await res.json()) as ChatCompletionResult;
}

export async function generateEmbeddings(
  key: string,
  params: { model: string; input: string | string[]; dimensions?: number },
  signal?: AbortSignal,
): Promise<{ ok: boolean; result: { data?: Array<{ embedding?: number[]; object?: string }>; usage?: unknown } }> {
  const res = await fetch(`/api/pollinations/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ kind: "embeddings", params }),
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw await parseError(res, "Pollinations embeddings failed.");
  return res.json();
}

export async function transcribeAudio(
  key: string,
  params: {
    url: string;
    model: string;
    language?: string;
    prompt?: string;
    response_format?: string;
    speakers_expected?: number;
  },
  signal?: AbortSignal,
): Promise<{ ok: boolean; result?: unknown; transcript?: string; format?: string }> {
  const res = await fetch(`/api/pollinations/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(params),
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw await parseError(res, "Pollinations transcription failed.");
  return res.json();
}
