/**
 * Pollinations server layer — shared helpers for the /api/pollinations/* and
 * /api/auth/pollinations/* routes.
 *
 * OFFICIAL API CONTRACT (https://gen.pollinations.ai/docs — verified against
 * the OpenAPI schema):
 *   - Base URL:          https://gen.pollinations.ai
 *   - Auth:              `Authorization: Bearer sk_...` (or `?key=` — used
 *                         ONLY for the realtime WebSocket where the official
 *                         docs prescribe it; HTTP routes here use the header)
 *   - Auth server (BYOP):https://enter.pollinations.ai  (authorize endpoint +
 *                         /api/oauth/token, OAuth authorization-code + PKCE)
 *   - Media storage:     https://media.pollinations.ai (upload + public GET)
 *
 * SECURITY MODEL:
 *   - The application's own credentials live ONLY in server env vars
 *     (POLLINATIONS_CLIENT_ID — the publishable App Key used as the OAuth
 *     client_id; POLLINATIONS_API_KEY — optional owner secret, never used to
 *     pay for user generations). They are never returned to the browser.
 *   - Each user connects THEIR OWN Pollinations account (BYOP — "Connect User
 *     Wallets"): the OAuth flow returns a scoped user key (sk_...) which the
 *     client stores vault-encrypted and sends as a Bearer header to these
 *     routes, exactly like the app's existing /api/chat-proxy provider keys.
 *     These routes only ever FORWARD that key upstream — never log it, never
 *     persist it.
 *   - Every route validates + whitelists what it forwards (paths, params,
 *     sizes) so the proxy cannot be abused as an open relay.
 */
import { Agent, fetch as undiciFetch } from "undici";

export const GEN_BASE_URL = "https://gen.pollinations.ai";
export const AUTH_BASE_URL = "https://enter.pollinations.ai";
export const MEDIA_BASE_URL = "https://media.pollinations.ai";
export const OAUTH_CALLBACK_PATH = "/api/auth/pollinations/callback";

/** The cookie that carries the in-flight OAuth state + PKCE verifier
 *  (HttpOnly — the browser never sees the verifier). */
export const OAUTH_COOKIE = "onyx_pln_oauth";
export const OAUTH_COOKIE_TTL_S = 600; // 10 min — the code's own lifetime.

/**
 * ZERO-TIMEOUT dispatcher — generation endpoints (video especially) can sit
 * silent for minutes before the first byte. Same rationale as the
 * chat-proxy's STREAM_AGENT (copied verbatim from its proven config).
 */
const POLLINATIONS_AGENT = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connect: { timeout: 30_000 },
});

type UndiciInit = NonNullable<Parameters<typeof undiciFetch>[1]>;
export type PFetchInit = UndiciInit;
/** Cast a browser FormData to undici's BodyInit (runtime-compatible;
 *  type-level mismatch only). */
export function formBody(form: FormData): UndiciInit["body"] {
  return form as unknown as UndiciInit["body"];
}

/** Typed as the GLOBAL Response so route handlers can return it directly
 *  (undici's Response type is structurally incompatible with the DOM one
 *  only at the type level — same runtime object). */
export async function pfetch(url: string | URL, init?: UndiciInit): Promise<Response> {
  const res = await undiciFetch(url, { ...init, dispatcher: POLLINATIONS_AGENT });
  return res as unknown as Response;
}

// ---------------------------------------------------------------------------
// Env + redirect URI.
// ---------------------------------------------------------------------------

/** The publishable App Key (pk_...) used as the OAuth client_id, or null when
 *  the app owner has not configured one (the official docs allow authorizing
 *  without an App Key — traffic is then unattributed). Server-side only. */
export function appClientId(): string | null {
  const v = process.env.POLLINATIONS_CLIENT_ID?.trim();
  return v ? v : null;
}

/** Optional app-owner secret key. Kept server-side; used ONLY for provider
 *  metadata that the docs gate behind an authenticated app context, never to
 *  pay for user generations. */
export function appApiKey(): string | null {
  const v = process.env.POLLINATIONS_API_KEY?.trim();
  return v ? v : null;
}

/** Canonical public origin: NEXT_PUBLIC_APP_URL when set (production), else
 *  derived from the request (proto/host headers — works behind the preview
 *  gateway and local dev). */
export function publicOrigin(req: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (envUrl) return envUrl.replace(/\/+$/, "");
  const h = new Headers(req.headers);
  const forwardedHost = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ??
    (forwardedHost.startsWith("localhost") || forwardedHost.startsWith("127.") ? "http" : "https");
  return `${proto}://${forwardedHost}`;
}

/** The exact redirect_uri registered on the App Key. */
export function oauthRedirectUri(req: Request): string {
  return `${publicOrigin(req)}${OAUTH_CALLBACK_PATH}`;
}

// ---------------------------------------------------------------------------
// Upstream error normalization.
// ---------------------------------------------------------------------------

export interface UpstreamError {
  status: number;
  code: string;
  message: string;
}

/** Pollinations errors are `{status, success:false, error:{code,message}}` —
 *  parse honestly; unknown shapes become a generic-but-truthful error. */
export async function readUpstreamError(res: Response): Promise<UpstreamError> {
  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch {
    /* ignore */
  }
  let code = `HTTP_${res.status}`;
  let message = bodyText.slice(0, 600) || res.statusText || "Pollinations request failed";
  try {
    const parsed = JSON.parse(bodyText);
    const err = parsed?.error;
    if (err && typeof err === "object") {
      if (typeof err.code === "string" && err.code) code = err.code;
      if (typeof err.message === "string" && err.message) message = err.message;
    } else if (typeof parsed?.message === "string") {
      message = parsed.message;
    }
  } catch {
    /* not JSON — keep the raw text */
  }
  return { status: res.status, code, message };
}

export function jsonError(error: UpstreamError, init?: ResponseInit) {
  return Response.json(
    { ok: false, error: { code: error.code, message: error.message, status: error.status } },
    { status: error.status, ...init },
  );
}

// ---------------------------------------------------------------------------
// User key handling.
// ---------------------------------------------------------------------------

const KEY_RE = /^(sk|pk)_[A-Za-z0-9_-]{8,}$/;

/** Extract + shape-validate the caller's Pollinations key from the Bearer
 *  header. Returns null when absent/invalid. */
export function userBearerKey(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const key = m?.[1]?.trim();
  if (!key || !KEY_RE.test(key)) return null;
  return key;
}

// ---------------------------------------------------------------------------
// Media URL resolution (binary generation → shareable URL).
// ---------------------------------------------------------------------------

/** Parse the RFC 8288 `Link: <https://media.pollinations.ai/{id}>; rel="enclosure"`
 *  header the generation endpoints attach to stored results. */
export function mediaLinkFromHeaders(res: Response): string | null {
  const link = res.headers.get("link");
  if (!link) return null;
  for (const part of link.split(",")) {
    const [target, ...params] = part.trim().split(/\s*;\s*/);
    if (params.some((p) => p.toLowerCase() === 'rel="enclosure"' || p.toLowerCase() === "rel=enclosure")) {
      const url = target?.replace(/^<|>$/g, "");
      if (url && /^https?:\/\//i.test(url)) return url;
    }
  }
  return null;
}

const MAX_UPLOAD_BYTES = 380 * 1024 * 1024; // docs: 400 MiB cap — keep a margin.

/** Fallback: upload the generated binary to media.pollinations.ai with the
 *  CALLER'S key (uploads require a user-owned key) and return the stored
 *  public URL. */
export async function uploadMedia(
  key: string,
  bytes: ArrayBuffer,
  contentType: string,
  fileName: string,
): Promise<string | null> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES) return null;
  try {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: contentType || "application/octet-stream" }), fileName);
    const res = await pfetch(`${MEDIA_BASE_URL}/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form as unknown as UndiciInit["body"],
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { url?: string; id?: string };
    if (data.url && typeof data.url === "string") return data.url;
    if (data.id && typeof data.id === "string") return `${MEDIA_BASE_URL}/${data.id}`;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-IP rate limiting (single-instance, in-memory — protects the app's own
// routes from abuse; the provider's own limits apply upstream regardless).
// ---------------------------------------------------------------------------

const RATE_BUCKETS = new Map<string, { count: number; resetAt: number }>();

/** True when the caller may proceed. `windowMs`/`max` tuned per route. */
export function rateLimit(bucket: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = RATE_BUCKETS.get(bucket);
  if (!entry || entry.resetAt <= now) {
    RATE_BUCKETS.set(bucket, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}

/** Periodic sweep so the map cannot grow unbounded. */
if (typeof setInterval === "function") {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of RATE_BUCKETS) if (v.resetAt <= now) RATE_BUCKETS.delete(k);
  }, 60_000);
  // Don't hold the event loop open (Next.js hot-reload safety).
  (timer as unknown as { unref?: () => void }).unref?.();
}

export function clientIp(req: Request): string {
  const h = new Headers(req.headers);
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "local"
  );
}

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------

/** Strip a leading `/` and force a whitelisted prefix (`/account`), blocking
 *  path traversal + SSRF beyond the documented account surface. */
export function accountPath(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let p = raw.trim();
  if (!p.startsWith("/")) p = `/${p}`;
  // No protocol-relative, no .., no backslash, no query injection.
  if (p.includes("..") || p.includes("\\") || p.includes("?")) return null;
  if (!/^\/account(\/[A-Za-z0-9._\-\/]*)?$/.test(p)) return null;
  return p;
}

/** Plain string → safe path segment. */
export function safeSegment(raw: unknown, maxLen = 200): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const v = raw.trim();
  if (v.length > maxLen) return null;
  if (!/^[A-Za-z0-9._:@\-\/+]+$/.test(v)) return null;
  return v;
}
