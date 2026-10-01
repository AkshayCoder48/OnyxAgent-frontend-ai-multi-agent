"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Braces,
  Copy,
  Database,
  Download,
  FileText,
  Image as ImageIcon,
  Info,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore, useConversationStore } from "@/stores";
import { useCodePanelStore } from "@/stores/code-panel-store";
import { useCodeDatabaseStore } from "@/stores/code-database-store";
import { qk } from "@/lib/query-keys";
import { conversationService } from "@/lib/services";
import type { Conversation } from "@/types";
import { ROUTES } from "@/lib/constants";
import {
  CODE_STORAGE_MAX_PAYLOAD_CHARS,
  codeDbFailureMessage,
  kvDelete,
  kvSet,
  resolveCodeDbClient,
  schemaDeleteEntity,
  schemaUpsert,
  storageDelete,
  storageMetadata,
  storageRead,
  storageWrite,
  type CodeActivityActor,
  type CodeActivityEvent,
  type CodeDatabaseOverview,
  type CodeKvEntry,
  type CodeSchemaEntity,
  type CodeStorageMetadata,
} from "@/lib/code/db-namespace";
import { cn } from "@/lib/utils";

/**
 * OnyxCode Database panel (OnyxBase Database PRD §6–§10, §15, §27–§32) — a
 * sectioned DEVELOPER CONSOLE docked beside the chat (rendered by
 * ChatWorkspace inside a DockedPanel, which owns the layout + mobile drawer).
 *
 * Scope: THIS conversation's isolated OnyxBase namespace (one chat = one
 * app's storage — §21). All data flows through Task C's per-chat helpers and
 * the dedicated `code-database-store`, so the panel NEVER subscribes to chat
 * messages — token streaming cannot re-render it, and its updates never
 * re-render the chat (§30–§31).
 *
 * Sections (only real data — §28 honesty: "—" while loading, real OnyxBase
 * errors with retry, never fabricated values):
 *   Overview · KV · Files · Schema · Search · Activity
 *
 * Lifecycle (calm per §31 — NO polling interval): refresh on panel open (when
 * stale), on conversation switch, when the browser tab becomes visible again
 * (while the panel is open), on the manual Refresh button, and targeted local
 * updates after every confirmed write (§32 — ONE entry changes, never a
 * refetch). A background refresh never clobbers an open editor dialog.
 */

/** Freshness window for the on-open / on-visibility refresh (§31). */
const STALE_MS = 30_000;

/** Images larger than this render a file icon instead of a live thumbnail
 *  (§111 lazy + light: never pull multi-megabyte payloads into the panel). */
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

type TabValue = "overview" | "kv" | "files" | "schema" | "search" | "activity";

type KvEditorState = { mode: "new" } | { mode: "edit"; entry: CodeKvEntry } | null;
type SchemaEditorState = { mode: "new" } | { mode: "edit"; entity: CodeSchemaEntity } | null;
type UploadState = { file: File; dataUrl: string } | null;
type ConfirmState =
  | { kind: "kv"; name: string }
  | { kind: "file"; path: string }
  | { kind: "entity"; name: string }
  | null;

/* ------------------------------------------------------------------ */
/* Shared helpers                                                       */
/* ------------------------------------------------------------------ */

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(ts: string | null | undefined): string {
  if (!ts) return "—";
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 45_000) return "just now";
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} d ago`;
  return new Date(t).toLocaleDateString();
}

function absoluteTime(ts: string): string {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? ts : new Date(t).toLocaleString();
}

async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error("Could not access the clipboard");
  }
}

/** Build an activity event for a LOCAL mirror append (§32) — the exact shape
 *  the library layer just appended server-side. */
function activityEvent(
  actor: CodeActivityActor,
  op: string,
  target: string,
  ok: boolean,
  detail?: string,
): CodeActivityEvent {
  return {
    ts: new Date().toISOString(),
    actor,
    op,
    target,
    ok,
    ...(detail ? { detail } : {}),
  };
}

/** The most recent time the activity log shows a KV op for this record —
 *  KV entries carry no updatedAt by design (Task C), so recency is HONEST:
 *  real events when they exist, "—" when the record predates the 50-event log. */
function lastKvTouchAt(name: string, activity: CodeActivityEvent[]): string | null {
  for (let i = activity.length - 1; i >= 0; i--) {
    const e = activity[i];
    if (e && (e.op === "kv_set" || e.op === "kv_delete") && e.target === name) {
      return e.ts;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* KV value typing (§9 — type badge + editor type selector)             */
/* ------------------------------------------------------------------ */

type KvValueType = "string" | "number" | "boolean" | "null" | "json-object" | "json-array";
type KvTypeBadgeLabel = "String" | "Number" | "Boolean" | "Null" | "JSON Object" | "JSON Array";

const KV_TYPE_OPTIONS: { value: KvValueType; label: string }[] = [
  { value: "string", label: "String" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Boolean" },
  { value: "null", label: "Null" },
  { value: "json-object", label: "JSON Object" },
  { value: "json-array", label: "JSON Array" },
];

/** Auto-detect a record's type from its parsed value. */
function kvTypeOf(entry: CodeKvEntry): KvTypeBadgeLabel {
  if (!entry.isJson) return "String";
  const p = entry.parsed;
  if (Array.isArray(p)) return "JSON Array";
  if (p !== null && typeof p === "object") return "JSON Object";
  if (typeof p === "number") return "Number";
  if (typeof p === "boolean") return "Boolean";
  if (p === null) return "Null";
  return "String";
}

/** Load a record into the editor's (type, text) draft. */
function entryToDraft(entry: CodeKvEntry): { type: KvValueType; text: string } {
  if (!entry.isJson) return { type: "string", text: entry.value };
  const p = entry.parsed;
  if (Array.isArray(p)) return { type: "json-array", text: JSON.stringify(p, null, 2) };
  if (p !== null && typeof p === "object") return { type: "json-object", text: JSON.stringify(p, null, 2) };
  if (typeof p === "number") return { type: "number", text: String(p) };
  if (typeof p === "boolean") return { type: "boolean", text: String(p) };
  if (p === null) return { type: "null", text: "null" };
  return { type: "string", text: String(p) };
}

/** Type validation BEFORE save (§9): invalid JSON (or number/boolean text)
 *  blocks the save and shows the parse error inline. */
function validateDraft(draft: { type: KvValueType; text: string }): string | null {
  const text = draft.text;
  switch (draft.type) {
    case "string":
    case "null":
      return null;
    case "number": {
      const t = text.trim();
      if (!t) return "Enter a number.";
      if (Number.isNaN(Number(t))) return `"${t}" is not a valid number.`;
      return null;
    }
    case "boolean": {
      const t = text.trim().toLowerCase();
      if (t !== "true" && t !== "false") return "Enter true or false.";
      return null;
    }
    case "json-object":
    case "json-array": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        return `Invalid JSON — ${err instanceof Error ? err.message : "parse error"}`;
      }
      if (draft.type === "json-object" && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
        return "Value is not a JSON object.";
      }
      if (draft.type === "json-array" && !Array.isArray(parsed)) {
        return "Value is not a JSON array.";
      }
      return null;
    }
  }
}

/** Type coercion per selection (§9) — produce the raw stored string. */
function serializeDraft(draft: { type: KvValueType; text: string }): string {
  switch (draft.type) {
    case "string": {
      // Plain text is stored as-is — EXCEPT when the text itself parses as
      // JSON (it would be misread as Number/Object on the way back), in
      // which case it is stored quoted so it round-trips as a String.
      try {
        JSON.parse(draft.text);
        return JSON.stringify(draft.text);
      } catch {
        return draft.text;
      }
    }
    case "number":
      return String(Number(draft.text.trim()));
    case "boolean":
      return draft.text.trim().toLowerCase();
    case "null":
      return "null";
    case "json-object":
    case "json-array":
      return JSON.stringify(JSON.parse(draft.text));
  }
}

function KvTypeBadge({ type }: { type: KvTypeBadgeLabel }) {
  const isJson = type === "JSON Object" || type === "JSON Array";
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-px text-[9px] font-semibold",
        isJson ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
      )}
    >
      {type}
    </span>
  );
}

function ActorBadge({ actor }: { actor: CodeActivityActor }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase",
        actor === "agent" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
      )}
    >
      {actor}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                                */
/* ------------------------------------------------------------------ */

export function DatabasePanel() {
  const router = useRouter();
  // Scope + visibility (primitive selectors — chat messages never re-render
  // this panel; only a conversation switch or panel toggle does).
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const active = useCodePanelStore((s) => s.open === "database");
  const userId = useAuthStore((s) => s.user?.id);
  // Project title — a NARROW, deduped read of the SHARED conversations query
  // (same key the sidebar uses → one cached fetch, no refetch storm). The
  // panel must never subscribe to chat/message state (§30): `select` narrows
  // the subscription to JUST this conversation's title.
  const title =
    useQuery({
      queryKey: qk.conversations.list(userId ?? undefined),
      queryFn: async () => {
        if (!userId) throw new Error("Not signed in");
        return conversationService.list(userId, { limit: 30, includeArchived: true });
      },
      enabled: !!userId && !!conversationId,
      select: (list: Conversation[]) =>
        list.find((c) => c.id === conversationId)?.title ?? null,
    }).data ?? null;

  const phase = useCodeDatabaseStore((s) => s.phase);
  const error = useCodeDatabaseStore((s) => s.error);
  const overview = useCodeDatabaseStore((s) => s.overview);
  const overviewBusy = useCodeDatabaseStore((s) => s.sectionBusy.overview);
  const refreshing = useCodeDatabaseStore(
    (s) =>
      s.sectionBusy.overview ||
      s.sectionBusy.kv ||
      s.sectionBusy.storage ||
      s.sectionBusy.schema ||
      s.sectionBusy.activity,
  );
  const refreshAll = useCodeDatabaseStore((s) => s.refreshAll);
  const refreshOverview = useCodeDatabaseStore((s) => s.refreshOverview);
  const setEditorOpenFor = useCodeDatabaseStore((s) => s.setEditorOpenFor);
  const setKvQuery = useCodeDatabaseStore((s) => s.setKvQuery);
  const removeKvLocal = useCodeDatabaseStore((s) => s.removeKvLocal);
  const removeFileLocal = useCodeDatabaseStore((s) => s.removeFileLocal);
  const removeSchemaEntityLocal = useCodeDatabaseStore((s) => s.removeSchemaEntityLocal);
  const appendActivityLocal = useCodeDatabaseStore((s) => s.appendActivityLocal);

  const [tab, setTab] = useState<TabValue>("overview");
  const [searchQuery, setSearchQuery] = useState("");
  const [filesQuery, setFilesQuery] = useState("");
  const [kvEditor, setKvEditor] = useState<KvEditorState>(null);
  const [schemaEditor, setSchemaEditor] = useState<SchemaEditorState>(null);
  const [upload, setUpload] = useState<UploadState>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  // ── Editor dialog guards (store flag blocks background refreshes) ──────

  const openKvEditor = useCallback(
    (state: NonNullable<KvEditorState>) => {
      setKvEditor(state);
      setEditorOpenFor(state.mode === "edit" ? state.entry.name : "__new_kv__");
    },
    [setEditorOpenFor],
  );
  const closeKvEditor = useCallback(() => {
    setKvEditor(null);
    setEditorOpenFor(null);
  }, [setEditorOpenFor]);

  const openSchemaEditor = useCallback(
    (state: NonNullable<SchemaEditorState>) => {
      setSchemaEditor(state);
      setEditorOpenFor(state.mode === "edit" ? state.entity.name : "__new_entity__");
    },
    [setEditorOpenFor],
  );
  const closeSchemaEditor = useCallback(() => {
    setSchemaEditor(null);
    setEditorOpenFor(null);
  }, [setEditorOpenFor]);

  // A dialog's data belongs to its conversation — close everything when the
  // scope changes (also clears the store guard for the refresh below).
  useEffect(() => {
    setKvEditor(null);
    setSchemaEditor(null);
    setUpload(null);
    setConfirmState(null);
    setEditorOpenFor(null);
  }, [conversationId, setEditorOpenFor]);

  // ── Lifecycle (§31 calm: refresh on open / scope change / visibility) ──

  useEffect(() => {
    if (!active || !conversationId || !userId) return;
    const st = useCodeDatabaseStore.getState();
    if (st.editorOpenFor) return; // never clobber an open editor
    const fresh =
      st.conversationId === conversationId &&
      st.lastFetchedAt !== null &&
      Date.now() - st.lastFetchedAt < STALE_MS &&
      st.phase === "ready";
    if (!fresh && st.phase !== "loading") {
      void refreshAll(conversationId);
    }
  }, [active, conversationId, userId, refreshAll]);

  useEffect(() => {
    if (!active) return;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (!conversationId || !userId) return;
      const st = useCodeDatabaseStore.getState();
      if (st.editorOpenFor || st.phase === "loading") return;
      const fresh =
        st.conversationId === conversationId &&
        st.lastFetchedAt !== null &&
        Date.now() - st.lastFetchedAt < STALE_MS &&
        st.phase === "ready";
      if (!fresh) void refreshAll(conversationId);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [active, conversationId, userId, refreshAll]);

  // ── Destructive actions (one shared confirm, real errors surfaced) ─────

  const runConfirm = useCallback(async () => {
    if (!confirmState || !conversationId) return;
    setConfirmBusy(true);
    try {
      const resolved = await resolveCodeDbClient();
      if ("kind" in resolved) throw new Error(codeDbFailureMessage(resolved));
      if (confirmState.kind === "kv") {
        const result = await kvDelete(conversationId, confirmState.name, {
          client: resolved,
          actor: "user",
        });
        removeKvLocal(conversationId, result.name);
        appendActivityLocal(conversationId, activityEvent("user", "kv_delete", result.name, true));
        toast.success(`Deleted "${result.name}"`);
      } else if (confirmState.kind === "file") {
        await storageDelete(conversationId, confirmState.path, { client: resolved, actor: "user" });
        removeFileLocal(conversationId, confirmState.path);
        appendActivityLocal(conversationId, activityEvent("user", "storage_delete", confirmState.path, true));
        toast.success(`Deleted "${confirmState.path}"`);
      } else {
        await schemaDeleteEntity(conversationId, confirmState.name, { client: resolved, actor: "user" });
        removeSchemaEntityLocal(conversationId, confirmState.name);
        appendActivityLocal(conversationId, activityEvent("user", "schema_delete", confirmState.name, true));
        toast.success(`Removed entity "${confirmState.name}"`);
      }
      setConfirmState(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed — nothing was changed.");
    } finally {
      setConfirmBusy(false);
    }
  }, [confirmState, conversationId, removeKvLocal, removeFileLocal, removeSchemaEntityLocal, appendActivityLocal]);

  const confirmMeta = useMemo(() => {
    if (!confirmState) return null;
    if (confirmState.kind === "kv") {
      return {
        title: `Delete "${confirmState.name}"?`,
        description: "The record is removed from this app's OnyxBase database. This cannot be undone.",
        label: "Delete record",
      };
    }
    if (confirmState.kind === "file") {
      return {
        title: `Delete "${confirmState.path}"?`,
        description: "All chunk records and the metadata are removed from OnyxBase. This cannot be undone.",
        label: "Delete file",
      };
    }
    return {
      title: `Remove entity "${confirmState.name}"?`,
      description: "The entity is removed from this app's schema metadata. This cannot be undone.",
      label: "Remove entity",
    };
  }, [confirmState]);

  const refresh = () => {
    if (conversationId) void refreshAll(conversationId);
  };

  return (
    <div className="animate-in fade-in duration-150 flex h-full min-h-0 flex-col">
      {/* Header — DATABASE + OnyxBase reachability + scope + refresh */}
      <div className="glass-header border-border flex shrink-0 items-center gap-2 border-b px-2.5 py-2">
        <Database className="text-primary h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="shrink-0 text-[12px] font-bold tracking-widest">DATABASE</span>
        <ReachDot overview={overview} />
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-[10px]">
          This app&apos;s storage
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={refresh}
          disabled={refreshing || !conversationId}
          className="h-7 w-7 shrink-0"
          title="Refresh all sections from OnyxBase"
          aria-label="Refresh database panel"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} aria-hidden />
        </Button>
      </div>

      {/* Body */}
      {!conversationId ? (
        <EmptyState
          icon={<Database className="h-5 w-5" aria-hidden />}
          title="No app chat selected"
          body="This panel shows one app's OnyxBase storage. Send a message in a Code Mode chat first — its database is created per chat."
        />
      ) : phase === "idle" || phase === "loading" ? (
        <div className="space-y-2 p-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : phase === "not-configured" ? (
        <EmptyState
          icon={<Database className="h-5 w-5" aria-hidden />}
          title="OnyxBase is not connected"
          body="Add your OnyxBase API key in Settings → Cloud to give this app (and the agent) a persistent cloud database."
          action={
            <Button size="sm" variant="outline" onClick={() => router.push(ROUTES.SETTINGS_CLOUD)}>
              Open Settings → Cloud
            </Button>
          }
        />
      ) : phase === "error" ? (
        <EmptyState
          icon={<AlertTriangle className="h-5 w-5" aria-hidden />}
          title="Couldn't load the database"
          body={error ?? "The OnyxBase request failed."}
          action={
            <Button size="sm" variant="outline" onClick={refresh} disabled={refreshing}>
              {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              Try again
            </Button>
          }
        />
      ) : (
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as TabValue)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="shrink-0 px-2.5 pt-2 pb-2">
            <TabsList
              aria-label="Database sections"
              className="scrollbar-thin h-8 w-full justify-start gap-0.5 overflow-x-auto rounded-lg p-0.5"
            >
              <TabsTrigger value="overview" className="h-7 rounded-md px-2.5 text-[11px]">
                Overview
              </TabsTrigger>
              <TabsTrigger value="kv" className="h-7 rounded-md px-2.5 text-[11px]">
                KV
              </TabsTrigger>
              <TabsTrigger value="files" className="h-7 rounded-md px-2.5 text-[11px]">
                Files
              </TabsTrigger>
              <TabsTrigger value="schema" className="h-7 rounded-md px-2.5 text-[11px]">
                Schema
              </TabsTrigger>
              <TabsTrigger value="search" className="h-7 rounded-md px-2.5 text-[11px]">
                Search
              </TabsTrigger>
              <TabsTrigger value="activity" className="h-7 rounded-md px-2.5 text-[11px]">
                Activity
              </TabsTrigger>
            </TabsList>
          </div>

          {error && (
            <div
              role="alert"
              className="border-destructive/30 bg-destructive/5 text-destructive mx-2.5 mb-1 flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11px]"
            >
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 break-words">{error}</span>
              <button
                type="button"
                onClick={refresh}
                className="hover:text-destructive/80 shrink-0 font-medium underline underline-offset-2"
              >
                Retry
              </button>
            </div>
          )}

          <TabsContent value="overview" className="scrollbar-thin mt-0 min-h-0 flex-1 overflow-y-auto">
            <OverviewTab
              overview={overview}
              title={title}
              conversationId={conversationId}
              onRetry={() => void refreshOverview(conversationId)}
              busy={overviewBusy}
            />
          </TabsContent>

          <TabsContent value="kv" className="scrollbar-thin mt-0 min-h-0 flex-1 overflow-y-auto">
            <KvTab
              onEdit={(entry) => openKvEditor({ mode: "edit", entry })}
              onNew={() => openKvEditor({ mode: "new" })}
              onConfirmDelete={(name) => setConfirmState({ kind: "kv", name })}
            />
          </TabsContent>

          <TabsContent value="files" className="scrollbar-thin mt-0 min-h-0 flex-1 overflow-y-auto">
            <FilesTab
              conversationId={conversationId}
              query={filesQuery}
              onQueryChange={setFilesQuery}
              onUpload={setUpload}
              onConfirmDelete={(path) => setConfirmState({ kind: "file", path })}
            />
          </TabsContent>

          <TabsContent value="schema" className="scrollbar-thin mt-0 min-h-0 flex-1 overflow-y-auto">
            <SchemaTab
              onEdit={(entity) => openSchemaEditor({ mode: "edit", entity })}
              onNew={() => openSchemaEditor({ mode: "new" })}
              onConfirmDelete={(name) => setConfirmState({ kind: "entity", name })}
            />
          </TabsContent>

          <TabsContent value="search" className="scrollbar-thin mt-0 min-h-0 flex-1 overflow-y-auto">
            <SearchTab
              query={searchQuery}
              onQueryChange={setSearchQuery}
              onOpenKv={(q) => {
                setKvQuery(q);
                setTab("kv");
              }}
              onOpenFiles={(q) => {
                setFilesQuery(q);
                setTab("files");
              }}
              onOpenSchema={() => setTab("schema")}
            />
          </TabsContent>

          <TabsContent value="activity" className="scrollbar-thin mt-0 min-h-0 flex-1 overflow-y-auto">
            <ActivityTab />
          </TabsContent>
        </Tabs>
      )}

      {/* Dialogs (panel-level — one shared confirm + the editors) */}
      {kvEditor && (
        <KvEditorDialog
          conversationId={conversationId ?? ""}
          mode={kvEditor.mode}
          entry={kvEditor.mode === "edit" ? kvEditor.entry : undefined}
          onClose={closeKvEditor}
        />
      )}
      {schemaEditor && (
        <SchemaEditorDialog
          conversationId={conversationId ?? ""}
          entity={schemaEditor.mode === "edit" ? schemaEditor.entity : undefined}
          onClose={closeSchemaEditor}
        />
      )}
      {upload && conversationId && (
        <UploadFileDialog conversationId={conversationId} file={upload.file} dataUrl={upload.dataUrl} onClose={() => setUpload(null)} />
      )}
      {confirmState && confirmMeta && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open && !confirmBusy) setConfirmState(null);
          }}
          title={confirmMeta.title}
          description={confirmMeta.description}
          confirmLabel={confirmMeta.label}
          destructive
          loading={confirmBusy}
          onConfirm={() => void runConfirm()}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Reachability dot                                                     */
/* ------------------------------------------------------------------ */

function ReachDot({ overview }: { overview: CodeDatabaseOverview | null }) {
  const reachable = overview?.onyxbase.reachable ?? null;
  const label =
    reachable === null
      ? "OnyxBase status unknown"
      : reachable
        ? `OnyxBase connected${overview?.onyxbase.account ? ` · ${overview.onyxbase.account}` : ""}`
        : `OnyxBase unreachable${overview?.onyxbase.error ? ` — ${overview.onyxbase.error}` : ""}`;
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={cn(
        "h-2 w-2 shrink-0 rounded-full",
        reachable === true && "bg-emerald-500",
        reachable === false && "bg-destructive animate-pulse",
        reachable === null && "bg-muted-foreground/40",
      )}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Overview tab (§7 — real aggregates only, "—" while loading)           */
/* ------------------------------------------------------------------ */

function OverviewTab({
  overview,
  title,
  conversationId,
  onRetry,
  busy,
}: {
  overview: CodeDatabaseOverview | null;
  title: string | null;
  conversationId: string;
  onRetry: () => void;
  busy: boolean;
}) {
  if (!overview) {
    return (
      <div className="space-y-2.5 p-2.5">
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          The overview could not be loaded{busy ? " — still trying…" : ""}.
        </p>
        <Button size="sm" variant="outline" onClick={onRetry} disabled={busy} className="gap-1.5">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
          Retry overview
        </Button>
      </div>
    );
  }

  const { kv, storage, schema, activity, onyxbase, lastUpdate, legacyRecords } = overview;

  return (
    <div className="space-y-2.5 p-2.5">
      <div className="border-border/60 divide-y divide-border/50 overflow-hidden rounded-xl border">
        <OverviewRow label="Project">
          <span className="truncate font-medium">{title || "Untitled app"}</span>
        </OverviewRow>
        <OverviewRow label="OnyxBase">
          {onyxbase.reachable ? (
            <span className="flex min-w-0 items-center justify-end gap-1.5">
              <span className="bg-emerald-500 h-1.5 w-1.5 shrink-0 rounded-full" aria-hidden />
              <span className="truncate">
                Connected{onyxbase.account ? ` · ${onyxbase.account}` : ""}
              </span>
            </span>
          ) : (
            <span className="text-destructive truncate" title={onyxbase.error}>
              Unreachable{onyxbase.error ? ` — ${onyxbase.error}` : ""}
            </span>
          )}
        </OverviewRow>
        <OverviewRow label="Records">
          <span className="tabular-nums">{kv.count.toLocaleString()}</span>
        </OverviewRow>
        <OverviewRow label="Files">
          <span className="tabular-nums">
            {storage.files.toLocaleString()}
            {storage.files > 0 ? (
              <span className="text-muted-foreground"> · {formatBytes(storage.totalBytes)}</span>
            ) : null}
          </span>
        </OverviewRow>
        <OverviewRow label="Schema entities">
          <span className="tabular-nums">{schema.entityCount.toLocaleString()}</span>
        </OverviewRow>
        <OverviewRow label="Storage usage">
          <span className="tabular-nums">{formatBytes(storage.totalBytes)}</span>
        </OverviewRow>
        <OverviewRow label="Last update">
          <span title={lastUpdate ? absoluteTime(lastUpdate) : undefined}>{formatWhen(lastUpdate)}</span>
        </OverviewRow>
      </div>

      {kv.keyPatterns.length > 0 && (
        <div className="px-0.5">
          <p className="text-muted-foreground mb-1.5 text-[10px] font-medium tracking-wide uppercase">
            Key patterns
          </p>
          <div className="flex flex-wrap gap-1">
            {kv.keyPatterns.map((p) => (
              <span
                key={p.pattern}
                className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]"
              >
                {p.pattern} ×{p.count}
              </span>
            ))}
          </div>
        </div>
      )}

      {schema.entities.length > 0 && (
        <div className="px-0.5">
          <p className="text-muted-foreground mb-1.5 text-[10px] font-medium tracking-wide uppercase">
            Entities
          </p>
          <div className="flex flex-wrap gap-1">
            {schema.entities.slice(0, 8).map((e) => (
              <span key={e.name} className="bg-primary/10 text-primary rounded px-1.5 py-0.5 font-mono text-[10px]">
                {e.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {activity.latest && (
        <p className="text-muted-foreground px-0.5 text-[10px] leading-relaxed">
          Last op: <span className="font-mono">{activity.latest.op}</span> ·{" "}
          <span className="font-mono">{activity.latest.target}</span> · {formatWhen(activity.latest.ts)}
        </p>
      )}

      {legacyRecords != null && legacyRecords > 0 && (
        <p className="border-border/60 text-muted-foreground rounded-lg border border-dashed px-2.5 py-2 text-[10px] leading-relaxed">
          {legacyRecords} legacy global workspace record(s) detected — they are adopted into this
          chat automatically on the next KV refresh.
        </p>
      )}

      <p className="text-muted-foreground/70 px-0.5 text-[10px]">
        Scope <code className="font-mono">{conversationId.slice(0, 12)}…</code> · one chat = one
        isolated OnyxBase namespace.
      </p>
    </div>
  );
}

function OverviewRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-2.5 py-2">
      <span className="text-muted-foreground shrink-0 text-[11px] font-medium">{label}</span>
      <span className="text-foreground/90 min-w-0 flex-1 truncate text-right text-xs">{children}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* KV tab (§9 — searchable list + editor dialog with typed values)      */
/* ------------------------------------------------------------------ */

function KvTab({
  onEdit,
  onNew,
  onConfirmDelete,
}: {
  onEdit: (entry: CodeKvEntry) => void;
  onNew: () => void;
  onConfirmDelete: (name: string) => void;
}) {
  const entries = useCodeDatabaseStore((s) => s.kv.entries);
  const query = useCodeDatabaseStore((s) => s.kv.query);
  const setKvQuery = useCodeDatabaseStore((s) => s.setKvQuery);
  const busy = useCodeDatabaseStore((s) => s.sectionBusy.kv);
  const activity = useCodeDatabaseStore((s) => s.activity);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) => e.name.toLowerCase().includes(q) || e.value.toLowerCase().includes(q),
    );
  }, [entries, query]);

  return (
    <div className="space-y-2.5 p-2.5">
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2" aria-hidden />
          <Input
            type="search"
            value={query}
            onChange={(e) => setKvQuery(e.target.value)}
            placeholder="Filter records…"
            aria-label="Filter KV records"
            className="h-8 pr-2.5 pl-8 text-xs"
          />
        </div>
        <Button size="sm" onClick={onNew} className="h-8 gap-1.5 px-2.5 text-[11px]">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          New
        </Button>
      </div>

      {busy && entries.length === 0 ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Braces className="h-5 w-5" aria-hidden />}
          title={query ? "No matches" : "No records yet"}
          body={
            query
              ? "Try a different filter — the search covers names and values."
              : "Ask OnyxCode to store app data (it uses the kv_set tool), or create the first record yourself."
          }
          action={
            !query ? (
              <Button size="sm" variant="outline" onClick={onNew}>
                New record
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="border-border/60 divide-y divide-border/50 overflow-hidden rounded-xl border">
          {filtered.map((entry) => (
            <KvRow
              key={entry.key}
              entry={entry}
              touchedAt={lastKvTouchAt(entry.name, activity)}
              onEdit={() => onEdit(entry)}
              onConfirmDelete={() => onConfirmDelete(entry.name)}
            />
          ))}
        </div>
      )}

      <p className="text-muted-foreground text-center text-[10px]">
        {filtered.length} record{filtered.length === 1 ? "" : "s"}
        {query && filtered.length !== entries.length ? ` · ${entries.length} total` : ""} · shared
        with the agent&apos;s kv_* tools
      </p>
    </div>
  );
}

function KvRow({
  entry,
  touchedAt,
  onEdit,
  onConfirmDelete,
}: {
  entry: CodeKvEntry;
  touchedAt: string | null;
  onEdit: () => void;
  onConfirmDelete: () => void;
}) {
  const preview = entry.value.replace(/\s+/g, " ").slice(0, 100);
  return (
    <div className="hover:bg-foreground/[0.03] flex items-start gap-1 px-2.5 py-2 transition-colors">
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left" title={`Edit ${entry.name}`}>
        <span className="block truncate font-mono text-xs font-medium">{entry.name}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <KvTypeBadge type={kvTypeOf(entry)} />
          <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
            {entry.size.toLocaleString()} ch
          </span>
          <span
            className="text-muted-foreground text-[10px]"
            title={touchedAt ? absoluteTime(touchedAt) : "Unknown — outside the last 50 activity events"}
          >
            {formatWhen(touchedAt)}
          </span>
        </span>
        <span className="text-muted-foreground/80 mt-1 block truncate font-mono text-[10px]">
          {preview || "\u00A0"}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground h-7 w-7 shrink-0"
            aria-label={`Actions for ${entry.name}`}
          >
            <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={onEdit} className="gap-2 text-xs">
            <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void copyText(entry.name, "Key")} className="gap-2 text-xs">
            <Copy className="h-3.5 w-3.5" aria-hidden /> Copy key
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void copyText(entry.value, "Value")} className="gap-2 text-xs">
            <Copy className="h-3.5 w-3.5" aria-hidden /> Copy value
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onConfirmDelete} className="text-destructive focus:text-destructive gap-2 text-xs">
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* KV editor dialog (§9)                                                */
/* ------------------------------------------------------------------ */

function KvEditorDialog({
  conversationId,
  mode,
  entry,
  onClose,
}: {
  conversationId: string;
  mode: "new" | "edit";
  entry?: CodeKvEntry;
  onClose: () => void;
}) {
  const upsertKvLocal = useCodeDatabaseStore((s) => s.upsertKvLocal);
  const appendActivityLocal = useCodeDatabaseStore((s) => s.appendActivityLocal);

  const [name, setName] = useState(entry?.name ?? "");
  const [draft, setDraft] = useState<{ type: KvValueType; text: string }>(() =>
    entry ? entryToDraft(entry) : { type: "json-object", text: "{\n  \n}" },
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const validation = validateDraft(draft);
  const isNull = draft.type === "null";

  const pretty = () => {
    try {
      setDraft((d) => ({ ...d, text: JSON.stringify(JSON.parse(d.text), null, 2) }));
    } catch {
      /* leave as-is — the live validation error already explains it */
    }
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setSaveError("Key is required.");
      return;
    }
    if (validation) {
      setSaveError(validation);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const resolved = await resolveCodeDbClient();
      if ("kind" in resolved) throw new Error(codeDbFailureMessage(resolved));
      const saved = await kvSet(conversationId, trimmed, serializeDraft(draft), {
        client: resolved,
        actor: "user",
      });
      // §32 — confirmed write: update ONE entry locally, mirror the activity
      // event the library just appended server-side. No refetch.
      upsertKvLocal(conversationId, saved);
      appendActivityLocal(
        conversationId,
        activityEvent("user", "kv_set", saved.name, true, `${saved.size} chars`),
      );
      toast.success(`Saved "${saved.name}"`);
      onClose();
    } catch (err) {
      // §28 — a REAL OnyxBase failure is never reported as success.
      setSaveError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === "new" ? "New record" : `Edit "${entry?.name}"`}</DialogTitle>
          <DialogDescription>
            Stored in OnyxBase under{" "}
            <code className="font-mono text-[11px]">code:db:{conversationId.slice(0, 8)}…:{name.trim() || "…"}</code>{" "}
            — the same records the agent&apos;s kv_* tools read and write.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="code-db-kv-key" className="mb-1 block text-xs">
              Key
            </Label>
            <Input
              id="code-db-kv-key"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. app-config or users/42"
              disabled={mode === "edit"}
              className="h-8 font-mono text-xs"
              autoComplete="off"
            />
            {mode === "edit" && (
              <p className="text-muted-foreground mt-1 text-[10px]">
                Renaming is not supported — delete and recreate the record instead.
              </p>
            )}
          </div>

          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Label className="text-muted-foreground mb-1 block text-[10px] font-medium tracking-wide uppercase">
                Type
              </Label>
              <Select
                value={draft.type}
                onValueChange={(v) => setDraft((d) => ({ ...d, type: v as KvValueType }))}
              >
                <SelectTrigger className="h-8 text-xs" aria-label="Value type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KV_TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value} className="text-xs">
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-1 pb-px">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground h-8 gap-1 px-2 text-[11px]"
                onClick={() => void copyText(name.trim(), "Key")}
                disabled={!name.trim()}
              >
                <Copy className="h-3 w-3" aria-hidden /> Key
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground h-8 gap-1 px-2 text-[11px]"
                onClick={() => void copyText(serializeDraft(draft), "Value")}
                disabled={!!validation}
              >
                <Copy className="h-3 w-3" aria-hidden /> Value
              </Button>
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <Label htmlFor="code-db-kv-value" className="text-xs">
                Value
              </Label>
              {(draft.type === "json-object" || draft.type === "json-array") && (
                <button
                  type="button"
                  onClick={pretty}
                  className="text-primary text-[11px] font-medium hover:underline"
                >
                  Format JSON
                </button>
              )}
            </div>
            {isNull ? (
              <div className="bg-muted/50 text-muted-foreground flex min-h-16 items-center justify-center rounded-md border border-dashed px-3 py-4 text-xs">
                The value will be stored as JSON <code className="font-mono">null</code>.
              </div>
            ) : (
              <Textarea
                id="code-db-kv-value"
                value={draft.text}
                onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
                className="scrollbar-thin min-h-[180px] font-mono text-xs"
                spellCheck={false}
                aria-invalid={!!validation}
              />
            )}
            {validation && (
              <p className="text-destructive mt-1.5 text-[11px] leading-relaxed" role="alert">
                {validation}
              </p>
            )}
          </div>

          {saveError && (
            <p className="text-destructive text-xs leading-relaxed" role="alert">
              {saveError}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={saving || !!validation}
            className="gap-1.5"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Files tab (§10 — persistent OnyxBase app storage, NOT workspace)     */
/* ------------------------------------------------------------------ */

function FilesTab({
  conversationId,
  query,
  onQueryChange,
  onUpload,
  onConfirmDelete,
}: {
  conversationId: string;
  query: string;
  onQueryChange: (q: string) => void;
  onUpload: (state: NonNullable<UploadState>) => void;
  onConfirmDelete: (path: string) => void;
}) {
  const files = useCodeDatabaseStore((s) => s.storage.files);
  const busy = useCodeDatabaseStore((s) => s.sectionBusy.storage);
  const [downloading, setDownloading] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.path.toLowerCase().includes(q) || f.mime.toLowerCase().includes(q));
  }, [files, query]);

  const download = async (file: CodeStorageMetadata) => {
    setDownloading(file.path);
    try {
      const resolved = await resolveCodeDbClient();
      if ("kind" in resolved) throw new Error(codeDbFailureMessage(resolved));
      const result = await storageRead(conversationId, file.path, { client: resolved });
      if (!result) throw new Error(`No file stored at "${file.path}" anymore.`);
      // Reconstruct the payload and hand it to the browser as a download.
      const url =
        result.encoding === "base64"
          ? `data:${result.metadata.mime};base64,${result.base64 ?? ""}`
          : URL.createObjectURL(new Blob([result.text ?? ""], { type: result.metadata.mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = file.path.split("/").pop() || file.path;
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (result.encoding === "utf8") URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setDownloading(null);
    }
  };

  const pickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow picking the same file again
    if (!file) return;
    if (Math.ceil((file.size * 4) / 3) > CODE_STORAGE_MAX_PAYLOAD_CHARS) {
      toast.error(`"${file.name}" is too large — OnyxBase storage caps files at ~8.6 MB.`);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => toast.error(`Could not read "${file.name}".`);
    reader.onload = () => onUpload({ file, dataUrl: String(reader.result) });
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-2.5 p-2.5">
      <p className="border-border/60 text-muted-foreground rounded-lg border border-dashed px-2.5 py-2 text-[10px] leading-relaxed">
        <span className="text-foreground font-medium">Application storage</span> — persistent files
        in your OnyxBase cloud for this app (survives sandbox resets).
        <br />
        <span className="text-foreground font-medium">Workspace files</span> — build sources in the
        E2B sandbox (temporary — a separate panel).
      </p>

      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2" aria-hidden />
          <Input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Filter paths…"
            aria-label="Filter stored files"
            className="h-8 pr-2.5 pl-8 text-xs"
          />
        </div>
        <input
          ref={fileInputRef}
          type="file"
          onChange={pickFile}
          className="hidden"
          aria-hidden
          tabIndex={-1}
        />
        <Button
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          className="h-8 gap-1.5 px-2.5 text-[11px]"
        >
          <Upload className="h-3.5 w-3.5" aria-hidden />
          Upload
        </Button>
      </div>

      {busy && files.length === 0 ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-5 w-5" aria-hidden />}
          title={query ? "No matches" : "No stored files yet"}
          body={
            query
              ? "Try a different filter — the search covers paths and mime types."
              : "Ask OnyxCode to store app assets (storage_write), or upload one — for binary assets that must persist."
          }
          action={
            !query ? (
              <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
                Upload a file
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="border-border/60 divide-y divide-border/50 overflow-hidden rounded-xl border">
          {filtered.map((file) => (
            <div key={file.path} className="hover:bg-foreground/[0.03] flex items-center gap-2.5 px-2.5 py-2 transition-colors">
              <LazyThumbnail conversationId={conversationId} file={file} />
              <div className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs font-medium" title={file.path}>
                  {file.path}
                </span>
                <span className="text-muted-foreground mt-0.5 block truncate text-[10px]">
                  {file.mime} · {formatBytes(file.size)}
                  {file.chunks > 1 ? ` · ${file.chunks} chunks` : ""} ·{" "}
                  <span title={absoluteTime(file.updatedAt)}>{formatWhen(file.updatedAt)}</span>
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-foreground h-7 w-7"
                  onClick={() => void download(file)}
                  disabled={downloading === file.path}
                  title={`Download ${file.path}`}
                  aria-label={`Download ${file.path}`}
                >
                  {downloading === file.path ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Download className="h-3.5 w-3.5" aria-hidden />
                  )}
                </Button>
                <FileMetadataPopover conversationId={conversationId} file={file} />
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive h-7 w-7"
                  onClick={() => onConfirmDelete(file.path)}
                  title={`Delete ${file.path}`}
                  aria-label={`Delete ${file.path}`}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-muted-foreground text-center text-[10px]">
        {filtered.length} file{filtered.length === 1 ? "" : "s"} · chunked OnyxBase records ·
        shared with the agent&apos;s storage_* tools
      </p>
    </div>
  );
}

/** §111 lazy thumbnail — fetched via storageRead only when the row scrolls
 *  into view, cached per path in the store, never blocking the list. */
function LazyThumbnail({
  conversationId,
  file,
}: {
  conversationId: string;
  file: CodeStorageMetadata;
}) {
  const thumbnail = useCodeDatabaseStore((s) => s.thumbnails[file.path]);
  const failed = useCodeDatabaseStore((s) => !!s.thumbnailFailed[file.path]);
  const ensureThumbnail = useCodeDatabaseStore((s) => s.ensureThumbnail);
  const holderRef = useRef<HTMLSpanElement | null>(null);

  const isImage = file.mime.startsWith("image/");
  const eligible = isImage && file.size <= THUMBNAIL_MAX_BYTES;
  const fresh = thumbnail?.updatedAt === file.updatedAt ? thumbnail : null;

  useEffect(() => {
    if (!eligible || fresh || failed) return;
    const el = holderRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) {
          ensureThumbnail(conversationId, file.path);
          io.disconnect();
        }
      },
      { rootMargin: "120px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [eligible, fresh, failed, conversationId, file.path, ensureThumbnail]);

  return (
    <span
      ref={holderRef}
      className="bg-muted text-muted-foreground flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/60"
      aria-hidden
    >
      {fresh ? (
        // eslint-disable-next-line @next/next/no-img-element -- data URL built from OnyxBase KV chunks; next/image cannot handle it
        <img
          src={fresh.dataUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      ) : isImage ? (
        <ImageIcon className="h-4 w-4" />
      ) : (
        <FileText className="h-4 w-4" />
      )}
    </span>
  );
}

/** Metadata popover — a FRESH storageMetadata read on open (real OnyxBase
 *  data, with its own loading + honest error state). */
function FileMetadataPopover({
  conversationId,
  file,
}: {
  conversationId: string;
  file: CodeStorageMetadata;
}) {
  const [open, setOpen] = useState(false);
  const [meta, setMeta] = useState<CodeStorageMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const resolved = await resolveCodeDbClient();
        if ("kind" in resolved) throw new Error(codeDbFailureMessage(resolved));
        const fresh = await storageMetadata(conversationId, file.path, { client: resolved });
        if (cancelled) return;
        if (!fresh) throw new Error(`No file stored at "${file.path}" anymore.`);
        setMeta(fresh);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not read the metadata.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, conversationId, file.path]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground h-7 w-7"
          title={`Metadata for ${file.path}`}
          aria-label={`Metadata for ${file.path}`}
        >
          <Info className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3 text-xs">
        <p className="text-muted-foreground mb-2 text-[10px] font-medium tracking-wide uppercase">
          Storage metadata
        </p>
        {loading ? (
          <div className="flex items-center gap-2 py-2">
            <Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" aria-hidden />
            <span className="text-muted-foreground">Reading from OnyxBase…</span>
          </div>
        ) : error ? (
          <p className="text-destructive leading-relaxed">{error}</p>
        ) : meta ? (
          <dl className="space-y-1.5">
            <MetaRow label="Path" value={meta.path} mono />
            <MetaRow label="Mime" value={meta.mime} mono />
            <MetaRow label="Size" value={`${meta.size.toLocaleString()} B (${formatBytes(meta.size)})`} />
            <MetaRow label="Chunks" value={`${meta.chunks} × ${meta.chunkSize.toLocaleString()} chars`} />
            <MetaRow label="Encoding" value={meta.encoding} mono />
            <MetaRow label="Updated" value={`${formatWhen(meta.updatedAt)} (${absoluteTime(meta.updatedAt)})`} />
          </dl>
        ) : (
          <p className="text-muted-foreground py-2">No metadata.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted-foreground shrink-0">{label}</dt>
      <dd className={cn("min-w-0 flex-1 truncate text-right", mono && "font-mono")} title={value}>
        {value}
      </dd>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Upload dialog                                                        */
/* ------------------------------------------------------------------ */

function UploadFileDialog({
  conversationId,
  file,
  dataUrl,
  onClose,
}: {
  conversationId: string;
  file: File;
  dataUrl: string;
  onClose: () => void;
}) {
  const upsertFileLocal = useCodeDatabaseStore((s) => s.upsertFileLocal);
  const appendActivityLocal = useCodeDatabaseStore((s) => s.appendActivityLocal);
  const [path, setPath] = useState(() => file.name.replace(/^\/+/, "").replace(/\s+/g, "-"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mime = /^data:([^;,]+)[;,]/.exec(dataUrl)?.[1] ?? "unknown";

  const save = async () => {
    const p = path.trim();
    if (!p) {
      setError("A storage path is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const resolved = await resolveCodeDbClient();
      if ("kind" in resolved) throw new Error(codeDbFailureMessage(resolved));
      const metadata = await storageWrite(conversationId, p, { base64: dataUrl }, {
        client: resolved,
        actor: "user",
      });
      upsertFileLocal(conversationId, metadata);
      appendActivityLocal(
        conversationId,
        activityEvent(
          "user",
          "storage_write",
          metadata.path,
          true,
          `${metadata.chunks} chunk(s), ${metadata.size} B, ${metadata.mime}`,
        ),
      );
      toast.success(`Uploaded "${metadata.path}" (${formatBytes(metadata.size)})`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upload to application storage</DialogTitle>
          <DialogDescription>
            The file is written to this app&apos;s persistent OnyxBase storage (chunked KV records)
            — it survives sandbox resets and is visible to the agent&apos;s storage tools.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="bg-muted/50 rounded-lg px-3 py-2 text-[11px]">
            <p className="truncate font-medium">{file.name}</p>
            <p className="text-muted-foreground mt-0.5">
              {mime} · {formatBytes(file.size)}
            </p>
          </div>
          <div>
            <Label htmlFor="code-db-upload-path" className="mb-1 block text-xs">
              Storage path
            </Label>
            <Input
              id="code-db-upload-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="e.g. assets/logo.png"
              className="h-8 font-mono text-xs"
              autoComplete="off"
            />
            <p className="text-muted-foreground mt-1 text-[10px]">
              Stored under <code className="font-mono">code:storage:{conversationId.slice(0, 8)}…:{path.trim() || "…"}</code>
            </p>
          </div>
          {error && (
            <p className="text-destructive text-xs leading-relaxed" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving || !path.trim()} className="gap-1.5">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Upload className="h-3.5 w-3.5" aria-hidden />}
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Schema tab (§15 — application schema metadata, NOT native tables)    */
/* ------------------------------------------------------------------ */

function SchemaTab({
  onEdit,
  onNew,
  onConfirmDelete,
}: {
  onEdit: (entity: CodeSchemaEntity) => void;
  onNew: () => void;
  onConfirmDelete: (name: string) => void;
}) {
  const schema = useCodeDatabaseStore((s) => s.schema);
  const busy = useCodeDatabaseStore((s) => s.sectionBusy.schema);
  const entities = schema?.entities ?? [];

  return (
    <div className="space-y-2.5 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-muted-foreground min-w-0 flex-1 text-[10px] leading-relaxed">
          Application schema metadata — stored in OnyxBase (not native database tables).
        </p>
        <Button size="sm" onClick={onNew} className="h-8 shrink-0 gap-1.5 px-2.5 text-[11px]">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Entity
        </Button>
      </div>

      {busy && entities.length === 0 ? (
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ) : entities.length === 0 ? (
        <EmptyState
          icon={<Braces className="h-5 w-5" aria-hidden />}
          title="No schema yet"
          body="Ask OnyxCode to design your data model — the agent creates entities with its schema_upsert tool. Nothing is fabricated here; the tables below appear once entities exist."
          action={
            <Button size="sm" variant="outline" onClick={onNew}>
              Design an entity
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {entities.map((entity) => (
            <div key={entity.name} className="border-border/60 overflow-hidden rounded-xl border">
              <div className="bg-muted/40 flex items-center gap-2 px-2.5 py-2">
                <span className="min-w-0 flex-1 truncate text-xs font-semibold">{entity.name}</span>
                <span className="text-muted-foreground shrink-0 text-[10px]">
                  {entity.fields.length} field{entity.fields.length === 1 ? "" : "s"} ·{" "}
                  <span title={entity.updatedAt ? absoluteTime(entity.updatedAt) : undefined}>
                    {formatWhen(entity.updatedAt)}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-foreground h-6 w-6"
                  onClick={() => onEdit(entity)}
                  title={`Edit entity ${entity.name}`}
                  aria-label={`Edit entity ${entity.name}`}
                >
                  <Pencil className="h-3 w-3" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive h-6 w-6"
                  onClick={() => onConfirmDelete(entity.name)}
                  title={`Remove entity ${entity.name}`}
                  aria-label={`Remove entity ${entity.name}`}
                >
                  <Trash2 className="h-3 w-3" aria-hidden />
                </Button>
              </div>
              <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_auto_minmax(0,1.4fr)] gap-x-2 border-t border-border/40 px-2.5 py-1.5 text-[9px] font-semibold tracking-wide text-muted-foreground uppercase">
                <span>Field</span>
                <span>Type</span>
                <span className="w-6 text-center">Req</span>
                <span>Notes</span>
              </div>
              {entity.fields.map((f) => (
                <div
                  key={f.name}
                  className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_auto_minmax(0,1.4fr)] gap-x-2 border-t border-border/40 px-2.5 py-1.5 text-[11px]"
                >
                  <span className="truncate font-mono" title={f.name}>
                    {f.name}
                  </span>
                  <span className="text-muted-foreground truncate" title={f.type}>
                    {f.type}
                  </span>
                  <span className="w-6 text-center" title={f.required ? "Required" : "Optional"}>
                    {f.required ? "•" : "—"}
                  </span>
                  <span
                    className="text-muted-foreground truncate"
                    title={f.notes ?? undefined}
                  >
                    {f.notes || "—"}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Schema editor dialog (§15 — add/edit entity: name + field rows)      */
/* ------------------------------------------------------------------ */

interface FieldDraft {
  name: string;
  type: string;
  required: boolean;
  notes: string;
}

function SchemaEditorDialog({
  conversationId,
  entity,
  onClose,
}: {
  conversationId: string;
  entity?: CodeSchemaEntity;
  onClose: () => void;
}) {
  const setSchemaLocal = useCodeDatabaseStore((s) => s.setSchemaLocal);
  const appendActivityLocal = useCodeDatabaseStore((s) => s.appendActivityLocal);
  const [name, setName] = useState(entity?.name ?? "");
  const [fields, setFields] = useState<FieldDraft[]>(() =>
    entity
      ? entity.fields.map((f) => ({
          name: f.name,
          type: f.type,
          required: f.required === true,
          notes: f.notes ?? "",
        }))
      : [{ name: "", type: "string", required: false, notes: "" }],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateField = (index: number, patch: Partial<FieldDraft>) => {
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  };

  const validFields = fields.filter((f) => f.name.trim().length > 0);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Entity name is required.");
      return;
    }
    if (validFields.length === 0) {
      setError("Add at least one field with a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const resolved = await resolveCodeDbClient();
      if ("kind" in resolved) throw new Error(codeDbFailureMessage(resolved));
      const schema = await schemaUpsert(
        conversationId,
        {
          name: trimmed,
          fields: validFields.map((f) => ({
            name: f.name.trim(),
            type: f.type.trim() || "string",
            ...(f.required ? { required: true } : {}),
            ...(f.notes.trim() ? { notes: f.notes.trim() } : {}),
          })),
        },
        { client: resolved, actor: "user" },
      );
      // §32 — schemaUpsert returns the FULL updated schema: one local set.
      setSchemaLocal(conversationId, schema);
      appendActivityLocal(
        conversationId,
        activityEvent("user", "schema_upsert", trimmed, true, `${validFields.length} field(s)`),
      );
      toast.success(`Saved entity "${trimmed}"`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the entity.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{entity ? `Edit entity "${entity.name}"` : "New schema entity"}</DialogTitle>
          <DialogDescription>
            Application-level schema metadata stored in OnyxBase — it describes your app&apos;s
            data model for you and the agent (not native database tables).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="code-db-entity-name" className="mb-1 block text-xs">
              Entity name
            </Label>
            <Input
              id="code-db-entity-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. users or orders"
              className="h-8 font-mono text-xs"
              autoComplete="off"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
              Fields
            </Label>
            {fields.map((f, i) => (
              <div key={i} className="space-y-1.5 rounded-lg border border-border/60 p-2">
                <div className="flex gap-1.5">
                  <Input
                    value={f.name}
                    onChange={(e) => updateField(i, { name: e.target.value })}
                    placeholder={`field ${i + 1} name`}
                    aria-label={`Field ${i + 1} name`}
                    className="h-8 min-w-0 flex-1 font-mono text-xs"
                  />
                  <Input
                    value={f.type}
                    onChange={(e) => updateField(i, { type: e.target.value })}
                    placeholder="type"
                    aria-label={`Field ${i + 1} type`}
                    className="h-8 w-24 shrink-0 text-xs"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive h-8 w-8 shrink-0"
                    onClick={() => setFields((prev) => prev.filter((_, j) => j !== i))}
                    disabled={fields.length === 1}
                    aria-label={`Remove field ${f.name || i + 1}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </div>
                <div className="flex items-center gap-1.5">
                  <Input
                    value={f.notes}
                    onChange={(e) => updateField(i, { notes: e.target.value })}
                    placeholder="notes (optional)"
                    aria-label={`Field ${i + 1} notes`}
                    className="h-8 min-w-0 flex-1 text-xs"
                  />
                  <label className="text-muted-foreground flex h-8 shrink-0 cursor-pointer items-center gap-1.5 text-[11px]">
                    <Checkbox
                      checked={f.required}
                      onCheckedChange={(v) => updateField(i, { required: v === true })}
                      aria-label={`Field ${i + 1} required`}
                    />
                    Required
                  </label>
                </div>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setFields((prev) => [...prev, { name: "", type: "string", required: false, notes: "" }])
              }
              className="h-8 gap-1.5 text-[11px]"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Add field
            </Button>
          </div>

          {error && (
            <p className="text-destructive text-xs leading-relaxed" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            Save entity
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Search tab — one input, client-side over the fetched state           */
/* ------------------------------------------------------------------ */

function SearchTab({
  query,
  onQueryChange,
  onOpenKv,
  onOpenFiles,
  onOpenSchema,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  onOpenKv: (query: string) => void;
  onOpenFiles: (query: string) => void;
  onOpenSchema: () => void;
}) {
  const entries = useCodeDatabaseStore((s) => s.kv.entries);
  const files = useCodeDatabaseStore((s) => s.storage.files);
  const schema = useCodeDatabaseStore((s) => s.schema);

  const q = query.trim().toLowerCase();

  const kvMatches = useMemo(
    () =>
      q
        ? entries.filter(
            (e) => e.name.toLowerCase().includes(q) || e.value.toLowerCase().includes(q),
          )
        : [],
    [entries, q],
  );
  const fileMatches = useMemo(
    () =>
      q
        ? files.filter(
            (f) => f.path.toLowerCase().includes(q) || f.mime.toLowerCase().includes(q),
          )
        : [],
    [files, q],
  );
  const schemaMatches = useMemo(
    () =>
      q
        ? (schema?.entities ?? []).filter(
            (e) =>
              e.name.toLowerCase().includes(q) ||
              e.fields.some((f) =>
                [f.name, f.type, f.notes ?? ""].some((s) => s.toLowerCase().includes(q)),
              ),
          )
        : [],
    [schema, q],
  );

  const total = kvMatches.length + fileMatches.length + schemaMatches.length;

  return (
    <div className="space-y-2.5 p-2.5">
      <div className="relative">
        <Search className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2" aria-hidden />
        <Input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search records, files, schema…"
          aria-label="Search the loaded database state"
          className="h-8 pr-2.5 pl-8 text-xs"
        />
      </div>
      <p className="text-muted-foreground px-0.5 text-[10px] leading-relaxed">
        Client-side search over the data currently loaded in this panel (names, value previews,
        storage paths, schema entities and fields) — use Refresh to pick up the latest changes.
      </p>

      {!q ? null : total === 0 ? (
        <EmptyState
          icon={<Search className="h-5 w-5" aria-hidden />}
          title="No matches"
          body="Nothing in the loaded records, files or schema matches that search."
        />
      ) : (
        <div className="space-y-3">
          {kvMatches.length > 0 && (
            <SearchGroup title="Records" count={kvMatches.length}>
              {kvMatches.slice(0, 20).map((e) => (
                <button
                  key={e.key}
                  type="button"
                  onClick={() => onOpenKv(query.trim())}
                  className="hover:bg-foreground/[0.03] block w-full px-2.5 py-1.5 text-left transition-colors"
                >
                  <span className="block truncate font-mono text-xs font-medium">{e.name}</span>
                  <span className="text-muted-foreground mt-0.5 block truncate font-mono text-[10px]">
                    {e.value.replace(/\s+/g, " ").slice(0, 90)}
                  </span>
                </button>
              ))}
              {kvMatches.length > 20 && (
                <p className="text-muted-foreground px-2.5 py-1 text-[10px]">
                  + {kvMatches.length - 20} more — open the KV tab to see them all.
                </p>
              )}
            </SearchGroup>
          )}
          {fileMatches.length > 0 && (
            <SearchGroup title="Files" count={fileMatches.length}>
              {fileMatches.slice(0, 20).map((f) => (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => onOpenFiles(query.trim())}
                  className="hover:bg-foreground/[0.03] block w-full px-2.5 py-1.5 text-left transition-colors"
                >
                  <span className="block truncate font-mono text-xs font-medium">{f.path}</span>
                  <span className="text-muted-foreground mt-0.5 block truncate text-[10px]">
                    {f.mime} · {formatBytes(f.size)}
                  </span>
                </button>
              ))}
            </SearchGroup>
          )}
          {schemaMatches.length > 0 && (
            <SearchGroup title="Schema" count={schemaMatches.length}>
              {schemaMatches.map((e) => (
                <button
                  key={e.name}
                  type="button"
                  onClick={onOpenSchema}
                  className="hover:bg-foreground/[0.03] block w-full px-2.5 py-1.5 text-left transition-colors"
                >
                  <span className="block truncate text-xs font-medium">{e.name}</span>
                  <span className="text-muted-foreground mt-0.5 block truncate font-mono text-[10px]">
                    {e.fields.map((f) => f.name).slice(0, 8).join(", ")}
                  </span>
                </button>
              ))}
            </SearchGroup>
          )}
        </div>
      )}
    </div>
  );
}

function SearchGroup({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div className="border-border/60 overflow-hidden rounded-xl border">
      <p className="bg-muted/40 text-muted-foreground flex items-center justify-between px-2.5 py-1.5 text-[10px] font-semibold tracking-wide uppercase">
        <span>{title}</span>
        <span className="tabular-nums">{count}</span>
      </p>
      <div className="divide-y divide-border/40">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Activity tab (§28-style honesty — the last 50 REAL ops)              */
/* ------------------------------------------------------------------ */

function ActivityTab() {
  const activity = useCodeDatabaseStore((s) => s.activity);
  const busy = useCodeDatabaseStore((s) => s.sectionBusy.activity);
  // activityList is oldest→newest; show newest first.
  const events = useMemo(() => [...activity].reverse(), [activity]);

  return (
    <div className="space-y-2.5 p-2.5">
      <p className="text-muted-foreground px-0.5 text-[10px] leading-relaxed">
        The last {activity.length} operation{activity.length === 1 ? "" : "s"} on this app&apos;s
        database — real events appended by you and the agent (bounded to 50).
      </p>
      {busy && activity.length === 0 ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-8 w-full rounded-md" />
          ))}
        </div>
      ) : events.length === 0 ? (
        <EmptyState
          icon={<Database className="h-5 w-5" aria-hidden />}
          title="No activity yet"
          body="Every database write — yours from this panel and the agent's — is logged here with its real outcome."
        />
      ) : (
        <div className="border-border/60 divide-y divide-border/40 overflow-hidden rounded-xl border">
          {events.map((e, i) => (
            <div
              key={`${e.ts}-${i}`}
              className="flex items-start gap-2 px-2.5 py-1.5 text-[11px]"
              title={e.detail}
            >
              <span
                className="text-muted-foreground w-14 shrink-0"
                title={absoluteTime(e.ts)}
              >
                {formatWhen(e.ts)}
              </span>
              <ActorBadge actor={e.actor} />
              <span className={cn("shrink-0 font-mono font-medium", e.ok ? "text-foreground/85" : "text-destructive")}>
                {e.op}
              </span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono">
                {e.target}
              </span>
              {!e.ok && <span className="text-destructive shrink-0 font-medium">failed</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Empty state (matches the app's dashed-card pattern)                  */
/* ------------------------------------------------------------------ */

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-4 py-10 text-center">
      <span
        aria-hidden
        className="bg-muted text-muted-foreground mb-3 flex h-12 w-12 items-center justify-center rounded-full"
      >
        {icon}
      </span>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground mt-1 max-w-sm text-xs leading-relaxed">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
