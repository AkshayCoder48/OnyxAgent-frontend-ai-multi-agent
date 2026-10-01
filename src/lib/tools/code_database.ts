"use client";

import { registerTool, type ToolContext } from "./registry";
import {
  chatKvPrefix,
  codeDbFailureMessage,
  databaseOverview,
  kvDelete,
  kvGet,
  kvList,
  kvSearch,
  kvSet,
  resolveCodeDbClient,
  schemaUpsert,
  storageDelete,
  storageList,
  storageMetadata,
  storageRead,
  storageWrite,
  type CodeDbClient,
  type CodeKvEntry,
} from "@/lib/code/db-namespace";

/**
 * OnyxCode Code Mode database/storage tools (OnyxBase PRD §12/§13/§14/§21/§24/
 * §27/§28) — a per-chat document store, file storage, application schema and
 * activity log, ALL backed by the user's OnyxBase cloud KV (real persistent
 * storage; nothing is tied to the E2B sandbox, PRD §38).
 *
 * ONE chat = ONE isolated context (PRD §3): every tool derives its namespace
 * from `ctx.conversationId` (set by the runtime at turn start — the same
 * mechanism `start_preview` uses) and the LLM can never supply a
 * conversationId or a full raw KV key, so a chat can only ever touch its own
 * records (PRD §21).
 *
 * Tool set: inspect_database, kv_get, kv_set, kv_delete, kv_list,
 * storage_list, storage_read, storage_write, storage_delete,
 * storage_metadata, schema_upsert (+ the legacy manage_database, implemented
 * on top of the same layer for backward compatibility). All registered with
 * category "code" — they are only USEFUL in Code Mode; mode gating itself is
 * handled elsewhere (PRD §13).
 *
 * Streaming (PRD §27): every tool emits progress lines through the existing
 * ctx.onToolOutput channel ("Reading schema…", "Key app.config — reading…",
 * "✓ Value loaded"), exactly like the other code tools (create_app etc.).
 *
 * Errors (PRD §28): real OnyxBase failures surface with operation + target +
 * reason (the OnyxBaseKV client attaches the HTTP status + server reason);
 * success is only ever reported after a real backend confirmation.
 */

const NO_CONVERSATION =
  "No active conversation — the Code Mode database is scoped per chat (one chat = one isolated namespace).";

/** kv_get returns the full value up to this size; beyond it, a preview. */
const KV_GET_FULL_LIMIT = 50_000;

/** storage_read returns full text up to this size; beyond it, a preview. */
const STORAGE_TEXT_FULL_LIMIT = 50_000;

/** Base64 payloads ≤ this many chars are returned in full (tiny icons); larger
 *  ones only carry a short preview (full binaries stay in OnyxBase — the
 *  Database panel renders thumbnails from the library layer, not from the
 *  tool result, so the LLM context never gets flooded with base64). */
const STORAGE_B64_FULL_LIMIT = 2_000;

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function requireConversationId(ctx: ToolContext): string | null {
  const id = ctx.conversationId?.trim();
  return id ? id : null;
}

/** Resolve the OnyxBase client once per tool call (vault key never in prompt). */
async function resolveClient(ctx: ToolContext): Promise<CodeDbClient | { error: string }> {
  const resolved = await resolveCodeDbClient(ctx.userId);
  if ("kind" in resolved) return { error: codeDbFailureMessage(resolved) };
  return resolved;
}

function progressOf(ctx: ToolContext): (line: string) => void {
  return (line: string) => ctx.onToolOutput?.("", line, "stdout");
}

/** Coerce a model-supplied value arg into storable text (objects → JSON). */
function coerceText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function intArg(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

function strArg(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function kvPreview(e: CodeKvEntry): { key: string; isJson: boolean; size: number; preview: string } {
  return { key: e.name, isJson: e.isJson, size: e.size, preview: e.value.slice(0, 200) };
}

// ---------------------------------------------------------------------------
// inspect_database — compact overview (PRD §14: counts + key patterns + schema
// entity names + storage paths — NEVER a full dump).
// ---------------------------------------------------------------------------

registerTool(
  "inspect_database",
  "Inspect this chat's OnyxBase database: a compact overview — KV record count + key patterns + sample keys, stored files (count + bytes + paths), schema entity names, recent activity and OnyxBase connectivity. One chat = one isolated namespace. Call this FIRST before the other database tools; it never dumps full contents.",
  { type: "object", properties: {}, additionalProperties: false },
  async (_args, ctx) => {
    const conversationId = requireConversationId(ctx);
    if (!conversationId) return { ok: false, error: NO_CONVERSATION };
    const progress = progressOf(ctx);
    try {
      const client = await resolveClient(ctx);
      if ("error" in client) return { ok: false, error: client.error };

      progress("Inspecting chat database…");
      const overview = await databaseOverview(conversationId, {
        client,
        onProgress: (line) => progress(line),
      });
      progress(
        `✓ ${overview.kv.count} record(s), ${overview.storage.files} file(s) (${formatBytes(
          overview.storage.totalBytes,
        )}), ${overview.schema.entityCount} schema entit${overview.schema.entityCount === 1 ? "y" : "ies"}`,
      );
      return {
        kind: "database",
        ok: true,
        op: "inspect",
        namespace: chatKvPrefix(conversationId),
        overview,
        ...(overview.legacyRecords
          ? {
              hint: `${overview.legacyRecords} legacy global workspace record(s) found — call kv_list once to adopt them into this chat.`,
            }
          : {}),
      };
    } catch (err) {
      return { ok: false, op: "inspect", error: `inspect_database failed — ${errText(err)}` };
    }
  },
  false,
  "code",
);

// ---------------------------------------------------------------------------
// KV tools — per-chat documents (raw JSON/text values, panel-compatible).
// ---------------------------------------------------------------------------

registerTool(
  "kv_get",
  "Read one record from this chat's OnyxBase KV namespace (code:db:<chat>:<key>). Returns the full value (parsed JSON when valid) for reasonably-sized records, a truncated preview for large ones.",
  {
    type: "object",
    properties: {
      key: { type: "string", description: "Record name, e.g. app-config or users/42." },
    },
    required: ["key"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const conversationId = requireConversationId(ctx);
    if (!conversationId) return { ok: false, error: NO_CONVERSATION };
    const key = String(args.key ?? "").trim();
    if (!key) return { ok: false, error: "key is required." };
    const progress = progressOf(ctx);
    try {
      const client = await resolveClient(ctx);
      if ("error" in client) return { ok: false, error: client.error };

      progress(`Key ${key} — reading…`);
      const entry = await kvGet(conversationId, key, { client });
      if (!entry) {
        return { ok: false, op: "kv_get", error: `Key "${key}" not found in this chat's database.` };
      }
      progress(`✓ Value loaded (${entry.size} chars)`);
      if (entry.size <= KV_GET_FULL_LIMIT) {
        return {
          kind: "database",
          ok: true,
          op: "kv_get",
          key: entry.name,
          isJson: entry.isJson,
          size: entry.size,
          ...(entry.isJson ? { value: entry.parsed } : { text: entry.value }),
        };
      }
      return {
        kind: "database",
        ok: true,
        op: "kv_get",
        key: entry.name,
        isJson: entry.isJson,
        size: entry.size,
        text: entry.value.slice(0, 2_000),
        truncated: true,
        fullSize: entry.size,
        note: "Value truncated — retrieve it in smaller records or via the Database panel.",
      };
    } catch (err) {
      return { ok: false, op: "kv_get", error: `kv_get "${key}" failed — ${errText(err)}` };
    }
  },
  false,
  "code",
);

registerTool(
  "kv_set",
  "Create or overwrite one record in this chat's OnyxBase KV namespace. value = a JSON string (object/array/scalar — stored normalized) or plain text. Values above ~120k chars are rejected — use storage_write for large payloads (it chunks automatically).",
  {
    type: "object",
    properties: {
      key: { type: "string", description: "Record name, e.g. app-config or users/42." },
      value: {
        type: "string",
        description: "The record value — a JSON string (object, array or scalar) or plain text.",
      },
    },
    required: ["key", "value"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const conversationId = requireConversationId(ctx);
    if (!conversationId) return { ok: false, error: NO_CONVERSATION };
    const key = String(args.key ?? "").trim();
    const value = coerceText(args.value);
    if (!key) return { ok: false, error: "key is required." };
    if (value === undefined) return { ok: false, error: "value is required (a JSON string or text)." };
    const progress = progressOf(ctx);
    try {
      const client = await resolveClient(ctx);
      if ("error" in client) return { ok: false, error: client.error };

      progress(`Writing ${key}…`);
      const entry = await kvSet(conversationId, key, value, { client, actor: "agent" });
      progress(`✓ Saved (${entry.size} chars)`);
      return {
        kind: "database",
        ok: true,
        op: "kv_set",
        key: entry.name,
        size: entry.size,
        saved: true,
      };
    } catch (err) {
      return { ok: false, op: "kv_set", error: `kv_set "${key}" failed — ${errText(err)}` };
    }
  },
  false,
  "code",
);

registerTool(
  "kv_delete",
  "Delete one record from this chat's OnyxBase KV namespace.",
  {
    type: "object",
    properties: {
      key: { type: "string", description: "Record name to delete." },
    },
    required: ["key"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const conversationId = requireConversationId(ctx);
    if (!conversationId) return { ok: false, error: NO_CONVERSATION };
    const key = String(args.key ?? "").trim();
    if (!key) return { ok: false, error: "key is required." };
    const progress = progressOf(ctx);
    try {
      const client = await resolveClient(ctx);
      if ("error" in client) return { ok: false, error: client.error };

      progress(`Deleting ${key}…`);
      const result = await kvDelete(conversationId, key, { client, actor: "agent" });
      progress("✓ Deleted");
      return { kind: "database", ok: true, op: "kv_delete", key: result.name, deleted: true };
    } catch (err) {
      return { ok: false, op: "kv_delete", error: `kv_delete "${key}" failed — ${errText(err)}` };
    }
  },
  false,
  "code",
);

registerTool(
  "kv_list",
  "List records in this chat's OnyxBase KV namespace: names, sizes, JSON-ness and 200-char value previews (bounded — 100 by default). Optional `prefix` filters names; optional `search` filters by case-insensitive substring over names + values. On the FIRST list of a chat with zero records, legacy global workspace records are adopted (copied) into the chat.",
  {
    type: "object",
    properties: {
      prefix: { type: "string", description: "Only names starting with this prefix (e.g. \"users/\")." },
      limit: { type: "number", description: "Max records to return (default 100, max 200)." },
      search: { type: "string", description: "Case-insensitive substring filter over names + values." },
    },
    additionalProperties: false,
  },
  async (args, ctx) => {
    const conversationId = requireConversationId(ctx);
    if (!conversationId) return { ok: false, error: NO_CONVERSATION };
    const prefix = strArg(args.prefix);
    const search = strArg(args.search);
    const limit = intArg(args.limit);
    const progress = progressOf(ctx);
    try {
      const client = await resolveClient(ctx);
      if ("error" in client) return { ok: false, error: client.error };

      progress(search ? `Searching records for "${search}"…` : "Listing records…");
      let migrated = 0;
      const listOpts = {
        client,
        limit,
        prefix,
        onMigrate: (n: number) => {
          migrated = n;
          progress(`Adopting ${n} legacy workspace record(s) into this chat…`);
        },
      };
      const entries = search
        ? await kvSearch(conversationId, search, listOpts)
        : await kvList(conversationId, listOpts);
      if (migrated > 0) progress(`✓ Adopted ${migrated} legacy record(s)`);
      progress(`✓ ${entries.length} record(s)`);
      return {
        kind: "database",
        ok: true,
        op: "kv_list",
        namespace: chatKvPrefix(conversationId),
        count: entries.length,
        ...(prefix ? { prefix } : {}),
        ...(search ? { search } : {}),
        ...(migrated ? { migrated } : {}),
        records: entries.map(kvPreview),
      };
    } catch (err) {
      return { ok: false, op: "kv_list", error: `kv_list failed — ${errText(err)}` };
    }
  },
  false,
  "code",
);

// ---------------------------------------------------------------------------
// Storage tools — files as chunked KV records (PRD §4/§5/§24).
// ---------------------------------------------------------------------------

registerTool(
  "storage_list",
  "List files stored for this chat in OnyxBase cloud storage: path, mime, size, chunk count and updatedAt (metadata only — payloads are never returned).",
  {
    type: "object",
    properties: {
      prefix: { type: "string", description: "Only paths starting with this prefix (e.g. \"assets/\")." },
    },
    additionalProperties: false,
  },
  async (args, ctx) => {
    const conversationId = requireConversationId(ctx);
    if (!conversationId) return { ok: false, error: NO_CONVERSATION };
    const prefix = strArg(args.prefix);
    const progress = progressOf(ctx);
    try {
      const client = await resolveClient(ctx);
      if ("error" in client) return { ok: false, error: client.error };

      progress("Listing stored files…");
      const files = await storageList(conversationId, { client, prefix });
      progress(`✓ ${files.length} file(s)`);
      return {
        kind: "database",
        ok: true,
        op: "storage_list",
        count: files.length,
        ...(prefix ? { prefix } : {}),
        files: files.map((m) => ({
          path: m.path,
          mime: m.mime,
          size: m.size,
          chunks: m.chunks,
          updatedAt: m.updatedAt,
        })),
      };
    } catch (err) {
      return { ok: false, op: "storage_list", error: `storage_list failed — ${errText(err)}` };
    }
  },
  false,
  "code",
);

registerTool(
  "storage_read",
  "Read a stored file from this chat's OnyxBase cloud storage. Text files return their text (full up to 50k chars); binary/image files return metadata + a short base64 preview — the full payload stays in OnyxBase and renders as a thumbnail in the Code Mode Database panel.",
  {
    type: "object",
    properties: {
      path: { type: "string", description: "Storage path, e.g. assets/logo.png." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const conversationId = requireConversationId(ctx);
    if (!conversationId) return { ok: false, error: NO_CONVERSATION };
    const path = String(args.path ?? "").trim();
    if (!path) return { ok: false, error: "path is required." };
    const progress = progressOf(ctx);
    try {
      const client = await resolveClient(ctx);
      if ("error" in client) return { ok: false, error: client.error };

      progress(`File ${path} — reading…`);
      const result = await storageRead(conversationId, path, {
        client,
        maxChars: STORAGE_TEXT_FULL_LIMIT,
      });
      if (!result) {
        return { ok: false, op: "storage_read", error: `No file stored at "${path}" in this chat.` };
      }
      const { metadata } = result;
      progress(`✓ Loaded ${formatBytes(metadata.size)} (${metadata.chunks} chunk(s), ${metadata.mime})`);

      if (result.encoding === "utf8") {
        return {
          kind: "database",
          ok: true,
          op: "storage_read",
          path: metadata.path,
          mime: metadata.mime,
          size: metadata.size,
          encoding: "utf8",
          text: result.text,
          ...(result.truncated ? { truncated: true, fullChars: result.fullChars } : {}),
        };
      }

      const b64 = result.base64 ?? "";
      const full = b64.length <= STORAGE_B64_FULL_LIMIT;
      const isImage = metadata.mime.startsWith("image/");
      return {
        kind: "database",
        ok: true,
        op: "storage_read",
        path: metadata.path,
        mime: metadata.mime,
        size: metadata.size,
        encoding: "base64",
        isImage,
        chunks: metadata.chunks,
        ...(full
          ? { base64: b64 }
          : { base64Preview: b64.slice(0, 400), truncated: true, fullChars: result.fullChars }),
        note: isImage
          ? "Image stored in OnyxBase — it renders as a thumbnail in the Code Mode Database panel (don't paste the full base64 into chat)."
          : "Full binary payload stays in OnyxBase (chunked records).",
      };
    } catch (err) {
      return { ok: false, op: "storage_read", error: `storage_read "${path}" failed — ${errText(err)}` };
    }
  },
  false,
  "code",
);

registerTool(
  "storage_write",
  "Store a file for this chat in OnyxBase cloud storage — real persistent storage (chunked KV records, survives sandbox destruction). Pass `text` (UTF-8) OR `base64` (binary/images; data: URI prefixes are fine — the mime type is sniffed from magic bytes, or set it explicitly with `mime`). Files up to ~8.6 MB.",
  {
    type: "object",
    properties: {
      path: { type: "string", description: "Storage path, e.g. assets/logo.png or notes/readme.md." },
      text: { type: "string", description: "UTF-8 text content (for text files)." },
      base64: {
        type: "string",
        description: "Base64 content (binary/images); a data: URI prefix is accepted and its mime is used.",
      },
      mime: { type: "string", description: "Explicit mime type (e.g. image/png) — optional." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const conversationId = requireConversationId(ctx);
    if (!conversationId) return { ok: false, error: NO_CONVERSATION };
    const path = String(args.path ?? "").trim();
    if (!path) return { ok: false, error: "path is required." };
    const text = coerceText(args.text);
    const base64 = typeof args.base64 === "string" && args.base64.trim() ? args.base64 : undefined;
    const mime = strArg(args.mime);
    if (text !== undefined && base64 !== undefined) {
      return { ok: false, error: "Provide either `text` or `base64` — not both." };
    }
    if (text === undefined && base64 === undefined) {
      return { ok: false, error: "Provide the content: `text` (UTF-8) or `base64` (binary/images)." };
    }
    const progress = progressOf(ctx);
    try {
      const client = await resolveClient(ctx);
      if ("error" in client) return { ok: false, error: client.error };

      progress(`Storing ${path}…`);
      const metadata = await storageWrite(
        conversationId,
        path,
        { ...(text !== undefined ? { text } : { base64: base64 as string }), ...(mime ? { mime } : {}) },
        { client, actor: "agent" },
      );
      progress(`✓ Stored ${formatBytes(metadata.size)} in ${metadata.chunks} chunk(s) (${metadata.mime})`);
      return {
        kind: "database",
        ok: true,
        op: "storage_write",
        path: metadata.path,
        mime: metadata.mime,
        size: metadata.size,
        chunks: metadata.chunks,
        encoding: metadata.encoding,
        updatedAt: metadata.updatedAt,
      };
    } catch (err) {
      return { ok: false, op: "storage_write", error: `storage_write "${path}" failed — ${errText(err)}` };
    }
  },
  false,
  "code",
);

registerTool(
  "storage_delete",
  "Delete a stored file from this chat's OnyxBase cloud storage — all its chunk records plus its metadata record.",
  {
    type: "object",
    properties: {
      path: { type: "string", description: "Storage path to delete." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const conversationId = requireConversationId(ctx);
    if (!conversationId) return { ok: false, error: NO_CONVERSATION };
    const path = String(args.path ?? "").trim();
    if (!path) return { ok: false, error: "path is required." };
    const progress = progressOf(ctx);
    try {
      const client = await resolveClient(ctx);
      if ("error" in client) return { ok: false, error: client.error };

      progress(`Deleting ${path}…`);
      const result = await storageDelete(conversationId, path, { client, actor: "agent" });
      if (!result.deleted) {
        return { ok: false, op: "storage_delete", error: `No file stored at "${path}" in this chat.` };
      }
      progress(`✓ Deleted (${result.chunksRemoved} chunk record(s))`);
      return {
        kind: "database",
        ok: true,
        op: "storage_delete",
        path,
        deleted: true,
        chunksRemoved: result.chunksRemoved,
      };
    } catch (err) {
      return { ok: false, op: "storage_delete", error: `storage_delete "${path}" failed — ${errText(err)}` };
    }
  },
  false,
  "code",
);

registerTool(
  "storage_metadata",
  "Read the metadata of one stored file in this chat's OnyxBase cloud storage: path, mime, size, chunk count, encoding and updatedAt.",
  {
    type: "object",
    properties: {
      path: { type: "string", description: "Storage path to inspect." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const conversationId = requireConversationId(ctx);
    if (!conversationId) return { ok: false, error: NO_CONVERSATION };
    const path = String(args.path ?? "").trim();
    if (!path) return { ok: false, error: "path is required." };
    const progress = progressOf(ctx);
    try {
      const client = await resolveClient(ctx);
      if ("error" in client) return { ok: false, error: client.error };

      progress(`File ${path} — reading metadata…`);
      const metadata = await storageMetadata(conversationId, path, { client });
      if (!metadata) {
        return { ok: false, op: "storage_metadata", error: `No file stored at "${path}" in this chat.` };
      }
      progress("✓ Metadata loaded");
      return { kind: "database", ok: true, op: "storage_metadata", ...metadata };
    } catch (err) {
      return {
        ok: false,
        op: "storage_metadata",
        error: `storage_metadata "${path}" failed — ${errText(err)}`,
      };
    }
  },
  false,
  "code",
);

// ---------------------------------------------------------------------------
// Schema tool — application-level metadata (PRD §15: stored in the KV
// namespace, clearly labeled, NOT native OnyxBase tables).
// ---------------------------------------------------------------------------

registerTool(
  "schema_upsert",
  "Create or update one entity in this chat's application schema — OnyxCode application schema metadata stored in the KV namespace (NOT native tables). Upserts by entity name with the full field list. Read the schema back via inspect_database.",
  {
    type: "object",
    properties: {
      entity: { type: "string", description: "Entity name, e.g. \"users\" or \"orders\"." },
      fields: {
        type: "array",
        description: "The entity's fields.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Field name." },
            type: {
              type: "string",
              description: "Application-level type name (string, number, boolean, json, …). Default string.",
            },
            required: { type: "boolean", description: "Whether the field is required." },
            notes: { type: "string", description: "Optional note about the field." },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    },
    required: ["entity", "fields"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const conversationId = requireConversationId(ctx);
    if (!conversationId) return { ok: false, error: NO_CONVERSATION };
    const entity = String(args.entity ?? "").trim();
    const fields = args.fields;
    if (!entity) return { ok: false, error: "entity is required." };
    if (!Array.isArray(fields) || fields.length === 0) {
      return { ok: false, error: "fields is required (a non-empty array of {name, type, required?, notes?})." };
    }
    const progress = progressOf(ctx);
    try {
      const client = await resolveClient(ctx);
      if ("error" in client) return { ok: false, error: client.error };

      progress(`Updating schema entity ${entity}…`);
      const schema = await schemaUpsert(conversationId, { name: entity, fields }, { client, actor: "agent" });
      const saved = schema.entities.find((e) => e.name === entity);
      progress(`✓ Schema updated (${schema.entities.length} entit${schema.entities.length === 1 ? "y" : "ies"})`);
      return {
        kind: "database",
        ok: true,
        op: "schema_upsert",
        entity,
        fieldCount: saved?.fields.length ?? 0,
        entities: schema.entities.map((e) => e.name),
        updatedAt: schema.updatedAt,
        label: "OnyxCode application schema metadata",
      };
    } catch (err) {
      return { ok: false, op: "schema_upsert", error: `schema_upsert "${entity}" failed — ${errText(err)}` };
    }
  },
  false,
  "code",
);

// ---------------------------------------------------------------------------
// manage_database — the ORIGINAL one-tool API, kept for backward compat and
// reimplemented on top of the per-chat layer (same result shape as before,
// now scoped to the current conversation).
// ---------------------------------------------------------------------------

registerTool(
  "manage_database",
  "Read and write the OnyxCode app database for THIS chat — a document store in the user's OnyxBase cloud, namespaced per conversation (code:db:<chat>:<name>). Actions: `list` (documents with previews), `get` (one document), `set` (create/overwrite with a JSON value), `delete` (remove). Prefer the dedicated kv_get/kv_set/kv_delete/kv_list tools — this one is kept for compatibility.",
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "get", "set", "delete"],
        description: "The database operation to perform.",
      },
      name: {
        type: "string",
        description: "Document name (key, without the code:db: prefix). Required for get/set/delete.",
      },
      value: {
        type: "string",
        description: "For `set`: the document value — a JSON string (object, array, or scalar) or plain text.",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const action = String(args.action ?? "");
    const name = args.name !== undefined && args.name !== null ? String(args.name) : "";
    const value = coerceText(args.value);

    if (action !== "list" && !name.trim()) {
      return { ok: false, error: `name is required for ${action}.` };
    }
    const conversationId = requireConversationId(ctx);
    if (!conversationId) return { ok: false, error: NO_CONVERSATION };
    const progress = progressOf(ctx);
    try {
      const client = await resolveClient(ctx);
      if ("error" in client) return { ok: false, error: client.error };
      const opts = { client, actor: "agent" as const };

      if (action === "list") {
        progress("Listing documents…");
        let migrated = 0;
        const entries = await kvList(conversationId, {
          ...opts,
          onMigrate: (n: number) => {
            migrated = n;
          },
        });
        if (migrated > 0) progress(`✓ Adopted ${migrated} legacy workspace record(s)`);
        progress(`✓ ${entries.length} document(s)`);
        return {
          kind: "code_database",
          ok: true,
          action: "list",
          namespace: chatKvPrefix(conversationId),
          count: entries.length,
          documents: entries.map(kvPreview),
        };
      }

      if (action === "get") {
        progress(`Document ${name} — reading…`);
        const entry = await kvGet(conversationId, name, opts);
        if (!entry) return { ok: false, error: `Document "${name}" not found.` };
        progress(`✓ Value loaded (${entry.size} chars)`);
        return {
          kind: "code_database",
          ok: true,
          action: "get",
          name: entry.name,
          isJson: entry.isJson,
          ...(entry.isJson ? { value: entry.parsed } : { text: entry.value }),
        };
      }

      if (action === "set") {
        if (value === undefined) {
          return { ok: false, error: "value is required for set (a JSON string or text)." };
        }
        progress(`Writing ${name}…`);
        const entry = await kvSet(conversationId, name, value, opts);
        progress(`✓ Saved (${entry.size} chars)`);
        return { kind: "code_database", ok: true, action: "set", name: entry.name, saved: true };
      }

      if (action === "delete") {
        progress(`Deleting ${name}…`);
        await kvDelete(conversationId, name, opts);
        progress("✓ Deleted");
        return { kind: "code_database", ok: true, action: "delete", name, deleted: true };
      }

      return { ok: false, error: `Unknown action "${action}". Use list, get, set, or delete.` };
    } catch (err) {
      return { ok: false, error: `manage_database ${action} failed — ${errText(err)}` };
    }
  },
  false,
  "code",
);
