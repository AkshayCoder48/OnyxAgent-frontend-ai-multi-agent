"use client";

/**
 * OnyxCode Database namespace — shared between the Database tab
 * (DatabasePanel) and the agent's database/storage tools, so the UI and the
 * agent read/write EXACTLY the same records.
 *
 * Storage: the user's OnyxBase KV account (same client + key resolution as
 * the workspace-sync tools — the key never enters the prompt). Records live
 * in the existing "onyxagent" collection under the `code:db:` key prefix.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PER-CHAT LAYER (OnyxBase PRD §3/§5/§12–§15/§21/§24/§28/§38) — added on top
 * of the legacy global namespace. ONE chat = ONE isolated context: every
 * helper below takes the conversationId FIRST and derives its keys from it
 * internally, so a code chat can only ever touch its own namespace (the
 * caller never supplies full raw keys).
 *
 *   KV records   code:db:<conversationId>:<key>
 *                  value = RAW JSON/text string (ONE canonical shape — the
 *                  same shape the panel + legacy manage_database always
 *                  wrote, so old records round-trip unchanged).
 *   Storage      code:storage:<conversationId>:<path>             (metadata)
 *                code:storage:<conversationId>:<path>:chunk-000001 …       (payload chunks,
 *                  same 120 000-char chunk sizing as workspace-sync)
 *   Env          code:env:<conversationId>:<NAME>   (persistent per-app
 *                  environment variables — plain string values; they survive
 *                  sandbox destruction, e.g. API keys / app config)
 *   Schema       code:schema:<conversationId>      (ONE record, app-level
 *                  metadata — NOT native OnyxBase tables; PRD §15)
 *   Activity     code:activity:<conversationId>    (bounded append log,
 *                  last 500 events)
 *
 * All state is real OnyxBase KV data — it persists beyond sandbox
 * destruction (PRD §38) because nothing is ever tied to the E2B sandbox.
 */

import {
  OnyxBaseKV,
  OnyxBaseError,
  ONYXBASE_DEFAULT_BASE_URL,
} from "@/lib/onyxbase/kv-client";
import { settingsService } from "@/lib/services";
import { useAuthStore } from "@/stores";

/** All OnyxCode database records are stored under this key prefix. */
export const CODE_DB_PREFIX = "code:db:";

/** Upper bound on records pulled into the Database tab per refresh. Not a
 *  product limit (PRD §35) — every record is a paced OnyxBase read, so the
 *  genuine limit left is practical fetch time; 2 000 keeps a full refresh
 *  reasonable without artificially hiding data. */
export const CODE_DB_MAX_RECORDS = 2_000;

export function codeDbKey(name: string): string {
  return `${CODE_DB_PREFIX}${name.replace(/^\/+/, "").replace(/^code:db:/, "")}`;
}

export function stripCodeDbPrefix(key: string): string {
  return key.startsWith(CODE_DB_PREFIX) ? key.slice(CODE_DB_PREFIX.length) : key;
}

/** A single OnyxCode database record (key + parsed-when-possible JSON value). */
export interface CodeDbRecord {
  key: string;
  name: string;
  value: string;
  parsed: unknown;
  isJson: boolean;
  size: number;
}

export interface CodeDbClient {
  kv: OnyxBaseKV;
}

export type CodeDbFailure =
  | { kind: "not_configured" }
  | { kind: "error"; message: string };

/**
 * Resolve the OnyxBase KV client for the current (or given) user. Mirrors
 * the workspace_sync tool's key resolution: vault-decrypted key + optional
 * custom base URL, never any secret in the prompt.
 */
export async function resolveCodeDbClient(userId?: string): Promise<CodeDbClient | CodeDbFailure> {
  const uid = userId || useAuthStore.getState().user?.id;
  if (!uid) return { kind: "not_configured" };
  try {
    const key = await settingsService.getDecryptedOnyxBaseApiKey(uid);
    if (!key || !key.trim()) return { kind: "not_configured" };
    const settings = await settingsService.get(uid).catch(() => null);
    const baseUrl = settings?.onyxbase_base_url || ONYXBASE_DEFAULT_BASE_URL;
    return { kv: new OnyxBaseKV(key, baseUrl) };
  } catch {
    return { kind: "not_configured" };
  }
}

/** List every OnyxCode database record (bounded). */
export async function listCodeDbRecords(
  client: CodeDbClient,
  opts?: { onProgress?: (n: number) => void },
): Promise<CodeDbRecord[]> {
  const keys = (await client.kv.listKeys(CODE_DB_PREFIX))
    .filter((k) => k.startsWith(CODE_DB_PREFIX))
    .slice(0, CODE_DB_MAX_RECORDS);
  const records: CodeDbRecord[] = [];
  for (const key of keys) {
    try {
      const value = await client.kv.get(key);
      if (value === null) continue; // deleted between list + get
      records.push(makeRecord(key, value));
      opts?.onProgress?.(records.length);
    } catch {
      /* skip unreadable rows — the list stays useful */
    }
  }
  records.sort((a, b) => a.name.localeCompare(b.name));
  return records;
}

export function makeRecord(key: string, value: string): CodeDbRecord {
  let parsed: unknown;
  let isJson = false;
  try {
    parsed = JSON.parse(value);
    isJson = true;
  } catch {
    parsed = undefined;
  }
  return {
    key,
    name: stripCodeDbPrefix(key),
    value,
    parsed,
    isJson,
    size: value.length,
  };
}

/** Human-friendly message for OnyxBase failures (panel + tool share this). */
export function codeDbFailureMessage(failure: CodeDbFailure): string {
  if (failure.kind === "not_configured") {
    return "No OnyxBase API key configured. Add one in Settings → Cloud to use the Code Mode database.";
  }
  return failure.message ?? "OnyxBase request failed.";
}

// ===========================================================================
// PER-CHAT LAYER — constants + namespaces (PRD §3/§21).
// ===========================================================================

/** Storage (files, images, blobs) for a chat lives under this key prefix. */
export const CODE_STORAGE_PREFIX = "code:storage:";

/** Application schema metadata for a chat (PRD §15). */
export const CODE_SCHEMA_PREFIX = "code:schema:";

/** Persistent environment variables for a chat (per-app env namespace —
 *  plain string values under UPPER_SNAKE_CASE names). */
export const CODE_ENV_PREFIX = "code:env:";

/** Bounded activity log for a chat. */
export const CODE_ACTIVITY_PREFIX = "code:activity:";

/** Activity log bound — only the last N events are kept (append + trim).
 *  The log is ONE KV record (a JSON blob), so the genuine limit is that
 *  record's size: 500 events × ~100 chars stays far inside
 *  CODE_KV_MAX_VALUE_CHARS. */
export const CODE_ACTIVITY_MAX_EVENTS = 500;

/** Base64/text chars per storage chunk record — identical sizing to the
 *  live-verified workspace-sync chunking (see CHUNK_SIZE in
 *  src/lib/onyxbase/workspace-sync.ts; OnyxBase documented ~4 KB records but
 *  ≥256 KB values verified byte-identical on 2026-09-12). */
export const CODE_STORAGE_CHUNK_SIZE = 120_000;

/** Hard cap on one stored file (payload chars ≈ 8.6 MB decoded ≈ 100 chunks
 *  ≈ 100 paced KV writes). Larger payloads are rejected with a clear error. */
export const CODE_STORAGE_MAX_PAYLOAD_CHARS = 12_000_000;

/** Cap on one KV record value (chars). Not an arbitrary product limit
 *  (PRD §35) — it only guards a single record against pathological sizes;
 *  a genuine backend ceiling, if one is ever hit, surfaces as a REAL
 *  OnyxBase error (live-verified floor: ≥ 256 000 chars round-trip,
 *  2026-09-12). Larger documents belong in storage_write (chunked). */
export const CODE_KV_MAX_VALUE_CHARS = 1_000_000;

/** Upper bound on items pulled per listing call (records / files / env
 *  vars). Not a product limit (PRD §35) — each item costs a paced KV read,
 *  so this keeps listings practical instead of hiding data. */
export const CODE_MAX_LIST_ITEMS = 1_000;

/** Self-describing label embedded in every schema record (PRD §15 — the
 *  schema is application-level metadata in the KV namespace, NOT native
 *  OnyxBase tables, and must never pretend otherwise). */
export const CODE_SCHEMA_LABEL = "OnyxCode application schema metadata";

/** Sanity caps for the agent-facing schema API. The schema is ONE KV record
 *  (entities × fields serialized as JSON), so the genuine limit is that
 *  record's size — these bounds keep it far inside
 *  CODE_KV_MAX_VALUE_CHARS without restricting real data models. */
export const CODE_SCHEMA_MAX_ENTITIES = 500;
export const CODE_SCHEMA_MAX_FIELDS = 200;

// ---------------------------------------------------------------------------
// Input normalization (the §21 isolation boundary — every helper funnels
// through these, and callers can never pass full raw KV keys).
// ---------------------------------------------------------------------------

/** Validate + normalize a conversation id. Throws with a clear reason when
 *  the id is unusable (empty / whitespace / contains ':' — a ':' would break
 *  the key grammar). */
export function normalizeConversationId(conversationId: string): string {
  const id = (conversationId ?? "").trim();
  if (!id) {
    throw new Error(
      "conversationId is required — the Code Mode database is namespaced per conversation.",
    );
  }
  if (id.length > 128) {
    throw new Error(`conversationId is too long (${id.length} chars, max 128).`);
  }
  if (/[:\s]/.test(id)) {
    throw new Error("conversationId contains invalid characters (whitespace or ':').");
  }
  return id;
}

/** Normalize a record name (same rules the legacy codeDbKey applied, so
 *  panel-written and agent-written names land on identical keys). */
export function normalizeKvName(name: string): string {
  const n = (name ?? "").trim().replace(/^\/+/, "").replace(/^code:db:/, "");
  if (!n) throw new Error("A non-empty record name is required (e.g. \"app-config\", \"users/42\").");
  if (n.length > 200) {
    throw new Error(`Record name is too long (${n.length} chars, max 200).`);
  }
  return n;
}

/** Normalize a storage path (forward slashes, no leading slash, and never a
 *  reserved `:chunk-<n>` suffix — that would collide with chunk records). */
export function normalizeStoragePath(path: string): string {
  const p = (path ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
  if (!p) {
    throw new Error('A non-empty storage path is required (e.g. "assets/logo.png").');
  }
  if (p.length > 300) {
    throw new Error(`Storage path is too long (${p.length} chars, max 300).`);
  }
  if (/:chunk-\d+$/.test(p)) {
    throw new Error(
      'Storage path must not end with ":chunk-<number>" — that suffix is reserved for chunk records. Pick a different path.',
    );
  }
  return p;
}

/** Normalize an environment variable name: trimmed + UPPERCASE, then
 *  UPPER_SNAKE_CASE (letters, digits, underscores; must start with a letter
 *  or underscore), max 100 chars. Throws with a clear reason otherwise. */
export function normalizeEnvName(name: string): string {
  const raw = (name ?? "").trim();
  const n = raw.toUpperCase();
  if (!n) {
    throw new Error('An environment variable name is required (e.g. "OPENAI_API_KEY").');
  }
  if (n.length > 100) {
    throw new Error(`Environment variable name is too long (${n.length} chars, max 100).`);
  }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(n)) {
    throw new Error(
      `Invalid environment variable name "${raw}" — use UPPER_SNAKE_CASE (A-Z, 0-9, _; must start with a letter or underscore).`,
    );
  }
  return n;
}

// ---------------------------------------------------------------------------
// Key builders (all derived from the conversationId — never caller-supplied).
// ---------------------------------------------------------------------------

/** Full key prefix of a chat's KV namespace: `code:db:<conversationId>:`. */
export function chatKvPrefix(conversationId: string): string {
  return `${CODE_DB_PREFIX}${normalizeConversationId(conversationId)}:`;
}

/** Full KV key of one record: `code:db:<conversationId>:<name>`. */
export function chatKvKey(conversationId: string, key: string): string {
  return `${chatKvPrefix(conversationId)}${normalizeKvName(key)}`;
}

/** Record name (without the `code:db:<conversationId>:` prefix). */
export function chatKvName(conversationId: string, fullKey: string): string {
  const prefix = chatKvPrefix(conversationId);
  return fullKey.startsWith(prefix) ? fullKey.slice(prefix.length) : fullKey;
}

/** Full key prefix of a chat's environment-variable namespace:
 *  `code:env:<conversationId>:`. */
export function chatEnvPrefix(conversationId: string): string {
  return `${CODE_ENV_PREFIX}${normalizeConversationId(conversationId)}:`;
}

/** Full env record key: `code:env:<conversationId>:<NAME>`. */
export function chatEnvKey(conversationId: string, name: string): string {
  return `${chatEnvPrefix(conversationId)}${normalizeEnvName(name)}`;
}

/** Full key prefix of a chat's storage namespace: `code:storage:<id>:`. */
export function chatStoragePrefix(conversationId: string): string {
  return `${CODE_STORAGE_PREFIX}${normalizeConversationId(conversationId)}:`;
}

/** Metadata record key for a stored file. */
export function chatStorageMetaKey(conversationId: string, path: string): string {
  return `${chatStoragePrefix(conversationId)}${normalizeStoragePath(path)}`;
}

/** Payload chunk record key (1-based, zero-padded — sorts correctly). */
export function chatStorageChunkKey(conversationId: string, path: string, chunk: number): string {
  return `${chatStorageMetaKey(conversationId, path)}:chunk-${String(chunk).padStart(6, "0")}`;
}

/** True when a raw KV key is a storage CHUNK record (`…:chunk-000001`). */
export function isStorageChunkKey(key: string): boolean {
  return /:chunk-\d+$/.test(key);
}

/** Schema record key (ONE record per chat). */
export function chatSchemaKey(conversationId: string): string {
  return `${CODE_SCHEMA_PREFIX}${normalizeConversationId(conversationId)}`;
}

/** Activity log record key (ONE record per chat). */
export function chatActivityKey(conversationId: string): string {
  return `${CODE_ACTIVITY_PREFIX}${normalizeConversationId(conversationId)}`;
}

// ---------------------------------------------------------------------------
// Shared options + client resolution for the per-chat helpers.
// ---------------------------------------------------------------------------

export interface CodeLayerOptions {
  /** Pre-resolved OnyxBase client — resolve once, reuse across calls. */
  client?: CodeDbClient;
  /** User id for key resolution when no client is given. */
  userId?: string;
  /** Who performed the mutation (recorded in the activity log). */
  actor?: "agent" | "user";
  /** Skip the (best-effort) activity-log append. */
  skipActivity?: boolean;
}

/** Resolve the OnyxBase client or throw a descriptive OnyxBaseError (the
 *  not-configured case reuses the panel's friendly message). */
async function requireLayerClient(opts?: CodeLayerOptions): Promise<CodeDbClient> {
  if (opts?.client) return opts.client;
  const resolved = await resolveCodeDbClient(opts?.userId);
  if ("kind" in resolved) {
    throw new OnyxBaseError("ONYXBASE_NOT_CONFIGURED", codeDbFailureMessage(resolved));
  }
  return resolved;
}

function nowISO(): string {
  return new Date().toISOString();
}

function parseMaybeJson(value: string): { parsed: unknown; isJson: boolean } {
  try {
    return { parsed: JSON.parse(value), isJson: true };
  } catch {
    return { parsed: undefined, isJson: false };
  }
}

// ===========================================================================
// ACTIVITY LOG — bounded append log (last CODE_ACTIVITY_MAX_EVENTS events),
// best-effort by design.
// ===========================================================================

export type CodeActivityActor = "agent" | "user";

export interface CodeActivityEvent {
  ts: string;
  actor: CodeActivityActor;
  /** Short operation name — "kv_set", "storage_write", "schema_upsert",
   *  "legacy_migrated", … */
  op: string;
  /** What the operation touched (record name / storage path / entity name). */
  target: string;
  ok: boolean;
  detail?: string;
}

interface ActivityRecord {
  events: CodeActivityEvent[];
}

function isActivityEvent(e: unknown): e is CodeActivityEvent {
  if (!e || typeof e !== "object") return false;
  const ev = e as Partial<CodeActivityEvent>;
  return (
    typeof ev.ts === "string" &&
    (ev.actor === "agent" || ev.actor === "user") &&
    typeof ev.op === "string" &&
    typeof ev.target === "string" &&
    typeof ev.ok === "boolean"
  );
}

async function readActivityRecord(client: CodeDbClient, conversationId: string): Promise<ActivityRecord> {
  try {
    const raw = await client.kv.get(chatActivityKey(conversationId));
    if (!raw) return { events: [] };
    const parsed = JSON.parse(raw) as Partial<ActivityRecord>;
    if (parsed && Array.isArray(parsed.events)) {
      return { events: parsed.events.filter(isActivityEvent) };
    }
  } catch {
    /* missing/corrupt → fresh log */
  }
  return { events: [] };
}

/** Append an event to the bounded activity log (last
 *  CODE_ACTIVITY_MAX_EVENTS kept). Best-effort: failures are swallowed — the
 *  log must never break a real operation. */
export async function activityAppend(
  conversationId: string,
  event: Omit<CodeActivityEvent, "ts">,
  opts?: CodeLayerOptions,
): Promise<void> {
  try {
    const cid = normalizeConversationId(conversationId);
    const client = await requireLayerClient(opts);
    const record = await readActivityRecord(client, cid);
    record.events.push({ ...event, ts: nowISO() });
    record.events = record.events.slice(-CODE_ACTIVITY_MAX_EVENTS);
    await client.kv.set(chatActivityKey(cid), JSON.stringify(record));
  } catch {
    /* non-fatal by design */
  }
}

/** Read the activity log (oldest first, most recent last). */
export async function activityList(
  conversationId: string,
  limit?: number,
  opts?: CodeLayerOptions,
): Promise<CodeActivityEvent[]> {
  const cid = normalizeConversationId(conversationId);
  const client = await requireLayerClient(opts);
  const record = await readActivityRecord(client, cid);
  return typeof limit === "number" && limit >= 0 ? record.events.slice(-limit) : record.events;
}

// ===========================================================================
// KV — per-chat documents (raw JSON/text values, ONE canonical shape).
// ===========================================================================

/** Hard ceiling for an explicit kvList `limit` — a genuine practicality
 *  bound (every record is a paced KV read), aligned with
 *  CODE_DB_MAX_RECORDS; the default comes from CODE_MAX_LIST_ITEMS. */
const CODE_KV_LIST_HARD_CAP = 2_000;

/** One record in a chat's KV namespace. */
export interface CodeKvEntry {
  /** Full OnyxBase key (`code:db:<conversationId>:<name>`). */
  key: string;
  /** Record name inside this chat's namespace. */
  name: string;
  /** Raw stored value (JSON text or plain text — exactly what's in KV). */
  value: string;
  parsed: unknown;
  isJson: boolean;
  size: number;
}

export interface KvListOptions extends CodeLayerOptions {
  /** Only names starting with this prefix (within the chat namespace). */
  prefix?: string;
  /** Max records returned (default CODE_MAX_LIST_ITEMS, hard cap
   *  CODE_KV_LIST_HARD_CAP). */
  limit?: number;
  /** Called with the running count as values load. */
  onProgress?: (loaded: number) => void;
  /** Notified when legacy GLOBAL workspace records were adopted into this
 *    chat's namespace by the one-shot migration (see kvList). */
  onMigrate?: (adopted: number) => void;
  /** Disable the one-shot legacy adoption (default: enabled). */
  autoMigrateLegacy?: boolean;
}

function makeChatEntry(conversationId: string, fullKey: string, value: string): CodeKvEntry {
  const { parsed, isJson } = parseMaybeJson(value);
  return {
    key: fullKey,
    name: chatKvName(conversationId, fullKey),
    value,
    parsed,
    isJson,
    size: value.length,
  };
}

/** Cheap key-only listing: record NAMES in this chat's namespace (no values). */
export async function kvListKeys(conversationId: string, opts?: CodeLayerOptions): Promise<string[]> {
  const cid = normalizeConversationId(conversationId);
  const client = await requireLayerClient(opts);
  const prefix = chatKvPrefix(cid);
  const keys = await client.kv.listKeys(prefix);
  return keys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

/** One-shot adoption of legacy GLOBAL workspace records (`code:db:<name>`
 *  with NO further colon — a per-chat record always has
 *  `code:db:<conversationId>:<name>`, so the no-colon shape identifies legacy
 *  data unambiguously). COPIES (never deletes) up to CODE_MAX_LIST_ITEMS
 *  records into the chat namespace, skipping names the chat already has.
 *  Best-effort + non-fatal: failures return `{ error }`, never throw. */
export async function migrateLegacyRecords(
  conversationId: string,
  opts?: CodeLayerOptions,
): Promise<{ adopted: number; considered: number; error?: string }> {
  try {
    const cid = normalizeConversationId(conversationId);
    const client = await requireLayerClient(opts);
    const legacyKeys = (await client.kv.listKeys(CODE_DB_PREFIX))
      .filter(isLegacyGlobalRecordKey)
      .slice(0, CODE_MAX_LIST_ITEMS);
    const prefix = chatKvPrefix(cid);
    let adopted = 0;
    for (const legacyKey of legacyKeys) {
      const name = legacyKey.slice(CODE_DB_PREFIX.length);
      try {
        // Never overwrite something this chat already wrote.
        if ((await client.kv.get(`${prefix}${name}`)) !== null) continue;
        const value = await client.kv.get(legacyKey);
        if (value === null) continue;
        await client.kv.set(`${prefix}${name}`, value);
        adopted++;
      } catch {
        /* best-effort per record */
      }
    }
    if (adopted > 0) {
      await activityAppend(
        cid,
        {
          actor: opts?.actor ?? "agent",
          op: "legacy_migrated",
          target: "code:db:*",
          ok: true,
          detail: `adopted ${adopted} legacy workspace record(s)`,
        },
        { client },
      );
    }
    return { adopted, considered: legacyKeys.length };
  } catch (err) {
    return { adopted: 0, considered: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

function isLegacyGlobalRecordKey(key: string): boolean {
  if (!key.startsWith(CODE_DB_PREFIX)) return false;
  const rest = key.slice(CODE_DB_PREFIX.length);
  return rest.length > 0 && !rest.includes(":");
}

/** List records (names + values) in this chat's KV namespace, bounded.
 *
 *  One-shot legacy adoption (PRD compat): the FIRST time a chat with ZERO
 *  records is listed, legacy global `code:db:<name>` records are adopted
 *  (copied) into the chat namespace. The once-flag lives in the activity log
 *  (op "legacy_migrated") so it survives record deletions. */
export async function kvList(conversationId: string, opts?: KvListOptions): Promise<CodeKvEntry[]> {
  const cid = normalizeConversationId(conversationId);
  const client = await requireLayerClient(opts);
  const prefix = chatKvPrefix(cid);

  const listNames = async (): Promise<string[]> =>
    (await client.kv.listKeys(prefix)).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));

  let names = await listNames();

  if (names.length === 0 && opts?.autoMigrateLegacy !== false) {
    const activity = await activityList(cid, undefined, { client }).catch(() => [] as CodeActivityEvent[]);
    const alreadyMigrated = activity.some((e) => e.op === "legacy_migrated");
    if (!alreadyMigrated) {
      const migrated = await migrateLegacyRecords(cid, { client });
      if (migrated.adopted > 0) {
        opts?.onMigrate?.(migrated.adopted);
        names = await listNames();
      }
    }
  }

  const nameFilter = opts?.prefix?.trim();
  if (nameFilter) names = names.filter((n) => n.startsWith(nameFilter));

  const limit = Math.min(Math.max(opts?.limit ?? CODE_MAX_LIST_ITEMS, 1), CODE_KV_LIST_HARD_CAP);
  names = [...names].sort((a, b) => a.localeCompare(b)).slice(0, limit);

  const entries: CodeKvEntry[] = [];
  for (const name of names) {
    try {
      const fullKey = `${prefix}${name}`;
      const value = await client.kv.get(fullKey);
      if (value === null) continue; // deleted between list + get
      entries.push(makeChatEntry(cid, fullKey, value));
      opts?.onProgress?.(entries.length);
    } catch {
      /* skip unreadable rows — the list stays useful */
    }
  }
  return entries;
}

/** Read one record. Returns null when the key doesn't exist. */
export async function kvGet(
  conversationId: string,
  key: string,
  opts?: CodeLayerOptions,
): Promise<CodeKvEntry | null> {
  const cid = normalizeConversationId(conversationId);
  const client = await requireLayerClient(opts);
  const name = normalizeKvName(key);
  const fullKey = `${chatKvPrefix(cid)}${name}`;
  const value = await client.kv.get(fullKey);
  if (value === null) return null;
  return makeChatEntry(cid, fullKey, value);
}

/** Create/overwrite one record. JSON input is re-serialized for stable
 *  formatting (same rule as the legacy manage_database `set`), plain text is
 *  stored as-is — ONE canonical shape shared with the panel. Throws with
 *  operation + target + reason on any real OnyxBase failure. */
export async function kvSet(
  conversationId: string,
  key: string,
  value: string,
  opts?: CodeLayerOptions,
): Promise<CodeKvEntry> {
  const cid = normalizeConversationId(conversationId);
  const client = await requireLayerClient(opts);
  const name = normalizeKvName(key);
  if (typeof value !== "string") {
    throw new Error('kv_set failed — value must be a string (JSON text or plain text).');
  }
  let stored = value;
  try {
    stored = JSON.stringify(JSON.parse(value));
  } catch {
    /* plain text document */
  }
  if (stored.length > CODE_KV_MAX_VALUE_CHARS) {
    throw new OnyxBaseError(
      "FILE_TOO_LARGE",
      `kv_set "${name}" failed — value is ${stored.length} chars (max ${CODE_KV_MAX_VALUE_CHARS}). Use storage_write for large payloads (it chunks automatically).`,
    );
  }
  const fullKey = `${chatKvPrefix(cid)}${name}`;
  await client.kv.set(fullKey, stored);
  if (!opts?.skipActivity) {
    await activityAppend(
      cid,
      {
        actor: opts?.actor ?? "agent",
        op: "kv_set",
        target: name,
        ok: true,
        detail: `${stored.length} chars`,
      },
      { client },
    );
  }
  return makeChatEntry(cid, fullKey, stored);
}

/** Delete one record (404 → already gone, reported as deleted). */
export async function kvDelete(
  conversationId: string,
  key: string,
  opts?: CodeLayerOptions,
): Promise<{ name: string; key: string }> {
  const cid = normalizeConversationId(conversationId);
  const client = await requireLayerClient(opts);
  const name = normalizeKvName(key);
  const fullKey = `${chatKvPrefix(cid)}${name}`;
  await client.kv.delete(fullKey);
  if (!opts?.skipActivity) {
    await activityAppend(
      cid,
      { actor: opts?.actor ?? "agent", op: "kv_delete", target: name, ok: true },
      { client },
    );
  }
  return { name, key: fullKey };
}

/** Case-insensitive substring search over names + values of this chat's
 *  records (client-side filter over a bounded kvList). */
export async function kvSearch(
  conversationId: string,
  query: string,
  opts?: KvListOptions,
): Promise<CodeKvEntry[]> {
  const q = (query ?? "").trim().toLowerCase();
  const entries = await kvList(conversationId, { ...opts, prefix: undefined });
  if (!q) return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(q) || e.value.toLowerCase().includes(q));
}

// ===========================================================================
// ENV — persistent per-app environment variables (plain string values under
// UPPER_SNAKE_CASE names). Like every other section this is real OnyxBase KV
// data: the variables survive sandbox destruction, which makes them the
// right home for API keys / config the generated app needs across resets.
// Callers pass the resolved CodeDbClient FIRST (tools + panel resolve it once
// per interaction); the namespace still derives from the conversationId.
// ===========================================================================

/** One environment variable in a chat's env namespace. */
export interface CodeEnvRecord {
  /** Normalized UPPER_SNAKE_CASE name (without the key prefix). */
  name: string;
  /** The raw stored value — a plain string, exactly what was set. */
  value: string;
  size: number;
  /** Last env_set timestamp derived from the bounded activity log —
   *  undefined when the write predates the log window (honest recency, same
   *  rule as KV records, which carry no timestamps by design). */
  updatedAt?: string;
}

/** Env mutation options (activity-log bookkeeping, mirroring CodeLayerOptions
 *  for the client-first env helpers). */
export interface EnvMutationOptions {
  /** Who performed the mutation (recorded in the activity log). */
  actor?: CodeActivityActor;
  /** Skip the (best-effort) activity-log append. */
  skipActivity?: boolean;
}

/** List a chat's environment variables (sorted by name). `updatedAt` is the
 *  latest `env_set` event per name from the activity log (one extra read),
 *  undefined for writes older than the log window. */
export async function envList(
  client: CodeDbClient,
  conversationId: string,
): Promise<CodeEnvRecord[]> {
  const cid = normalizeConversationId(conversationId);
  const prefix = chatEnvPrefix(cid);
  const names = (await client.kv.listKeys(prefix))
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));

  const records: CodeEnvRecord[] = [];
  for (const name of names) {
    try {
      const value = await client.kv.get(`${prefix}${name}`);
      if (value === null) continue; // deleted between list + get
      records.push({ name, value, size: value.length });
    } catch {
      /* skip unreadable rows — the list stays useful */
    }
  }

  // Honest recency (same rule as KV records): the latest env_set event per
  // name from the bounded activity log. readActivityRecord never throws —
  // a missing/corrupt log just yields no timestamps.
  const activity = await readActivityRecord(client, cid);
  const latest = new Map<string, string>();
  for (const e of activity.events) {
    if (e.op === "env_set" && e.target) latest.set(e.target, e.ts);
  }

  return records
    .map((r) => {
      const ts = latest.get(r.name);
      return ts ? { ...r, updatedAt: ts } : r;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Read one environment variable. Returns null when it doesn't exist. */
export async function envGet(
  client: CodeDbClient,
  conversationId: string,
  name: string,
): Promise<{ name: string; value: string } | null> {
  const cid = normalizeConversationId(conversationId);
  const n = normalizeEnvName(name);
  const value = await client.kv.get(chatEnvKey(cid, n));
  if (value === null) return null;
  return { name: n, value };
}

/** Create/overwrite (upsert) one environment variable. Values are PLAIN
 *  strings — no JSON normalization — capped at CODE_KV_MAX_VALUE_CHARS (same
 *  bound as KV records; larger payloads belong in storage_write). Throws with
 *  operation + target + reason on any real OnyxBase failure. */
export async function envSet(
  client: CodeDbClient,
  conversationId: string,
  name: string,
  value: string,
  opts?: EnvMutationOptions,
): Promise<CodeEnvRecord> {
  const cid = normalizeConversationId(conversationId);
  const n = normalizeEnvName(name);
  if (typeof value !== "string") {
    throw new Error('env_set failed — value must be a plain string.');
  }
  if (value.length > CODE_KV_MAX_VALUE_CHARS) {
    throw new OnyxBaseError(
      "FILE_TOO_LARGE",
      `env_set "${n}" failed — value is ${value.length} chars (max ${CODE_KV_MAX_VALUE_CHARS}). Use storage_write for large payloads (it chunks automatically).`,
    );
  }
  await client.kv.set(chatEnvKey(cid, n), value);
  const updatedAt = nowISO();
  if (!opts?.skipActivity) {
    await activityAppend(
      cid,
      {
        actor: opts?.actor ?? "agent",
        op: "env_set",
        target: n,
        ok: true,
        detail: `${value.length} chars`,
      },
      { client },
    );
  }
  return { name: n, value, size: value.length, updatedAt };
}

/** Delete one environment variable (404 → already gone, reported as deleted). */
export async function envDelete(
  client: CodeDbClient,
  conversationId: string,
  name: string,
  opts?: EnvMutationOptions,
): Promise<{ name: string }> {
  const cid = normalizeConversationId(conversationId);
  const n = normalizeEnvName(name);
  await client.kv.delete(chatEnvKey(cid, n));
  if (!opts?.skipActivity) {
    await activityAppend(
      cid,
      { actor: opts?.actor ?? "agent", op: "env_delete", target: n, ok: true },
      { client },
    );
  }
  return { name: n };
}

// ===========================================================================
// STORAGE — files as chunked KV records (PRD §4/§5/§24: real persistent
// storage, same chunking pattern as workspace-sync; images via base64).
// ===========================================================================

export interface CodeStorageMetadata {
  path: string;
  mime: string;
  /** Decoded byte count. */
  size: number;
  /** Number of payload chunk records. */
  chunks: number;
  /** Payload chars per chunk record. */
  chunkSize: number;
  updatedAt: string;
  encoding: "utf8" | "base64";
}

export interface CodeStorageWriteInput {
  /** UTF-8 text content (mutually exclusive with `base64`). */
  text?: string;
  /** Base64 content — a bare base64 string or a data: URI (prefix + mime are
 *    extracted automatically). Binary/images belong here (PRD §24). */
  base64?: string;
  /** Explicit mime type; sniffed from magic bytes / extension when omitted. */
  mime?: string;
}

export interface CodeStorageReadResult {
  metadata: CodeStorageMetadata;
  encoding: "utf8" | "base64";
  /** UTF-8 payloads: the text (truncated to maxChars when set). */
  text?: string;
  /** Base64 payloads: the base64 (truncated to maxChars when set). */
  base64?: string;
  truncated: boolean;
  /** Full payload length in chars (text chars, or base64 chars). */
  fullChars: number;
}

export interface StorageListOptions extends CodeLayerOptions {
  prefix?: string;
  onProgress?: (loaded: number) => void;
}

export interface StorageReadOptions extends CodeLayerOptions {
  /** Truncate the returned text/base64 to this many chars (default: full). */
  maxChars?: number;
}

// -- base64 utilities -------------------------------------------------------

function stripDataUri(input: string): { base64: string; mime?: string } {
  const trimmed = (input ?? "").trim();
  const m = /^data:([^;,]+)?(?:;[^,]*)?,/i.exec(trimmed);
  if (!m) return { base64: trimmed.replace(/\s+/g, "") };
  return {
    base64: trimmed.slice(m[0].length).replace(/\s+/g, ""),
    mime: m[1]?.toLowerCase(),
  };
}

function validateBase64(b64: string): void {
  if (!b64) throw new Error("Empty base64 payload.");
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error("Invalid base64 payload (unexpected characters).");
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function approxBase64Bytes(b64: string): number {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - pad);
}

// -- mime sniffing (PRD §24: base64 image data, mime sniffed or provided) ---

const TEXT_EXT_MIME: Record<string, string> = {
  json: "application/json",
  md: "text/markdown",
  txt: "text/plain",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  jsx: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  csv: "text/csv",
  svg: "image/svg+xml",
  xml: "application/xml",
  yml: "text/yaml",
  yaml: "text/yaml",
  py: "text/x-python",
  sql: "application/sql",
};

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot <= path.lastIndexOf("/")) return "";
  return path.slice(dot + 1).toLowerCase();
}

/** Sniff a mime type from the first bytes of a base64 payload (magic bytes),
 *  with a text fallback for SVG/XML/HTML. Returns null when unknown. */
export function sniffMimeFromBase64(b64: string): string | null {
  try {
    const bytes = base64ToBytes(b64.slice(0, 64));
    const eq = (magic: string, at: number): boolean => {
      for (let i = 0; i < magic.length; i++) {
        if (bytes[at + i] !== magic.charCodeAt(i)) return false;
      }
      return true;
    };
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes[0] === 0x89 && eq("PNG", 1)) return "image/png";
    if (eq("GIF8", 0)) return "image/gif";
    if (eq("BM", 0)) return "image/bmp";
    if (eq("RIFF", 0) && eq("WEBP", 8)) return "image/webp";
    if (eq("%PDF", 0)) return "application/pdf";
    if (eq("PK", 0) && bytes[2] === 0x03) return "application/zip";
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "application/gzip";
    if (eq("II*\u0000", 0) || eq("MM\u0000*", 0)) return "image/tiff";
    if (bytes[0] === 0x3c || bytes[0] === 0xef || bytes[0] === 0xfe || bytes[0] === 0xff) {
      // '<' markup, UTF-8/UTF-16 BOMs — decode + look at the start tag.
      const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trimStart();
      if (/^<\?xml/i.test(head)) return head.includes("<svg") ? "image/svg+xml" : "application/xml";
      if (/^<svg/i.test(head)) return "image/svg+xml";
      if (/^<!doctype html/i.test(head) || /^<html/i.test(head)) return "text/html";
    }
    return null;
  } catch {
    return null;
  }
}

function resolveStorageMime(input: CodeStorageWriteInput, path: string, b64: string | null): string {
  const explicit = input.mime?.trim();
  if (explicit) return explicit.toLowerCase();
  if (b64) {
    return (
      sniffMimeFromBase64(b64) ??
      TEXT_EXT_MIME[extOf(path)] ??
      "application/octet-stream"
    );
  }
  return TEXT_EXT_MIME[extOf(path)] ?? "text/plain";
}

function parseStorageMetadata(path: string, raw: unknown): CodeStorageMetadata {
  const m = raw as Partial<CodeStorageMetadata>;
  if (
    !m ||
    typeof m !== "object" ||
    typeof m.mime !== "string" ||
    typeof m.chunks !== "number" ||
    (m.encoding !== "utf8" && m.encoding !== "base64")
  ) {
    throw new Error("invalid metadata");
  }
  return {
    path: typeof m.path === "string" ? m.path : path,
    mime: m.mime,
    size: typeof m.size === "number" ? m.size : 0,
    chunks: m.chunks,
    chunkSize: typeof m.chunkSize === "number" ? m.chunkSize : CODE_STORAGE_CHUNK_SIZE,
    updatedAt: typeof m.updatedAt === "string" ? m.updatedAt : "",
    encoding: m.encoding,
  };
}

/** Store a file (text or base64/binary) as chunked KV records + a metadata
 *  record. Chunks are written FIRST and metadata LAST (the commit point),
 *  then stale tail chunks from a longer previous version are removed
 *  (best-effort). Throws with operation + target + reason on failure. */
export async function storageWrite(
  conversationId: string,
  path: string,
  input: CodeStorageWriteInput,
  opts?: CodeLayerOptions,
): Promise<CodeStorageMetadata> {
  const cid = normalizeConversationId(conversationId);
  const client = await requireLayerClient(opts);
  const p = normalizeStoragePath(path);

  const text = input.text;
  const rawB64 = input.base64;
  if (text !== undefined && rawB64 !== undefined) {
    throw new Error(`storage_write "${p}" failed — provide either text or base64, not both.`);
  }
  if (text === undefined && rawB64 === undefined) {
    throw new Error(`storage_write "${p}" failed — provide the content: text (UTF-8) or base64 (binary/images).`);
  }

  let encoding: "utf8" | "base64";
  let payload: string;
  let mime: string;
  let size: number;
  if (text !== undefined) {
    encoding = "utf8";
    payload = text;
    mime = resolveStorageMime(input, p, null);
    size = new TextEncoder().encode(text).length;
  } else {
    const { base64, mime: dataUriMime } = stripDataUri(rawB64 as string);
    validateBase64(base64);
    encoding = "base64";
    payload = base64;
    const explicit = input.mime?.trim();
    mime = (explicit || dataUriMime || sniffMimeFromBase64(base64) || TEXT_EXT_MIME[extOf(p)] || "application/octet-stream").toLowerCase();
    size = approxBase64Bytes(base64);
  }

  if (payload.length > CODE_STORAGE_MAX_PAYLOAD_CHARS) {
    throw new OnyxBaseError(
      "FILE_TOO_LARGE",
      `storage_write "${p}" failed — payload is ${payload.length} chars (max ${CODE_STORAGE_MAX_PAYLOAD_CHARS} ≈ 8.6 MB decoded).`,
    );
  }

  const parts: string[] = [];
  for (let i = 0; i < payload.length; i += CODE_STORAGE_CHUNK_SIZE) {
    parts.push(payload.slice(i, i + CODE_STORAGE_CHUNK_SIZE));
  }

  const metaKey = `${chatStoragePrefix(cid)}${p}`;

  // Previous version (for stale tail-chunk cleanup).
  let oldChunks = 0;
  try {
    const oldRaw = await client.kv.get(metaKey);
    if (oldRaw) {
      oldChunks = parseStorageMetadata(p, JSON.parse(oldRaw)).chunks;
    }
  } catch {
    /* no/corrupt previous version */
  }

  // 1. Payload chunks first — while they stream out, the previous version's
  //    metadata still points at its own (still-present) chunk range.
  for (let i = 0; i < parts.length; i++) {
    await client.kv.set(`${metaKey}:chunk-${String(i + 1).padStart(6, "0")}`, parts[i] as string);
  }
  // 2. Commit metadata.
  const metadata: CodeStorageMetadata = {
    path: p,
    mime,
    size,
    chunks: parts.length,
    chunkSize: CODE_STORAGE_CHUNK_SIZE,
    updatedAt: nowISO(),
    encoding,
  };
  await client.kv.set(metaKey, JSON.stringify(metadata));
  // 3. Best-effort cleanup of stale tail chunks when the new version is
  //    shorter than the old one.
  for (let i = parts.length + 1; i <= oldChunks; i++) {
    try {
      await client.kv.delete(`${metaKey}:chunk-${String(i).padStart(6, "0")}`);
    } catch {
      /* non-fatal — orphan chunk */
    }
  }

  if (!opts?.skipActivity) {
    await activityAppend(
      cid,
      {
        actor: opts?.actor ?? "agent",
        op: "storage_write",
        target: p,
        ok: true,
        detail: `${parts.length} chunk(s), ${size} B, ${mime}`,
      },
      { client },
    );
  }
  return metadata;
}

/** Read a stored file. Returns null when no file is stored at the path.
 *  Verifies every referenced chunk exists — a hole fails loudly with the
 *  chunk index (never a silently-truncated payload). */
export async function storageRead(
  conversationId: string,
  path: string,
  opts?: StorageReadOptions,
): Promise<CodeStorageReadResult | null> {
  const cid = normalizeConversationId(conversationId);
  const client = await requireLayerClient(opts);
  const p = normalizeStoragePath(path);
  const metaKey = `${chatStoragePrefix(cid)}${p}`;
  const rawMeta = await client.kv.get(metaKey);
  if (rawMeta === null) return null;

  let metadata: CodeStorageMetadata;
  try {
    metadata = parseStorageMetadata(p, JSON.parse(rawMeta));
  } catch {
    throw new OnyxBaseError(
      "KV_READ_FAILED",
      `storage_read "${p}" failed — its metadata record is corrupt (got: ${rawMeta.slice(0, 120)}).`,
    );
  }

  const parts: string[] = [];
  for (let i = 1; i <= metadata.chunks; i++) {
    const chunk = await client.kv.get(`${metaKey}:chunk-${String(i).padStart(6, "0")}`);
    if (chunk === null) {
      throw new OnyxBaseError(
        "KV_READ_FAILED",
        `storage_read "${p}" failed — chunk ${i}/${metadata.chunks} is missing in OnyxBase (the file record is incomplete).`,
      );
    }
    parts.push(chunk);
  }

  const full = parts.join("");
  const maxChars = opts?.maxChars;
  const truncated = typeof maxChars === "number" && full.length > maxChars;
  const visible = truncated && typeof maxChars === "number" ? full.slice(0, maxChars) : full;
  return {
    metadata,
    encoding: metadata.encoding,
    ...(metadata.encoding === "utf8" ? { text: visible } : { base64: visible }),
    truncated,
    fullChars: full.length,
  };
}

/** Delete a stored file: all its chunk records + the metadata record. */
export async function storageDelete(
  conversationId: string,
  path: string,
  opts?: CodeLayerOptions,
): Promise<{ deleted: boolean; chunksRemoved: number }> {
  const cid = normalizeConversationId(conversationId);
  const client = await requireLayerClient(opts);
  const p = normalizeStoragePath(path);
  const metaKey = `${chatStoragePrefix(cid)}${p}`;
  const rawMeta = await client.kv.get(metaKey);
  if (rawMeta === null) return { deleted: false, chunksRemoved: 0 };

  let chunks = 0;
  try {
    chunks = parseStorageMetadata(p, JSON.parse(rawMeta)).chunks;
  } catch {
    /* corrupt metadata — still delete what we can identify */
  }

  const failed: string[] = [];
  for (let i = 1; i <= chunks; i++) {
    const key = `${metaKey}:chunk-${String(i).padStart(6, "0")}`;
    try {
      await client.kv.delete(key);
    } catch {
      failed.push(key);
    }
  }
  await client.kv.delete(metaKey);

  if (!opts?.skipActivity) {
    await activityAppend(
      cid,
      {
        actor: opts?.actor ?? "agent",
        op: "storage_delete",
        target: p,
        ok: failed.length === 0,
        ...(failed.length ? { detail: `${failed.length} chunk(s) could not be removed` } : {}),
      },
      { client },
    );
  }
  if (failed.length > 0) {
    throw new OnyxBaseError(
      "KV_WRITE_FAILED",
      `storage_delete "${p}" partially failed — ${failed.length}/${chunks + 1} records could not be deleted and remain in OnyxBase.`,
    );
  }
  return { deleted: true, chunksRemoved: chunks };
}

/** List stored files (metadata only — never payloads), bounded. */
export async function storageList(conversationId: string, opts?: StorageListOptions): Promise<CodeStorageMetadata[]> {
  const cid = normalizeConversationId(conversationId);
  const client = await requireLayerClient(opts);
  const prefix = chatStoragePrefix(cid);
  const keys = (await client.kv.listKeys(prefix))
    .filter((k) => k.startsWith(prefix) && !isStorageChunkKey(k))
    .slice(0, CODE_MAX_LIST_ITEMS);

  const out: CodeStorageMetadata[] = [];
  for (const key of keys) {
    const raw = await client.kv.get(key).catch(() => null);
    if (raw === null) continue;
    try {
      out.push(parseStorageMetadata(key.slice(prefix.length), JSON.parse(raw)));
      opts?.onProgress?.(out.length);
    } catch {
      /* skip corrupt metadata rows */
    }
  }
  const pf = opts?.prefix?.trim();
  const filtered = pf ? out.filter((m) => m.path.startsWith(pf)) : out;
  return filtered.sort((a, b) => a.path.localeCompare(b.path));
}

/** Read just the metadata record of a stored file (null when absent). */
export async function storageMetadata(
  conversationId: string,
  path: string,
  opts?: CodeLayerOptions,
): Promise<CodeStorageMetadata | null> {
  const cid = normalizeConversationId(conversationId);
  const client = await requireLayerClient(opts);
  const p = normalizeStoragePath(path);
  const raw = await client.kv.get(`${chatStoragePrefix(cid)}${p}`);
  if (raw === null) return null;
  try {
    return parseStorageMetadata(p, JSON.parse(raw));
  } catch {
    throw new OnyxBaseError("KV_READ_FAILED", `storage_metadata "${p}" failed — its metadata record is corrupt.`);
  }
}

// ===========================================================================
// SCHEMA — application-level metadata in the KV namespace (PRD §15: NOT
// native tables; the record is clearly labeled as such).
// ===========================================================================

export interface CodeSchemaField {
  name: string;
  /** Any application-level type name (string, number, boolean, json, …). */
  type: string;
  required?: boolean;
  notes?: string;
}

export interface CodeSchemaEntity {
  name: string;
  fields: CodeSchemaField[];
  updatedAt: string;
}

export interface CodeSchema {
  entities: CodeSchemaEntity[];
  updatedAt: string;
}

interface CodeSchemaRecord extends CodeSchema {
  /** Self-description — PRD §15 (application-level metadata, not native
 *    OnyxBase tables). */
  label: string;
}

function normalizeSchemaEntity(input: { name?: unknown; fields?: unknown }): {
  name: string;
  fields: CodeSchemaField[];
} {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("Entity name is required.");
  if (name.length > 80) {
    throw new Error(`Entity name is too long (${name.length} chars, max 80).`);
  }
  if (!Array.isArray(input.fields) || input.fields.length === 0) {
    throw new Error(`Entity "${name}" needs at least one field.`);
  }
  if (input.fields.length > CODE_SCHEMA_MAX_FIELDS) {
    throw new Error(`Entity "${name}" has too many fields (${input.fields.length}, max ${CODE_SCHEMA_MAX_FIELDS}).`);
  }
  const seen = new Set<string>();
  const fields = input.fields.map((raw) => {
    const f = (raw ?? {}) as Partial<CodeSchemaField>;
    const fname = typeof f.name === "string" ? f.name.trim() : "";
    if (!fname) throw new Error(`Entity "${name}" has a field without a name.`);
    const dedupe = fname.toLowerCase();
    if (seen.has(dedupe)) throw new Error(`Entity "${name}" has duplicate field "${fname}".`);
    seen.add(dedupe);
    return {
      name: fname,
      type: (typeof f.type === "string" && f.type.trim()) || "string",
      ...(f.required === true ? { required: true } : {}),
      ...(f.notes && String(f.notes).trim() ? { notes: String(f.notes).trim().slice(0, 300) } : {}),
    } satisfies CodeSchemaField;
  });
  return { name, fields };
}

/** Read this chat's application schema (null when none was stored). */
export async function schemaGet(conversationId: string, opts?: CodeLayerOptions): Promise<CodeSchema | null> {
  const cid = normalizeConversationId(conversationId);
  const client = await requireLayerClient(opts);
  const raw = await client.kv.get(chatSchemaKey(cid));
  if (raw === null) return null;
  try {
    const rec = JSON.parse(raw) as Partial<CodeSchemaRecord>;
    if (!rec || !Array.isArray(rec.entities)) return null;
    const entities: CodeSchemaEntity[] = rec.entities
      .filter((e): e is CodeSchemaEntity => !!e && typeof e.name === "string" && Array.isArray(e.fields))
      .slice(0, CODE_SCHEMA_MAX_ENTITIES)
      .map((e) => ({
        name: e.name,
        fields: e.fields.slice(0, CODE_SCHEMA_MAX_FIELDS),
        updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : "",
      }));
    return { entities, updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : "" };
  } catch {
    throw new OnyxBaseError(
      "KV_READ_FAILED",
      `Reading the schema failed — the schema record for this chat is corrupt (key ${chatSchemaKey(cid)}).`,
    );
  }
}

/** Upsert one entity (by exact name) into this chat's application schema.
 *  Returns the full updated schema. */
export async function schemaUpsert(
  conversationId: string,
  entity: { name?: unknown; fields?: unknown },
  opts?: CodeLayerOptions,
): Promise<CodeSchema> {
  const cid = normalizeConversationId(conversationId);
  const client = await requireLayerClient(opts);
  const normalized = normalizeSchemaEntity(entity);
  const current = (await schemaGet(cid, { client })) ?? { entities: [], updatedAt: "" };
  if (
    current.entities.length >= CODE_SCHEMA_MAX_ENTITIES &&
    !current.entities.some((e) => e.name === normalized.name)
  ) {
    throw new Error(
      `Schema is full (${CODE_SCHEMA_MAX_ENTITIES} entities) — remove one before adding "${normalized.name}".`,
    );
  }
  const entities = current.entities.filter((e) => e.name !== normalized.name);
  entities.push({ ...normalized, updatedAt: nowISO() });
  entities.sort((a, b) => a.name.localeCompare(b.name));
  const schema: CodeSchema = { entities, updatedAt: nowISO() };
  const record: CodeSchemaRecord = { label: CODE_SCHEMA_LABEL, ...schema };
  await client.kv.set(chatSchemaKey(cid), JSON.stringify(record));
  if (!opts?.skipActivity) {
    await activityAppend(
      cid,
      {
        actor: opts?.actor ?? "agent",
        op: "schema_upsert",
        target: normalized.name,
        ok: true,
        detail: `${normalized.fields.length} field(s)`,
      },
      { client },
    );
  }
  return schema;
}

/** Remove one entity from this chat's application schema by exact name. */
export async function schemaDeleteEntity(
  conversationId: string,
  name: string,
  opts?: CodeLayerOptions,
): Promise<{ removed: boolean; entities: string[] }> {
  const cid = normalizeConversationId(conversationId);
  const client = await requireLayerClient(opts);
  const current = await schemaGet(cid, { client });
  if (!current) return { removed: false, entities: [] };
  const kept = current.entities.filter((e) => e.name !== name);
  const removed = kept.length !== current.entities.length;
  if (removed) {
    const schema: CodeSchema = { entities: kept, updatedAt: nowISO() };
    await client.kv.set(chatSchemaKey(cid), JSON.stringify({ label: CODE_SCHEMA_LABEL, ...schema }));
    if (!opts?.skipActivity) {
      await activityAppend(
        cid,
        { actor: opts?.actor ?? "agent", op: "schema_delete", target: name, ok: true },
        { client },
      );
    }
  }
  return { removed, entities: kept.map((e) => e.name) };
}

// ===========================================================================
// OVERVIEW — compact, computed from real list calls (PRD §14: counts + key
// patterns + schema entity names + storage paths — NEVER a full dump).
// ===========================================================================

export interface CodeKvKeyPattern {
  pattern: string;
  count: number;
}

export interface CodeDatabaseOverview {
  conversationId: string;
  kv: {
    count: number;
    sampleKeys: string[];
    keyPatterns: CodeKvKeyPattern[];
    truncated: boolean;
  };
  /** Persistent environment variables (code:env:<chat>:<NAME>). */
  envCount: number;
  storage: {
    files: number;
    /** Sum of decoded bytes over the (bounded) metadata scan. */
    totalBytes: number;
    samplePaths: string[];
    truncated: boolean;
  };
  schema: {
    entityCount: number;
    entities: Array<{ name: string; fieldCount: number; fieldNames: string[] }>;
  };
  activity: {
    events: number;
    latest?: CodeActivityEvent;
  };
  /** Most recent timestamp across schema/storage/activity (ISO, or null). */
  lastUpdate: string | null;
  onyxbase: {
    configured: boolean;
    reachable: boolean;
    account?: string;
    checkedAt: string;
    error?: string;
  };
  /** Legacy GLOBAL workspace records this chat could adopt via kv_list
 *    (only probed when the chat has zero records). */
  legacyRecords?: number;
}

export interface OverviewOptions extends CodeLayerOptions {
  /** Streaming progress line (PRD §27) — "Reading schema…" etc. */
  onProgress?: (line: string) => void;
}

/** Compute a compact overview of this chat's database — counts, key
 *  patterns, schema entity names, storage paths, recency and OnyxBase
 *  reachability. Computed from REAL list/get/whoami calls. */
export async function databaseOverview(
  conversationId: string,
  opts?: OverviewOptions,
): Promise<CodeDatabaseOverview> {
  const cid = normalizeConversationId(conversationId);
  const client = await requireLayerClient(opts);
  const note = (line: string) => opts?.onProgress?.(line);

  note("Listing database keys…");
  const kvPrefix = chatKvPrefix(cid);
  const names = (await client.kv.listKeys(kvPrefix))
    .filter((k) => k.startsWith(kvPrefix))
    .map((k) => k.slice(kvPrefix.length));

  note("Reading environment variables…");
  const envPrefix = chatEnvPrefix(cid);
  const envCount = (await client.kv.listKeys(envPrefix)).filter((k) =>
    k.startsWith(envPrefix),
  ).length;

  note("Reading stored files…");
  const storagePrefix = chatStoragePrefix(cid);
  const storageKeys = (await client.kv.listKeys(storagePrefix)).filter(
    (k) => k.startsWith(storagePrefix) && !isStorageChunkKey(k),
  );
  const storageMeta: CodeStorageMetadata[] = [];
  for (const key of storageKeys.slice(0, CODE_MAX_LIST_ITEMS)) {
    const raw = await client.kv.get(key).catch(() => null);
    if (raw === null) continue;
    try {
      storageMeta.push(parseStorageMetadata(key.slice(storagePrefix.length), JSON.parse(raw)));
    } catch {
      /* skip corrupt rows */
    }
  }

  note("Reading schema…");
  const schema = await schemaGet(cid, { client }).catch(() => null);

  note("Reading activity log…");
  const activity = await activityList(cid, undefined, { client }).catch(() => [] as CodeActivityEvent[]);

  let onyxbase: CodeDatabaseOverview["onyxbase"] = { configured: true, reachable: true, checkedAt: nowISO() };
  try {
    note("Checking OnyxBase connectivity…");
    const who = await client.kv.whoami();
    const account = who.apiKey?.name || who.user;
    onyxbase = {
      configured: true,
      reachable: true,
      checkedAt: nowISO(),
      ...(account ? { account } : {}),
    };
  } catch (err) {
    onyxbase = {
      configured: true,
      reachable: false,
      checkedAt: nowISO(),
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Key patterns — group by the first segment ("users/42" → "users").
  const patterns = new Map<string, number>();
  for (const name of names) {
    const m = /^([^:/]+)[:/]/.exec(name);
    const pattern = m?.[1] ?? name;
    patterns.set(pattern, (patterns.get(pattern) ?? 0) + 1);
  }
  const keyPatterns = [...patterns.entries()]
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern))
    .slice(0, 5);

  const timestamps = [
    schema?.updatedAt,
    ...storageMeta.map((m) => m.updatedAt),
    activity.length > 0 ? activity[activity.length - 1]?.ts : undefined,
  ].filter((t): t is string => !!t);
  timestamps.sort();
  const lastUpdate = timestamps.length > 0 ? timestamps[timestamps.length - 1] ?? null : null;

  let legacyRecords: number | undefined;
  if (names.length === 0) {
    legacyRecords = (await client.kv.listKeys(CODE_DB_PREFIX).catch(() => [] as string[])).filter(
      isLegacyGlobalRecordKey,
    ).length;
  }

  return {
    conversationId: cid,
    kv: {
      count: names.length,
      sampleKeys: names.slice(0, 8),
      keyPatterns,
      truncated: names.length > 8,
    },
    envCount,
    storage: {
      files: storageKeys.length,
      totalBytes: storageMeta.reduce((sum, m) => sum + m.size, 0),
      samplePaths: storageMeta.slice(0, 8).map((m) => m.path),
      truncated: storageKeys.length > 8,
    },
    schema: {
      entityCount: schema?.entities.length ?? 0,
      entities: (schema?.entities ?? []).map((e) => ({
        name: e.name,
        fieldCount: e.fields.length,
        fieldNames: e.fields.slice(0, 10).map((f) => f.name),
      })),
    },
    activity: {
      events: activity.length,
      ...(activity.length > 0 ? { latest: activity[activity.length - 1] } : {}),
    },
    lastUpdate,
    onyxbase,
    ...(legacyRecords !== undefined && legacyRecords > 0 ? { legacyRecords } : {}),
  };
}
