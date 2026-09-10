"use client";

/**
 * Persistent cloud-workspace sync engine (OnyxBase KV).
 *
 * ARCHITECTURE (PRD §29):
 *
 *   E2B (temporary execution env) ←→ this engine (browser) ←→ OnyxBase KV
 *                                                        (persistent state)
 *
 * STORAGE MODEL (KV values stay ≤ ~3 KB — comfortably under OnyxBase's ~4 KB
 * record ceiling, leaving room for JSON overhead):
 *
 *   workspace:default:manifest                     ← small atomic POINTER
 *   workspace:default:m:{manifestSha8}:000001…     ← manifest chunks
 *   workspace:default:f:{fileId}:{sha8}:000001…    ← file content chunks
 *
 *   fileId = sha256(relative path)[:16]   — deterministic per path
 *   sha8   = sha256(content)[:8]          — content-addressed chunks
 *
 * ATOMICITY (PRD §12): chunk keys are CONTENT-ADDRESSED, so new/changed
 * files write to NEW keys that the old manifest doesn't reference — a failed
 * push leaves the previously committed state fully intact. The single
 * pointer write at `workspace:default:manifest` is the COMMIT. Obsolete
 * (unreferenced) chunk keys are garbage-collected AFTER a successful commit.
 *
 * INCREMENTAL (PRD §32): files whose sha256 matches the committed manifest
 * reuse their existing chunk keys — zero KV writes. Only changed files cost
 * bandwidth.
 *
 * SECURITY: the OnyxBase API key is resolved by the TOOL layer and handed to
 * the OnyxBaseKV client directly — it never appears in manifests, chunk
 * values, results, logs, or E2B. Nothing in this module touches the key
 * beyond passing the constructed client around.
 */

import type { E2BClient } from "@/lib/e2b/client";
import {
  OnyxBaseKV,
  OnyxBaseError,
  ONYXBASE_WORKSPACE_ID as WORKSPACE_ID,
} from "./kv-client";
import { isExcludedPath, exclusionReason } from "./ignore";

export { WORKSPACE_ID };

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

/** Fixed, non-secret workspace identifier (re-exported from kv-client —
 *  PRD §4: stable, exposed to the model so it can reason about which
 *  workspace it operates on). */

/** KV key namespace root — every record this engine writes starts here. */
const NS = `workspace:default`;

/** Max bytes per synced file (PRD §9). Larger files are skipped, never fail
 *  the whole push. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Soft cap on the TOTAL workspace payload so a runaway workspace can't
 *  produce a multi-hour sync. Individual-file limit is 50 MB; this guards
 *  the aggregate. */
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

/** Encoded chars per KV value. OnyxBase documents ~4 KB per record; 3000
 *  chars leaves comfortable JSON overhead (PRD §8 — "2–3 KB, never fill the
 *  limit"). */
const CHUNK_SIZE = 3000;

/** Concurrent KV writes (small pool — polite to OnyxBase + Telegram mirror). */
const KV_CONCURRENCY = 5;

/** Files per E2B read/write batch round-trip. */
const E2B_BATCH_FILES = 40;

/** Soft cap on base64 bytes accumulated per E2B batch response (~2 MB). */
const E2B_BATCH_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export type SyncStage =
  | "checking"
  | "collecting"
  | "syncing"
  | "committing"
  | "cleanup"
  | "retrieving"
  | "restoring"
  | "verifying"
  | "done";

export interface StageEvent {
  stage: SyncStage;
  /** Short human line for the live UI, e.g. "Collecting 42 files…". */
  detail: string;
}

export interface WorkspaceFileMeta {
  path: string;
  /** Deterministic id — sha256(path).hex[:16]. */
  fileId: string;
  size: number;
  sha256: string;
  chunkCount: number;
  /** "gzip" when payload is gzip(base64) chunks, "identity" for raw base64. */
  encoding: "gzip" | "identity";
}

export interface WorkspaceManifest {
  version: 1;
  workspaceId: string;
  updatedAt: string;
  generation: number;
  files: WorkspaceFileMeta[];
  skippedFiles: Array<{ path: string; reason: string }>;
  totalFiles: number;
  totalBytes: number;
}

/** Small committed pointer record at `workspace:default:manifest`. */
export interface WorkspacePointer {
  v: 1;
  workspaceId: string;
  generation: number;
  updatedAt: string;
  totalFiles: number;
  totalBytes: number;
  /** sha256 of the (decompressed) manifest JSON — integrity check on read. */
  manifestSha256: string;
  /** Number of manifest chunk records. */
  manifestChunks: number;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface SyncErrorEntry {
  path?: string;
  code: string;
  message: string;
}

export interface PushResult {
  ok: boolean;
  status: "success" | "partial" | "error" | "not_configured";
  tool: "push_workspace";
  workspaceId: string;
  syncedFiles: number;
  unchangedFiles: number;
  updatedFiles: number;
  uploadedBytes: number;
  removedFiles: number;
  skippedFiles: SkippedFile[];
  errors: SyncErrorEntry[];
  durationMs: number;
}

export interface RetrieveResult {
  ok: boolean;
  status: "success" | "partial" | "error" | "not_found" | "not_configured" | "check";
  tool: "retrieve_workspace";
  workspaceId: string;
  restoredFiles: number;
  downloadedBytes: number;
  integrityVerified: boolean;
  /** check-mode summary of the cloud state. */
  cloud?: {
    totalFiles: number;
    totalBytes: number;
    updatedAt: string;
    generation: number;
  };
  skippedFiles: SkippedFile[];
  errors: SyncErrorEntry[];
  durationMs: number;
}

export interface SyncOptions {
  /** E2B client — required for push + restore; null is fine for check mode. */
  e2b: E2BClient | null;
  kv: OnyxBaseKV;
  onStage?: (ev: StageEvent) => void;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Crypto / encoding helpers (WebCrypto + CompressionStream).
// ---------------------------------------------------------------------------

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([bytes as unknown as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === "undefined") return null;
  try {
    const stream = new Blob([bytes as unknown as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

function chunkString(s: string): string[] {
  if (s.length <= CHUNK_SIZE) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += CHUNK_SIZE) out.push(s.slice(i, i + CHUNK_SIZE));
  return out;
}

function padIndex(i: number): string {
  return String(i + 1).padStart(6, "0");
}

/** Tiny concurrency pool. */
async function pool<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      const item = items[i];
      if (item === undefined || i >= items.length) return;
      await fn(item, i);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Key builders (deterministic namespace, PRD §6).
// ---------------------------------------------------------------------------

function fileChunkKey(fileId: string, sha8: string, index: number): string {
  return `${NS}:f:${fileId}:${sha8}:${padIndex(index)}`;
}

function manifestChunkKey(sha8: string, index: number): string {
  return `${NS}:m:${sha8}:${padIndex(index)}`;
}

export const POINTER_KEY = `${NS}:manifest`;

function sha8(shaHex: string): string {
  return shaHex.slice(0, 8);
}

/** Only delete keys that parse as OUR chunk records — the GC guard. */
function isManagedChunkKey(key: string): boolean {
  return key.startsWith(`${NS}:f:`) || key.startsWith(`${NS}:m:`);
}

// ---------------------------------------------------------------------------
// Manifest (read/write through chunked KV records).
// ---------------------------------------------------------------------------

async function readPointer(kv: OnyxBaseKV): Promise<WorkspacePointer | null> {
  const raw = await kv.get(POINTER_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as WorkspacePointer;
    if (p && p.v === 1 && typeof p.manifestSha256 === "string") return p;
    return null;
  } catch {
    return null;
  }
}

/** Lightweight cloud-state probe (for auto-restore + UI): returns the
 *  committed pointer summary or null when nothing is stored. Does NOT
 *  download the manifest. */
export async function getCloudPointer(
  kv: OnyxBaseKV,
): Promise<{ totalFiles: number; totalBytes: number; updatedAt: string; generation: number } | null> {
  const p = await readPointer(kv);
  if (!p) return null;
  return {
    totalFiles: p.totalFiles,
    totalBytes: p.totalBytes,
    updatedAt: p.updatedAt,
    generation: p.generation,
  };
}

async function readManifest(
  kv: OnyxBaseKV,
  pointer: WorkspacePointer,
): Promise<WorkspaceManifest | null> {
  const m8 = sha8(pointer.manifestSha256);
  const parts: string[] = [];
  for (let i = 0; i < pointer.manifestChunks; i++) {
    const val = await kv.get(manifestChunkKey(m8, i));
    if (val === null) return null; // hole in the manifest — treat as corrupt
    parts.push(val);
  }
  const payload = base64ToBytes(parts.join(""));
  const unzipped = (await gunzipBytes(payload)) ?? payload;
  // Integrity: full sha must match the pointer.
  const actual = await sha256Hex(unzipped);
  if (actual !== pointer.manifestSha256) return null;
  try {
    return JSON.parse(new TextDecoder().decode(unzipped)) as WorkspaceManifest;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PUSH.
// ---------------------------------------------------------------------------

export async function pushWorkspace(opts: SyncOptions): Promise<PushResult> {
  const t0 = Date.now();
  const { e2b, kv, onStage } = opts;
  const skipped: SkippedFile[] = [];
  const errors: SyncErrorEntry[] = [];
  const stage = (stage: SyncStage, detail: string) => onStage?.({ stage, detail });

  const base: PushResult = {
    ok: false,
    status: "error",
    tool: "push_workspace",
    workspaceId: WORKSPACE_ID,
    syncedFiles: 0,
    unchangedFiles: 0,
    updatedFiles: 0,
    uploadedBytes: 0,
    removedFiles: 0,
    skippedFiles: skipped,
    errors,
    durationMs: 0,
  };

  // 1. Validate E2B workspace availability (PRD §13).
  stage("checking", "Checking workspace…");
  let listing: Array<{ path: string; size: number }>;
  try {
    if (!e2b) throw new Error("E2B client unavailable");
    listing = await e2b.walkFiles();
  } catch (e) {
    base.errors.push({
      code: "E2B_UNAVAILABLE",
      message: e instanceof Error ? e.message : "E2B workspace unavailable",
    });
    base.durationMs = Date.now() - t0;
    return base;
  }

  // 2. Apply ignore rules + 50 MB rule (PRD §9-10).
  const files: Array<{ path: string; size: number }> = [];
  let totalBytes = 0;
  for (const f of listing) {
    const p = f.path.replace(/^\/+/, "");
    if (!p) continue;
    if (isExcludedPath(p)) {
      skipped.push({ path: p, reason: exclusionReason(p) ?? "excluded" });
      continue;
    }
    if (f.size > MAX_FILE_BYTES) {
      skipped.push({ path: p, reason: "file_too_large" });
      continue;
    }
    files.push({ path: p, size: f.size });
    totalBytes += f.size;
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    base.errors.push({
      code: "SERIALIZATION_FAILED",
      message: `Workspace is ${(totalBytes / 1048576).toFixed(1)} MB — above the 100 MB sync ceiling.`,
    });
    base.durationMs = Date.now() - t0;
    return base;
  }

  stage("collecting", `Collecting ${files.length} files…`);

  // 3. Read the committed cloud state (for incremental reuse + deletions).
  let oldPointer: WorkspacePointer | null = null;
  let oldManifest: WorkspaceManifest | null = null;
  try {
    oldPointer = await readPointer(kv);
    if (oldPointer) oldManifest = await readManifest(kv, oldPointer);
  } catch (e) {
    if (e instanceof OnyxBaseError && e.code === "ONYXBASE_UNAUTHORIZED") {
      base.errors.push({ code: e.code, message: e.message });
      base.durationMs = Date.now() - t0;
      return base;
    }
    // Read failures on a first push are fine — treat as no prior state.
  }
  const oldFilesByPath = new Map<string, WorkspaceFileMeta>(
    (oldManifest?.files ?? []).map((f) => [f.path, f]),
  );

  // 4. Read file bytes in E2B batches → hash → stage changed chunks.
  const newMeta: WorkspaceFileMeta[] = [];
  let uploadedBytes = 0;
  let unchangedFiles = 0;
  const pendingWrites: Array<{ key: string; value: string }> = [];

  // fileId needs sha256(path) — precompute for all files first (fast).
  const pathIds = new Map<string, string>();
  for (const f of files) {
    pathIds.set(f.path, (await sha256Hex(new TextEncoder().encode(f.path))).slice(0, 16));
  }

  let idx = 0;
  while (idx < files.length) {
    if (opts.signal?.aborted) break;
    // Accumulate a size-capped batch (≤ E2B_BATCH_FILES files and
    // ≤ ~2 MB cumulative so the JSON response stays under body limits).
    const batch: Array<{ path: string; size: number }> = [];
    let batchBytes = 0;
    while (idx < files.length && batch.length < E2B_BATCH_FILES) {
      const f = files[idx];
      if (!f) break;
      if (batchBytes + f.size > E2B_BATCH_BYTES && batch.length > 0) break;
      batch.push(f);
      batchBytes += f.size;
      idx++;
    }

    let read: Awaited<ReturnType<E2BClient["readFilesBatch"]>>;
    try {
      read = await e2b.readFilesBatch(batch.map((f) => f.path));
    } catch (e) {
      for (const f of batch) {
        errors.push({
          path: f.path,
          code: "E2B_UNAVAILABLE",
          message: e instanceof Error ? e.message : "E2B read failed",
        });
      }
      continue;
    }
    for (const err of read.errors) {
      errors.push({ path: err.path, code: "E2B_UNAVAILABLE", message: err.error });
    }
    for (const f of read.files) {
      try {
        const bytes = base64ToBytes(f.base64);
        const digest = await sha256Hex(bytes);
        const fileId = pathIds.get(f.path) ?? "unknown";
        const prev = oldFilesByPath.get(f.path);
        const same = prev && prev.sha256 === digest && prev.size === f.size;

        if (same) {
          // Incremental: reuse the committed chunk keys as-is.
          newMeta.push({ ...prev });
          unchangedFiles++;
          continue;
        }

        // gzip when it helps; fall back to raw base64 otherwise.
        const gz = await gzipBytes(bytes);
        let payload: Uint8Array = bytes;
        let encoding: "gzip" | "identity" = "identity";
        if (gz && gz.length < bytes.length) {
          payload = gz;
          encoding = "gzip";
        }
        const b64 = bytesToBase64(payload);
        const chunks = chunkString(b64);
        for (let i = 0; i < chunks.length; i++) {
          const value = chunks[i];
          if (value === undefined) continue;
          pendingWrites.push({ key: fileChunkKey(fileId, sha8(digest), i), value });
        }
        uploadedBytes += payload.length;
        newMeta.push({
          path: f.path,
          fileId,
          size: f.size,
          sha256: digest,
          chunkCount: chunks.length,
          encoding,
        });
        stage(
          "syncing",
          `Syncing workspace… (${newMeta.length}/${files.length} files)`,
        );
      } catch (e) {
        errors.push({
          path: f.path,
          code: "SERIALIZATION_FAILED",
          message: e instanceof Error ? e.message : "serialization failed",
        });
      }
    }
  }

  // 5. Build the manifest (metadata only — PRD §7).
  const manifest: WorkspaceManifest = {
    version: 1,
    workspaceId: WORKSPACE_ID,
    updatedAt: new Date().toISOString(),
    generation: (oldPointer?.generation ?? 0) + 1,
    files: newMeta.sort((a, b) => (a.path < b.path ? -1 : 1)),
    skippedFiles: skipped,
    totalFiles: newMeta.length,
    totalBytes: newMeta.reduce((s, f) => s + f.size, 0),
  };

  // 6. Stage manifest chunks (content-addressed).
  stage("committing", "Committing workspace snapshot…");
  const manifestJson = JSON.stringify(manifest);
  const manifestBytes = new TextEncoder().encode(manifestJson);
  const manifestSha = await sha256Hex(manifestBytes);
  const manifestGz = (await gzipBytes(manifestBytes)) ?? manifestBytes;
  const manifestB64 = bytesToBase64(manifestGz);
  const mChunks = chunkString(manifestB64);
  for (let i = 0; i < mChunks.length; i++) {
    const value = mChunks[i];
    if (value === undefined) continue;
    pendingWrites.push({ key: manifestChunkKey(sha8(manifestSha), i), value });
  }

  // 7. Write all staged chunks (concurrency-limited, one retry each).
  let writeFailures = 0;
  await pool(pendingWrites, KV_CONCURRENCY, async (w) => {
    try {
      await kv.set(w.key, w.value);
    } catch (e) {
      if (e instanceof OnyxBaseError && e.code === "ONYXBASE_UNAUTHORIZED") throw e;
      // One retry for transient failures.
      try {
        await kv.set(w.key, w.value);
      } catch (e2) {
        writeFailures++;
        if (e2 instanceof OnyxBaseError && e2.code === "ONYXBASE_UNAUTHORIZED") throw e2;
        errors.push({
          code: "KV_WRITE_FAILED",
          message: e2 instanceof Error ? e2.message : `KV write failed for ${w.key}`,
        });
      }
    }
  }).catch((e) => {
    errors.push({
      code: e instanceof OnyxBaseError ? e.code : "KV_WRITE_FAILED",
      message: e instanceof Error ? e.message : "KV write aborted",
    });
  });

  if (errors.some((err) => err.code === "ONYXBASE_UNAUTHORIZED")) {
    base.errors = errors;
    base.durationMs = Date.now() - t0;
    return base;
  }

  // 8. ATOMIC COMMIT — the single pointer write flips the cloud state.
  if (writeFailures > 0) {
    // Partial staging — DON'T commit; the previous state stays valid (§12).
    base.status = "partial";
    base.errors = errors;
    base.durationMs = Date.now() - t0;
    return base;
  }
  const pointer: WorkspacePointer = {
    v: 1,
    workspaceId: WORKSPACE_ID,
    generation: manifest.generation,
    updatedAt: manifest.updatedAt,
    totalFiles: manifest.totalFiles,
    totalBytes: manifest.totalBytes,
    manifestSha256: manifestSha,
    manifestChunks: mChunks.length,
  };
  try {
    await kv.set(POINTER_KEY, JSON.stringify(pointer));
  } catch (e) {
    base.errors.push({
      code: e instanceof OnyxBaseError ? e.code : "KV_WRITE_FAILED",
      message: e instanceof Error ? e.message : "commit failed",
    });
    base.durationMs = Date.now() - t0;
    return base;
  }

  // 9. GC — remove obsolete chunks from any previous generation (PRD §11).
  stage("cleanup", "Cleaning up obsolete records…");
  let removedFiles = 0;
  if (oldManifest) {
    const referenced = new Set<string>([
      ...mChunks.map((_, i) => manifestChunkKey(sha8(manifestSha), i)),
    ]);
    for (const f of manifest.files) {
      for (let i = 0; i < f.chunkCount; i++) {
        referenced.add(fileChunkKey(f.fileId, sha8(f.sha256), i));
      }
    }
    try {
      const allKeys = await kv.listKeys(`${NS}:`);
      const obsolete = allKeys.filter((k) => isManagedChunkKey(k) && !referenced.has(k));
      await pool(obsolete, KV_CONCURRENCY, async (k) => {
        try {
          await kv.delete(k);
        } catch {
          /* best-effort cleanup */
        }
      });
      // Files present in the old manifest but absent now were removed from
      // the cloud representation — count for the report.
      removedFiles = oldManifest.files.filter(
        (f) => !manifest.files.some((nf) => nf.path === f.path),
      ).length;
    } catch {
      /* GC is best-effort */
    }
  }

  stage("done", `Workspace synchronized — ${manifest.totalFiles} files`);

  const ok = errors.length === 0;
  base.ok = ok;
  base.status = ok ? "success" : "partial";
  base.syncedFiles = manifest.files.length;
  base.unchangedFiles = unchangedFiles;
  base.updatedFiles = manifest.files.length - unchangedFiles;
  base.uploadedBytes = uploadedBytes;
  base.removedFiles = removedFiles;
  base.errors = errors;
  base.durationMs = Date.now() - t0;
  return base;
}

// ---------------------------------------------------------------------------
// RETRIEVE.
// ---------------------------------------------------------------------------

export async function retrieveWorkspace(
  opts: SyncOptions & { mode?: "restore" | "check" },
): Promise<RetrieveResult> {
  const t0 = Date.now();
  const { e2b, kv, onStage, mode = "restore" } = opts;
  const errors: SyncErrorEntry[] = [];
  const skipped: SkippedFile[] = [];
  const stage = (stage: SyncStage, detail: string) => onStage?.({ stage, detail });

  const base: RetrieveResult = {
    ok: false,
    status: "error",
    tool: "retrieve_workspace",
    workspaceId: WORKSPACE_ID,
    restoredFiles: 0,
    downloadedBytes: 0,
    integrityVerified: false,
    skippedFiles: skipped,
    errors,
    durationMs: 0,
  };

  stage("checking", "Retrieving workspace…");
  let pointer: WorkspacePointer | null = null;
  try {
    pointer = await readPointer(kv);
  } catch (e) {
    base.errors.push({
      code: e instanceof OnyxBaseError ? e.code : "KV_READ_FAILED",
      message: e instanceof Error ? e.message : "KV read failed",
    });
    base.durationMs = Date.now() - t0;
    return base;
  }
  if (!pointer) {
    base.status = "not_found";
    base.durationMs = Date.now() - t0;
    return base;
  }
  let manifest: WorkspaceManifest | null = null;
  try {
    manifest = await readManifest(kv, pointer);
  } catch (e) {
    base.errors.push({
      code: e instanceof OnyxBaseError ? e.code : "KV_READ_FAILED",
      message: e instanceof Error ? e.message : "manifest read failed",
    });
    base.durationMs = Date.now() - t0;
    return base;
  }
  if (!manifest) {
    base.errors.push({
      code: "WORKSPACE_NOT_FOUND",
      message: "The stored workspace manifest is corrupt or incomplete",
    });
    base.durationMs = Date.now() - t0;
    return base;
  }

  // Check mode — report cloud state, no restore.
  if (mode === "check") {
    base.ok = true;
    base.status = "check";
    base.cloud = {
      totalFiles: manifest.totalFiles,
      totalBytes: manifest.totalBytes,
      updatedAt: manifest.updatedAt,
      generation: manifest.generation,
    };
    base.durationMs = Date.now() - t0;
    return base;
  }

  // Restore: download + verify each file, then write to E2B in batches.
  if (!e2b) {
    base.errors.push({ code: "E2B_UNAVAILABLE", message: "E2B client unavailable" });
    base.durationMs = Date.now() - t0;
    return base;
  }
  stage("retrieving", `Retrieving ${manifest.files.length} files…`);
  const verified: Array<{ path: string; base64: string; size: number }> = [];
  let checksumOk = 0;
  let checksumBad = 0;

  for (const f of manifest.files) {
    if (opts.signal?.aborted) break;
    try {
      const parts: string[] = [];
      for (let c = 0; c < f.chunkCount; c++) {
        const val = await kv.get(fileChunkKey(f.fileId, sha8(f.sha256), c));
        if (val === null) throw new Error("missing chunk");
        parts.push(val);
      }
      const payload = base64ToBytes(parts.join(""));
      const raw = f.encoding === "gzip" ? ((await gunzipBytes(payload)) ?? payload) : payload;
      const digest = await sha256Hex(raw);
      if (digest !== f.sha256 || raw.length !== f.size) {
        checksumBad++;
        skipped.push({ path: f.path, reason: "checksum_mismatch" });
        continue; // corrupt file — never silently accepted (PRD §33)
      }
      checksumOk++;
      verified.push({ path: f.path, base64: bytesToBase64(raw), size: f.size });
      if (verified.length % 25 === 0) {
        stage("restoring", `Restoring files… (${verified.length}/${manifest.files.length})`);
      }
    } catch (e) {
      errors.push({
        path: f.path,
        code: e instanceof OnyxBaseError ? e.code : "KV_READ_FAILED",
        message: e instanceof Error ? e.message : "chunk read failed",
      });
    }
  }

  stage("restoring", `Restoring ${verified.length} files…`);
  let restored = 0;
  let downloaded = 0;
  for (let start = 0; start < verified.length; start += 150) {
    if (opts.signal?.aborted) break;
    const batch = verified.slice(start, start + 150);
    try {
      const r = await e2b.batchWriteBytes(batch.map((v) => ({ path: v.path, base64: v.base64 })));
      restored += r.written;
      downloaded += batch.reduce((s, v) => s + v.size, 0);
      for (const err of r.errors) {
        errors.push({ path: err.path, code: "RESTORE_FAILED", message: err.error });
      }
    } catch (e) {
      for (const v of batch) {
        errors.push({
          path: v.path,
          code: "RESTORE_FAILED",
          message: e instanceof Error ? e.message : "E2B write failed",
        });
      }
    }
  }

  stage("verifying", "Verifying integrity…");
  const integrity = checksumBad === 0 && errors.length === 0;
  base.ok = restored > 0 && errors.length === 0 && checksumBad === 0;
  base.status = base.ok ? "success" : restored > 0 || checksumOk > 0 ? "partial" : "error";
  base.restoredFiles = restored;
  base.downloadedBytes = downloaded;
  base.integrityVerified = integrity;
  stage("done", `Workspace restored — ${restored} files`);

  base.durationMs = Date.now() - t0;
  return base;
}
