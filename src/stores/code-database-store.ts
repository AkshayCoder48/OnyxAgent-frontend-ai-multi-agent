"use client";

/**
 * Code Mode Database store (OnyxBase Database PRD §30–§32) — the isolated
 * client state behind the OnyxCode Database panel.
 *
 * WHY A DEDICATED STORE (§30–§32): database state must never re-render the
 * chat / sidebar / preview, and token streaming must never re-render the
 * panel. The panel subscribes HERE ONLY — never to the chat store — and
 * every mutation lands as a TARGETED local update (§32: after a confirmed
 * write, exactly ONE entry changes in place — never a full refetch).
 *
 * Data source: Task C's per-chat OnyxBase layer (`@/lib/code/db-namespace`).
 * Every helper takes the conversationId FIRST, so this store is scoped to
 * one conversation at a time and resets when the scope changes.
 *
 * CACHING (§31): data is cached deliberately. There are NO timers in this
 * store — the panel decides when to refresh (on open, on scope change, on
 * visibility regain, on the manual Refresh button; see DatabasePanel).
 *
 * GUARDS:
 *  - seq-guarded, parallel-safe refreshes — a newer refresh supersedes any
 *    in-flight one (stale responses are dropped), and a repeat refreshAll
 *    for the SAME conversation dedupes onto the in-flight promise.
 *  - `editorOpenFor` — while ANY editor dialog is open, refreshes
 *    early-return so a background refresh can never clobber the editor.
 *  - local upserts are conversation-scoped: a late update for a previous
 *    conversation can never paint over the current one.
 */

import { create } from "zustand";
import {
  CODE_ACTIVITY_MAX_EVENTS,
  activityList,
  codeDbFailureMessage,
  databaseOverview,
  envList,
  kvList,
  resolveCodeDbClient,
  schemaGet,
  storageList,
  storageRead,
  type CodeActivityEvent,
  type CodeDatabaseOverview,
  type CodeDbClient,
  type CodeDbFailure,
  type CodeEnvRecord,
  type CodeKvEntry,
  type CodeSchema,
  type CodeStorageMetadata,
} from "@/lib/code/db-namespace";

export type CodeDatabasePhase =
  | "idle" // no refresh has run yet (no scope / auth still hydrating)
  | "loading"
  | "ready"
  | "not-configured" // user has no OnyxBase key → Settings → Cloud
  | "error";

export type CodeDatabaseSection = "overview" | "kv" | "env" | "storage" | "schema" | "activity";

/** A lazily-loaded thumbnail for one storage path (§111 — never blocking). */
export interface CodeThumbnail {
  dataUrl: string;
  /** The file's `updatedAt` when the payload was fetched. A mismatch on the
   *  next request re-fetches (files can be overwritten in place). */
  updatedAt: string;
}

const ALL_SECTIONS: readonly CodeDatabaseSection[] = [
  "overview",
  "kv",
  "env",
  "storage",
  "schema",
  "activity",
];

function busySections(): Record<CodeDatabaseSection, boolean> {
  return { overview: true, kv: true, env: true, storage: true, schema: true, activity: true };
}

function idleSections(): Record<CodeDatabaseSection, boolean> {
  return { overview: false, kv: false, env: false, storage: false, schema: false, activity: false };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Narrow the client | failure union returned by resolveCodeDbClient. */
function isFailure(v: CodeDbClient | CodeDbFailure): v is CodeDbFailure {
  return "kind" in v;
}

// ── refresh machinery (module scope — shared across the store's lifetime) ──

/** Monotonic refresh sequence: only the LATEST refresh may apply its results. */
let refreshSeq = 0;

/** The in-flight refreshAll (dedupes repeat calls for the same conversation). */
let inflightRefresh: { conversationId: string; promise: Promise<void> } | null = null;

/** Storage-path → in-flight thumbnail read (prevents duplicate fetches). */
const thumbnailInflight = new Set<string>();

export interface CodeDatabaseState {
  /** The conversation this state belongs to (null before the first refresh). */
  conversationId: string | null;
  phase: CodeDatabasePhase;
  /** Last refresh/section error (honest OnyxBase reasons; null when clean). */
  error: string | null;
  sectionBusy: Record<CodeDatabaseSection, boolean>;
  overview: CodeDatabaseOverview | null;
  kv: { entries: CodeKvEntry[]; query: string };
  /** Persistent environment variables for this conversation (env tab). */
  env: CodeEnvRecord[];
  storage: { files: CodeStorageMetadata[] };
  /** Lazy image thumbnails, keyed by storage path (current conversation). */
  thumbnails: Record<string, CodeThumbnail>;
  /** Paths whose thumbnail read failed once (no retry loops). */
  thumbnailFailed: Record<string, boolean>;
  schema: CodeSchema | null;
  activity: CodeActivityEvent[];
  /** The record key / entity name being edited (dialog guard — see header). */
  editorOpenFor: string | null;
  lastFetchedAt: number | null;

  /** Full refresh (all six sections, fetched in parallel, one client). */
  refreshAll: (conversationId: string) => Promise<void>;
  /** Individual section refreshes (each resolves its own client). */
  refreshOverview: (conversationId: string) => Promise<void>;
  refreshKv: (conversationId: string) => Promise<void>;
  refreshEnv: (conversationId: string) => Promise<void>;
  refreshStorage: (conversationId: string) => Promise<void>;
  refreshSchema: (conversationId: string) => Promise<void>;
  refreshActivity: (conversationId: string) => Promise<void>;

  // ── §32 targeted local updates (call AFTER the real write confirmed) ──
  upsertKvLocal: (conversationId: string, entry: CodeKvEntry) => void;
  removeKvLocal: (conversationId: string, name: string) => void;
  setEnvLocal: (conversationId: string, record: CodeEnvRecord) => void;
  deleteEnvLocal: (conversationId: string, name: string) => void;
  upsertFileLocal: (conversationId: string, metadata: CodeStorageMetadata) => void;
  removeFileLocal: (conversationId: string, path: string) => void;
  setSchemaLocal: (conversationId: string, schema: CodeSchema) => void;
  removeSchemaEntityLocal: (conversationId: string, name: string) => void;
  appendActivityLocal: (conversationId: string, event: CodeActivityEvent) => void;

  setKvQuery: (query: string) => void;
  setEditorOpenFor: (key: string | null) => void;
  /** Lazily read one stored image and cache its data URL (§111). No-op when
   *  cached+fresh, already in-flight, or previously failed. */
  ensureThumbnail: (conversationId: string, path: string) => void;
}

export const useCodeDatabaseStore = create<CodeDatabaseState>((set, get) => {
  /** Shared refreshAll body — never rejects (allSettled + guarded sets). */
  async function doRefreshAll(conversationId: string, seq: number): Promise<void> {
    const resolved = await resolveCodeDbClient();
    if (seq !== refreshSeq) return;
    if (isFailure(resolved)) {
      set({
        phase: resolved.kind === "not_configured" ? "not-configured" : "error",
        error: resolved.kind === "not_configured" ? null : codeDbFailureMessage(resolved),
        sectionBusy: idleSections(),
        lastFetchedAt: Date.now(),
      });
      return;
    }
    const client = resolved;
    const [overviewR, kvR, envR, storageR, schemaR, activityR] = await Promise.allSettled([
      databaseOverview(conversationId, { client }),
      kvList(conversationId, { client }),
      envList(client, conversationId),
      storageList(conversationId, { client }),
      schemaGet(conversationId, { client }),
      activityList(conversationId, undefined, { client }),
    ]);
    if (seq !== refreshSeq) return;

    const failures: string[] = [];
    const patch: Partial<CodeDatabaseState> = {};
    if (overviewR.status === "fulfilled") patch.overview = overviewR.value;
    else failures.push(`overview — ${errText(overviewR.reason)}`);
    if (kvR.status === "fulfilled") patch.kv = { entries: kvR.value, query: get().kv.query };
    else failures.push(`KV records — ${errText(kvR.reason)}`);
    if (envR.status === "fulfilled") patch.env = envR.value;
    else failures.push(`environment variables — ${errText(envR.reason)}`);
    if (storageR.status === "fulfilled") patch.storage = { files: storageR.value };
    else failures.push(`files — ${errText(storageR.reason)}`);
    if (schemaR.status === "fulfilled") patch.schema = schemaR.value;
    else failures.push(`schema — ${errText(schemaR.reason)}`);
    if (activityR.status === "fulfilled") patch.activity = activityR.value;
    else failures.push(`activity — ${errText(activityR.reason)}`);

    const allFailed = failures.length === ALL_SECTIONS.length;
    set({
      ...patch,
      phase: allFailed ? "error" : "ready",
      error: failures.length
        ? allFailed
          ? `Database refresh failed — ${failures[0]}`
          : `Some sections could not be refreshed (${failures.length}): ${failures[0]}`
        : null,
      sectionBusy: idleSections(),
      lastFetchedAt: Date.now(),
    });
  }

  /** One section refresh: resolve client → apply → guarded by the shared seq. */
  async function runSection(
    section: CodeDatabaseSection,
    conversationId: string,
    apply: (client: CodeDbClient) => Promise<Partial<CodeDatabaseState>>,
  ): Promise<void> {
    if (get().editorOpenFor) return; // never clobber an open editor
    const seq = ++refreshSeq;
    set((s) => ({ sectionBusy: { ...s.sectionBusy, [section]: true } }));
    const resolved = await resolveCodeDbClient();
    if (seq !== refreshSeq) return;
    if (isFailure(resolved)) {
      set((s) => ({
        phase:
          resolved.kind === "not_configured"
            ? "not-configured"
            : s.phase === "ready"
              ? "ready"
              : "error",
        error: codeDbFailureMessage(resolved),
        sectionBusy: { ...s.sectionBusy, [section]: false },
      }));
      return;
    }
    try {
      const patch = await apply(resolved);
      if (seq !== refreshSeq) return;
      set((s) => ({
        ...patch,
        phase: "ready",
        error: null,
        sectionBusy: { ...s.sectionBusy, [section]: false },
        lastFetchedAt: Date.now(),
      }));
    } catch (err) {
      if (seq !== refreshSeq) return;
      set((s) => ({
        error: `${section} refresh failed — ${errText(err)}`,
        phase: s.phase === "ready" ? "ready" : "error",
        sectionBusy: { ...s.sectionBusy, [section]: false },
      }));
    }
  }

  return {
    conversationId: null,
    phase: "idle",
    error: null,
    sectionBusy: idleSections(),
    overview: null,
    kv: { entries: [], query: "" },
    env: [],
    storage: { files: [] },
    thumbnails: {},
    thumbnailFailed: {},
    schema: null,
    activity: [],
    editorOpenFor: null,
    lastFetchedAt: null,

    refreshAll: (conversationId) => {
      const st = get();
      if (st.editorOpenFor) return Promise.resolve(); // never clobber an editor
      if (inflightRefresh && inflightRefresh.conversationId === conversationId) {
        return inflightRefresh.promise; // dedupe repeat calls (parallel-safe)
      }
      const seq = ++refreshSeq;
      const scopeChanged = st.conversationId !== conversationId;
      set({
        conversationId,
        phase: "loading",
        error: null,
        sectionBusy: busySections(),
        ...(scopeChanged
          ? {
              overview: null,
              kv: { entries: [], query: "" },
              env: [],
              storage: { files: [] },
              thumbnails: {},
              thumbnailFailed: {},
              schema: null,
              activity: [],
            }
          : {}),
      });
      const promise = doRefreshAll(conversationId, seq);
      inflightRefresh = { conversationId, promise };
      void promise.finally(() => {
        if (inflightRefresh?.promise === promise) inflightRefresh = null;
      });
      return promise;
    },

    refreshOverview: (conversationId) =>
      runSection("overview", conversationId, async (client) => {
        const overview = await databaseOverview(conversationId, { client });
        return { overview };
      }),
    refreshKv: (conversationId) =>
      runSection("kv", conversationId, async (client) => {
        const entries = await kvList(conversationId, { client });
        return { kv: { entries, query: get().kv.query } };
      }),
    refreshEnv: (conversationId) =>
      runSection("env", conversationId, async (client) => {
        const env = await envList(client, conversationId);
        return { env };
      }),
    refreshStorage: (conversationId) =>
      runSection("storage", conversationId, async (client) => {
        const files = await storageList(conversationId, { client });
        return { storage: { files } };
      }),
    refreshSchema: (conversationId) =>
      runSection("schema", conversationId, async (client) => {
        const schema = await schemaGet(conversationId, { client });
        return { schema };
      }),
    refreshActivity: (conversationId) =>
      runSection("activity", conversationId, async (client) => {
        const activity = await activityList(conversationId, undefined, { client });
        return { activity };
      }),

    // ── §32 targeted updates — ONE entry, never a refetch ──────────────────

    upsertKvLocal: (conversationId, entry) => {
      if (get().conversationId !== conversationId) return;
      set((s) => {
        const exists = s.kv.entries.some((e) => e.name === entry.name);
        const entries = exists
          ? s.kv.entries.map((e) => (e.name === entry.name ? entry : e))
          : [...s.kv.entries, entry];
        entries.sort((a, b) => a.name.localeCompare(b.name));
        return { kv: { entries, query: s.kv.query } };
      });
    },

    removeKvLocal: (conversationId, name) => {
      if (get().conversationId !== conversationId) return;
      set((s) => ({
        kv: { entries: s.kv.entries.filter((e) => e.name !== name), query: s.kv.query },
      }));
    },

    setEnvLocal: (conversationId, record) => {
      if (get().conversationId !== conversationId) return;
      set((s) => {
        const exists = s.env.some((e) => e.name === record.name);
        const env = exists
          ? s.env.map((e) => (e.name === record.name ? record : e))
          : [...s.env, record];
        env.sort((a, b) => a.name.localeCompare(b.name));
        return { env };
      });
    },

    deleteEnvLocal: (conversationId, name) => {
      if (get().conversationId !== conversationId) return;
      set((s) => ({ env: s.env.filter((e) => e.name !== name) }));
    },

    upsertFileLocal: (conversationId, metadata) => {
      if (get().conversationId !== conversationId) return;
      set((s) => {
        const exists = s.storage.files.some((f) => f.path === metadata.path);
        const files = exists
          ? s.storage.files.map((f) => (f.path === metadata.path ? metadata : f))
          : [...s.storage.files, metadata];
        files.sort((a, b) => a.path.localeCompare(b.path));
        return { storage: { files } };
      });
    },

    removeFileLocal: (conversationId, path) => {
      if (get().conversationId !== conversationId) return;
      set((s) => {
        const thumbnails = { ...s.thumbnails };
        delete thumbnails[path];
        const thumbnailFailed = { ...s.thumbnailFailed };
        delete thumbnailFailed[path];
        return {
          storage: { files: s.storage.files.filter((f) => f.path !== path) },
          thumbnails,
          thumbnailFailed,
        };
      });
    },

    setSchemaLocal: (conversationId, schema) => {
      if (get().conversationId !== conversationId) return;
      set({ schema });
    },

    removeSchemaEntityLocal: (conversationId, name) => {
      if (get().conversationId !== conversationId) return;
      set((s) =>
        s.schema
          ? {
              schema: {
                entities: s.schema.entities.filter((e) => e.name !== name),
                // The delete rewrote the schema record server-side NOW — an
                // honest local mirror of schemaDeleteEntity's updatedAt.
                updatedAt: new Date().toISOString(),
              },
            }
          : {},
      );
    },

    appendActivityLocal: (conversationId, event) => {
      if (get().conversationId !== conversationId) return;
      set((s) => ({
        activity: [...s.activity, event].slice(-CODE_ACTIVITY_MAX_EVENTS),
      }));
    },

    setKvQuery: (query) => set((s) => ({ kv: { ...s.kv, query } })),

    setEditorOpenFor: (key) => set({ editorOpenFor: key }),

    ensureThumbnail: (conversationId, path) => {
      const st = get();
      if (st.conversationId !== conversationId) return;
      const file = st.storage.files.find((f) => f.path === path);
      if (!file) return; // deleted or not listed — nothing to render
      const cached = st.thumbnails[path];
      if (cached && cached.updatedAt === file.updatedAt) return; // fresh
      if (st.thumbnailFailed[path]) return; // failed once — no retry loop
      if (thumbnailInflight.has(path)) return;
      thumbnailInflight.add(path);
      void (async () => {
        try {
          const resolved = await resolveCodeDbClient();
          if (isFailure(resolved)) throw new Error(codeDbFailureMessage(resolved));
          const result = await storageRead(conversationId, path, { client: resolved });
          if (!result || !result.base64) throw new Error("No image payload stored.");
          if (get().conversationId !== conversationId) return;
          set((s) => ({
            thumbnails: {
              ...s.thumbnails,
              [path]: {
                dataUrl: `data:${result.metadata.mime};base64,${result.base64}`,
                updatedAt: file.updatedAt,
              },
            },
          }));
        } catch {
          if (get().conversationId === conversationId) {
            set((s) => ({ thumbnailFailed: { ...s.thumbnailFailed, [path]: true } }));
          }
        } finally {
          thumbnailInflight.delete(path);
        }
      })();
    },
  };
});
