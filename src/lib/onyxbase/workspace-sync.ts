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
 *   workspace:default:manifest                     ← atomic POINTER + INLINE
 *                                                     manifest when small
 *   workspace:default:m:{manifestSha8}:000001…     ← manifest chunks (large
 *   workspace:default:mr:{manifestSha8}:000001…    ←  …mirrored replicas)
 *   workspace:default:f:{fileId}:{sha8}:000001…    ← file content chunks
 *   workspace:default:fm:{fileId}:{sha8}           ← PER-FILE metadata record
 *                                                     (path, size, sha, chunk
 *                                                     count, encoding, time)
 *
 *   The `fm:` records are the DISTRIBUTED manifest: each file carries its
 *   own metadata at file granularity, so a lost manifest record can no
 *   longer orphan the whole snapshot — retrieve rebuilds the file list from
 *   surviving `fm:` records, and even without them salvages whole files
 *   directly from chunk keys (see RECOVERY below).
 *
 *   fileId = sha256(relative path)[:16]   — deterministic per path
 *   sha8   = sha256(content)[:8]          — content-addressed chunks
 *
 * ATOMICITY (PRD §12): chunk keys are CONTENT-ADDRESSED, so new/changed
 * files write to NEW keys that the old manifest doesn't reference — a failed
 * push leaves the previously committed state fully intact. The single
 * pointer write at `workspace:default:manifest` is the COMMIT.
 *
 * DURABILITY (learned the hard way — live incident 2026-09-11): OnyxBase's
 *   KV is multi-instance: each instance keeps a local index hydrated from
 *   the Telegram mirror, and a write updates the WRITING instance + the
 *   mirror — where the mirror write can silently fail (which orphaned a
 *   committed snapshot whose manifest chunk vanished). Reads hit random
 *   instances, so a fresh write can be invisible to the next read for a
 *   while (cold-start rehydrate is the convergence path). Defenses:
 *   1. Small manifests are INLINED in the pointer record itself — the commit
 *      carries the manifest, so no separate record can go missing.
 *   2. Chunked manifests are written to BOTH `m:` and mirrored `mr:` keys,
 *      with read-back verification (rewrite + settle rounds).
 *   3. The committed pointer is verified by reading it back through the
 *      exact retrieve path; an unverifiable commit is KEPT and reported as
 *      "partial" (read-back failures are usually stale routing, not lost
 *      writes — rolling back a probably-good commit is worse).
 *   4. Retrieve retries missing records across several settle rounds before
 *      declaring a snapshot corrupt.
 *   5. EMPTY-PUSH GUARD: a push from an empty sandbox can NEVER overwrite a
 *      non-empty cloud snapshot (the exact incident that orphaned the
 *      2026-09-11 workspace). Requires an explicit force=true to override.
 *
 * RECOVERY (when the manifest itself is lost, live incident 2026-09-11):
 *   retrieve_workspace degrades gracefully instead of failing:
 *   1. Rebuild the file list from surviving `fm:` per-file records (verify
 *      chunk availability per candidate, newest version first) → restore
 *      normally with per-file SHA-256 verification (result: degraded=true).
 *   2. No `fm:` records (old-format snapshot) → CHUNK SALVAGE: scan all `f:`
 *      chunk keys, reconstruct every group that starts at chunk 1 and
 *      verifies against its content-addressed sha8, write the recovered
 *      files into `.onyx-salvage/` with a README, and report exactly what
 *      was and wasn't recoverable. Surviving cloud records are NEVER
 *      deleted by a failed restore, and the error message NEVER advises a
 *      blind re-push (that would wipe the remaining data).
 * Obsolete (unreferenced) chunk keys are garbage-collected AFTER a commit.
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

/** Max base64 chars of manifest payload embedded directly in the pointer
 *  record. Keeps the whole pointer JSON ≤ ~2.9 KB — comfortably under
 *  OnyxBase's ~4 KB record ceiling. Small/medium workspaces (roughly ≤ 150
 *  files) then commit atomically as ONE self-contained record; larger ones
 *  fall back to chunked manifest records with mirrored replicas +
 *  pre-commit read-back verification. */
const MANIFEST_INLINE_MAX = 2400;

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
  /** Inline manifest payload — base64(gzip(manifest JSON)) when it fits in
   *  the pointer record. Makes the atomic commit self-contained: the
   *  manifest can never go missing on its own (see DURABILITY above). */
  manifestInline?: string;
  /** Encoding of `manifestInline` — "gzip" when compression helped. */
  manifestEncoding?: "gzip" | "identity";
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
  /** Set when the manifest was lost but the file list was rebuilt from
   *   per-file `fm:` records — every restored file still passed SHA-256. */
  degraded?: boolean;
  /** Salvage-mode outcome (manifest lost, chunk-level recovery). */
  salvage?: {
    salvagedFiles: number;
    salvagedBytes: number;
    salvagedPaths: string[];
    unrecoverableGroups: number;
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
  /** Skip post-commit garbage collection (used by the live integration
   *  test so it never deletes pre-existing records it didn't create). */
  skipGc?: boolean;
  /** Allow pushing an EMPTY workspace over a non-empty cloud snapshot.
   *  Off by default — the empty-push guard refuses the wipe (see
   *  EMPTY-PUSH GUARD above). Only the user's explicit confirmation
   *  should ever set this. */
  force?: boolean;
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

/** Mirrored replica of a manifest chunk — OnyxBase is multi-instance and a
 *  single record can lose durability; reads fall back to the replica. */
function manifestReplicaKey(sha8: string, index: number): string {
  return `${NS}:mr:${sha8}:${padIndex(index)}`;
}

/** Per-file metadata record — the DISTRIBUTED manifest. Small (≈ 200
 *  chars), one per (path, content-version): losing one record costs one
 *  file, never the whole snapshot. */
function fileMetaKey(fileId: string, sha8: string): string {
  return `${NS}:fm:${fileId}:${sha8}`;
}

export const POINTER_KEY = `${NS}:manifest`;

/** Directory (inside the sandbox) where salvage-mode writes recovered
 *  files when the manifest is lost and only chunks survive. */
export const SALVAGE_DIR = ".onyx-salvage";

function sha8(shaHex: string): string {
  return shaHex.slice(0, 8);
}

/** Only delete keys that parse as OUR chunk records — the GC guard. */
function isManagedChunkKey(key: string): boolean {
  return (
    key.startsWith(`${NS}:f:`) ||
    key.startsWith(`${NS}:m:`) ||
    key.startsWith(`${NS}:mr:`) ||
    key.startsWith(`${NS}:fm:`)
  );
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
  let payload: Uint8Array;
  if (typeof pointer.manifestInline === "string" && pointer.manifestInline) {
    // Self-contained commit — decode straight from the pointer record.
    payload = base64ToBytes(pointer.manifestInline);
    if (pointer.manifestEncoding === "gzip") {
      payload = (await gunzipBytes(payload)) ?? payload;
    }
  } else {
    const m8 = sha8(pointer.manifestSha256);
    const parts: string[] = [];
    for (let i = 0; i < pointer.manifestChunks; i++) {
      // Primary `m:` record, falling back to the mirrored `mr:` replica —
      // a single record can lose durability on the multi-instance backend.
      const val =
        (await kv.get(manifestChunkKey(m8, i))) ??
        (await kv.get(manifestReplicaKey(m8, i)));
      if (val === null) return null; // hole in the manifest — treat as corrupt
      parts.push(val);
    }
    payload = base64ToBytes(parts.join(""));
    payload = (await gunzipBytes(payload)) ?? payload;
  }
  // Integrity: full sha must match the pointer.
  const actual = await sha256Hex(payload);
  if (actual !== pointer.manifestSha256) return null;
  try {
    return JSON.parse(new TextDecoder().decode(payload)) as WorkspaceManifest;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// RECOVERY — per-file meta records + chunk salvage (manifest lost).
// ---------------------------------------------------------------------------

/** Compact per-file metadata record stored at `fm:{fileId}:{sha8}`. */
interface FileMetaRecord {
  /** Relative path. */
  p: string;
  /** Size in bytes. */
  s: number;
  /** sha256 hex of the raw content. */
  h: string;
  /** Chunk count. */
  c: number;
  /** "gzip" | "identity". */
  e: "gzip" | "identity";
  /** Push timestamp (ISO) — version ordering for rebuild. */
  t: string;
}

const FM_KEY_RE = /^workspace:default:fm:([0-9a-f]{16}):([0-9a-f]{8})$/;
const CHUNK_KEY_RE = /^workspace:default:f:([0-9a-f]{16}):([0-9a-f]{8}):(\d{6})$/;

/** A surviving file-chunk group from a key scan: one (path, content
 *  version) pair with the chunk indexes still present in the cloud. */
export interface ChunkGroup {
  fileId: string;
  sha8: string;
  /** 1-based chunk indexes (as encoded in the keys) present in the cloud. */
  indexes: number[];
}

/** List keys with retries that UNION results — OnyxBase's list endpoint can
 *  hit a stale instance that shows only part of the namespace (observed
 *  live: the same prefix listed 19 keys on one instance and 46 on another). */
async function listKeysRobust(kv: OnyxBaseKV, prefix: string): Promise<string[]> {
  const union = new Set<string>();
  let sawAny = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const keys = await kv.listKeys(prefix);
      if (keys.length > 0) sawAny = true;
      for (const k of keys) union.add(k);
    } catch {
      /* retry */
    }
    // One non-empty pass + one confirmation pass is enough; keep retrying
    // only while nothing at all has been seen.
    if (attempt === 1 && sawAny) break;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
  }
  return [...union];
}

/** Scan all surviving `f:` chunk keys WITHOUT downloading values. */
async function scanChunkGroups(kv: OnyxBaseKV): Promise<ChunkGroup[]> {
  const keys = await listKeysRobust(kv, `${NS}:f:`);
  const groups = new Map<string, ChunkGroup>();
  for (const k of keys) {
    const m = CHUNK_KEY_RE.exec(k);
    if (!m) continue;
    const fileId = m[1] as string;
    const sha8v = m[2] as string;
    const idx = Number(m[3]);
    if (!Number.isFinite(idx) || idx < 1) continue;
    const id = `${fileId}:${sha8v}`;
    const g = groups.get(id) ?? { fileId, sha8: sha8v, indexes: [] };
    g.indexes.push(idx);
    groups.set(id, g);
  }
  for (const g of groups.values()) g.indexes.sort((a, b) => a - b);
  return [...groups.values()];
}

/** Common workspace paths probed during salvage so recognizable files
 *  (`.bashrc`, `package.json`, …) get their real names back — the path is
 *  otherwise lost with the manifest. fileId = sha256(path)[:16]. */
const COMMON_FILE_PATHS = [
  ".bashrc", ".profile", ".bash_logout", ".bash_profile", ".viminfo", ".gitconfig",
  "Onyx.md", "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "README.md", "readme.md", "LICENSE", ".gitignore", "tsconfig.json", "vite.config.ts",
  "next.config.js", "next.config.ts", "tailwind.config.js", "index.html",
  "index.js", "index.ts", "index.tsx", "index.css", "app.js", "app.ts", "app.tsx",
  "main.js", "main.ts", "main.tsx", "main.py", "app.py", "style.css", "styles.css",
  "script.js", "server.js", "server.ts", "requirements.txt", "pyproject.toml",
  "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "Makefile", "Dockerfile",
  "docker-compose.yml", ".env.example", "composer.json", "Gemfile", "src/index.ts",
  "src/App.tsx", "src/App.css", "src/index.css", "src/main.tsx", "src/main.ts",
  "src/app/page.tsx", "src/app/layout.tsx", "src/app/globals.css",
  "public/index.html", "app/main.py", "app/models.py", "app/routes.py",
  "components/App.tsx", "components/App.js", "styles/globals.css",
];

const COMMON_PATH_IDS: Promise<Map<string, string>> = (async () => {
  const m = new Map<string, string>();
  const enc = new TextEncoder();
  for (const p of COMMON_FILE_PATHS) {
    try {
      m.set((await sha256Hex(enc.encode(p))).slice(0, 16), p);
    } catch {
      /* skip */
    }
  }
  return m;
})();

/** Try to recover the original path for a fileId via the common-path
 *  dictionary (salvage naming only — never a correctness dependency). */
async function probePathForFileId(fileId: string): Promise<string | null> {
  try {
    return (await COMMON_PATH_IDS).get(fileId) ?? null;
  } catch {
    return null;
  }
}

/** Attempt to reassemble one chunk group into verified bytes: contiguous
 *  chunks from index 1, gzip→identity decode, sha256 must match the group's
 *  content-addressed sha8 (32 bits — false-positive odds ~1/4 billion). */
async function salvageGroup(
  kv: OnyxBaseKV,
  g: ChunkGroup,
): Promise<Uint8Array | null> {
  if (!g.indexes.includes(1)) return null;
  const parts: string[] = [];
  let i = 1;
  while (g.indexes.includes(i)) {
    let v: string | null = null;
    try {
      v = await kv.get(fileChunkKey(g.fileId, g.sha8, i - 1));
    } catch {
      v = null;
    }
    if (v === null) break;
    parts.push(v);
    i++;
  }
  if (parts.length === 0) return null;
  let payload: Uint8Array;
  try {
    payload = base64ToBytes(parts.join(""));
  } catch {
    return null;
  }
  let raw = payload;
  try {
    const gz = await gunzipBytes(payload);
    if (gz) raw = gz;
  } catch {
    /* identity fallback */
  }
  const digest = await sha256Hex(raw);
  if (!digest.startsWith(g.sha8)) return null;
  return raw;
}

/** Rebuild a usable manifest from surviving per-file `fm:` records when the
 *  committed manifest is unreadable. Candidates are tried newest-first and
 *  only accepted when every referenced chunk record exists. */
async function rebuildManifestFromMetaRecords(
  kv: OnyxBaseKV,
  pointer: WorkspacePointer,
): Promise<WorkspaceManifest | null> {
  const keys = await listKeysRobust(kv, `${NS}:fm:`);
  if (keys.length === 0) return null;
  const byPath = new Map<string, FileMetaRecord[]>();
  for (const k of keys) {
    if (!FM_KEY_RE.test(k)) continue;
    let raw: string | null = null;
    try {
      raw = await kv.get(k);
    } catch {
      continue;
    }
    if (!raw) continue;
    let rec: Partial<FileMetaRecord> | null = null;
    try {
      rec = JSON.parse(raw) as Partial<FileMetaRecord>;
    } catch {
      continue;
    }
    if (
      !rec ||
      typeof rec.p !== "string" ||
      !rec.p ||
      typeof rec.h !== "string" ||
      !Number.isFinite(rec.c) ||
      (rec.e !== "gzip" && rec.e !== "identity")
    ) {
      continue;
    }
    const arr = byPath.get(rec.p) ?? [];
    arr.push({
      p: rec.p,
      s: typeof rec.s === "number" ? rec.s : 0,
      h: rec.h,
      c: rec.c as number,
      e: rec.e,
      t: typeof rec.t === "string" ? rec.t : "",
    });
    byPath.set(rec.p, arr);
  }
  if (byPath.size === 0) return null;

  const enc = new TextEncoder();
  const files: WorkspaceFileMeta[] = [];
  for (const [path, recs] of byPath) {
    recs.sort((a, b) => (b.t ?? "").localeCompare(a.t ?? ""));
    const fileId = (await sha256Hex(enc.encode(path))).slice(0, 16);
    let chosen: FileMetaRecord | null = null;
    for (const rec of recs) {
      let complete = true;
      for (let c = 0; c < rec.c; c++) {
        let v: string | null = null;
        try {
          v = await kv.get(fileChunkKey(fileId, sha8(rec.h), c));
        } catch {
          v = null;
        }
        if (v === null) {
          complete = false;
          break;
        }
      }
      if (complete) {
        chosen = rec;
        break;
      }
    }
    if (chosen) {
      files.push({
        path,
        fileId,
        size: chosen.s,
        sha256: chosen.h,
        chunkCount: chosen.c,
        encoding: chosen.e,
      });
    }
  }
  if (files.length === 0) return null;
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    version: 1,
    workspaceId: WORKSPACE_ID,
    updatedAt: pointer.updatedAt,
    generation: pointer.generation,
    files,
    skippedFiles: [],
    totalFiles: files.length,
    totalBytes: files.reduce((s, f) => s + f.size, 0),
  };
}

/** README written into `.onyx-salvage/` alongside recovered files. */
function salvageReadme(
  salvaged: Array<{ path: string; bytes: number }>,
  unrecoverable: number,
): string {
  const lines = [
    "# Cloud workspace salvage",
    "",
    "The committed manifest of the cloud snapshot was lost by OnyxBase's",
    "storage backend, so file paths and the full file list could not be read",
    "back. This folder contains every file that could be re-assembled and",
    "checksum-verified from the surviving chunk records.",
    "",
    `**Recovered:** ${salvaged.length} file(s), ${salvaged.reduce((s, f) => s + f.bytes, 0)} bytes.`,
    `**Not recoverable:** ${unrecoverable} chunk group(s) had holes (missing early chunks — gzip streams cannot be re-assembled from the middle).`,
    "",
    "| File | Bytes |",
    "| --- | --- |",
    ...salvaged.map((f) => `| ${f.path} | ${f.bytes} |`),
    "",
    "Nothing in the cloud was deleted by this restore. Once you have real",
    "work in the sandbox again, push_workspace will commit a fresh, healthy",
    "snapshot (it refuses to overwrite this state from an empty sandbox, so",
    "your remaining data cannot be wiped by accident).",
    "",
  ];
  return lines.join("\n");
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
  /** Stable timestamp stamped into every fm record for version ordering. */
  const pushStamp = new Date().toISOString();

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

  // 3.5 EMPTY-PUSH GUARD — pushing an empty sandbox over a non-empty cloud
  //     snapshot is exactly how the 2026-09-11 workspace was nearly wiped:
  //     the user's local copy was gone, restore failed, and a re-push would
  //     have replaced the surviving cloud records with nothing. Refuse
  //     unless the caller passes an explicit force (user confirmation only).
  if (
    files.length === 0 &&
    oldPointer &&
    oldPointer.totalFiles > 0 &&
    !opts.force
  ) {
    base.errors.push({
      code: "EMPTY_PUSH_BLOCKED",
      message:
        `Refused to sync: the current sandbox has no syncable files, but the cloud workspace still holds ${oldPointer.totalFiles} committed file(s) (snapshot from ${oldPointer.updatedAt}). ` +
        "Pushing now would REPLACE that state and permanently delete the surviving data. " +
        "Run retrieve_workspace first — it restores (or salvages into .onyx-salvage/) whatever is recoverable — " +
        "and only push again once the sandbox actually holds work. Use force=true ONLY with the user's explicit confirmation.",
    });
    base.durationMs = Date.now() - t0;
    return base;
  }

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
        // Per-file metadata record — the DISTRIBUTED manifest. Survives
        // manifest-record loss at FILE granularity (see RECOVERY above).
        pendingWrites.push({
          key: fileMetaKey(fileId, sha8(digest)),
          value: JSON.stringify({
            p: f.path,
            s: f.size,
            h: digest,
            c: chunks.length,
            e: encoding,
            t: pushStamp,
          }),
        });
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

  // 6. Encode the manifest — INLINE in the pointer when it fits, else staged
  //    as content-addressed chunk records plus mirrored replicas.
  stage("committing", "Committing workspace snapshot…");
  const manifestJson = JSON.stringify(manifest);
  const manifestBytes = new TextEncoder().encode(manifestJson);
  const manifestSha = await sha256Hex(manifestBytes);
  const manifestGz = (await gzipBytes(manifestBytes)) ?? manifestBytes;
  const manifestEnc: "gzip" | "identity" =
    manifestGz.length < manifestBytes.length ? "gzip" : "identity";
  const manifestPayload = manifestEnc === "gzip" ? manifestGz : manifestBytes;
  const manifestB64 = bytesToBase64(manifestPayload);
  const manifestRecordKeys: string[] = [];
  let manifestChunkCount = 0;
  let manifestInline: string | null = null;
  if (manifestB64.length <= MANIFEST_INLINE_MAX) {
    // Small manifest → embed directly in the pointer record. The pointer IS
    // the atomic commit, so the manifest can never go missing on its own.
    manifestInline = manifestB64;
  } else {
    const mChunks = chunkString(manifestB64);
    manifestChunkCount = mChunks.length;
    for (let i = 0; i < mChunks.length; i++) {
      const value = mChunks[i];
      if (value === undefined) continue;
      const primary = manifestChunkKey(sha8(manifestSha), i);
      pendingWrites.push({ key: primary, value });
      const replica = manifestReplicaKey(sha8(manifestSha), i);
      pendingWrites.push({ key: replica, value });
      manifestRecordKeys.push(primary, replica);
    }
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

  // 7.5 PRE-COMMIT VERIFICATION (ALL staged records) — a KV write that
  //     returned 200 can still be STRANDED on the writing instance when
  //     OnyxBase's Telegram-mirror write silently fails (observed live
  //     2026-09-11 AND in live test runs: committed pointer + invisible
  //     chunks = restores that fail with "missing chunks"). Read back EVERY
  //     staged record — file chunks, per-file meta, manifest chunks — and
  //     rewrite any that don't match (each rewrite lands on a new random
  //     instance and retries the mirror write). Settle rounds absorb routing
  //     lag. Records that stay unreadable after the rounds BLOCK THE COMMIT:
  //     the previous cloud snapshot stays valid, the push reports "partial"
  //     and is safely retryable (content-addressed keys are idempotent, and
  //     the empty-push guard prevents any accidental wipe in between).
  {
    const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // OnyxBase smart-parses JSON-looking string values into objects (the
    // pointer round-trips as an object), so compare read-backs with a
    // normalization fallback: parse both sides when the strings differ.
    const equalValue = (a: string | null, b: string): boolean => {
      if (a === b) return true;
      if (a === null) return false;
      try {
        return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
      } catch {
        return false;
      }
    };
    // One "probe" = up to 3 GETs a few hundred ms apart. Reads route to
    // RANDOM instances, so a single miss proves nothing — a healthy record
    // still living on its writing instance (or already mirrored) is seen by
    // at least one of 3 rolls with high probability, while a record whose
    // mirror write silently failed stays invisible no matter how many rolls.
    const probe = async (key: string, value: string): Promise<boolean> => {
      for (let i = 0; i < 3; i++) {
        let back: string | null = null;
        try {
          back = await kv.get(key);
        } catch {
          back = null;
        }
        if (equalValue(back, value)) return true;
        if (i < 2) await settle(400);
      }
      return false;
    };
    const readBackAll = async (): Promise<Set<string>> => {
      const bad = new Set<string>();
      await pool(pendingWrites, KV_CONCURRENCY, async (w) => {
        if (!(await probe(w.key, w.value))) bad.add(w.key);
      });
      return bad;
    };
    let bad = await readBackAll(); // round 0 — immediate
    for (const round of [1, 2] as const) {
      if (bad.size === 0) break;
      stage(
        "committing",
        `Verifying records… (${pendingWrites.length - bad.size}/${pendingWrites.length} readable)`,
      );
      const toRewrite = pendingWrites.filter((w) => bad.has(w.key));
      await pool(toRewrite, KV_CONCURRENCY, async (w) => {
        try {
          await kv.set(w.key, w.value);
        } catch {
          /* re-probed after the settle */
        }
      });
      await settle(round === 1 ? 2000 : 4000); // let instances converge
      bad = await readBackAll();
    }
    if (bad.size > 0) {
      base.status = "partial";
      base.errors = errors;
      errors.push({
        code: "KV_WRITE_FAILED",
        message:
          `${bad.size} of ${pendingWrites.length} record(s) could not be verified as readable on OnyxBase after retries (mirror propagation failed on their instances). ` +
          "NO commit was made — the previous cloud snapshot is untouched. Run push_workspace again; it is safe to retry (unchanged files are reused).",
      });
      base.durationMs = Date.now() - t0;
      return base;
    }
  }

  const pointer: WorkspacePointer = {
    v: 1,
    workspaceId: WORKSPACE_ID,
    generation: manifest.generation,
    updatedAt: manifest.updatedAt,
    totalFiles: manifest.totalFiles,
    totalBytes: manifest.totalBytes,
    manifestSha256: manifestSha,
    manifestChunks: manifestChunkCount,
    ...(manifestInline
      ? { manifestInline, manifestEncoding: manifestEnc }
      : {}),
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

  // 8.5 POST-COMMIT VERIFICATION — a commit is only real if it reads back.
  //     Runs the EXACT code path a future retrieve uses (readPointer →
  //     readManifest), end-to-end, with one settle round because OnyxBase
  //     reads are eventually-consistent across instances (a fresh write may
  //     not be visible to every instance yet — lag, not a lost write). An
  //     unverifiable commit is KEPT and reported as "partial": read-back
  //     failures are usually stale routing, and content-addressed chunk keys
  //     mean a bad commit can never corrupt the previous state (the old
  //     chunks stay intact; rolling back a probably-good commit would be
  //     worse). NOTE: errors[] already carries any 7.5 warning — add the
  //     pointer-level warning only when the pointer itself wouldn't verify.
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const verifyCommit = async (): Promise<boolean> => {
    try {
      const back = await readPointer(kv);
      if (!back) return false;
      if (
        back.generation !== pointer.generation ||
        back.manifestSha256 !== pointer.manifestSha256
      ) {
        return false;
      }
      const m = await readManifest(kv, back);
      return m !== null && m.totalFiles === manifest.totalFiles;
    } catch {
      return false;
    }
  };
  let committed = await verifyCommit(); // immediate
  if (!committed) {
    stage("committing", "Verifying commit…");
    // The pointer write may be stranded on one instance — rewrite it once
    // (a new instance + fresh mirror write), then re-verify.
    try {
      await kv.set(POINTER_KEY, JSON.stringify(pointer));
    } catch {
      /* final verify below decides */
    }
    await settle(2500); // instance convergence window
    committed = await verifyCommit();
  }
  if (!committed) {
    errors.push({
      code: "KV_WRITE_FAILED",
      message:
        "The commit was written but could not be verified in OnyxBase yet (instance read lag). If retrieve_workspace reports problems, run push_workspace again — content-addressed records make the retry safe.",
    });
  }

  // 9. GC — remove managed chunks no longer referenced by the new manifest
  //    (including orphans left behind by earlier broken snapshots — PRD §11).
  stage("cleanup", "Cleaning up obsolete records…");
  let removedFiles = 0;
  if (!opts.skipGc) {
    const referenced = new Set<string>(manifestRecordKeys);
    for (const f of manifest.files) {
      for (let i = 0; i < f.chunkCount; i++) {
        referenced.add(fileChunkKey(f.fileId, sha8(f.sha256), i));
      }
      // Keep the fm record for EVERY manifest file (unchanged files reuse
      // records written by earlier pushes; changed files wrote new ones).
      referenced.add(fileMetaKey(f.fileId, sha8(f.sha256)));
    }
    try {
      const allKeys = await kv.listKeys(`${NS}:`);
      const obsolete = allKeys.filter((k) => isManagedChunkKey(k) && !referenced.has(k));
      if (obsolete.length > 0) {
        await pool(obsolete, KV_CONCURRENCY, async (k) => {
          try {
            await kv.delete(k);
          } catch {
            /* best-effort cleanup */
          }
        });
      }
      // Files present in the old manifest but absent now were removed from
      // the cloud representation — count for the report.
      removedFiles = oldManifest
        ? oldManifest.files.filter(
            (f) => !manifest.files.some((nf) => nf.path === f.path),
          ).length
        : 0;
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
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let pointer: WorkspacePointer | null = null;
  try {
    pointer = await readPointer(kv);
    if (!pointer) {
      // Cheap guard against stale-negative reads — a fresh write can be
      // invisible to the serving instance for a while (cold-start rehydrate
      // converges). One short settle + re-read before concluding "empty".
      await settle(2000);
      pointer = await readPointer(kv);
    }
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
    if (!manifest) {
      // Missing manifest records are often instance read lag, not loss —
      // retry across growing settle rounds before declaring corruption.
      // (Convergence is cold-start rehydrate; worst case can exceed 20s.)
      for (const ms of [3000, 6000, 12000]) {
        stage("checking", "Waiting for cloud records to converge…");
        await settle(ms);
        manifest = await readManifest(kv, pointer);
        if (manifest) break;
      }
    }
  } catch (e) {
    base.errors.push({
      code: e instanceof OnyxBaseError ? e.code : "KV_READ_FAILED",
      message: e instanceof Error ? e.message : "manifest read failed",
    });
    base.durationMs = Date.now() - t0;
    return base;
  }
  // The pointer EXISTS but its manifest payload may be unreadable — a
  // CORRUPT snapshot (manifest record lost durability on OnyxBase's
  // multi-instance backend; live incident 2026-09-11). Degrade gracefully
  // instead of hard-failing:
  //   1. rebuild the file list from surviving per-file fm: records;
  //   2. else salvage whole files straight from the surviving chunk keys.
  // NEVER advise a blind re-push — from an empty sandbox that would wipe the
  // remaining data (push_workspace's empty-push guard refuses it anyway).
  let degraded = false;
  if (!manifest) {
    stage("checking", "Manifest unreadable — rebuilding from per-file records…");
    try {
      manifest = await rebuildManifestFromMetaRecords(kv, pointer);
    } catch {
      manifest = null;
    }
    if (manifest) {
      degraded = true;
      stage("checking", `Rebuilt file list — ${manifest.files.length} recoverable file(s)…`);
    }
  }

  // Check mode — report cloud state, no restore.
  if (mode === "check") {
    if (!manifest) {
      // Corrupt snapshot: scan (no downloads) and report what a restore
      // could salvage, so callers get an honest verdict instead of a
      // misleading "not found".
      const groups = await scanChunkGroups(kv);
      const withHead = groups.filter((g) => g.indexes.includes(1)).length;
      base.errors.push({
        code: "CHECKSUM_MISMATCH",
        message:
          `The cloud snapshot is corrupt — the committed manifest was lost by OnyxBase's backend, but ${groups.length} file chunk group(s) still survive (${withHead} look complete). ` +
          "A restore will rebuild from per-file records or salvage whatever verifies — it never deletes anything.",
      });
      base.durationMs = Date.now() - t0;
      return base;
    }
    base.ok = true;
    base.status = "check";
    base.cloud = {
      totalFiles: manifest.totalFiles,
      totalBytes: manifest.totalBytes,
      updatedAt: manifest.updatedAt,
      generation: manifest.generation,
    };
    base.degraded = degraded;
    base.durationMs = Date.now() - t0;
    return base;
  }

  // Restore: download + verify each file, then write to E2B in batches.
  if (!e2b) {
    base.errors.push({ code: "E2B_UNAVAILABLE", message: "E2B client unavailable" });
    base.durationMs = Date.now() - t0;
    return base;
  }

  // SALVAGE MODE — no manifest and no fm records to rebuild from. Pull every
  // surviving chunk group, re-assemble the ones that start at chunk 1 and
  // pass their content-addressed checksum, and write them into
  // .onyx-salvage/ with a README explaining exactly what was recovered.
  if (!manifest) {
    stage("retrieving", "Snapshot manifest lost — salvaging surviving chunks…");
    const groups = await scanChunkGroups(kv);
    const salvaged: Array<{ path: string; bytes: Uint8Array }> = [];
    const failed: ChunkGroup[] = [];
    for (const g of groups) {
      if (opts.signal?.aborted) break;
      const raw = await salvageGroup(kv, g);
      if (raw) {
        const probed = await probePathForFileId(g.fileId);
        salvaged.push({
          path: probed
            ? `${SALVAGE_DIR}/${probed}`
            : `${SALVAGE_DIR}/recovered-${g.fileId}-${g.sha8}.bin`,
          bytes: raw,
        });
      } else {
        failed.push(g);
      }
    }
    const salvagedBytes = salvaged.reduce((s, f) => s + f.bytes.length, 0);
    base.salvage = {
      salvagedFiles: 0,
      salvagedBytes,
      salvagedPaths: salvaged.map((f) => f.path),
      unrecoverableGroups: failed.length,
    };
    if (salvaged.length > 0) {
      stage("restoring", `Writing ${salvaged.length} salvaged file(s)…`);
      const writes = salvaged.map((f) => ({ path: f.path, base64: bytesToBase64(f.bytes) }));
      writes.push({
        path: `${SALVAGE_DIR}/README.md`,
        base64: bytesToBase64(
          new TextEncoder().encode(
            salvageReadme(
              salvaged.map((f) => ({ path: f.path, bytes: f.bytes.length })),
              failed.length,
            ),
          ),
        ),
      });
      try {
        const r = await e2b.batchWriteBytes(writes);
        base.restoredFiles = r.written;
        for (const err of r.errors) {
          errors.push({ path: err.path, code: "RESTORE_FAILED", message: err.error });
        }
      } catch (e) {
        errors.push({
          code: "RESTORE_FAILED",
          message: e instanceof Error ? e.message : "E2B write failed during salvage",
        });
      }
      base.salvage.salvagedFiles = salvaged.length;
      base.downloadedBytes = salvagedBytes;
      base.integrityVerified = true; // every salvaged file verified by its sha8
      base.status = "partial";
      base.ok = false;
      errors.push({
        code: "CHECKSUM_MISMATCH",
        message:
          `Cloud snapshot was partially lost by OnyxBase (the committed manifest record is gone). Salvage mode re-assembled and checksum-verified ${salvaged.length} file(s) (${salvagedBytes} bytes) into ${SALVAGE_DIR}/ — see ${SALVAGE_DIR}/README.md. ` +
          `${failed.length} chunk group(s) had holes (missing early chunks) and could not be reconstructed; their records remain in the cloud, untouched. ` +
          "Nothing was deleted by this restore — the damage happened on OnyxBase's side before it. Tell the user this honestly, and do NOT push from an empty sandbox (push_workspace refuses that by default).",
      });
      stage("done", `Salvaged ${salvaged.length} file(s) into ${SALVAGE_DIR}/`);
      base.durationMs = Date.now() - t0;
      return base;
    }
    // Nothing re-assemblable — every surviving chunk group is a mid-stream
    // hole. Keep the records, report the loss honestly.
    errors.push({
      code: "CHECKSUM_MISMATCH",
      message:
        `The cloud snapshot's manifest was lost by OnyxBase and no complete file could be re-assembled from the ${groups.length} surviving chunk group(s) — all have holes (gzip streams cannot be re-assembled from the middle). ` +
        "The remaining records were left untouched — nothing was deleted by this restore. The stored data was already corrupted on OnyxBase's side before this session, so re-pushing cannot recover it (and push_workspace refuses to overwrite from an empty sandbox). " +
        "Be honest with the user about the loss; if they have the files anywhere else, they can drop them into the workspace and push a fresh snapshot.",
    });
    base.durationMs = Date.now() - t0;
    return base;
  }
  stage("retrieving", `Retrieving ${manifest.files.length} files…`);
  // A legitimately-empty cloud snapshot (e.g. after a forced empty sync) is
  // a SUCCESSFUL restore of zero files, not an error.
  if (manifest.files.length === 0) {
    base.ok = true;
    base.status = "success";
    base.restoredFiles = 0;
    base.integrityVerified = true;
    base.degraded = degraded;
    stage("done", "Cloud workspace is empty — nothing to restore");
    base.durationMs = Date.now() - t0;
    return base;
  }
  const verified: Array<{ path: string; base64: string; size: number }> = [];
  let checksumOk = 0;
  let checksumBad = 0;

  /** Download + verify ONE file. Returns the verified payload or the failure
   *  reason ("missing_chunk" for 404 holes — cross-instance propagation lag
   *  or a corrupt snapshot; OnyxBaseError for hard read failures). */
  const downloadFile = async (
    f: WorkspaceFileMeta,
  ): Promise<
    | { ok: true; path: string; base64: string; size: number }
    | { ok: false; kind: "missing_chunk" | "error" | "checksum"; message: string }
  > => {
    try {
      const parts: string[] = [];
      for (let c = 0; c < f.chunkCount; c++) {
        const val = await kv.get(fileChunkKey(f.fileId, sha8(f.sha256), c));
        if (val === null) {
          return {
            ok: false,
            kind: "missing_chunk",
            message: `chunk ${c + 1}/${f.chunkCount} record missing in cloud`,
          };
        }
        parts.push(val);
      }
      const payload = base64ToBytes(parts.join(""));
      const raw = f.encoding === "gzip" ? ((await gunzipBytes(payload)) ?? payload) : payload;
      const digest = await sha256Hex(raw);
      if (digest !== f.sha256 || raw.length !== f.size) {
        return { ok: false, kind: "checksum", message: "checksum mismatch — cloud copy is corrupt" };
      }
      return { ok: true, path: f.path, base64: bytesToBase64(raw), size: f.size };
    } catch (e) {
      const code = e instanceof OnyxBaseError ? `${e.code}: ` : "";
      return {
        ok: false,
        kind: "error",
        message: `${code}${e instanceof Error ? e.message : "chunk read failed"}`,
      };
    }
  };

  /** Files that failed ONLY with missing-chunk 404s get one extra round: the
   *  read may have hit a cold OnyxBase instance whose local index hadn't
   *  rehydrated the just-pushed records yet. A short settle delay + one
   *  retry resolves the transient case; a persistent miss is a real gap. */
  const missingChunkFiles: WorkspaceFileMeta[] = [];

  const absorb = (
    r: Awaited<ReturnType<typeof downloadFile>>,
    f: WorkspaceFileMeta,
  ): void => {
    if (r.ok) {
      checksumOk++;
      verified.push({ path: r.path, base64: r.base64, size: r.size });
      if (verified.length % 25 === 0) {
        stage("restoring", `Restoring files… (${verified.length}/${manifest.files.length})`);
      }
      return;
    }
    if (r.kind === "missing_chunk") {
      missingChunkFiles.push(f);
      return;
    }
    if (r.kind === "checksum") {
      checksumBad++;
      skipped.push({ path: f.path, reason: "checksum_mismatch" });
      return; // corrupt file — never silently accepted (PRD §33)
    }
    errors.push({ path: f.path, code: "KV_READ_FAILED", message: r.message });
  };

  for (const f of manifest.files) {
    if (opts.signal?.aborted) break;
    absorb(await downloadFile(f), f);
  }

  // Extra passes for cross-instance propagation lag (bounded, growing
  // waits) — a chunk that 404s now may simply be invisible to the serving
  // instance; only a persistent miss after all passes is a real gap.
  if (missingChunkFiles.length > 0) {
    let pending = missingChunkFiles;
    for (const waitMs of [3000, 6000, 12000]) {
      if (pending.length === 0 || opts.signal?.aborted) break;
      stage("retrieving", `Re-checking ${pending.length} lagging file(s)…`);
      await settle(waitMs);
      const next: WorkspaceFileMeta[] = [];
      for (const f of pending) {
        if (opts.signal?.aborted) {
          next.push(f);
          continue;
        }
        const r = await downloadFile(f);
        if (r.ok) {
          absorb(r, f);
        } else if (r.kind === "missing_chunk") {
          next.push(f);
        } else {
          absorb(r, f);
        }
      }
      pending = next;
    }
    for (const f of pending) {
      errors.push({
        path: f.path,
        code: "KV_READ_FAILED",
        message:
          "chunk record missing in cloud after retries — this file is not recoverable from the snapshot; if the sandbox holds real work, a new push_workspace re-commits a healthy snapshot (it refuses to run from an empty sandbox, so the surviving cloud data stays safe)",
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
  base.degraded = degraded;
  stage("done", `Workspace restored — ${restored} files`);

  base.durationMs = Date.now() - t0;
  return base;
}
