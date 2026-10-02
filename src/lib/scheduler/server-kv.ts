/**
 * SERVER-side OnyxBase KV client for the scheduler.
 *
 * Mirrors the browser client's wire protocol exactly (same endpoints, same
 * collection, same retry/backoff/pacer semantics — see
 * src/lib/onyxbase/kv-client.ts), but imports cleanly inside server routes
 * (no "use client" boundary). All scheduler state (tasks, runs, tick
 * lock) lives in this KV under the user's OnyxBase account, so
 * the schedule survives restarts and works with the browser closed.
 *
 * Durability rules learned from the 9-hour-push incident (commit 4a6a8f0):
 *  - hard per-request timeout (AbortSignal) — never hang a serverless worker
 *  - paced requests (token bucket) with 429/Retry-After adaptation
 *  - retried 401/500/502/503 (multi-instance cold-start roulette)
 *  - writes are issued SEQUENTIALLY by callers (concurrent writes can be
 *    dropped by OnyxBase's durable mirror — see worklog cloud-sync-9hr-fix)
 */

const ONYXBASE_DEFAULT_BASE_URL = "https://onyxbase-chi.vercel.app";
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
  /** WRITE PACER — OnyxBase's durable mirror drops rapid sequential
   *  writes (the 9-hour-push lesson: pace + sequential = durable). A
   *  minimum gap between writes, widened on 429s, recovered on success. */
  private lastWriteAt = 0;
  private minWriteGapMs = 400;

  constructor(apiKey: string, baseUrl?: string | null) {
    this.apiKey = apiKey.trim();
    const raw = (baseUrl ?? ONYXBASE_DEFAULT_BASE_URL).trim();
    this.base = raw.replace(/\/+$/, "");
  }

  private async paceWrite(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastWriteAt;
    if (elapsed < this.minWriteGapMs) {
      await new Promise((r) => setTimeout(r, this.minWriteGapMs - elapsed));
    }
    this.lastWriteAt = Date.now();
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
      if (res.status === 429) {
        this.minWriteGapMs = Math.min(this.minWriteGapMs * 2, 5000);
      } else if (res.ok) {
        this.minWriteGapMs = Math.max(400, Math.floor(this.minWriteGapMs / 2));
      }
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
    await this.paceWrite();
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

// ---------------------------------------------------------------------------
// CachedSchedulerKV — the scheduler request-storm fix
// ---------------------------------------------------------------------------

/**
 * SHORT-TTL READ CACHE (per OnyxBase key).
 *
 * Live-diagnosed (2026-10-03): the browser pollers (sidebar convergence,
 * server-chat pull, scheduler heartbeat — one of each per open client)
 * plus the tick engine's OWN re-reads made every /api/scheduler request do
 * 5-30 SEQUENTIAL OnyxBase roundtrips (listKeys unions, per-task version
 * gets, run envelopes) — 2-5s per "list" and 14-18s per full tick. With
 * several clients polling, those slow requests held the browser's
 * per-origin connection pool open continuously, so the router's RSC fetch
 * for a route change (e.g. Agent ⇄ OnyxCode, Settings) QUEUED BEHIND THEM
 * — the reported "takes 20-40 seconds to navigate" lag.
 *
 * This wrapper caches reads for a few seconds (module-level, so every
 * request on a warm instance shares it) and invalidates precisely on
 * writes. Safety analysis:
 *  - listKeys: invalidated on EVERY set/delete (version records mint NEW
 *    keys, so the key universe changes) — staleness window ≈ the write
 *    itself, same as before.
 *  - get: read-your-write on set; deleted on delete. The tick-lock get is
 *    cached too — the lock is an OPTIMIZATION (run ids are deterministic
 *    per occurrence, double ticks can never double-run a task), and the
 *    in-process tick collapse in the route is now the primary guard.
 */
const KV_CACHE_TTL_MS = 12_000;

interface CacheBox<T> {
  at: number;
  value: T;
}

const kvListCache = new Map<string, CacheBox<string[]>>();
const kvGetCache = new Map<string, CacheBox<string | null>>();

/** Per-key cache scope — users never cross-read each other's state. */
function kvCacheScope(apiKey: string): string {
  let h = 0;
  for (let i = 0; i < apiKey.length; i++) h = (h * 31 + apiKey.charCodeAt(i)) | 0;
  return `${h.toString(36)}:${apiKey.length}`;
}

function pruneKvCaches(): void {
  const cutoff = Date.now() - KV_CACHE_TTL_MS;
  for (const [k, v] of kvListCache) if (v.at < cutoff) kvListCache.delete(k);
  for (const [k, v] of kvGetCache) if (v.at < cutoff) kvGetCache.delete(k);
}

export class CachedSchedulerKV extends SchedulerKV {
  private readonly scope: string;

  constructor(apiKey: string, baseUrl?: string | null) {
    super(apiKey, baseUrl);
    this.scope = kvCacheScope(apiKey.trim());
  }

  async listKeys(prefix: string): Promise<string[]> {
    const key = `${this.scope}:${prefix}`;
    const hit = kvListCache.get(key);
    if (hit && Date.now() - hit.at < KV_CACHE_TTL_MS) return [...hit.value];
    const value = await super.listKeys(prefix);
    kvListCache.set(key, { at: Date.now(), value });
    if (kvListCache.size > 64 || kvGetCache.size > 512) pruneKvCaches();
    return [...value];
  }

  async get(key: string): Promise<string | null> {
    const ck = `${this.scope}:${key}`;
    const hit = kvGetCache.get(ck);
    if (hit && Date.now() - hit.at < KV_CACHE_TTL_MS) return hit.value;
    const value = await super.get(key);
    kvGetCache.set(ck, { at: Date.now(), value });
    if (kvListCache.size > 64 || kvGetCache.size > 512) pruneKvCaches();
    return value;
  }

  /** A write changes the value AND (version records) the key universe. */
  private invalidate(key: string): void {
    kvGetCache.delete(`${this.scope}:${key}`);
    for (const k of kvListCache.keys()) {
      if (k.startsWith(`${this.scope}:`)) kvListCache.delete(k);
    }
  }

  async set(key: string, value: string): Promise<void> {
    await super.set(key, value);
    this.invalidate(key);
    // read-your-write — the next read must observe this write.
    kvGetCache.set(`${this.scope}:${key}`, { at: Date.now(), value });
  }

  async delete(key: string): Promise<void> {
    await super.delete(key);
    this.invalidate(key);
  }
}

/** Construct a read-cached scheduler KV (drop-in for `new SchedulerKV`). */
export function cachedSchedulerKv(apiKey: string, baseUrl?: string | null): CachedSchedulerKV {
  return new CachedSchedulerKV(apiKey, baseUrl);
}
