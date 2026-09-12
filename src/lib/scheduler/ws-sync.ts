/**
 * SERVER-side workspace sync (OnyxBase KV ⇄ E2B sandbox) for scheduled runs.
 *
 * Writes/reads the EXACT same KV layout as the browser engine
 * (src/lib/onyxbase/workspace-sync.ts) so both sides interoperate:
 *
 *   workspace:default:manifest                ← pointer + inline manifest
 *   workspace:default:m:{sha8}:{000001}…      ← manifest chunks (+mr: replicas)
 *   workspace:default:f:{fileId}:{sha8}:{…}   ← content chunks
 *   workspace:default:fm:{fileId}:{sha8}      ← per-file metadata record
 *
 * Durability rules (from the 4a6a8f0 push-hang fix): SEQUENTIAL writes
 * (concurrent writes drop OnyxBase's Telegram mirror), hard budget, atomic
 * pointer-last commit, capped GC.
 *
 * Uses the E2B SDK Sandbox directly (server-only).
 */

import { Sandbox } from "@e2b/code-interpreter";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { SchedulerKV } from "./server-kv";

const NS = "workspace:default";
const WORKSPACE_ID = "workspace_default";
const POINTER_KEY = `${NS}:manifest`;
const CHUNK_SIZE = 120_000;
const MANIFEST_INLINE_MAX = 100_000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const GC_MAX_DELETES = 200;
const SYNC_BUDGET_MS = 90_000;

// ── exclusions (compact server copy of onyxbase/ignore.ts) ────────────────
const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", "dist", "build", "out", "coverage",
  "tmp", "temp", ".tmp", "__pycache__", ".venv", "venv", "env", ".cache",
  ".mypy_cache", ".pytest_cache", ".ruff_cache", ".gradle", "target", ".idea",
]);
const EXCLUDED_FILES = new Set([
  "onyx.md", ".onyxagent_files.json", ".env", ".env.local", ".env.development",
  ".env.production", ".env.test", ".env.dev", ".env.prod", ".env.staging",
  ".env.default", ".ds_store", ".npmrc", ".netrc", ".pypirc", "credentials.json",
  "service-account.json", "service_account.json", "secrets.json", "secrets.yaml",
  "secrets.yml", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "authorized_keys",
  "known_hosts", "wallet.dat",
]);
const EXCLUDED_PATTERNS: RegExp[] = [
  /^\.env\./, /(^|\.)pem$/i, /(^|\.)key$/i, /(^|\.)p12$/i, /(^|\.)pfx$/i,
  /(^|\.)kdbx$/i, /^id_rsa_?\w*$/, /^id_ed25519_?\w*$/,
];

function isExcludedPath(relPath: string): boolean {
  const parts = relPath.split("/");
  for (const part of parts) {
    if (EXCLUDED_DIRS.has(part)) return true;
    if (part.startsWith(".git")) return true;
  }
  const base = parts[parts.length - 1] ?? "";
  if (EXCLUDED_FILES.has(base.toLowerCase())) return true;
  return EXCLUDED_PATTERNS.some((re) => re.test(base));
}

// ── encoding helpers ───────────────────────────────────────────────────────

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const b64Encode = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const b64Decode = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

function gzipBest(bytes: Uint8Array): Uint8Array | null {
  try {
    const gz = gzipSync(bytes);
    return gz.length < bytes.length ? new Uint8Array(gz) : null;
  } catch {
    return null;
  }
}

function gunzip(bytes: Uint8Array): Uint8Array {
  try {
    return new Uint8Array(gunzipSync(bytes));
  } catch {
    return bytes;
  }
}

function chunkString(s: string): string[] {
  if (s.length <= CHUNK_SIZE) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += CHUNK_SIZE) out.push(s.slice(i, i + CHUNK_SIZE));
  return out;
}

const padIndex = (i: number): string => String(i + 1).padStart(6, "0");
const sha8Of = (hex: string): string => hex.slice(0, 8);
const fileChunkKey = (fileId: string, sha8: string, i: number) => `${NS}:f:${fileId}:${sha8}:${padIndex(i)}`;
const fileMetaKey = (fileId: string, sha8: string) => `${NS}:fm:${fileId}:${sha8}`;
const manifestChunkKey = (sha8: string, i: number) => `${NS}:m:${sha8}:${padIndex(i)}`;
const manifestReplicaKey = (sha8: string, i: number) => `${NS}:mr:${sha8}:${padIndex(i)}`;
const isManagedChunkKey = (k: string) => k.startsWith(`${NS}:f:`) || k.startsWith(`${NS}:m:`) || k.startsWith(`${NS}:mr:`) || k.startsWith(`${NS}:fm:`);

// ── wire types (must match the browser engine byte-for-byte) ───────────────

interface WorkspaceFileMeta {
  path: string;
  fileId: string;
  size: number;
  sha256: string;
  chunkCount: number;
  encoding: "gzip" | "identity";
}
interface WorkspaceManifest {
  version: 1;
  workspaceId: string;
  updatedAt: string;
  generation: number;
  files: WorkspaceFileMeta[];
  skippedFiles: Array<{ path: string; reason: string }>;
  totalFiles: number;
  totalBytes: number;
}
interface WorkspacePointer {
  v: 1;
  workspaceId: string;
  generation: number;
  updatedAt: string;
  totalFiles: number;
  totalBytes: number;
  manifestSha256: string;
  manifestChunks: number;
  manifestInline?: string;
  manifestEncoding?: "gzip" | "identity";
}

// ── KV reads ───────────────────────────────────────────────────────────────

async function readPointer(kv: SchedulerKV): Promise<WorkspacePointer | null> {
  try {
    const raw = await kv.get(POINTER_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as WorkspacePointer;
    return p && p.v === 1 && typeof p.manifestSha256 === "string" ? p : null;
  } catch {
    return null;
  }
}

async function readManifest(kv: SchedulerKV, pointer: WorkspacePointer): Promise<WorkspaceManifest | null> {
  try {
    let payload: Uint8Array;
    if (typeof pointer.manifestInline === "string" && pointer.manifestInline) {
      payload = b64Decode(pointer.manifestInline);
      if (pointer.manifestEncoding === "gzip") payload = gunzip(payload);
    } else {
      const m8 = sha8Of(pointer.manifestSha256);
      const parts: string[] = [];
      for (let i = 0; i < pointer.manifestChunks; i++) {
        const val = (await kv.get(manifestChunkKey(m8, i))) ?? (await kv.get(manifestReplicaKey(m8, i)));
        if (val === null) return null;
        parts.push(val);
      }
      payload = b64Decode(parts.join(""));
      payload = gunzip(payload);
    }
    if (sha256Hex(payload) !== pointer.manifestSha256) return null;
    return JSON.parse(new TextDecoder().decode(payload)) as WorkspaceManifest;
  } catch {
    return null;
  }
}

// ── sandbox file listing (recursive, depth-capped) ─────────────────────────

const HOME = "/home/user";

export async function walkSandboxFiles(
  sandbox: Sandbox,
): Promise<Array<{ path: string; size: number }>> {
  const out: Array<{ path: string; size: number }> = [];
  const seen = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 64 || seen.has(dir)) return;
    seen.add(dir);
    let entries: Awaited<ReturnType<Sandbox["files"]["list"]>>;
    try {
      entries = await sandbox.files.list(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = dir === "/" ? `/${e.name}` : `${dir}/${e.name}`;
      if (e.type === "file") {
        const rel = full.startsWith(`${HOME}/`) ? full.slice(HOME.length + 1) : null;
        if (!rel) continue;
        if (isExcludedPath(rel)) continue;
        let size = 0;
        try {
          size = typeof e.size === "number" ? e.size : 0;
        } catch {
          size = 0;
        }
        if (size > MAX_FILE_BYTES) continue;
        out.push({ path: rel, size });
      } else if (e.type === "dir") {
        const rel = full.startsWith(`${HOME}/`) ? full.slice(HOME.length + 1) : null;
        if (rel && isExcludedPath(rel)) continue;
        await walk(full, depth + 1);
      }
    }
  };
  await walk(HOME, 0);
  return out;
}

// ── PUSH (sandbox → KV) ────────────────────────────────────────────────────

export interface ServerPushResult {
  ok: boolean;
  syncedFiles: number;
  uploadedBytes: number;
  warnings: string[];
  error?: string;
}

export async function serverPushWorkspace(
  sandbox: Sandbox,
  kv: SchedulerKV,
): Promise<ServerPushResult> {
  const t0 = Date.now();
  const deadline = t0 + SYNC_BUDGET_MS;
  const warnings: string[] = [];
  const files = await walkSandboxFiles(sandbox);
  let totalBytes = 0;
  for (const f of files) totalBytes += f.size;
  if (totalBytes > MAX_TOTAL_BYTES) {
    return { ok: false, syncedFiles: 0, uploadedBytes: 0, warnings, error: `workspace ${Math.round(totalBytes / 1048576)}MB exceeds 100MB ceiling` };
  }

  // Empty-push guard — never wipe a non-empty cloud snapshot (4a6a8f0 rule).
  const oldPointer = await readPointer(kv);
  if (files.length === 0 && oldPointer && oldPointer.totalFiles > 0) {
    return {
      ok: false,
      syncedFiles: 0,
      uploadedBytes: 0,
      warnings,
      error: `EMPTY_PUSH_BLOCKED: sandbox empty but cloud holds ${oldPointer.totalFiles} files — skipped sync`,
    };
  }
  const oldManifest = oldPointer ? await readManifest(kv, oldPointer) : null;
  const oldByPath = new Map<string, WorkspaceFileMeta>((oldManifest?.files ?? []).map((f) => [f.path, f]));

  const newMeta: WorkspaceFileMeta[] = [];
  const pendingWrites: Array<{ key: string; value: string }> = [];
  let uploadedBytes = 0;
  const pushStamp = new Date().toISOString();

  for (const f of files) {
    if (Date.now() > deadline) {
      return { ok: false, syncedFiles: 0, uploadedBytes: 0, warnings, error: "sync budget elapsed before commit — nothing written" };
    }
    try {
      const raw = await sandbox.files.read(`${HOME}/${f.path}`, { format: "bytes" });
      const bytes = new Uint8Array(raw);
      const digest = sha256Hex(bytes);
      const fileId = sha256Hex(new TextEncoder().encode(f.path)).slice(0, 16);
      const prev = oldByPath.get(f.path);
      if (prev && prev.sha256 === digest && prev.size === bytes.length) {
        newMeta.push({ ...prev });
        continue; // incremental reuse
      }
      const gz = gzipBest(bytes);
      const payload = gz ?? bytes;
      const encoding: "gzip" | "identity" = gz ? "gzip" : "identity";
      const b64 = b64Encode(payload);
      const chunks = chunkString(b64);
      for (let i = 0; i < chunks.length; i++) {
        pendingWrites.push({ key: fileChunkKey(fileId, sha8Of(digest), i), value: chunks[i]! });
      }
      pendingWrites.push({
        key: fileMetaKey(fileId, sha8Of(digest)),
        value: JSON.stringify({ p: f.path, s: bytes.length, h: digest, c: chunks.length, e: encoding, t: pushStamp }),
      });
      uploadedBytes += payload.length;
      newMeta.push({ path: f.path, fileId, size: bytes.length, sha256: digest, chunkCount: chunks.length, encoding });
    } catch {
      warnings.push(`read failed: ${f.path} (skipped)`);
    }
  }

  // Manifest — inline in the pointer when it fits.
  const manifest: WorkspaceManifest = {
    version: 1,
    workspaceId: WORKSPACE_ID,
    updatedAt: new Date().toISOString(),
    generation: (oldPointer?.generation ?? 0) + 1,
    files: newMeta.sort((a, b) => (a.path < b.path ? -1 : 1)),
    skippedFiles: [],
    totalFiles: newMeta.length,
    totalBytes: newMeta.reduce((s, f) => s + f.size, 0),
  };
  const manifestJson = JSON.stringify(manifest);
  const manifestBytes = new TextEncoder().encode(manifestJson);
  const manifestSha = sha256Hex(manifestBytes);
  const manifestGz = gzipBest(manifestBytes);
  const manifestEnc: "gzip" | "identity" = manifestGz ? "gzip" : "identity";
  const manifestPayload = manifestGz ?? manifestBytes;
  const manifestB64 = b64Encode(manifestPayload);
  const manifestRecordKeys: string[] = [];
  let manifestChunkCount = 0;
  let manifestInline: string | null = null;
  if (manifestB64.length <= MANIFEST_INLINE_MAX) {
    manifestInline = manifestB64;
  } else {
    const mChunks = chunkString(manifestB64);
    manifestChunkCount = mChunks.length;
    for (let i = 0; i < mChunks.length; i++) {
      const primary = manifestChunkKey(sha8Of(manifestSha), i);
      pendingWrites.push({ key: primary, value: mChunks[i]! });
      const replica = manifestReplicaKey(sha8Of(manifestSha), i);
      pendingWrites.push({ key: replica, value: mChunks[i]! });
      manifestRecordKeys.push(primary, replica);
    }
  }

  // SEQUENTIAL durable writes (mirror-safe).
  for (const w of pendingWrites) {
    if (Date.now() > deadline) {
      return { ok: false, syncedFiles: 0, uploadedBytes: 0, warnings, error: "sync budget elapsed mid-write — nothing committed, previous snapshot intact" };
    }
    try {
      await kv.set(w.key, w.value);
    } catch (e) {
      try {
        await kv.set(w.key, w.value); // one retry
      } catch (e2) {
        return { ok: false, syncedFiles: 0, uploadedBytes: 0, warnings, error: `KV write failed (${e2 instanceof Error ? e2.message : String(e)}) — nothing committed` };
      }
    }
  }

  // ATOMIC COMMIT — the pointer write flips the cloud state (LAST).
  const pointer: WorkspacePointer = {
    v: 1,
    workspaceId: WORKSPACE_ID,
    generation: manifest.generation,
    updatedAt: manifest.updatedAt,
    totalFiles: manifest.totalFiles,
    totalBytes: manifest.totalBytes,
    manifestSha256: manifestSha,
    manifestChunks: manifestChunkCount,
    ...(manifestInline ? { manifestInline, manifestEncoding: manifestEnc } : {}),
  };
  try {
    await kv.set(POINTER_KEY, JSON.stringify(pointer));
  } catch (e) {
    return { ok: false, syncedFiles: 0, uploadedBytes: 0, warnings, error: `commit failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Capped best-effort GC of unreferenced managed keys.
  try {
    const referenced = new Set<string>(manifestRecordKeys);
    for (const f of manifest.files) {
      for (let i = 0; i < f.chunkCount; i++) referenced.add(fileChunkKey(f.fileId, sha8Of(f.sha256), i));
      referenced.add(fileMetaKey(f.fileId, sha8Of(f.sha256)));
    }
    const allKeys = await kv.listKeys(`${NS}:`);
    const obsolete = allKeys.filter((k) => isManagedChunkKey(k) && !referenced.has(k)).slice(0, GC_MAX_DELETES);
    for (const k of obsolete) {
      if (Date.now() > deadline) break;
      try {
        await kv.delete(k);
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* GC best-effort */
  }

  return { ok: true, syncedFiles: manifest.totalFiles, uploadedBytes, warnings };
}

// ── RESTORE (KV → sandbox) ─────────────────────────────────────────────────

export interface ServerRestoreResult {
  ok: boolean;
  restoredFiles: number;
  bytes: number;
  warnings: string[];
  error?: string;
}

export async function serverRestoreWorkspace(
  sandbox: Sandbox,
  kv: SchedulerKV,
): Promise<ServerRestoreResult> {
  const t0 = Date.now();
  const deadline = t0 + SYNC_BUDGET_MS;
  const warnings: string[] = [];
  const pointer = await readPointer(kv);
  if (!pointer) {
    return { ok: true, restoredFiles: 0, bytes: 0, warnings: ["no cloud workspace — starting empty"], error: undefined };
  }
  const manifest = await readManifest(kv, pointer);
  if (!manifest) {
    return { ok: false, restoredFiles: 0, bytes: 0, warnings, error: "cloud manifest unreadable" };
  }

  let restored = 0;
  let bytes = 0;
  for (const f of manifest.files) {
    if (Date.now() > deadline) {
      warnings.push("restore budget hit — some files not restored");
      break;
    }
    try {
      const parts: string[] = [];
      for (let i = 0; i < f.chunkCount; i++) {
        const v = await kv.get(fileChunkKey(f.fileId, sha8Of(f.sha256), i));
        if (v === null) throw new Error(`missing chunk ${i + 1}/${f.chunkCount}`);
        parts.push(v);
      }
      let payload = b64Decode(parts.join(""));
      if (f.encoding === "gzip") payload = gunzip(payload);
      if (sha256Hex(payload) !== f.sha256) throw new Error("checksum mismatch");
      await sandbox.files.write(`${HOME}/${f.path}`, new Blob([new Uint8Array(payload)]));
      restored++;
      bytes += payload.length;
    } catch (e) {
      warnings.push(`restore failed: ${f.path} (${e instanceof Error ? e.message : "error"})`);
    }
  }
  return { ok: restored > 0 || manifest.files.length === 0, restoredFiles: restored, bytes, warnings };
}
