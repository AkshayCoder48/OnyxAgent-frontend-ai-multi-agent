"use client";

/**
 * OnyxBase Files REST client (browser-side).
 *
 * OnyxBase is not just a KV store — it also hosts FILES (up to 50 MB via the
 * cloud Bot API, 2 GB with a self-hosted local Bot API server) with signed,
 * revocable download links. This client surfaces that capability for the
 * Knowledge Base: the agent (and the KB tab) can host an important generated
 * file in the user's OnyxBase account and mint a fresh public download link
 * for it — persistence that survives sandbox restarts, chat deletion and
 * browser sessions.
 *
 * Endpoints (per https://onyxbase-chi.vercel.app/llms.txt §5 + OpenAPI):
 *   POST   /v1/files              multipart (file, label?, public?) → file meta
 *   GET    /v1/files              list files (+ maxFileUploadBytes)
 *   GET    /v1/files/{id}         file metadata
 *   POST   /v1/files/{id}/link    mint a fresh signed ~55-min download URL
 *                                 → { url, proxyUrl, expiresAt, expiresInSec, revocable }
 *   POST   /v1/files/{id}/revoke  drop the cached Telegram URL
 *   DELETE /v1/files/{id}         permanently delete the file
 *   GET    /v1/stats              account usage statistics
 *
 * CORS: same permissive policy as the KV API (Authorization + Content-Type
 * allowed for arbitrary origins), so the key NEVER crosses our server —
 * it is resolved from the encrypted vault in the browser at call time.
 *
 * Rate discipline: Knowledge-Base operations are low-frequency (a save, a
 * search, a link mint), so this client uses the SAME adaptive-pacer budget
 * pattern as the KV client but a standalone, simpler instance: hard
 * per-request timeout, bounded retries on the retryable statuses
 * (401/408/429/5xx — OnyxBase is multi-instance and transiently fails
 * cold reads), Retry-After honored on 429.
 */

import { OnyxBaseError, ONYXBASE_DEFAULT_BASE_URL } from "./kv-client";

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

/** A hosted file row as OnyxBase returns it (defensively typed — the API
 *  adds fields; we read the ones we know about and keep the rest). */
export interface OnyxBaseFile {
  /** Internal record id (used for /v1/files/{id} paths). */
  id: string;
  /** Public file id — the permanent `/f/{fileId}` proxy slug. */
  fileId?: string;
  /** Original file name. */
  name?: string;
  /** Human label (optional, set at upload). */
  label?: string;
  /** Byte size. */
  size?: number;
  /** MIME type, when captured. */
  type?: string;
  /** Upload timestamp (ISO string or epoch millis — normalized on read). */
  uploadedAt?: string;
  createdAt?: string;
  /** Whether the file is flagged public. */
  isPublic?: boolean;
  /** Download counter, when tracked. */
  downloads?: number;
  [k: string]: unknown;
}

/** Response of POST /v1/files/{id}/link. */
export interface OnyxBaseFileLink {
  /** Fresh Telegram cloud URL (expires on its own ~1h clock). */
  url: string;
  /** Same-origin proxy URL (`/f/<fileId>?t=…&e=…`) — the one to share. */
  proxyUrl: string;
  /** Expiry epoch millis of the signed token. */
  expiresAt?: number;
  /** Seconds until expiry. */
  expiresInSec?: number;
  revocable?: boolean;
}

/** GET /v1/files listing result. */
export interface OnyxBaseFilesListing {
  files: OnyxBaseFile[];
  /** Effective per-file upload ceiling in bytes (50 MB cloud / 2 GB local). */
  maxFileUploadBytes?: number;
}

/** Account usage snapshot from /v1/stats (fields normalized defensively). */
export interface OnyxBaseUsage {
  records?: number;
  collections?: number;
  apiKeys?: number;
  logs?: number;
  files?: number;
  fileBytes?: number;
  /** Extra/unknown fields passthrough. */
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Client.
// ---------------------------------------------------------------------------

/** Per-request hard timeout — a stalled fetch must fail into the retry path. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Bounded retry attempts for the retryable statuses. */
const MAX_ATTEMPTS = 3;

function normalizeBaseUrl(raw: string): string {
  let url = (raw || ONYXBASE_DEFAULT_BASE_URL).trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, "");
}

export class OnyxBaseFiles {
  private base: string;
  private apiKey: string;

  constructor(apiKey: string, baseUrl?: string | null) {
    if (!apiKey || !apiKey.trim()) {
      throw new OnyxBaseError("ONYXBASE_NOT_CONFIGURED", "OnyxBase API key is not configured");
    }
    this.apiKey = apiKey.trim();
    this.base = normalizeBaseUrl(baseUrl ?? ONYXBASE_DEFAULT_BASE_URL);
  }

  /** Low-level request wrapper with timeout + bounded retry (see header). */
  private async req<T>(
    method: "GET" | "POST" | "DELETE",
    pathname: string,
    init?: { body?: BodyInit; headers?: Record<string, string> },
  ): Promise<{ ok: boolean; status: number; data: T | null; errorDetail?: string; code?: string }> {
    let last: { ok: boolean; status: number; data: T | null; errorDetail?: string; code?: string } | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(600 * 2 ** (attempt - 1), 4000);
        await new Promise((r) => setTimeout(r, backoff));
      }
      let res: Response;
      try {
        res = await fetch(`${this.base}${pathname}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            ...(init?.headers ?? {}),
          },
          ...(init?.body !== undefined ? { body: init.body } : {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        if (attempt === MAX_ATTEMPTS - 1) {
          throw new OnyxBaseError(
            "ONYXBASE_UNAVAILABLE",
            `Unable to reach OnyxBase (${e instanceof Error ? e.message : "network error"})`,
          );
        }
        continue;
      }
      // 429 → honor Retry-After before the next attempt.
      if (res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
        const ra = Number(res.headers.get("retry-after"));
        if (Number.isFinite(ra) && ra > 0) {
          await new Promise((r) => setTimeout(r, Math.min(ra * 1000, 15_000)));
        }
      }
      let data: T | null = null;
      let errorDetail: string | undefined;
      let serverCode: string | undefined;
      const text = await res.text();
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: unknown; code?: unknown; [k: string]: unknown };
          data = parsed as T;
          if (typeof parsed.error === "string") errorDetail = parsed.error;
          if (typeof parsed.code === "string") serverCode = parsed.code;
        } catch {
          errorDetail = text.slice(0, 120).replace(/\s+/g, " ");
        }
      }
      last = { ok: res.ok, status: res.status, data, errorDetail, code: serverCode };
      const retryable =
        res.status === 401 || res.status === 408 || res.status === 429 || res.status >= 500;
      if (res.ok || !retryable || attempt === MAX_ATTEMPTS - 1) return last;
    }
    return last!;
  }

  /** Structured failure → OnyxBaseError (shared with the KV client). */
  private fail(r: { status: number; errorDetail?: string; code?: string }, what: string): OnyxBaseError {
    const reason = [r.code, r.errorDetail].filter(Boolean).join(": ");
    if (r.status === 401) {
      return new OnyxBaseError("ONYXBASE_UNAUTHORIZED", "OnyxBase rejected the API key", 401);
    }
    if (r.status === 503) {
      return new OnyxBaseError(
        "ONYXBASE_UNAVAILABLE",
        `OnyxBase is temporarily unreachable${reason ? ` — ${reason}` : ""}`,
        503,
      );
    }
    return new OnyxBaseError("KV_WRITE_FAILED", `${what} failed (HTTP ${r.status})${reason ? ` — ${reason}` : ""}`, r.status);
  }

  // -------------------------------------------------------------------------
  // Files API.
  // -------------------------------------------------------------------------

  /** List hosted files. Accepts `{files:[…]}` / `{files:{…}}` / bare-array
   *  response shapes defensively. */
  async list(): Promise<OnyxBaseFilesListing> {
    const r = await this.req<Record<string, unknown>>("GET", "/v1/files");
    if (!r.ok) throw this.fail(r, "Listing files");
    const d = r.data ?? {};
    const rawFiles: unknown = Array.isArray(d) ? d : (d.files ?? d.items ?? d.data ?? []);
    const files = Array.isArray(rawFiles)
      ? rawFiles
          .map((f) => normalizeFile(f))
          .filter((f): f is OnyxBaseFile => f !== null)
      : [];
    const max = d.maxFileUploadBytes ?? d.maxFileBytes;
    return {
      files,
      maxFileUploadBytes: typeof max === "number" ? max : undefined,
    };
  }

  /** File metadata by id. Null when missing (404). */
  async getMeta(id: string): Promise<OnyxBaseFile | null> {
    const r = await this.req<Record<string, unknown>>("GET", `/v1/files/${encodeURIComponent(id)}`);
    if (!r.ok) {
      if (r.status === 404) return null;
      throw this.fail(r, "Reading file metadata");
    }
    const d = r.data ?? {};
    const candidate = (d.file ?? d) as unknown;
    return normalizeFile(candidate);
  }

  /**
   * Upload a file (multipart). `blob` carries the bytes; `name` sets the
   * filename; optional `label` is the human-facing label OnyxBase shows.
   * Returns the created file metadata.
   */
  async upload(
    blob: Blob,
    opts?: { name?: string; label?: string; isPublic?: boolean },
  ): Promise<OnyxBaseFile> {
    const fd = new FormData();
    const name = opts?.name ?? (blob instanceof File ? blob.name : "file");
    try {
      fd.append("file", blob, name);
    } catch {
      // Some Blob implementations reject the name argument — retry bare.
      fd.append("file", blob);
    }
    if (opts?.label) fd.append("label", opts.label);
    if (opts?.isPublic !== undefined) fd.append("public", opts.isPublic ? "true" : "false");
    const r = await this.req<Record<string, unknown>>("POST", "/v1/files", {
      body: fd,
      // NOTE: never set Content-Type for multipart — the browser must
      // generate the boundary.
    });
    if (!r.ok) throw this.fail(r, "Uploading file");
    const d = r.data ?? {};
    const candidate = (d.file ?? d) as unknown;
    const file = normalizeFile(candidate);
    if (!file) {
      throw new OnyxBaseError("SERIALIZATION_FAILED", "OnyxBase returned no file metadata for the upload");
    }
    return file;
  }

  /**
   * Mint a fresh signed download link (~55 min). The `proxyUrl` is the one
   * to hand out — it streams through the OnyxBase origin (`/f/<fileId>`).
   */
  async mintLink(id: string): Promise<OnyxBaseFileLink> {
    const r = await this.req<Record<string, unknown>>("POST", `/v1/files/${encodeURIComponent(id)}/link`);
    if (!r.ok) throw this.fail(r, "Minting a file link");
    const d = r.data ?? {};
    const url = typeof d.url === "string" ? d.url : "";
    const proxyUrl =
      typeof d.proxyUrl === "string"
        ? d.proxyUrl
        : typeof d.link === "string"
          ? (d.link as string)
          : url;
    if (!url && !proxyUrl) {
      throw new OnyxBaseError("KV_READ_FAILED", "OnyxBase returned no URL for the file link");
    }
    return {
      url,
      proxyUrl,
      expiresAt: typeof d.expiresAt === "number" ? d.expiresAt : undefined,
      expiresInSec: typeof d.expiresInSec === "number" ? d.expiresInSec : undefined,
      revocable: typeof d.revocable === "boolean" ? d.revocable : undefined,
    };
  }

  /** Drop the cached Telegram URL (the next mintLink pulls a new one). */
  async revoke(id: string): Promise<void> {
    const r = await this.req<Record<string, unknown>>("POST", `/v1/files/${encodeURIComponent(id)}/revoke`);
    if (!r.ok && r.status !== 404) throw this.fail(r, "Revoking the file link");
  }

  /** Permanently delete a hosted file (record + Telegram document). */
  async deleteFile(id: string): Promise<void> {
    const r = await this.req<Record<string, unknown>>("DELETE", `/v1/files/${encodeURIComponent(id)}`);
    if (!r.ok && r.status !== 404) throw this.fail(r, "Deleting the file");
  }

  // -------------------------------------------------------------------------
  // Usage.
  // -------------------------------------------------------------------------

  /** Account usage statistics (records / collections / files counts …). */
  async stats(): Promise<OnyxBaseUsage> {
    const r = await this.req<Record<string, unknown>>("GET", "/v1/stats");
    if (!r.ok) throw this.fail(r, "Reading usage stats");
    const d = r.data ?? {};
    const counts = (d.counts ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;
    return {
      records: num(d.records ?? d.recordCount ?? counts.records),
      collections: num(d.collections ?? d.collectionCount ?? counts.collections),
      apiKeys: num(d.apiKeys ?? counts.apiKeys),
      logs: num(d.logs ?? counts.logs),
      files: num(d.files ?? d.fileCount ?? counts.files),
      fileBytes: num(d.fileBytes ?? d.filesBytes ?? d.bytes),
      raw: d,
    };
  }
}

// ---------------------------------------------------------------------------
// Normalization helpers.
// ---------------------------------------------------------------------------

/** Coerce one unknown row into an OnyxBaseFile (null when unusable). */
function normalizeFile(candidate: unknown): OnyxBaseFile | null {
  if (!candidate || typeof candidate !== "object") return null;
  const f = candidate as Record<string, unknown>;
  const id = typeof f.id === "string" ? f.id : typeof f.fileId === "string" ? f.fileId : null;
  if (!id) return null;
  const ts = (v: unknown): string | undefined => {
    if (typeof v === "string") return v;
    if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
    return undefined;
  };
  return {
    ...f,
    id,
    fileId: typeof f.fileId === "string" ? f.fileId : undefined,
    name: typeof f.name === "string" ? f.name : typeof f.fileName === "string" ? f.fileName : undefined,
    label: typeof f.label === "string" ? f.label : undefined,
    size: typeof f.size === "number" ? f.size : typeof f.bytes === "number" ? (f.bytes as number) : undefined,
    type: typeof f.type === "string" ? f.type : typeof f.mimeType === "string" ? f.mimeType : undefined,
    uploadedAt: ts(f.uploadedAt) ?? ts(f.uploaded_at),
    createdAt: ts(f.createdAt) ?? ts(f.created_at),
    isPublic: typeof f.isPublic === "boolean" ? f.isPublic : undefined,
    downloads: typeof f.downloads === "number" ? f.downloads : undefined,
  };
}

/** Format a byte count for display (1.2 KB / 3.4 MB …). */
export function formatBytes(bytes: number | undefined | null): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
