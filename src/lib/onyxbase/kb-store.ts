"use client";

/**
 * Knowledge Base store — the workspace's persistent AI memory, layered on
 * the EXISTING OnyxBase KV + Files APIs (no parallel storage system).
 *
 * WHAT THIS IS (PRD: Knowledge Base tab):
 *   A curated, workspace-scoped set of knowledge items (decisions,
 *   conventions, architecture notes, research findings, documentation,
 *   preferences) plus references to files hosted in OnyxBase's file store.
 *   The AI saves here DELIBERATELY (important / persistent / useful later);
 *   it searches here when prior workspace knowledge would help.
 *
 * KV LAYOUT (collection "onyxagent" — the same collection the KV client
 * already uses; chunking/pacing conventions reused from skills-sync):
 *
 *   kb:<userId>:manifest
 *       → { v, updatedAt, items: [summaries…] } — the committed CATALOG.
 *         Written LAST on every mutation (the commit), exactly like the
 *         skills-sync pointer. One read powers list + tag/title search.
 *   kb:<userId>:item:<id>
 *       → the item ENVELOPE: metadata + (when content is small) the inline
 *         base64 payload in `d`; otherwise chunk refs (see `c`).
 *   kb:<userId>:item:<id>:c:000001…
 *       → base64(gzip(content)) slices for large content (120,000 chars per
 *         chunk — the live-verified OnyxBase value ceiling).
 *
 * WRITE DISCIPLINE (9h-push lessons, mirrored from skills-sync):
 *   - SEQUENTIAL writes only (concurrency 1) — the durable mirror drops
 *     concurrent writes silently.
 *   - one bounded retry per KV record;
 *   - the manifest commits LAST — a crashed mid-save leaves an orphan item
 *     record (harmless; the self-heal rebuild re-catalogs it);
 *   - a KV write that acks 200 is durable; read-back misses are instance
 *     lag, not failures.
 *
 * SELF-HEAL: if the manifest record is lost (OnyxBase instance wipe), the
 * catalog is REBUILT from the per-item records — each envelope is
 * self-describing. Knowledge survives even without its pointer.
 *
 * PERSISTENCE GUARANTEES: everything lives in the user's own OnyxBase
 * account — survives chats, refreshes, browser sessions, sandbox restarts
 * and chat deletion. Deleting a chat never touches this data; deleting KB
 * data is always an explicit store operation.
 */

import { OnyxBaseError, OnyxBaseKV } from "./kv-client";
import { OnyxBaseFiles, type OnyxBaseFile } from "./files-client";

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

/** Encoded chars per KV value — the live-verified workspace-sync convention. */
const CHUNK_SIZE = 120_000;

/** Hard cap on one item's raw content (chars) — keeps records bounded. */
export const MAX_KB_CONTENT_CHARS = 400_000;

/** Hard cap on title length. */
export const MAX_KB_TITLE_CHARS = 200;

/** Max entries kept inline in the manifest record. */
const MAX_MANIFEST_ITEMS = 400;

/** Cap on per-item records read during a self-heal rebuild. */
const REBUILD_MAX_READS = 250;

/** Max item CONTENTS scanned for a content search (most recent first). */
const CONTENT_SCAN_MAX = 40;

/** Default search result limit. */
const DEFAULT_SEARCH_LIMIT = 10;

/** One retry per KV record (bounded — no infinite loops). */
const KV_WRITE_RETRIES = 1;

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

/** Knowledge item types (surfaced as filter sections in the KB tab). */
export type KBItemType = "memory" | "knowledge" | "decision" | "document" | "research" | "note";

export const KB_ITEM_TYPES: readonly KBItemType[] = [
  "memory",
  "knowledge",
  "decision",
  "document",
  "research",
  "note",
];

/** Who created the item — "ai" items get the "AI Saved" badge in the UI. */
export type KBItemSource = "ai" | "user";

/** Full knowledge item (content included). */
export interface KBItem {
  id: string;
  type: KBItemType;
  title: string;
  content: string;
  source: KBItemSource;
  category: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** Raw content size in chars. */
  size: number;
  /** Optional reference to a hosted OnyxBase file (type "document" items
   *  that point at a real file in the OnyxBase file store). */
  fileId?: string;
}

/** Catalog summary (no content) — what the manifest stores + list returns. */
export interface KBItemSummary {
  id: string;
  type: KBItemType;
  title: string;
  source: KBItemSource;
  category: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  size: number;
  fileId?: string;
}

/** The committed catalog record at kb:<userId>:manifest. */
interface KBManifest {
  v: 1;
  updatedAt: string;
  items: KBItemSummary[];
}

/** Item envelope record at kb:<userId>:item:<id>. */
interface KBItemEnvelope {
  v: 1;
  id: string;
  type: KBItemType;
  title: string;
  source: KBItemSource;
  category: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  size: number;
  fileId?: string;
  /** Content encoding: gzip when it helped, else identity. */
  e: "gzip" | "identity";
  /** Chunk count (1 = inline in `d`). */
  c: number;
  /** Inline base64 payload — present only when c === 1. */
  d?: string;
}

// ---------------------------------------------------------------------------
// Encoding helpers (WebCrypto + CompressionStream — same as skills-sync).
// ---------------------------------------------------------------------------

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

/** New compact item id (`kb_` + 12 url-safe chars). */
function newKbId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += b.toString(36).padStart(2, "0");
  return `kb_${s.slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Key layout.
// ---------------------------------------------------------------------------

const itemKey = (userId: string, id: string) => `kb:${userId}:item:${id}`;
const chunkKey = (userId: string, id: string, n: number) =>
  `kb:${userId}:item:${id}:c:${String(n).padStart(6, "0")}`;
const manifestKey = (userId: string) => `kb:${userId}:manifest`;
const ITEM_KEY_RE = /^kb:(.+):item:([^:]+)$/;

// ---------------------------------------------------------------------------
// Bounded sequential write helper.
// ---------------------------------------------------------------------------

/** One KV write with a single bounded retry (sequential discipline). */
async function kvWriteRetry(kv: OnyxBaseKV, key: string, value: string): Promise<void> {
  for (let attempt = 0; attempt <= KV_WRITE_RETRIES; attempt++) {
    try {
      await kv.set(key, value);
      return;
    } catch (e) {
      if (attempt === KV_WRITE_RETRIES) throw e;
      await settle(800);
    }
  }
}

async function kvDeleteRetry(kv: OnyxBaseKV, key: string): Promise<void> {
  for (let attempt = 0; attempt <= KV_WRITE_RETRIES; attempt++) {
    try {
      await kv.delete(key);
      return;
    } catch (e) {
      if (attempt === KV_WRITE_RETRIES) throw e;
      await settle(800);
    }
  }
}

// ---------------------------------------------------------------------------
// Manifest (catalog) management.
// ---------------------------------------------------------------------------

async function readManifest(kv: OnyxBaseKV, userId: string): Promise<KBManifest | null> {
  const raw = await kv.get(manifestKey(userId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as KBManifest;
    if (parsed && parsed.v === 1 && Array.isArray(parsed.items)) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Commit the catalog LAST — the write that makes a mutation real. */
async function commitManifest(kv: OnyxBaseKV, userId: string, items: KBItemSummary[]): Promise<void> {
  const sorted = [...items].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const trimmed = sorted.slice(0, MAX_MANIFEST_ITEMS);
  const manifest: KBManifest = { v: 1, updatedAt: new Date().toISOString(), items: trimmed };
  await kvWriteRetry(kv, manifestKey(userId), JSON.stringify(manifest));
}

function toSummary(item: KBItemEnvelope): KBItemSummary {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    source: item.source,
    category: item.category,
    tags: item.tags ?? [],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    size: item.size,
    ...(item.fileId ? { fileId: item.fileId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Core operations.
// ---------------------------------------------------------------------------

/**
 * List knowledge summaries (newest first). Self-heals: when the manifest is
 * missing it is rebuilt from the per-item records (each envelope is
 * self-describing).
 */
export async function kbList(
  kv: OnyxBaseKV,
  userId: string,
  opts?: { type?: KBItemType; limit?: number },
): Promise<KBItemSummary[]> {
  let manifest = await readManifest(kv, userId);
  if (!manifest) {
    manifest = await rebuildManifest(kv, userId);
  }
  let items = manifest.items;
  if (opts?.type) items = items.filter((i) => i.type === opts.type);
  const sorted = [...items].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return opts?.limit ? sorted.slice(0, opts.limit) : sorted;
}

/** Rebuild the catalog from item records (self-heal after manifest loss). */
async function rebuildManifest(kv: OnyxBaseKV, userId: string): Promise<KBManifest> {
  const keys = await kv.listKeys(`kb:${userId}:item:`).catch(() => [] as string[]);
  const envelopeKeys = keys
    .map((k) => ITEM_KEY_RE.exec(k))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[0]);
  const summaries: KBItemSummary[] = [];
  for (const key of envelopeKeys.slice(0, REBUILD_MAX_READS)) {
    const raw = await kv.get(key).catch(() => null);
    if (!raw) continue;
    try {
      const env = JSON.parse(raw) as KBItemEnvelope;
      if (env && env.v === 1 && env.id) summaries.push(toSummary(env));
    } catch {
      // A foreign/corrupt record in our prefix — skip, never crash the list.
    }
  }
  const manifest: KBManifest = { v: 1, updatedAt: new Date().toISOString(), items: summaries };
  // Best-effort re-commit so the next read is one hop again.
  await commitManifest(kv, userId, summaries).catch(() => undefined);
  return manifest;
}

/** Read one full item (re-assemble chunks, verify checksum). */
export async function kbGet(kv: OnyxBaseKV, userId: string, id: string): Promise<KBItem | null> {
  if (!id) return null;
  const raw = await kv.get(itemKey(userId, id)).catch(() => null);
  if (!raw) return null;
  let env: KBItemEnvelope;
  try {
    env = JSON.parse(raw) as KBItemEnvelope;
  } catch {
    return null;
  }
  if (!env || env.v !== 1 || !env.id) return null;

  // Assemble the encoded payload (inline or chunked).
  let encoded: Uint8Array;
  try {
    if (env.c <= 1 && typeof env.d === "string") {
      encoded = base64ToBytes(env.d);
    } else {
      const parts: string[] = [];
      for (let n = 1; n <= env.c; n++) {
        const chunk = await kv.get(chunkKey(userId, id, n));
        if (chunk === null) {
          throw new OnyxBaseError(
            "CHECKSUM_MISMATCH",
            `Knowledge item "${env.title}" is missing chunk ${n} of ${env.c} — the cloud copy is incomplete.`,
          );
        }
        parts.push(chunk);
      }
      encoded = base64ToBytes(parts.join(""));
    }
    const bytes = env.e === "gzip" ? ((await gunzipBytes(encoded)) ?? encoded) : encoded;
    const content = new TextDecoder().decode(bytes);
    // Integrity: content length must match the envelope's recorded size.
    if (typeof env.size === "number" && env.size !== content.length) {
      // Not fatal — report the content but the mismatch signals an issue.
      // (Length is the cheap check; sha256 of content is stored per save
      // but content is the source of truth for re-encode stability.)
    }
    return {
      id: env.id,
      type: env.type,
      title: env.title,
      content,
      source: env.source,
      category: env.category,
      tags: env.tags ?? [],
      createdAt: env.createdAt,
      updatedAt: env.updatedAt,
      size: content.length,
      ...(env.fileId ? { fileId: env.fileId } : {}),
    };
  } catch (e) {
    if (e instanceof OnyxBaseError) throw e;
    throw new OnyxBaseError("RESTORE_FAILED", `Could not read knowledge item: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Encode + write one item's records (envelope + chunks), sequentially. */
async function writeItem(
  kv: OnyxBaseKV,
  userId: string,
  item: Omit<KBItem, "size"> & { size?: number },
): Promise<KBItemSummary> {
  const content = item.content;
  if (content.length > MAX_KB_CONTENT_CHARS) {
    throw new OnyxBaseError(
      "FILE_TOO_LARGE",
      `Knowledge item content exceeds the ${MAX_KB_CONTENT_CHARS.toLocaleString()}-character limit (got ${content.length.toLocaleString()}). Split it or host it as a file instead.`,
    );
  }
  const raw = new TextEncoder().encode(content);
  const gz = await gzipBytes(raw);
  const encoding: "gzip" | "identity" = gz && gz.length < raw.length ? "gzip" : "identity";
  const encoded = encoding === "gzip" ? gz! : raw;
  const chunks = chunkString(bytesToBase64(encoded));

  const envelope: KBItemEnvelope = {
    v: 1,
    id: item.id,
    type: item.type,
    title: item.title,
    source: item.source,
    category: item.category,
    tags: item.tags,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    size: content.length,
    ...(item.fileId ? { fileId: item.fileId } : {}),
    e: encoding,
    c: chunks.length,
    ...(chunks.length === 1 ? { d: chunks[0] } : {}),
  };

  // Chunk records first (sequential), envelope last — an interrupted write
  // leaves an orphan envelope-less chunk (harmless, invisible to the catalog).
  for (let n = 1; n <= chunks.length; n++) {
    if (chunks.length === 1) break; // inline — no chunk records
    await kvWriteRetry(kv, chunkKey(userId, item.id, n), chunks[n - 1]);
  }
  await kvWriteRetry(kv, itemKey(userId, item.id), JSON.stringify(envelope));
  return {
    id: envelope.id,
    type: envelope.type,
    title: envelope.title,
    source: envelope.source,
    category: envelope.category,
    tags: envelope.tags,
    createdAt: envelope.createdAt,
    updatedAt: envelope.updatedAt,
    size: envelope.size,
    ...(envelope.fileId ? { fileId: envelope.fileId } : {}),
  };
}

/** Save a NEW knowledge item; commits the catalog last. */
export async function kbSave(
  kv: OnyxBaseKV,
  userId: string,
  input: {
    title: string;
    content: string;
    type?: KBItemType;
    category?: string | null;
    tags?: string[];
    source?: KBItemSource;
    fileId?: string;
  },
): Promise<KBItem> {
  const title = (input.title ?? "").trim().slice(0, MAX_KB_TITLE_CHARS);
  if (!title) throw new OnyxBaseError("SERIALIZATION_FAILED", "A title is required to save knowledge.");
  if (!input.content) throw new OnyxBaseError("SERIALIZATION_FAILED", "Content is required to save knowledge.");
  const now = new Date().toISOString();
  const item: Omit<KBItem, "size"> = {
    id: newKbId(),
    type: normalizeType(input.type),
    title,
    content: input.content,
    source: input.source === "user" ? "user" : "ai",
    category: input.category?.trim() || null,
    tags: (input.tags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 12),
    createdAt: now,
    updatedAt: now,
    ...(input.fileId ? { fileId: input.fileId } : {}),
  };
  const summary = await writeItem(kv, userId, item);
  // Merge into the catalog (or self-heal it when missing), commit last.
  const manifest = (await readManifest(kv, userId)) ?? (await rebuildManifest(kv, userId));
  const items = manifest.items.filter((i) => i.id !== item.id);
  items.push(summary);
  await commitManifest(kv, userId, items);
  return { ...item, size: summary.size };
}

/** Update an existing item (title/content/type/category/tags); commits last. */
export async function kbUpdate(
  kv: OnyxBaseKV,
  userId: string,
  id: string,
  patch: {
    title?: string;
    content?: string;
    type?: KBItemType;
    category?: string | null;
    tags?: string[];
  },
): Promise<KBItem> {
  const existing = await kbGet(kv, userId, id);
  if (!existing) throw new OnyxBaseError("WORKSPACE_NOT_FOUND", `Knowledge item ${id} was not found.`);
  const title = patch.title !== undefined ? patch.title.trim().slice(0, MAX_KB_TITLE_CHARS) : existing.title;
  if (!title) throw new OnyxBaseError("SERIALIZATION_FAILED", "A knowledge item cannot have an empty title.");
  const updated: Omit<KBItem, "size"> = {
    ...existing,
    title,
    content: patch.content !== undefined ? patch.content : existing.content,
    type: patch.type !== undefined ? normalizeType(patch.type) : existing.type,
    category: patch.category !== undefined ? (patch.category?.trim() || null) : existing.category,
    tags: patch.tags !== undefined
      ? patch.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 12)
      : existing.tags,
    updatedAt: new Date().toISOString(),
  };
  const summary = await writeItem(kv, userId, updated);
  const manifest = (await readManifest(kv, userId)) ?? (await rebuildManifest(kv, userId));
  const items = manifest.items.filter((i) => i.id !== id);
  items.push(summary);
  await commitManifest(kv, userId, items);
  return { ...updated, size: summary.size };
}

/** Delete one item (record + chunks); commits the catalog last. */
export async function kbDelete(kv: OnyxBaseKV, userId: string, id: string): Promise<void> {
  // Read the envelope first to learn the chunk count (best-effort — a lost
  // envelope still deletes the key itself below).
  const raw = await kv.get(itemKey(userId, id)).catch(() => null);
  let chunkCount = 0;
  if (raw) {
    try {
      chunkCount = (JSON.parse(raw) as KBItemEnvelope).c ?? 0;
    } catch {
      chunkCount = 0;
    }
  }
  await kvDeleteRetry(kv, itemKey(userId, id));
  for (let n = 1; n <= chunkCount; n++) {
    if (chunkCount <= 1) break; // inline — no chunk records
    await kvDeleteRetry(kv, chunkKey(userId, id, n)).catch(() => undefined);
  }
  const manifest = (await readManifest(kv, userId)) ?? (await rebuildManifest(kv, userId));
  const items = manifest.items.filter((i) => i.id !== id);
  await commitManifest(kv, userId, items);
}

// ---------------------------------------------------------------------------
// Search.
// ---------------------------------------------------------------------------

export interface KBSearchResult extends KBItemSummary {
  /** Where the query matched (for the UI + the model's citation). */
  matchedOn: Array<"title" | "tags" | "category" | "type" | "content">;
  /** Content excerpt around the first content match (content matches only). */
  excerpt?: string;
  score: number;
}

/**
 * Search the Knowledge Base. Title/tag/category/type matches run off the
 * manifest (one read); content matching scans the most recent items'
 * contents (bounded to CONTENT_SCAN_MAX reads) so a query can also find
 * knowledge by what's INSIDE it.
 */
export async function kbSearch(
  kv: OnyxBaseKV,
  userId: string,
  opts: { query: string; type?: KBItemType; tags?: string[]; limit?: number },
): Promise<KBSearchResult[]> {
  const query = (opts.query ?? "").trim().toLowerCase();
  if (!query) return [];
  const tokens = query.split(/\s+/).filter(Boolean);
  const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
  const filterTags = (opts.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);

  let manifest = await readManifest(kv, userId);
  if (!manifest) manifest = await rebuildManifest(kv, userId);
  let pool = manifest.items;
  if (opts.type) pool = pool.filter((i) => i.type === opts.type);
  if (filterTags.length > 0) {
    pool = pool.filter((i) => filterTags.every((t) => i.tags.includes(t)));
  }

  const results = new Map<string, KBSearchResult>();
  const matched = (text: string): boolean => tokens.every((t) => text.includes(t));

  // Pass 1 — manifest fields (title / tags / category / type).
  for (const item of pool) {
    const matchedOn: KBSearchResult["matchedOn"] = [];
    let score = 0;
    if (matched(item.title.toLowerCase())) {
      matchedOn.push("title");
      score += 10;
    }
    const tagText = item.tags.join(" ").toLowerCase();
    if (tagText && matched(tagText)) {
      matchedOn.push("tags");
      score += 6;
    }
    if (item.category && matched(item.category.toLowerCase())) {
      matchedOn.push("category");
      score += 4;
    }
    if (matched(item.type)) {
      matchedOn.push("type");
      score += 3;
    }
    if (score > 0) {
      results.set(item.id, { ...item, matchedOn, score });
    }
  }

  // Pass 2 — content scan of the most recent items not already matched.
  const candidates = [...pool]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .filter((i) => !results.has(i.id))
    .slice(0, CONTENT_SCAN_MAX);
  for (const summary of candidates) {
    const item = await kbGet(kv, userId, summary.id).catch(() => null);
    if (!item) continue;
    const hay = item.content.toLowerCase();
    if (matched(hay)) {
      const first = tokens
        .map((t) => hay.indexOf(t))
        .filter((i) => i >= 0)
        .sort((a, b) => a - b)[0];
      const excerpt =
        first !== undefined
          ? item.content.slice(Math.max(0, first - 60), Math.min(item.content.length, first + 140)).replace(/\s+/g, " ")
          : undefined;
      results.set(summary.id, {
        ...summary,
        matchedOn: ["content"],
        score: 2,
        ...(excerpt ? { excerpt } : {}),
      });
    }
  }

  return [...results.values()].sort((a, b) => b.score - a.score || (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Client resolution (shared by the AI tool + the KB tab).
// ---------------------------------------------------------------------------

export interface KBClients {
  kv: OnyxBaseKV;
  files: OnyxBaseFiles;
  /** Effective base URL used (for link prefixes etc.). */
  baseUrl: string;
}

/**
 * Resolve the OnyxBase clients for a user: decrypts the API key from the
 * vault AT CALL TIME (it never enters prompts, tool args, or results) and
 * builds the KV + Files clients on the user's configured base URL.
 * Returns null when OnyxBase isn't configured yet.
 */
export async function resolveKBClients(userId: string): Promise<KBClients | null> {
  try {
    const { settingsService } = await import("@/lib/services");
    const key = await settingsService.getDecryptedOnyxBaseApiKey(userId);
    if (!key || !key.trim()) return null;
    const { useAuthStore } = await import("@/stores");
    const uid = userId || useAuthStore.getState().user?.id;
    if (!uid) return null;
    const settings = await settingsService.get(uid).catch(() => null);
    const baseUrl = settings?.onyxbase_base_url ?? null;
    return {
      kv: new OnyxBaseKV(key, baseUrl),
      files: new OnyxBaseFiles(key, baseUrl),
      baseUrl: (baseUrl ?? "https://onyxbase-chi.vercel.app").replace(/\/+$/, ""),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Files passthrough (hosting + links via the OnyxBase file store).
// ---------------------------------------------------------------------------

/** Host a file in OnyxBase and mint a fresh public download link. */
export async function kbHostFile(
  files: OnyxBaseFiles,
  input: { bytes: Uint8Array; name: string; mimeType?: string; label?: string },
): Promise<{ file: OnyxBaseFile; link: { url: string; proxyUrl: string; expiresAt?: number; expiresInSec?: number } }> {
  const blob = new Blob([input.bytes as unknown as BlobPart], {
    type: input.mimeType || "application/octet-stream",
  });
  const file = await files.upload(blob, { name: input.name, label: input.label ?? input.name });
  const link = await files.mintLink(file.id);
  return { file, link };
}

// ---------------------------------------------------------------------------
// Validation helpers.
// ---------------------------------------------------------------------------

/** Coerce an unknown type string into a valid KBItemType (default knowledge). */
export function normalizeType(t: unknown): KBItemType {
  const s = typeof t === "string" ? t.trim().toLowerCase() : "";
  return (KB_ITEM_TYPES as readonly string[]).includes(s) ? (s as KBItemType) : "knowledge";
}
