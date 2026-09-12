"use client";

/**
 * OnyxBase KV REST client (browser-side).
 *
 * Talks directly to the OnyxBase KV API with the user's `kv_live_…` key in
 * the `Authorization: Bearer` header. OnyxBase serves permissive CORS
 * (verified: OPTIONS preflight allows Authorization + Content-Type for
 * arbitrary origins), so no proxy is needed — the key NEVER crosses our
 * server, the LLM, the system prompt, or the E2B sandbox.
 *
 * Endpoints (per https://onyxbase-phi.vercel.app/docs):
 *   POST   /v1/set            { collection?, key, value }
 *   GET    /v1/get/{key}      404 when missing
 *   DELETE /v1/delete/{key}
 *   GET    /v1/list?prefix=…  paginated key listing
 *   GET    /v1/whoami         key verification / account info
 *   GET    /v1/health         per-subsystem status
 *
 * All records live in the deterministic collection "onyxagent".
 */

export const ONYXBASE_DEFAULT_BASE_URL = "https://onyxbase-phi.vercel.app";

/** Fixed, non-secret workspace identifier (PRD §4). Generated once, then
 *  permanent. The model MAY know this — it identifies which workspace the
 *  agent operates on; it is NOT an authentication credential. */
export const ONYXBASE_WORKSPACE_ID = "workspace_default";

/** KV records for the workspace sync live in this collection (created on
 *  first write). Keeps OnyxAgent data separate from anything else the user
 *  stores in their OnyxBase account. */
export const ONYXBASE_COLLECTION = "onyxagent";

/** Machine-readable error codes surfaced by the sync layer (PRD §22).
 *  Internal names use the ONYXBASE_ prefix; user-facing messages stay clean. */
export type OnyxBaseErrorCode =
  | "ONYXBASE_NOT_CONFIGURED"
  | "ONYXBASE_UNAUTHORIZED"
  | "ONYXBASE_UNAVAILABLE"
  | "WORKSPACE_NOT_FOUND"
  | "E2B_UNAVAILABLE"
  | "KV_WRITE_FAILED"
  | "KV_READ_FAILED"
  | "CHECKSUM_MISMATCH"
  | "FILE_TOO_LARGE"
  | "SERIALIZATION_FAILED"
  | "RESTORE_FAILED"
  /** Push from an (near-)empty sandbox that would wipe a non-empty cloud
   *  workspace — refused unless the user explicitly passes force. */
  | "EMPTY_PUSH_BLOCKED";

export class OnyxBaseError extends Error {
  code: OnyxBaseErrorCode;
  status?: number;
  constructor(code: OnyxBaseErrorCode, message: string, status?: number) {
    super(message);
    this.name = "OnyxBaseError";
    this.code = code;
    this.status = status;
  }
}

export interface WhoAmI {
  ok: boolean;
  /** Account user id, e.g. "usr_wb4pes". */
  user?: string;
  /** Key metadata — `name` is the human-readable account name. */
  apiKey?: { id?: string; name?: string; lastUsedAt?: string };
  authenticated?: boolean;
  [k: string]: unknown;
}

function normalizeBaseUrl(raw: string): string {
  let url = (raw || ONYXBASE_DEFAULT_BASE_URL).trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, "");
}

/** Per-request hard timeout. A stalled connection must FAIL into the retry
 *  path — never hang a worker forever (live incident 2026-09-11/12: a push
 *  “ran” for 9+ hours, partly because individual fetches never timed out). */
const REQUEST_TIMEOUT_MS = 25_000;

/**
 * Adaptive request pacer (token bucket).
 *
 * OnyxBase's throughput ceiling is NOT fixed: live 2026-09-12 a burst of
 * 240 concurrent writes all returned 200 in ~12s (~1200/min), but during the
 *  2026-09-11 night incident the same API throttled with 429
 * "Rate limit exceeded (60 req/min)" storms. Fixed-rate assumptions are
 * therefore wrong in BOTH directions — hammering triggers storms, crawling
 * wastes hours.
 *
 * Strategy: pace proactively at a polite default (360/min, burst 6), then
 * adapt: every 429 halves the sustained rate (floor 30/min) and honors the
 * server's Retry-After; a run of clean responses slowly recovers the rate.
 * All requests of one client share ONE pacer, so set/get/delete/list/whoami
 * stay inside the same budget.
 */
class RatePacer {
  private ratePerSec: number;
  private readonly initialRatePerSec: number;
  private readonly minRatePerSec: number;
  private tokens: number;
  private lastRefillAt: number;
  private coolUntil = 0;
  private successRun = 0;

  constructor(initialRatePerMin = 360, minRatePerMin = 30) {
    this.initialRatePerSec = initialRatePerMin / 60;
    this.ratePerSec = this.initialRatePerSec;
    this.minRatePerSec = minRatePerMin / 60;
    this.tokens = 6; // small burst so latency-hiding concurrency still works
    this.lastRefillAt = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefillAt) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(6, this.tokens + elapsed * this.ratePerSec);
      this.lastRefillAt = now;
    }
  }

  async acquire(): Promise<void> {
    for (let i = 0; ; i++) {
      const now = Date.now();
      if (now < this.coolUntil) {
        await new Promise((r) => setTimeout(r, this.coolUntil - now));
        continue;
      }
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.max(25, Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000));
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 5000)));
      if (i > 2000) return; // absolute guard against a pathological loop
    }
  }

  noteThrottled(retryAfterSec?: number): void {
    this.ratePerSec = Math.max(this.minRatePerSec, this.ratePerSec / 2);
    this.tokens = 0;
    this.successRun = 0;
    const ra = Number(retryAfterSec);
    const coolMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : 2000;
    this.coolUntil = Math.max(this.coolUntil, Date.now() + coolMs);
  }

  noteSuccess(): void {
    if (++this.successRun >= 30) {
      this.ratePerSec = Math.min(this.initialRatePerSec, this.ratePerSec * 1.25);
      this.successRun = 0;
    }
  }

  /** Current sustained rate for ETA math (requests per minute). */
  effectiveRatePerMin(): number {
    return Math.round(this.ratePerSec * 60);
  }
}

export class OnyxBaseKV {
  private base: string;
  private apiKey: string;
  private pacer = new RatePacer();

  constructor(apiKey: string, baseUrl?: string | null) {
    if (!apiKey || !apiKey.trim()) {
      throw new OnyxBaseError("ONYXBASE_NOT_CONFIGURED", "OnyxBase API key is not configured");
    }
    this.apiKey = apiKey.trim();
    this.base = normalizeBaseUrl(baseUrl ?? ONYXBASE_DEFAULT_BASE_URL);
  }

  // ---------------------------------------------------------------------
  // Low-level fetch wrapper.
  // ---------------------------------------------------------------------

  /**
   * Response envelope with the server's structured error fields extracted, so
   * every caller can SEE the real reason (rate_limited, auth_backend_unavailable,
   * insufficient_scope …) instead of an opaque "HTTP 500".
   */
  private async req<T>(
    method: "GET" | "POST" | "DELETE",
    pathname: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<{ ok: boolean; status: number; data: T | null; errorDetail?: string; code?: string }> {
    const qs = query
      ? "?" + new URLSearchParams({ collection: ONYXBASE_COLLECTION, ...query }).toString()
      : `?collection=${ONYXBASE_COLLECTION}`;
    // OnyxBase is multi-instance (in-memory index + Telegram mirror): reads
    // can transiently fail with 500 (auth rehydrate error on a cold instance),
    // 502/503 (restarts / "durable backend unreachable"), or 429 (per-key
    // rate caps). 401 can appear briefly for freshly-created keys before an
    // instance rehydrates its identity manifest. Retry all of these with
    // backoff — a genuinely-invalid key still fails after the retries, and a
    // real rate limit is respected via the Retry-After header.
    const MAX_ATTEMPTS = 4;
    let last: { ok: boolean; status: number; data: T | null; errorDetail?: string; code?: string } | null =
      null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(600 * 2 ** (attempt - 1), 4000);
        await new Promise((r) => setTimeout(r, backoff));
      }
      // Paced BEFORE the fetch — the shared token bucket keeps every
      // request of this client (and all its concurrent callers) inside a
      // sustainable rate, so 429 storms never start.
      await this.pacer.acquire();
      let res: Response;
      try {
        res = await fetch(`${this.base}${pathname}${qs}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          // Hard per-request timeout — a stalled connection fails into the
          // retry path instead of hanging a worker for hours.
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        // Network-level failure — retry, then surface as unavailable.
        if (attempt === MAX_ATTEMPTS - 1) {
          throw new OnyxBaseError(
            "ONYXBASE_UNAVAILABLE",
            `Unable to reach OnyxBase (${e instanceof Error ? e.message : "network error"})`,
          );
        }
        continue;
      }
      let data: T | null = null;
      let errorDetail: string | undefined;
      let serverCode: string | undefined;
      const text = await res.text();
      if (text) {
        try {
          const parsed = JSON.parse(text) as {
            error?: unknown;
            code?: unknown;
            value?: unknown;
            [k: string]: unknown;
          };
          data = parsed as T;
          if (typeof parsed.error === "string") errorDetail = parsed.error;
          if (typeof parsed.code === "string") serverCode = parsed.code;
        } catch {
          data = null;
          // Non-JSON body (e.g. an HTML error page) — keep a trimmed hint.
          errorDetail = text.slice(0, 120).replace(/\s+/g, " ");
        }
      }
      last = { ok: res.ok, status: res.status, data, errorDetail, code: serverCode };

      if (res.ok) {
        this.pacer.noteSuccess();
      } else if (res.status === 429) {
        // The pacer adapts (halve rate, honor Retry-After) BEFORE we decide
        // whether to retry — so even the final failed attempt leaves the
        // pacer throttled down for whatever comes next.
        const ra = Number(res.headers.get("retry-after"));
        this.pacer.noteThrottled(Number.isFinite(ra) && ra > 0 ? ra : undefined);
      }

      // Respect Retry-After on 429 (seconds) before the next attempt.
      if (!res.ok && res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
        const ra = Number(res.headers.get("retry-after"));
        if (Number.isFinite(ra) && ra > 0) {
          await new Promise((r) => setTimeout(r, Math.min(ra * 1000, 15_000)));
        }
      }

      const retryable =
        res.status === 401 ||
        res.status === 408 ||
        res.status === 429 ||
        res.status === 500 ||
        res.status === 502 ||
        res.status === 503 ||
        res.status === 504;
      if (res.ok || !retryable || attempt === MAX_ATTEMPTS - 1) return last;
    }
    return last!;
  }

  /** Human-readable reason from a failed response, e.g.
   *  `— rate_limited: Rate limit exceeded (60 req/min)…`. */
  private reason(r: { errorDetail?: string; code?: string }): string {
    const parts: string[] = [];
    if (r.code) parts.push(r.code);
    if (r.errorDetail) parts.push(r.errorDetail);
    return parts.length ? ` — ${parts.join(": ")}` : "";
  }

  // ---------------------------------------------------------------------
  // KV primitives.
  // ---------------------------------------------------------------------

  /** Write a value under a key. Values here are always plain strings
   *  (base64 payload slices) kept well under OnyxBase's ~4 KB record limit.
   *  NOTE: /v1/set reads `collection` from the BODY only (verified against
   *  the live API — the query param is ignored for POST). */
  async set(key: string, value: string): Promise<void> {
    const r = await this.req<{ error?: string }>("POST", "/v1/set", {
      collection: ONYXBASE_COLLECTION,
      key,
      value,
    });
    if (!r.ok) {
      if (r.status === 401) {
        throw new OnyxBaseError("ONYXBASE_UNAUTHORIZED", "OnyxBase rejected the API key", 401);
      }
      // 503 = "durable backend temporarily unreachable" — retryable, not a
      // write failure. Anything else is a real write failure with the
      // server's reason attached.
      if (r.status === 503) {
        throw new OnyxBaseError(
          "ONYXBASE_UNAVAILABLE",
          `OnyxBase is temporarily unreachable${this.reason(r)}`,
          503,
        );
      }
      throw new OnyxBaseError(
        "KV_WRITE_FAILED",
        `KV write failed for ${key} (HTTP ${r.status})${this.reason(r)}`,
        r.status,
      );
    }
  }

  /** Read a value; null when the key doesn't exist (404). */
  async get(key: string): Promise<string | null> {
    const r = await this.req<{ value?: unknown; error?: string }>("GET", `/v1/get/${encodeURIComponent(key)}`);
    if (!r.ok) {
      if (r.status === 404) return null;
      if (r.status === 401) {
        throw new OnyxBaseError("ONYXBASE_UNAUTHORIZED", "OnyxBase rejected the API key", 401);
      }
      if (r.status === 503) {
        throw new OnyxBaseError(
          "ONYXBASE_UNAVAILABLE",
          `OnyxBase is temporarily unreachable${this.reason(r)}`,
          503,
        );
      }
      throw new OnyxBaseError(
        "KV_READ_FAILED",
        `KV read failed for ${key} (HTTP ${r.status})${this.reason(r)}`,
        r.status,
      );
    }
    const v = r.data?.value;
    if (typeof v === "string") return v;
    if (v === undefined || v === null) return null;
    return JSON.stringify(v);
  }

  /** Delete a key (404 → treated as already gone). */
  async delete(key: string): Promise<void> {
    const r = await this.req<{ error?: string }>("DELETE", `/v1/delete/${encodeURIComponent(key)}`);
    if (!r.ok && r.status !== 404) {
      if (r.status === 503) {
        throw new OnyxBaseError(
          "ONYXBASE_UNAVAILABLE",
          `OnyxBase is temporarily unreachable${this.reason(r)}`,
          503,
        );
      }
      throw new OnyxBaseError(
        "KV_WRITE_FAILED",
        `KV delete failed for ${key} (HTTP ${r.status})${this.reason(r)}`,
        r.status,
      );
    }
  }

  /**
   * List all keys under a prefix, following whatever pagination shape
   * OnyxBase returns (defensively parsed — the docs describe pagination
   * without pinning the exact response fields).
   */
  async listKeys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | null = null;
    // Hard cap to avoid infinite pagination loops.
    for (let page = 0; page < 100; page++) {
      const query: Record<string, string> = { prefix };
      if (cursor) query.cursor = cursor;
      const r = await this.req<Record<string, unknown>>("GET", "/v1/list", undefined, query);
      if (!r.ok) {
        if (r.status === 401) {
          throw new OnyxBaseError("ONYXBASE_UNAUTHORIZED", "OnyxBase rejected the API key", 401);
        }
        if (r.status === 503) {
          throw new OnyxBaseError(
            "ONYXBASE_UNAVAILABLE",
            `OnyxBase is temporarily unreachable${this.reason(r)}`,
            503,
          );
        }
        throw new OnyxBaseError(
          "KV_READ_FAILED",
          `KV list failed (HTTP ${r.status})${this.reason(r)}`,
          r.status,
        );
      }
      const d = (r.data ?? {}) as Record<string, unknown>;
      // Accept { keys: [...] } | { records: [...] } | [...] shapes; entries
      // may be strings or { key } objects.
      const raw: unknown =
        Array.isArray(d) ? d : d.keys ?? d.records ?? d.items ?? d.data ?? [];
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (typeof entry === "string") out.push(entry);
          else if (entry && typeof entry === "object" && typeof (entry as { key?: unknown }).key === "string") {
            out.push((entry as { key: string }).key);
          }
        }
      }
      const next = d.cursor ?? d.nextCursor ?? d.next ?? d.page;
      if (typeof next !== "string" || !next || next === cursor) break;
      cursor = next;
      if (!Array.isArray(raw) || raw.length === 0) break;
    }
    return Array.from(new Set(out));
  }

  // ---------------------------------------------------------------------
  // Identity / health.
  // ---------------------------------------------------------------------

  /** Verify the key — returns account info, throws on 401/unreachable. */
  async whoami(): Promise<WhoAmI> {
    const r = await this.req<WhoAmI>("GET", "/v1/whoami");
    if (!r.ok) {
      if (r.status === 401) {
        throw new OnyxBaseError("ONYXBASE_UNAUTHORIZED", "OnyxBase rejected the API key", 401);
      }
      throw new OnyxBaseError(
        "ONYXBASE_UNAVAILABLE",
        `Unable to connect to OnyxBase (HTTP ${r.status})${this.reason(r)}`,
        r.status,
      );
    }
    return r.data ?? { ok: true };
  }

  /** Safe connectivity + subsystem probe. */
  async health(): Promise<Record<string, unknown>> {
    const r = await this.req<Record<string, unknown>>("GET", "/v1/health");
    if (!r.ok) {
      if (r.status === 401) {
        throw new OnyxBaseError("ONYXBASE_UNAUTHORIZED", "OnyxBase rejected the API key", 401);
      }
      throw new OnyxBaseError(
        "ONYXBASE_UNAVAILABLE",
        `OnyxBase health check failed (HTTP ${r.status})${this.reason(r)}`,
        r.status,
      );
    }
    return r.data ?? {};
  }

  /** Current effective request rate (requests/min) after adaptive
   *  throttling — used by the sync engine for ETA + feasibility math. */
  effectiveRatePerMin(): number {
    return this.pacer.effectiveRatePerMin();
  }
}

/** Structural sanity check for kv_live_… keys (no network). */
export function looksLikeOnyxBaseKey(key: string): boolean {
  const k = key.trim();
  return k.length >= 16 && /^[A-Za-z0-9_\-]+$/.test(k);
}
