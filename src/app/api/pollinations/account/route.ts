/**
 * POST /api/pollinations/account — authenticated proxy for the OFFICIAL
 * Pollinations account surface (https://gen.pollinations.ai/account/*):
 *
 *   GET  /account/profile        — connected account identity
 *   GET  /account/balance        — Pollen balance (total / Quest tier / paid)
 *   GET  /account/usage[?...]    — per-request usage history (actual costs)
 *   GET  /account/usage/daily    — daily aggregated usage
 *   GET  /account/key            — key validity/permissions
 *   CRUD /account/my-models…     — publish/update/delete community models
 *   CRUD /account/agents…        — publish/update/delete/sync agents
 *   GET  /account/integrations…  — connected apps / wallets
 *
 * The caller's OWN Pollinations key (BYOP sk_...) rides in the Authorization
 * header — same trust model as /api/chat-proxy: the key is the user's, stored
 * vault-encrypted client-side, and only ever forwarded to the official
 * provider. Nothing is logged; the path is whitelisted to /account/* so the
 * route can't be repurposed as an open proxy.
 *
 * Body: { path: "/account/balance", method?: "GET"|"POST"|"PATCH"|"DELETE", query?: Record<string,string|number>, body?: unknown }
 */
import {
  GEN_BASE_URL,
  accountPath,
  clientIp,
  jsonError,
  pfetch,
  rateLimit,
  readUpstreamError,
  userBearerKey,
} from "@/lib/pollinations-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_METHODS = new Set(["GET", "POST", "PATCH", "DELETE"]);
const MAX_BODY_BYTES = 256 * 1024;

export async function POST(req: Request) {
  // Abuse guard: 90 account calls / minute / IP (upstream applies its own
  // limits too — this protects THIS app from runaway loops).
  if (!rateLimit(`pln-account:${clientIp(req)}`, 90, 60_000)) {
    return jsonError({
      status: 429,
      code: "RATE_LIMITED",
      message: "Too many Pollinations account requests — slow down and retry shortly.",
    });
  }

  const key = userBearerKey(req);
  if (!key) {
    return jsonError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Connect your Pollinations account first (Settings → Pollinations AI), or provide a valid API key.",
    });
  }

  let payload: { path?: unknown; method?: unknown; query?: unknown; body?: unknown };
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) throw new Error("body too large");
    payload = raw ? (JSON.parse(raw) as typeof payload) : {};
  } catch {
    return jsonError({ status: 400, code: "BAD_REQUEST", message: "Expected a JSON body {path, method?, query?, body?}." });
  }

  const path = accountPath(payload.path);
  if (!path) {
    return jsonError({
      status: 400,
      code: "BAD_REQUEST",
      message: "`path` must be an official /account/... endpoint path.",
    });
  }
  const method = typeof payload.method === "string" && ALLOWED_METHODS.has(payload.method.toUpperCase())
    ? payload.method.toUpperCase()
    : "GET";

  const upstream = new URL(`${GEN_BASE_URL}${path}`);
  if (payload.query && typeof payload.query === "object" && !Array.isArray(payload.query)) {
    for (const [k, v] of Object.entries(payload.query as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number") {
        upstream.searchParams.set(k.slice(0, 64), String(v).slice(0, 500));
      }
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  };
  let bodyText: string | undefined;
  if (payload.body !== undefined && payload.body !== null && method !== "GET" && method !== "DELETE") {
    bodyText = JSON.stringify(payload.body);
    headers["Content-Type"] = "application/json";
  }

  let res: Response;
  try {
    res = await pfetch(upstream, {
      method,
      headers,
      ...(bodyText !== undefined ? { body: bodyText } : {}),
      cache: "no-store",
      signal: req.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonError({ status: 502, code: "PROVIDER_UNREACHABLE", message: `Pollinations is unreachable: ${message}` });
  }

  if (!res.ok) {
    const err = await readUpstreamError(res);
    return jsonError(err);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    return Response.json({ ok: true, result: null, note: "The endpoint returned a non-JSON body." });
  }
  try {
    const result = await res.json();
    return Response.json({ ok: true, result }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return jsonError({ status: 502, code: "BAD_UPSTREAM_BODY", message: "Pollinations returned an unparseable response." });
  }
}
