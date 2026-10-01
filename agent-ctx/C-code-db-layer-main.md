# Task C — OnyxBase per-chat Database & Storage layer + Code-Mode agent tools

Agent: main (Task C) · Repo state: `fa6539d` + fix commits · Files touched (ONLY these two):
- `src/lib/code/db-namespace.ts` — EXTENDED in place (all legacy exports intact)
- `src/lib/tools/code_database.ts` — rewritten into the tool suite (12 tools)

`bunx tsc --noEmit` clean · `bun run lint` 0 errors, 0 warnings in my files (31 pre-existing warnings elsewhere) · dev.log compiles clean. Untouched: `src/components/code/database-panel.tsx` (Task D rebuilds it), all preview files (another agent's concurrent work).

Full work record also appended to `/home/z/my-project/worklog.md` (section `---` / Task ID: C). Summary below.

## Namespace scheme (collection `onyxagent`)

| Purpose | Key | Value |
|---|---|---|
| KV document | `code:db:<conversationId>:<name>` | RAW JSON/text string (unchanged canonical shape; JSON re-serialized on agent writes, same as legacy `manage_database set`) |
| Storage metadata | `code:storage:<conversationId>:<path>` | `{ path, mime, size, chunks, chunkSize, updatedAt, encoding }` |
| Storage payload | `code:storage:<conversationId>:<path>:chunk-000001…` (1-based, padStart 6) | payload slice, ≤ 120 000 chars (same CHUNK_SIZE as workspace-sync) |
| Schema | `code:schema:<conversationId>` | `{ label: "OnyxCode application schema metadata", entities: [{ name, fields: [{ name, type, required?, notes? }], updatedAt }], updatedAt }` |
| Activity | `code:activity:<conversationId>` | `{ events: [{ ts, actor: "agent"|"user", op, target, ok, detail? }] }` — last 50 |
| LEGACY (global) | `code:db:<name>` (no further colon) | unchanged, read-compatible; one-shot COPIED into new chats by `kvList` auto-migration |

Isolation (PRD §21): every helper takes `conversationId` FIRST and derives keys internally; `normalizeConversationId` rejects empty/whitespace/`:`; tools NEVER accept conversationId or full raw keys from the model.

## Exported helper signatures (all in `@/lib/code/db-namespace`)

```ts
// legacy (unchanged): CODE_DB_PREFIX, CODE_DB_MAX_RECORDS, codeDbKey, stripCodeDbPrefix,
// CodeDbRecord, CodeDbClient, CodeDbFailure, resolveCodeDbClient(userId?),
// listCodeDbRecords(client, opts?), makeRecord(key, value), codeDbFailureMessage(failure)

// constants
CODE_STORAGE_PREFIX; CODE_SCHEMA_PREFIX; CODE_ACTIVITY_PREFIX;
CODE_ACTIVITY_MAX_EVENTS = 50; CODE_STORAGE_CHUNK_SIZE = 120_000;
CODE_STORAGE_MAX_PAYLOAD_CHARS = 12_000_000; CODE_KV_MAX_VALUE_CHARS = 120_000;
CODE_MAX_LIST_ITEMS = 100; CODE_SCHEMA_LABEL; CODE_SCHEMA_MAX_ENTITIES = 100; CODE_SCHEMA_MAX_FIELDS = 60;

// pure
normalizeConversationId(id): string            // throws on invalid
normalizeKvName(name): string                  // strips leading "/" + "code:db:"
normalizeStoragePath(path): string             // backslashes→/, rejects ":chunk-N" suffix
chatKvPrefix(id); chatKvKey(id, name); chatKvName(id, fullKey);
chatStoragePrefix(id); chatStorageMetaKey(id, path); chatStorageChunkKey(id, path, n);
isStorageChunkKey(key); chatSchemaKey(id); chatActivityKey(id);
sniffMimeFromBase64(b64): string | null        // png/jpeg/gif/bmp/webp/pdf/zip/gzip/tiff/svg/xml/html

// options
interface CodeLayerOptions { client?; userId?; actor?: "agent"|"user"; skipActivity?: boolean }
interface KvListOptions extends CodeLayerOptions { prefix?; limit?; onProgress?(n); onMigrate?(adopted); autoMigrateLegacy? }
interface StorageListOptions extends CodeLayerOptions { prefix?; onProgress?(n) }
interface StorageReadOptions extends CodeLayerOptions { maxChars? }
interface OverviewOptions extends CodeLayerOptions { onProgress?(line) }

// KV
kvListKeys(conversationId, opts?): Promise<string[]>                       // names only, cheap
kvList(conversationId, opts?): Promise<CodeKvEntry[]>                       // names+values, ≤100 (cap 200); auto-adopts legacy once
kvGet(conversationId, key, opts?): Promise<CodeKvEntry | null>
kvSet(conversationId, key, value, opts?): Promise<CodeKvEntry>              // >120k chars → FILE_TOO_LARGE error
kvDelete(conversationId, key, opts?): Promise<{ name; key }>
kvSearch(conversationId, query, opts?): Promise<CodeKvEntry[]>             // substring over name+value
migrateLegacyRecords(conversationId, opts?): Promise<{ adopted; considered; error? }>  // non-fatal, copies

// storage
storageWrite(conversationId, path, { text? | base64?, mime? }, opts?): Promise<CodeStorageMetadata>
storageRead(conversationId, path, { maxChars? }?): Promise<CodeStorageReadResult | null>  // verifies every chunk
storageDelete(conversationId, path, opts?): Promise<{ deleted; chunksRemoved }>
storageList(conversationId, { prefix? }?): Promise<CodeStorageMetadata[]>  // metadata only, ≤100
storageMetadata(conversationId, path, opts?): Promise<CodeStorageMetadata | null>

// schema
schemaGet(conversationId, opts?): Promise<CodeSchema | null>
schemaUpsert(conversationId, { name, fields }, opts?): Promise<CodeSchema> // upsert by exact entity name
schemaDeleteEntity(conversationId, name, opts?): Promise<{ removed; entities }>

// activity + overview
activityAppend(conversationId, Omit<CodeActivityEvent,"ts">, opts?): Promise<void>  // best-effort
activityList(conversationId, limit?, opts?): Promise<CodeActivityEvent[]>
databaseOverview(conversationId, { onProgress? }?): Promise<CodeDatabaseOverview>
```

`CodeKvEntry = { key (full), name, value, parsed, isJson, size }`.

## Registered tools (`src/lib/tools/code_database.ts`, all category `"code"`, no approval)

| Tool | Params (JSON schema) |
|---|---|
| `inspect_database` | `{}` — compact overview: kv{count, sampleKeys≤8, keyPatterns≤5}, storage{files, totalBytes, samplePaths≤8}, schema entities (name+fieldCount+fieldNames≤10), activity latest, lastUpdate, onyxbase{reachable, account}, optional `legacyRecords` hint |
| `kv_get` | `{ key }` → full value if ≤50k chars (parsed JSON when valid), else 2 000-char preview + `truncated` |
| `kv_set` | `{ key, value }` — value string (objects coerced to JSON); normalizes JSON like legacy set |
| `kv_delete` | `{ key }` |
| `kv_list` | `{ prefix?, limit?, search? }` → records `[{ key, isJson, size, preview(200) }]`, optional `migrated` |
| `storage_list` | `{ prefix? }` → files `[{ path, mime, size, chunks, updatedAt }]` |
| `storage_read` | `{ path }` → utf8: text (≤50k chars, else truncated); base64: `isImage`, full b64 only if ≤2k chars else `base64Preview(400)` + note (full payload stays in KV; panel renders thumbnails) |
| `storage_write` | `{ path, text? | base64?, mime? }` — data: URI accepted; mime sniffed; ≤8.6 MB; chunked at 120k chars |
| `storage_delete` | `{ path }` |
| `storage_metadata` | `{ path }` |
| `schema_upsert` | `{ entity, fields: [{ name, type?, required?, notes? }] }` (addition beyond §12's list, justified by §15 "agent-facing" upsert) |
| `manage_database` | legacy `{ action: list|get|set|delete, name?, value? }`, same result shape (`kind:"code_database"`), now per-chat |

Results carry `kind: "database"` + `op` + `ok` for Task D's rich cards; errors are `{ ok:false, error: "<op> \"<target>\" failed — <OnyxBase reason>" }` (PRD §28). Progress streams via `ctx.onToolOutput("", line, "stdout")` (PRD §27) — "Reading schema…", "Key app.config — reading…", "✓ Value loaded".

## conversationId flow

Registry `ToolContext.conversationId` — set by `src/lib/agent/runtime.ts` at turn start (`toolCtxForList = { ...toolCtx, conversationId }`), same mechanism `start_preview` uses. Tools read `ctx.conversationId`; missing → honest error (runtime always sets it; subagents get their own subagentId namespace).

## Caveats / notes for Task D (panel UI)

- Resolve once per call: `const resolved = await resolveCodeDbClient(userId); if ("kind" in resolved) …` — pass `{ client: resolved }` into helpers. Panel writes should pass `actor: "user"` (activity log), agent writes log `actor: "agent"` automatically.
- Legacy global panel (`listCodeDbRecords`) still works and will ALSO show per-chat keys as `<convId>:<name>` until Task D replaces it — expected transitional state.
- Thumbnails: call `storageRead(convId, path)` (library) — `base64` field → `data:<mime>;base64,<b64>`; tool results only carry previews by design.
- Legacy migration is COPY (never deletes), triggered inside `kvList` when a chat has 0 records + no `legacy_migrated` activity event; legacy names containing `:` are NOT adopted (ambiguous with per-chat keys — documented).
- Storage overwrite is path-addressed (per the PRD key layout): metadata commits last; a mid-write crash can leave a torn previous version; stale tail chunks are cleaned best-effort.
- KV records intentionally carry NO updatedAt wrapper (round-trip compatibility with existing panel/makeRecord) — recency comes from the activity log / storage metadata / schema updatedAt.
