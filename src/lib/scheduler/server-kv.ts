/**
 * SERVER-side OnyxBase KV client for the scheduler.
 *
 * Mirrors the browser client's wire protocol exactly (same endpoints, same
 * collection, same retry/backoff/pacer semantics — see
 * src/lib/onyxbase/kv-client.ts), but imports cleanly inside server routes
 * (no "use client" boundary). All scheduler state (tasks, runs, telegram
 * creds, tick lock) lives in this KV under the user's OnyxBase account, so
 * the schedule survives restarts and works with the browser closed.
 *
 * Durability rules learned from the 9-hour-push incident (commit 4a6a8f0):
 *  - hard per-request timeout (AbortSignal) — never hang a serverless worker
 *  - paced requests (token bucket) with 429/Retry-After adaptation
 *  - retried 401/500/502/503 (multi-instance cold-start roulette)
 *  - writes are issued SEQUENTIALLY by callers (concurrent writes drop
 *    OnyxBase's Telegram mirror durability — see worklog cloud-sync-9hr-fix)
 */

const ONYXBASE_DEFAULT_BASE_URL = "https://onyxbase-phi.vercel.app";
const ONYXBASE_COLLECTION = "onyxagent";
/** Hung connections (rare but real) burn the full timeout; healthy calls
 *  land in 0.2-2s. Reads: 8s × 3 attempts; writes: 15s × 4 (durability). */
const READ_TIMEOUT_MS = 8_000;
const WRITE_TIMEOUT_MS = 15_000;
const READ_ATTEMPTS = 3;
const WRITE_ATTEMPTS = 4;

export class SchedulerKV {
  private base: string;
  private apiKey: string;

  constructor(apiKey: string, baseUrl?: string | null) {
    this.apiKey = apiKey.trim();
    const raw = (baseUrl ?? ONYXBASE_DEFAULT_BASE_URL).trim();
    this.base = raw.replace(/\/+$/, "");
  }

  private async req<T>(
    method: "GET" | "POST" | "DELETE",
    pathname: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<{ ok: boolean; status: number; data: T | null; errorDetail?: string; code?: string }> {
    const qs = query
      ? "?" + new URLSearchParams({ collection: ONYXBASE_COLLECTION, ...query }).toString()
      : `?collection=${ONYXBASE_COLLECTION}`;
    const isWrite = method === "POST" && pathname === "/v1/set";
    const MAX_ATTEMPTS = isWrite ? WRITE_ATTEMPTS : READ_ATTEMPTS;
    const timeoutMs = isWrite ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS;
    let last: { ok: boolean; status: number; data: T | null; errorDetail?: string; code?: string } | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        // Light backoffs — the 401/5xx roulette (cold-instance auth
        // rehydrate / restarts) clears within a few hundred ms; heavy
        // backoffs made simple list reads take 40s+.
        const backoff = Math.min(300 * 2 ** (attempt - 1), 1200);
        await new Promise((r) => setTimeout(r, backoff));
      }
      let res: Response;
      try {
        res = await fetch(`${this.base}${pathname}${qs}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        if (attempt === MAX_ATTEMPTS - 1) {
          return { ok: false, status: 0, data: null, errorDetail: "network unreachable" };
        }
        continue;
      }
      let data: T | null = null;
      let errorDetail: string | undefined;
      let serverCode: string | undefined;
      const text = await res.text();
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: unknown; code?: unknown };
          data = parsed as T;
          if (typeof parsed.error === "string") errorDetail = parsed.error;
          if (typeof parsed.code === "string") serverCode = parsed.code;
        } catch {
          errorDetail = text.slice(0, 120).replace(/\s+/g, " ");
        }
      }
      last = { ok: res.ok, status: res.status, data, errorDetail, code: serverCode };
      if (!res.ok && res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
        const ra = Number(res.headers.get("retry-after"));
        if (Number.isFinite(ra) && ra > 0) {
          await new Promise((r) => setTimeout(r, Math.min(ra * 1000, 15_000)));
        }
      }
      const retryable =
        res.status === 401 || res.status === 408 || res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504;
      if (res.ok || !retryable || attempt === MAX_ATTEMPTS - 1) return last!;
    }
    return last!;
  }

  async set(key: string, value: string): Promise<void> {
    const r = await this.req<{ error?: string }>("POST", "/v1/set", {
      collection: ONYXBASE_COLLECTION,
      key,
      value,
    });
    if (!r.ok) {
      throw new Error(`KV write failed for ${key} (HTTP ${r.status})${r.errorDetail ? " — " + r.errorDetail : ""}`);
    }
  }

  async get(key: string): Promise<string | null> {
    const r = await this.req<{ value?: unknown }>("GET", `/v1/get/${encodeURIComponent(key)}`);
    if (!r.ok) {
      if (r.status === 404) return null;
      throw new Error(`KV read failed for ${key} (HTTP ${r.status})${r.errorDetail ? " — " + r.errorDetail : ""}`);
    }
    const v = r.data?.value;
    if (typeof v === "string") return v;
    if (v === undefined || v === null) return null;
    return JSON.stringify(v);
  }

  async delete(key: string): Promise<void> {
    const r = await this.req<{ error?: string }>("DELETE", `/v1/delete/${encodeURIComponent(key)}`);
    if (!r.ok && r.status !== 404) {
      throw new Error(`KV delete failed for ${key} (HTTP ${r.status})${r.errorDetail ? " — " + r.errorDetail : ""}`);
    }
  }

  async listKeys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const query: Record<string, string> = { prefix };
      if (cursor) query.cursor = cursor;
      const r = await this.req<Record<string, unknown>>("GET", "/v1/list", undefined, query);
      if (!r.ok) {
        if (r.status === 404) return out;
        throw new Error(`KV list failed (HTTP ${r.status})${r.errorDetail ? " — " + r.errorDetail : ""}`);
      }
      const d = (r.data ?? {}) as Record<string, unknown>;
      const raw: unknown = Array.isArray(d) ? d : d.keys ?? d.records ?? d.items ?? d.data ?? [];
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
    }
    return out;
  }

  async whoami(): Promise<{ ok: boolean; user?: string; keyName?: string; error?: string }> {
    const r = await this.req<{ user?: string; apiKey?: { name?: string } }>("GET", "/v1/whoami");
    if (!r.ok) {
      return { ok: false, error: r.errorDetail ?? `HTTP ${r.status}` };
    }
    return { ok: true, user: r.data?.user, keyName: r.data?.apiKey?.name };
  }
}

/** Resolve the scheduler's OnyxBase key: request header (browser ops, key
 * resolved from the encrypted vault client-side) → server env (cron/external
 * pinger with the browser closed). Returns null when unconfigured. */
export function resolveSchedulerKey(headerKey: string | null | undefined): string | null {
  const fromHeader = (headerKey ?? "").trim();
  if (fromHeader) return fromHeader;
  const fromEnv = (process.env.ONYXBASE_SCHEDULER_KEY ?? "").trim();
  return fromEnv || null;
}
