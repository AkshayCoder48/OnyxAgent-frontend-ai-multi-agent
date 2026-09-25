"use client";

/**
 * Skills ↔ OnyxBase KV sync (PRD §8).
 *
 * Skills live browser-side (Dexie `skills` rows + OPFS
 * `users/<id>/skills/<slug>/`), which the sandbox-oriented workspace sync
 * cannot see. This engine uploads them to their OWN KV namespace whenever
 * the user performs a workspace push (the `push_workspace` tool rides this
 * flow) or presses "Push skills to cloud" in Settings → Skills.
 *
 * KV LAYOUT (own namespace; follows the workspace-sync conventions — see
 * `workspace-sync.ts`, whose chunking/pacing lessons are reused verbatim):
 *
 *   skills:<userId>:manifest
 *       → the committed POINTER with the full manifest inlined (skills
 *         manifests are small; the pointer IS the atomic commit).
 *   skills:<userId>:skill:<slug>:meta
 *       → per-skill record: payload sha256, chunk count, encoding, per-file
 *         entries, name/description, syncedAt (the distributed manifest — a
 *         skill can be restored even if the pointer record is lost).
 *   skills:<userId>:skill:<slug>:chunk:000001…
 *       → base64(gzip(skill payload JSON)) slices.
 *
 * CHUNK SIZE uses the workspace-sync convention (120,000 base64 chars —
 * LIVE-VERIFIED 2026-09-12 against OnyxBase with byte-identical read-back;
 * the historical "~2–3 KB per KV record" assumption is what produced the
 * 9-hour push incident). A typical skill is ONE chunk.
 *
 * WRITE DISCIPLINE (mirror of the 9h-push lessons):
 *   - SEQUENTIAL writes (concurrency 1) — OnyxBase's durable mirror drops
 *     concurrent writes silently.
 *   - one bounded retry per record, then an honest per-skill failure;
 *   - hard wall-clock budget (default 2 min — skills are small);
 *   - the manifest pointer is committed LAST (the commit);
 *   - a KV write that acks 200 is durable (the mirror keeps up with
 *     sequential writes); read-back misses are instance LAG and become
 *     warnings, never "sync failed" (§38: never lie about persistence —
 *     but also never call a durable write a failure).
 *
 * NEVER-LOSE-SKILLS RULES (PRD §38):
 *   - a failed push never deletes or overwrites local skills (local state
 *     is only ever READ here);
 *   - cloud skills that no longer exist locally are CARRIED OVER in every
 *     new manifest (never auto-deleted — they become "Restore from cloud"
 *     candidates);
 *   - a local skill with an EMPTY directory never overwrites a non-empty
 *     cloud copy (per-skill empty-push guard);
 *   - GC only trims over-index chunk records of manifest members.
 *
 * RECONCILE RULE (documented, PRD §8): on refresh the UI reconciles local
 * skills with the cloud manifest WITHOUT deleting anything. Local content
 * WINS on conflict unless the cloud version is NEWER by its `syncedAt`
 * timestamp (content differs AND cloud.syncedAt > local.synced_at) — such
 * skills are flagged "cloud-newer" and an explicit "Update from cloud"
 * action is offered. Nothing is ever auto-overwritten or auto-deleted.
 */

import { OnyxBaseError, type OnyxBaseKV } from "./kv-client";

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

/** Encoded chars per KV value — the workspace-sync convention (see header). */
const CHUNK_SIZE = 120_000;

/** Max bytes of raw file content per synced skill (SKILL.md + assets). */
export const MAX_SKILL_BYTES = 2 * 1024 * 1024;

/** Hard wall-clock budget for one skills push. */
const SKILLS_PUSH_DEADLINE_MS = 2 * 60_000;

/** Manifest pointer + inline manifest size ceiling (base64 chars). */
const MANIFEST_INLINE_MAX = 100_000;

/** Max skills in one manifest (keeps the pointer record well under limits). */
const MAX_MANIFEST_SKILLS = 500;

/** Max obsolete-record deletions per GC pass. */
const GC_MAX_DELETES = 100;

/** One retry per KV record (bounded — no infinite loops). */
const KV_WRITE_RETRIES = 1;

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

/** Per-file entry inside a manifest/meta record. */
export interface SkillFileEntry {
  /** Relative path inside the skill dir (e.g. "SKILL.md", "scripts/run.py"). */
  p: string;
  /** Raw size in bytes. */
  s: number;
  /** sha256 hex of the raw content. */
  h: string;
}

/** One skill inside the committed manifest. */
export interface SkillsManifestEntry {
  slug: string;
  name: string;
  description: string | null;
  /** sha256 of the skill payload (all files) — incremental-reuse key. */
  sha256: string;
  chunkCount: number;
  encoding: "gzip" | "identity";
  /** Encoded payload size (bytes). */
  size: number;
  /** Total raw file bytes. */
  rawBytes: number;
  fileCount: number;
  files: SkillFileEntry[];
  /** ISO timestamp of the push that wrote this version. */
  syncedAt: string;
  /** Monotonic version counter per skill (bumped on every push). */
  version: number;
}

/** The committed pointer record at `skills:<userId>:manifest`. */
export interface SkillsPointer {
  v: 1;
  updatedAt: string;
  generation: number;
  skills: SkillsManifestEntry[];
}

/** Compact per-skill KV record at `skills:<userId>:skill:<slug>:meta`. */
export interface SkillMetaRecord {
  v: 1;
  slug: string;
  n: string;
  d: string | null;
  h: string;
  c: number;
  e: "gzip" | "identity";
  s: number;
  u: number;
  f: SkillFileEntry[];
  t: string;
  g: number;
}

export type SkillSyncState = "local" | "synced" | "syncing" | "sync_failed";

/** Minimal local-skill row shape this engine needs (subset of SkillRow). */
export interface LocalSkillRow {
  id: string;
  name: string;
  description: string | null;
  dir_path: string;
  is_active: boolean;
  updated_at: string;
  sync_state?: SkillSyncState | null;
  synced_at?: string | null;
  cloud_sha256?: string | null;
}

export interface SkillsPushResult {
  ok: boolean;
  status: "success" | "partial" | "error" | "not_configured";
  /** Skills whose chunks were (re)written this run. */
  pushed: number;
  /** Skills already in the cloud with identical content (zero writes). */
  unchanged: number;
  /** Skills that failed to push (per-skill error). */
  failed: number;
  /** Cloud-only skills carried over in the manifest (kept, never deleted). */
  cloudOnly: number;
  errors: string[];
  /** Per-skill non-fatal notes (oversize, empty dir, …). */
  skipped: string[];
  warnings: string[];
  durationMs: number;
}

/** Compact skills summary attached to the push_workspace tool result (the
 *  model + tool-result cards render this inline). */
export interface SkillsPushSummary {
  tool: "push_skills";
  ok: boolean;
  pushed: number;
  unchanged: number;
  failed: number;
  cloudOnly: number;
  errors: string[];
  skipped: string[];
  warnings: string[];
  durationMs: number;
}

export function toSummary(r: SkillsPushResult): SkillsPushSummary {
  return {
    tool: "push_skills",
    ok: r.ok,
    pushed: r.pushed,
    unchanged: r.unchanged,
    failed: r.failed,
    cloudOnly: r.cloudOnly,
    errors: r.errors,
    skipped: r.skipped,
    warnings: r.warnings,
    durationMs: r.durationMs,
  };
}

/** Reads one skill's files from storage (injectable for tests). */
export type SkillFileProvider = (
  slug: string,
) => Promise<Array<{ path: string; bytes: Uint8Array }>>;

/** Persists a sync-state patch on a Dexie row (injectable for tests). */
export type SkillRowUpdater = (
  id: string,
  patch: Partial<{ sync_state: SkillSyncState; synced_at: string | null; cloud_sha256: string | null; sync_chunks: number | null; sync_error: string | null }>,
) => Promise<void>;

export interface SkillsSyncOptions {
  kv: OnyxBaseKV;
  onStage?: (detail: string) => void;
  signal?: AbortSignal;
  deadlineMs?: number;
  /** Tests: inject the local rows (defaults to skillService.list). */
  rows?: LocalSkillRow[];
  /** Tests: inject the OPFS reader. */
  fileProvider?: SkillFileProvider;
  /** Tests: inject the Dexie row updater. */
  rowUpdater?: SkillRowUpdater;
  /** Tests/automation: skip the empty-read settle delay. */
  fastReads?: boolean;
}

// ---------------------------------------------------------------------------
// Key builders.
// ---------------------------------------------------------------------------

/** userIds are URL-safe ids in practice; anything else is hashed so the key
 *  stays collision-free and KV-safe. */
export function skillsNamespace(userId: string): string {
  if (/^[A-Za-z0-9_.-]+$/.test(userId)) return `skills:${userId}`;
  return `skills:${hashSegment(userId)}`;
}

function hashSegment(s: string): string {
  // Deterministic 16-hex digest without async crypto and without BigInt
  // literals (TS target < ES2020) — two 32-bit FNV-1a rolls are plenty for a
  // namespace segment.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c << 3) | (i & 7)), 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export function skillsPointerKey(userId: string): string {
  return `${skillsNamespace(userId)}:manifest`;
}

export function skillMetaKey(userId: string, slug: string): string {
  return `${skillsNamespace(userId)}:skill:${slug}:meta`;
}

export function skillChunkKey(userId: string, slug: string, index: number): string {
  return `${skillsNamespace(userId)}:skill:${slug}:chunk:${String(index + 1).padStart(6, "0")}`;
}

const CHUNK_KEY_RE = /^skills:([^:]+):skill:([^:]+):chunk:(\d{6})$/;

/** Only GC-managed keys parse as OUR chunk records. */
export function parseSkillChunkKey(key: string): { ns: string; slug: string; index: number } | null {
  const m = CHUNK_KEY_RE.exec(key);
  if (!m) return null;
  const index = Number(m[3]);
  if (!Number.isFinite(index) || index < 1) return null;
  return { ns: m[1]!, slug: m[2]!, index };
}

// ---------------------------------------------------------------------------
// Crypto / encoding helpers (WebCrypto + CompressionStream — same as the
// workspace engine).
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

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Payload building (pure — unit-tested).
// ---------------------------------------------------------------------------

export interface SkillPayload {
  /** sha256 of the raw file-content stream (the identity of this version). */
  sha256: string;
  /** Sorted per-file entries for the manifest/meta records. */
  files: SkillFileEntry[];
  /** gzip when it helped, else the raw JSON bytes. */
  encoded: Uint8Array;
  encoding: "gzip" | "identity";
  chunks: string[];
  rawBytes: number;
}

/**
 * Deterministically encode one skill's files into the KV payload:
 *   payload = JSON { v, files: [{ p, d: base64 }] }   (paths sorted)
 *   encoded = gzip(payload) when smaller, else payload
 *   chunks  = base64(encoded) sliced at CHUNK_SIZE
 *   sha256  = digest of the payload bytes (content identity for incremental
 *             reuse + integrity checks on restore)
 */
export async function buildSkillPayload(
  slug: string,
  files: Array<{ path: string; bytes: Uint8Array }>,
): Promise<SkillPayload> {
  void slug; // (payload body is file-only; slug lives in the meta records)
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let rawBytes = 0;
  const entries: Array<{ p: string; d: string; s: number; h: string }> = [];
  for (const f of sorted) {
    rawBytes += f.bytes.length;
    entries.push({ p: f.path, s: f.bytes.length, h: await sha256Hex(f.bytes), d: bytesToBase64(f.bytes) });
  }
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ v: 1, files: entries.map(({ p, d }) => ({ p, d })) }));
  const sha = await sha256Hex(payloadBytes);
  const gz = await gzipBytes(payloadBytes);
  const encoding: "gzip" | "identity" = gz && gz.length < payloadBytes.length ? "gzip" : "identity";
  const encoded = encoding === "gzip" ? gz! : payloadBytes;
  const chunks = chunkString(bytesToBase64(encoded));
  return {
    sha256: sha,
    files: entries.map(({ p, s, h }) => ({ p, s, h })),
    encoded,
    encoding,
    chunks,
    rawBytes,
  };
}

/** Rebuild the raw files from a downloaded payload (verify-first). */
export async function parseSkillPayload(
  encoded: Uint8Array,
  encoding: "gzip" | "identity",
  expectSha256: string,
): Promise<Array<{ path: string; bytes: Uint8Array }>> {
  const payload =
    encoding === "gzip" ? ((await gunzipBytes(encoded)) ?? encoded) : encoded;
  const sha = await sha256Hex(payload);
  if (sha !== expectSha256) {
    throw new Error(
      `Checksum mismatch — the cloud copy of this skill is corrupt (expected ${expectSha256.slice(0, 8)}…, got ${sha.slice(0, 8)}…). Nothing was overwritten.`,
    );
  }
  let parsed: { v?: number; files?: Array<{ p?: unknown; d?: unknown }> };
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload)) as typeof parsed;
  } catch {
    throw new Error("The cloud copy of this skill is not a valid skill payload.");
  }
  if (!Array.isArray(parsed.files)) {
    throw new Error("The cloud copy of this skill has no file list.");
  }
  return parsed.files
    .filter((f) => typeof f.p === "string" && typeof f.d === "string")
    .map((f) => ({ path: f.p as string, bytes: base64ToBytes(f.d as string) }));
}

// ---------------------------------------------------------------------------
// Default storage adapters (OPFS + Dexie).
// ---------------------------------------------------------------------------

/** Default file provider — reads `users/<userId>/skills/<slug>/` from OPFS. */
function opfsFileProvider(userId: string): SkillFileProvider {
  return async (slug: string) => {
    const { ensureSkillDir, walkFiles } = await import("@/lib/storage/opfs");
    const dir = await ensureSkillDir(userId, slug);
    const files = await walkFiles(dir);
    const out: Array<{ path: string; bytes: Uint8Array }> = [];
    for (const f of files) {
      const blob = await f.handle.getFile();
      out.push({ path: f.path, bytes: new Uint8Array(await blob.arrayBuffer()) });
    }
    return out;
  };
}

function defaultRowUpdater(): SkillRowUpdater {
  return async (id, patch) => {
    const { skillService } = await import("@/lib/services");
    await skillService.update(id, patch);
  };
}

async function loadRows(userId: string): Promise<LocalSkillRow[]> {
  const { skillService } = await import("@/lib/services");
  return (await skillService.list(userId)) as LocalSkillRow[];
}

// ---------------------------------------------------------------------------
// Manifest read/write.
// ---------------------------------------------------------------------------

/** Read the committed skills pointer (null when nothing is stored). Tolerant
 *  of OnyxBase's eventual-consistent reads: one settle + re-read before
 *  concluding "nothing in the cloud" (pass `settleOnEmpty: false` to skip the
 *  delay in tests / hot paths that already know the cloud may be empty). */
export async function readSkillsPointer(
  kv: OnyxBaseKV,
  userId: string,
  opts: { settleOnEmpty?: boolean } = {},
): Promise<SkillsPointer | null> {
  const key = skillsPointerKey(userId);
  let raw: string | null = null;
  try {
    raw = await kv.get(key);
    if (raw === null && opts.settleOnEmpty !== false) {
      await settle(1500);
      raw = await kv.get(key);
    }
  } catch (e) {
    if (e instanceof OnyxBaseError && e.code === "ONYXBASE_UNAUTHORIZED") throw e;
    return null;
  }
  if (!raw) return null;
  try {
    let parsed = JSON.parse(raw) as SkillsPointer & { gz?: string };
    if (parsed && parsed.v === 1 && typeof parsed.gz === "string" && Array.isArray(parsed.skills) && parsed.skills.length === 0) {
      // Oversized manifest committed in the compressed form — gunzip the
      // inner pointer (a read failure is treated as corrupt → null).
      const inner = await gunzipBytes(base64ToBytes(parsed.gz));
      if (!inner) return null;
      parsed = JSON.parse(new TextDecoder().decode(inner)) as SkillsPointer;
    }
    if (parsed && parsed.v === 1 && Array.isArray(parsed.skills)) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Manifest entry from a compact meta record. */
export function metaToEntry(rec: SkillMetaRecord): SkillsManifestEntry {
  return {
    slug: rec.slug,
    name: rec.n,
    description: rec.d,
    sha256: rec.h,
    chunkCount: rec.c,
    encoding: rec.e,
    size: rec.s,
    rawBytes: rec.u,
    fileCount: rec.f.length,
    files: rec.f,
    syncedAt: rec.t,
    version: rec.g,
  };
}

/** Compact meta record from a manifest entry. */
export function entryToMeta(e: SkillsManifestEntry): SkillMetaRecord {
  return {
    v: 1,
    slug: e.slug,
    n: e.name,
    d: e.description,
    h: e.sha256,
    c: e.chunkCount,
    e: e.encoding,
    s: e.size,
    u: e.rawBytes,
    f: e.files,
    t: e.syncedAt,
    g: e.version,
  };
}

/** Sequential, paced KV write with ONE bounded retry (9h-push lesson). */
async function writeRecord(kv: OnyxBaseKV, key: string, value: string): Promise<void> {
  for (let attempt = 0; attempt <= KV_WRITE_RETRIES; attempt++) {
    try {
      await kv.set(key, value);
      return;
    } catch (err) {
      if (err instanceof OnyxBaseError && err.code === "ONYXBASE_UNAUTHORIZED") throw err;
      if (attempt === KV_WRITE_RETRIES) throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// PUSH.
// ---------------------------------------------------------------------------

export async function pushSkillsToCloud(
  userId: string,
  opts: SkillsSyncOptions,
): Promise<SkillsPushResult> {
  const t0 = Date.now();
  const { kv, onStage } = opts;
  const deadlineAt = t0 + (opts.deadlineMs ?? SKILLS_PUSH_DEADLINE_MS);
  const stage = (detail: string) => onStage?.(detail);

  const base: SkillsPushResult = {
    ok: false,
    status: "error",
    pushed: 0,
    unchanged: 0,
    failed: 0,
    cloudOnly: 0,
    errors: [],
    skipped: [],
    warnings: [],
    durationMs: 0,
  };

  let rows: LocalSkillRow[];
  try {
    rows = opts.rows ?? (await loadRows(userId));
  } catch (e) {
    base.errors.push(`Could not read the local skills list: ${e instanceof Error ? e.message : String(e)}`);
    base.durationMs = Date.now() - t0;
    return base;
  }
  if (rows.length === 0 && !opts.rows) {
    // Nothing local — nothing to push (never wipe; cloud-only entries are
    // simply not carried into a NEW manifest because we don't commit at all).
    base.ok = true;
    base.status = "success";
    base.durationMs = Date.now() - t0;
    return base;
  }

  const readSkillFiles = opts.fileProvider ?? opfsFileProvider(userId);
  const updateRow = opts.rowUpdater ?? defaultRowUpdater();

  // 1. Read the committed cloud state (incremental reuse + carried entries).
  stage("Checking cloud skills…");
  let oldPointer: SkillsPointer | null = null;
  try {
    oldPointer = await readSkillsPointer(kv, userId, { settleOnEmpty: !opts.fastReads });
  } catch (e) {
    base.errors.push(e instanceof Error ? e.message : "cloud read failed");
    base.durationMs = Date.now() - t0;
    return base;
  }
  const oldBySlug = new Map((oldPointer?.skills ?? []).map((e) => [e.slug, e]));

  // Deduplicate rows by name (Dexie guarantees uniqueness, but be safe).
  const bySlug = new Map<string, LocalSkillRow>();
  for (const r of rows) bySlug.set(r.name, r);

  // 2. Build + upload every LOCAL skill.
  const newEntries = new Map<string, SkillsManifestEntry>();
  const pushStamp = new Date().toISOString();
  const failedSlugs = new Set<string>();

  for (const [slug, row] of bySlug) {
    if (opts.signal?.aborted) break;
    if (Date.now() > deadlineAt) {
      base.warnings.push(
        `The ${Math.round((opts.deadlineMs ?? SKILLS_PUSH_DEADLINE_MS) / 1000)}s skills-push budget elapsed — remaining skills were not pushed. Nothing was committed; re-running resumes cheaply.`,
      );
      break;
    }

    // Files from local storage.
    let files: Array<{ path: string; bytes: Uint8Array }>;
    try {
      files = await readSkillFiles(slug);
    } catch (e) {
      failedSlugs.add(slug);
      base.failed++;
      const message = `Could not read the local files of "${slug}": ${e instanceof Error ? e.message : String(e)}`;
      base.errors.push(message);
      await updateRow(row.id, { sync_state: "sync_failed", sync_error: message }).catch(() => {});
      continue;
    }

    if (files.length === 0) {
      // Per-skill EMPTY-PUSH GUARD — an empty local dir must never replace a
      // non-empty cloud copy (mirror of the workspace empty-push rule).
      const old = oldBySlug.get(slug);
      if (old && old.fileCount > 0) {
        base.skipped.push(
          `"${slug}" has no local files but the cloud copy holds ${old.fileCount} — kept the cloud version (re-install the skill locally before pushing to replace it).`,
        );
        newEntries.set(slug, old);
        continue;
      }
      base.skipped.push(`"${slug}" has an empty skill directory — nothing to push.`);
      continue;
    }

    const totalBytes = files.reduce((s, f) => s + f.bytes.length, 0);
    if (totalBytes > MAX_SKILL_BYTES) {
      failedSlugs.add(slug);
      base.failed++;
      const message = `"${slug}" is ${(totalBytes / 1048576).toFixed(1)} MB — above the ${Math.round(MAX_SKILL_BYTES / 1048576)} MB per-skill sync cap.`;
      base.errors.push(message);
      await updateRow(row.id, { sync_state: "sync_failed", sync_error: message }).catch(() => {});
      continue;
    }

    const payload = await buildSkillPayload(slug, files);
    const old = oldBySlug.get(slug);
    if (old && old.sha256 === payload.sha256) {
      // Incremental: identical content — reuse the committed record as-is.
      base.unchanged++;
      newEntries.set(slug, old);
      await updateRow(row.id, {
        sync_state: "synced",
        synced_at: old.syncedAt,
        cloud_sha256: old.sha256,
        sync_chunks: old.chunkCount,
        sync_error: null,
      }).catch(() => {});
      continue;
    }

    stage(`Syncing skill "${slug}"…`);
    await updateRow(row.id, { sync_state: "syncing" }).catch(() => {});
    try {
      // Chunks first, meta second (meta references the chunks). Sequential +
      // paced — see WRITE DISCIPLINE.
      for (let i = 0; i < payload.chunks.length; i++) {
        await writeRecord(kv, skillChunkKey(userId, slug, i), payload.chunks[i]!);
      }
      const version = (old?.version ?? 0) + 1;
      const entry: SkillsManifestEntry = {
        slug,
        name: slug,
        description: row.description,
        sha256: payload.sha256,
        chunkCount: payload.chunks.length,
        encoding: payload.encoding,
        size: payload.encoded.length,
        rawBytes: payload.rawBytes,
        fileCount: payload.files.length,
        files: payload.files,
        syncedAt: pushStamp,
        version,
      };
      const meta = entryToMeta(entry);
      meta.n = row.name || slug;
      await writeRecord(kv, skillMetaKey(userId, slug), JSON.stringify(meta));
      newEntries.set(slug, { ...entry, name: meta.n });
      base.pushed++;
      await updateRow(row.id, {
        sync_state: "synced",
        synced_at: pushStamp,
        cloud_sha256: payload.sha256,
        sync_chunks: payload.chunks.length,
        sync_error: null,
      }).catch(() => {});
    } catch (e) {
      if (e instanceof OnyxBaseError && e.code === "ONYXBASE_UNAUTHORIZED") {
        base.errors.push(e.message);
        base.durationMs = Date.now() - t0;
        return base;
      }
      failedSlugs.add(slug);
      base.failed++;
      const message = `Failed to sync "${slug}": ${e instanceof Error ? e.message : String(e)}`;
      base.errors.push(message);
      await updateRow(row.id, { sync_state: "sync_failed", sync_error: message }).catch(() => {});
    }
  }

  if (opts.signal?.aborted) {
    base.status = "partial";
    base.warnings.push("Push aborted — nothing was committed; the previous cloud manifest is untouched.");
    base.durationMs = Date.now() - t0;
    return base;
  }

  // 3. Carry over CLOUD-ONLY skills (locally deleted skills are NEVER
  //    removed from the cloud — they stay restorable).
  for (const [slug, entry] of oldBySlug) {
    if (!newEntries.has(slug) && !failedSlugs.has(slug)) {
      newEntries.set(slug, entry);
      base.cloudOnly++;
    }
  }

  if (newEntries.size > MAX_MANIFEST_SKILLS) {
    base.errors.push(
      `${newEntries.size} skills exceed the ${MAX_MANIFEST_SKILLS}-skill manifest cap — remove some skills before pushing.`,
    );
    base.status = "error";
    base.durationMs = Date.now() - t0;
    return base;
  }

  // 4. COMMIT — the manifest pointer write flips the cloud state. Skills
  //    whose writes failed are NOT committed (their old entries survive).
  if (base.failed === 0) {
    const pointer: SkillsPointer = {
      v: 1,
      updatedAt: new Date().toISOString(),
      generation: (oldPointer?.generation ?? 0) + 1,
      skills: [...newEntries.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1)),
    };
    let manifestStr = JSON.stringify(pointer);
    // Keep the pointer record comfortably under the value ceiling: gzip the
    // manifest JSON when it is large (stored base64(gzip) with a `gz` marker
    // — readSkillsPointer transparently decompresses it).
    if (manifestStr.length > MANIFEST_INLINE_MAX) {
      const gz = await gzipBytes(new TextEncoder().encode(manifestStr));
      if (!gz) {
        base.errors.push("The skills manifest is too large for a single KV record — split your skills.");
        base.status = "error";
        base.durationMs = Date.now() - t0;
        return base;
      }
      manifestStr = JSON.stringify({ ...pointer, skills: [], gz: bytesToBase64(gz) });
    }
    try {
      stage("Committing skills manifest…");
      await writeRecord(kv, skillsPointerKey(userId), manifestStr);
    } catch (e) {
      if (e instanceof OnyxBaseError && e.code === "ONYXBASE_UNAUTHORIZED") {
        base.errors.push(e.message);
      } else {
        base.errors.push(`Commit failed: ${e instanceof Error ? e.message : String(e)} — chunk records were written but the cloud manifest was NOT updated (retry is safe).`);
      }
      base.status = "partial";
      base.durationMs = Date.now() - t0;
      return base;
    }

    // 4.5 POST-COMMIT VERIFICATION — read the pointer back through the exact
    //     retrieve path. A read-back miss after one rewrite + settle is
    //     instance LAG, not a lost write → warning (mirror of workspace 8.5).
    const verify = async (): Promise<boolean> => {
      try {
        const back = await readSkillsPointer(kv, userId, { settleOnEmpty: !opts.fastReads });
        return !!back && back.generation === pointer.generation;
      } catch {
        return false;
      }
    };
    if (!(await verify())) {
      try {
        await kv.set(skillsPointerKey(userId), manifestStr);
      } catch {
        /* final verdict below */
      }
      await settle(2000);
      if (!(await verify())) {
        base.warnings.push(
          "The skills manifest was written (acked 200 — durable) but could not be re-read yet (OnyxBase instance lag). If restore reports problems, wait ~1 minute and retry.",
        );
      }
    }

    // 5. GC — trim over-index chunk records of manifest members (a skill
    //    that shrank leaves stale chunk:000002+ keys behind). Cloud-only and
    //    failed skills are manifest members too → protected. Bounded.
    try {
      const allKeys = await kv.listKeys(`${skillsNamespace(userId)}:skill:`);
      const chunkCountBySlug = new Map(
        [...newEntries.values()].map((e) => [e.slug, e.chunkCount]),
      );
      const obsolete: string[] = [];
      for (const key of allKeys) {
        const parsed = parseSkillChunkKey(key);
        if (!parsed) continue;
        const count = chunkCountBySlug.get(parsed.slug);
        if (count !== undefined && parsed.index > count) obsolete.push(key);
      }
      const toDelete = obsolete.slice(0, GC_MAX_DELETES);
      for (const key of toDelete) {
        await kv.delete(key).catch(() => {});
      }
    } catch {
      /* GC is best-effort */
    }
  } else {
    base.status = "partial";
    base.warnings.push(
      `${base.failed} skill(s) failed — the cloud manifest was NOT committed (the previous cloud state is untouched). Fix or remove the failing skills and push again.`,
    );
    base.durationMs = Date.now() - t0;
    return base;
  }

  base.ok = base.errors.length === 0;
  base.status = base.ok ? "success" : "partial";
  base.durationMs = Date.now() - t0;
  return base;
}

// ---------------------------------------------------------------------------
// Cloud inspection + reconcile (pure plan + IO wrapper).
// ---------------------------------------------------------------------------

export interface LocalSkillFingerprint {
  slug: string;
  /** sha256 of the local payload (null when the local dir is unreadable). */
  sha: string | null;
  updatedAt: string;
  syncedAt: string | null;
}

export type ReconcileVerdict = "synced" | "local" | "cloud-newer" | "missing-files";

export interface ReconcilePlanEntry {
  slug: string;
  verdict: ReconcileVerdict;
  cloudSyncedAt?: string;
}

export interface ReconcilePlan {
  /** One entry per LOCAL skill. */
  local: ReconcilePlanEntry[];
  /** Cloud skills with NO local counterpart — offered via "Restore from
   *  cloud"; NEVER auto-deleted or auto-restored. */
  cloudOnly: SkillsManifestEntry[];
}

/**
 * Pure conflict resolution (documented rule, see module header):
 *  - local sha === cloud sha               → "synced"
 *  - no local files                        → "missing-files" (restore offered)
 *  - shas differ AND cloud.syncedAt > local.syncedAt → "cloud-newer"
 *  - otherwise (local newer / never synced) → "local" (push will update)
 * LOCAL ALWAYS WINS unless the cloud is strictly newer by timestamp.
 */
export function planReconcile(
  locals: LocalSkillFingerprint[],
  cloud: SkillsPointer | null,
): ReconcilePlan {
  const cloudBySlug = new Map((cloud?.skills ?? []).map((e) => [e.slug, e]));
  const local: ReconcilePlanEntry[] = [];
  const localSlugs = new Set<string>();

  for (const l of locals) {
    localSlugs.add(l.slug);
    const c = cloudBySlug.get(l.slug);
    if (!c) {
      local.push({ slug: l.slug, verdict: "local" });
      continue;
    }
    if (l.sha === null) {
      local.push({ slug: l.slug, verdict: "missing-files", cloudSyncedAt: c.syncedAt });
      continue;
    }
    if (l.sha === c.sha256) {
      local.push({ slug: l.slug, verdict: "synced", cloudSyncedAt: c.syncedAt });
      continue;
    }
    const localStamp = l.syncedAt ? Date.parse(l.syncedAt) : 0;
    const cloudStamp = Date.parse(c.syncedAt);
    const cloudNewer =
      Number.isFinite(cloudStamp) &&
      cloudStamp > localStamp &&
      // A skill never pushed from THIS device is "local" (its content wins
      // until the next push) — only a cloud push NEWER than our last sync
      // (i.e. from another device) flags "cloud-newer".
      l.syncedAt !== null;
    local.push({
      slug: l.slug,
      verdict: cloudNewer ? "cloud-newer" : "local",
      cloudSyncedAt: c.syncedAt,
    });
  }

  const cloudOnly = [...cloudBySlug.values()].filter((e) => !localSlugs.has(e.slug));
  cloudOnly.sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return { local, cloudOnly };
}

/** Cloud-side summary for the UI ("Restore from cloud" list + badges). */
export async function getCloudSkillsSummary(
  kv: OnyxBaseKV,
  userId: string,
): Promise<{ updatedAt: string; generation: number; skills: SkillsManifestEntry[] } | null> {
  const p = await readSkillsPointer(kv, userId);
  if (!p) return null;
  return { updatedAt: p.updatedAt, generation: p.generation, skills: p.skills };
}

/** Compute the local payload sha for every skill row (used by the reconcile
 *  flow — the UI derives its badges from the plan, not from cached state). */
export async function computeLocalFingerprints(
  userId: string,
  rows: LocalSkillRow[],
  fileProvider?: SkillFileProvider,
): Promise<LocalSkillFingerprint[]> {
  const readSkillFiles = fileProvider ?? opfsFileProvider(userId);
  const out: LocalSkillFingerprint[] = [];
  for (const row of rows) {
    try {
      const files = await readSkillFiles(row.name);
      if (files.length === 0) {
        out.push({ slug: row.name, sha: null, updatedAt: row.updated_at, syncedAt: row.synced_at ?? null });
        continue;
      }
      const payload = await buildSkillPayload(row.name, files);
      out.push({ slug: row.name, sha: payload.sha256, updatedAt: row.updated_at, syncedAt: row.synced_at ?? null });
    } catch {
      out.push({ slug: row.name, sha: null, updatedAt: row.updated_at, syncedAt: row.synced_at ?? null });
    }
  }
  return out;
}

export interface ReconcileOutcome {
  plan: ReconcilePlan;
  /** Rows whose cached sync_state was "syncing" from a crashed session and
   *  got reset to an honest "sync_failed (interrupted)". */
  resetStuck: string[];
}

/**
 * Full reconcile for the Settings UI (runs when the Skills section opens):
 * reads local rows + local content fingerprints + the cloud manifest, resets
 * rows stuck in "syncing" from a previous crashed session, and returns the
 * display plan. NEVER writes skill content, NEVER deletes anything.
 */
export async function reconcileSkillsFromCloud(
  userId: string,
  opts: SkillsSyncOptions,
): Promise<ReconcileOutcome> {
  const rows = opts.rows ?? (await loadRows(userId));
  const kv = opts.kv;
  const resetStuck: string[] = [];
  const updateRow = opts.rowUpdater ?? defaultRowUpdater();
  for (const row of rows) {
    if (row.sync_state === "syncing") {
      // A "syncing" row on a FRESH reconcile is a push that never finished
      // (crashed tab) — reset to an honest failed state (§38: badges never lie).
      resetStuck.push(row.name);
      await updateRow(row.id, {
        sync_state: "sync_failed",
        sync_error: "Sync was interrupted before it finished — push again.",
      }).catch(() => {});
    }
  }
  const refreshedRows = opts.rows ?? (await loadRows(userId));
  const fingerprints = await computeLocalFingerprints(userId, refreshedRows, opts.fileProvider);
  const cloud = await readSkillsPointer(kv, userId, { settleOnEmpty: !opts.fastReads }).catch(() => null);
  return { plan: planReconcile(fingerprints, cloud), resetStuck };
}

// ---------------------------------------------------------------------------
// RESTORE (one skill, cloud → local).
// ---------------------------------------------------------------------------

export interface RestoreSkillResult {
  ok: boolean;
  slug: string;
  restoredFiles: number;
  error?: string;
}

/** Download + verify + persist ONE cloud skill into OPFS/Dexie. Never
 *  deletes anything; a checksum failure aborts BEFORE any local write. */
export async function restoreSkillFromCloud(
  userId: string,
  slug: string,
  opts: SkillsSyncOptions,
): Promise<RestoreSkillResult> {
  const { kv } = opts;
  try {
    // 1. Meta record (authoritative), manifest entry as fallback.
    let rec: SkillMetaRecord | null = null;
    try {
      const raw = await kv.get(skillMetaKey(userId, slug));
      if (raw) rec = JSON.parse(raw) as SkillMetaRecord;
    } catch {
      /* fall through to the manifest */
    }
    let entry: SkillsManifestEntry | null = rec
      ? metaToEntry(rec)
      : null;
    if (!entry) {
      const pointer = await readSkillsPointer(kv, userId, { settleOnEmpty: !opts.fastReads });
      entry = pointer?.skills.find((e) => e.slug === slug) ?? null;
    }
    if (!entry || entry.chunkCount < 1) {
      return { ok: false, slug, restoredFiles: 0, error: `No cloud copy of "${slug}" was found (its records may still be converging — retry in a minute).` };
    }

    // 2. Download the chunks (sequential, settle-tolerant for propagation
    //    lag — bounded rounds, no infinite loops).
    const parts: string[] = [];
    for (let i = 0; i < entry.chunkCount; i++) {
      let val: string | null = null;
      for (let attempt = 0; attempt < 3 && val === null; attempt++) {
        try {
          val = await kv.get(skillChunkKey(userId, slug, i));
        } catch {
          val = null;
        }
        if (val === null && attempt < 2) await settle(1500 + attempt * 1500);
      }
      if (val === null) {
        return {
          ok: false,
          slug,
          restoredFiles: 0,
          error: `Chunk ${i + 1}/${entry.chunkCount} of "${slug}" is missing in the cloud (instance lag or a damaged snapshot) — nothing was overwritten locally. Retry in a minute.`,
        };
      }
      parts.push(val);
    }
    const encoded = base64ToBytes(parts.join(""));

    // 3. Verify + parse (aborts before any write on mismatch).
    const files = await parseSkillPayload(encoded, entry.encoding, entry.sha256);

    // 4. Persist to OPFS + Dexie. The restore is a cloud-pull: the sync
    //    bookkeeping matches the cloud version exactly afterwards.
    const { writeFileAtPath, ensureSkillDir } = await import("@/lib/storage/opfs");
    const { skillService } = await import("@/lib/services");
    await ensureSkillDir(userId, slug);
    const dirPath = `users/${userId}/skills/${slug}`;
    for (const f of files) {
      if (f.path.startsWith("/") || f.path.split("/").includes("..")) continue; // defense in depth
      const segments = f.path.split("/");
      const filename = segments.pop();
      if (!filename) continue;
      const subdir = segments.length > 0 ? `${dirPath}/${segments.join("/")}` : dirPath;
      const buf = new ArrayBuffer(f.bytes.byteLength);
      new Uint8Array(buf).set(f.bytes);
      await writeFileAtPath(subdir, filename, new Blob([buf]));
    }
    const row = await skillService.install(userId, slug, entry.description, dirPath, {
      source: "restore",
      fileCount: files.length,
      resetSync: false,
    });
    const updateRow = opts.rowUpdater ?? defaultRowUpdater();
    await updateRow(row.id, {
      sync_state: "synced",
      synced_at: entry.syncedAt,
      cloud_sha256: entry.sha256,
      sync_chunks: entry.chunkCount,
      sync_error: null,
    }).catch(() => {});

    // 5. Fire-and-forget: make the restored SKILL.md available in the
    //    sandbox too (same discipline as local installs).
    try {
      const { readTextFile } = await import("@/lib/storage/opfs");
      const md = await readTextFile(`${dirPath}/SKILL.md`);
      const { uploadSkillToSandbox } = await import("@/lib/skills/installer");
      void uploadSkillToSandbox(userId, slug, md).catch(() => {});
    } catch {
      /* no SKILL.md in the payload — fine */
    }

    return { ok: true, slug, restoredFiles: files.length };
  } catch (e) {
    return {
      ok: false,
      slug,
      restoredFiles: 0,
      error: e instanceof Error ? e.message : `Failed to restore "${slug}".`,
    };
  }
}

// ---------------------------------------------------------------------------
// Credential resolution (mirrors the push_workspace tool's resolveOnyxBase).
// ---------------------------------------------------------------------------

/** Resolve the encrypted OnyxBase key + build the KV client. Returns null
 *  when unconfigured (never throws). */
export async function resolveSkillsKVClient(userId: string): Promise<OnyxBaseKV | null> {
  try {
    const { settingsService } = await import("@/lib/services");
    const key = await settingsService.getDecryptedOnyxBaseApiKey(userId);
    if (!key || !key.trim()) return null;
    const settings = await settingsService.get(userId).catch(() => null);
    const { ONYXBASE_DEFAULT_BASE_URL } = await import("./kv-client");
    const baseUrl = settings?.onyxbase_base_url || ONYXBASE_DEFAULT_BASE_URL;
    const { OnyxBaseKV: Ctor } = await import("./kv-client");
    return new Ctor(key, baseUrl);
  } catch {
    return null;
  }
}
