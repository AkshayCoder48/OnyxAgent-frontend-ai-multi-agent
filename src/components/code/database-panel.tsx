"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Braces, Database, FileText, Loader2, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useSettings } from "@/hooks/use-data";
import { ROUTES } from "@/lib/constants";
import { cn } from "@/lib/utils";
import {
  codeDbKey,
  CodeDbRecord,
  listCodeDbRecords,
  makeRecord,
  resolveCodeDbClient,
  type CodeDbClient,
} from "@/lib/code/db-namespace";

/**
 * OnyxCode Database tab (OnyxCode PRD §4.3 + extension PRD §3.4) — a live
 * browser over the OnyxBase KV store for the current workspace. The agent
 * writes through the `manage_database` tool; this panel reads/writes the
 * EXACT same records (`code:db:*` keys in the "onyxagent" collection), so
 * data the agent stores appears here and edits here are visible to the
 * agent on its next tool call.
 *
 * Features: search, manual refresh + 10s polling while mounted, new
 * document creation, JSON view/edit dialog, delete.
 */

type PanelState =
  | { phase: "loading" }
  | { phase: "not_configured" }
  | { phase: "error"; message: string }
  | { phase: "ready"; records: CodeDbRecord[] };

export function DatabasePanel() {
  const router = useRouter();
  const { settings, loading: settingsLoading } = useSettings();
  const configured = !!settings?.onyxbase_api_key_present;

  const [state, setState] = useState<PanelState>({ phase: "loading" });
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [dialog, setDialog] = useState<
    | { mode: "new" }
    | { mode: "view"; record: CodeDbRecord }
    | null
  >(null);
  const clientRef = useRef<CodeDbClient | null>(null);
  const refreshSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    if (dialog) return; // never clobber an open editor with polled data
    const seq = ++refreshSeqRef.current;
    setRefreshing(true);
    try {
      const resolved = await resolveCodeDbClient();
      if (seq !== refreshSeqRef.current) return;
      if ("kind" in resolved) {
        setState(
          resolved.kind === "not_configured"
            ? { phase: "not_configured" }
            : { phase: "error", message: resolved.message },
        );
        clientRef.current = null;
        return;
      }
      clientRef.current = resolved;
      const records = await listCodeDbRecords(resolved);
      if (seq !== refreshSeqRef.current) return;
      setState({ phase: "ready", records });
    } catch (err) {
      if (seq !== refreshSeqRef.current) return;
      setState({
        phase: "error",
        message: err instanceof Error ? err.message : "Failed to load database records.",
      });
    } finally {
      if (seq === refreshSeqRef.current) setRefreshing(false);
    }
  }, [dialog]);

  // Initial load once settings resolve (key presence gates the whole panel).
  useEffect(() => {
    if (settingsLoading) return;
    if (!configured) {
      setState({ phase: "not_configured" });
      return;
    }
    void refresh();
  }, [settingsLoading, configured, refresh]);

  // Light polling while the tab is open (PRD: "real-time or refreshable").
  useEffect(() => {
    if (!configured || state.phase === "not_configured") return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 10_000);
    return () => window.clearInterval(id);
  }, [configured, refresh, state.phase]);

  const filtered = useMemo(() => {
    if (state.phase !== "ready") return [];
    const q = query.trim().toLowerCase();
    if (!q) return state.records;
    return state.records.filter(
      (r) => r.name.toLowerCase().includes(q) || r.value.toLowerCase().includes(q),
    );
  }, [state, query]);

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display flex items-center gap-2 text-xl font-semibold tracking-tight">
              <Database className="text-primary h-5 w-5" aria-hidden />
              Database
            </h1>
            <p className="text-muted-foreground mt-1 text-xs">
              OnyxBase KV · collection <code className="font-mono">onyxagent</code> · workspace{" "}
              <code className="font-mono">workspace_default</code> — shared with the agent&apos;s{" "}
              <code className="font-mono">manage_database</code> tool.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
              disabled={refreshing || !configured}
              className="gap-1.5"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} aria-hidden />
              Refresh
            </Button>
            <Button
              size="sm"
              onClick={() => setDialog({ mode: "new" })}
              disabled={!configured}
              className="gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              New document
            </Button>
          </div>
        </div>

        {/* Search */}
        <div className="relative mt-4">
          <Search className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search documents…"
            aria-label="Search documents"
            className="h-9 pl-9"
            disabled={state.phase !== "ready"}
          />
        </div>

        {/* Body */}
        <div className="mt-4">
          {state.phase === "loading" || settingsLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-14 w-full rounded-xl" />
              ))}
            </div>
          ) : state.phase === "not_configured" ? (
            <EmptyState
              icon={<Database className="h-5 w-5" aria-hidden />}
              title="OnyxBase is not connected"
              body="Add your OnyxBase API key in Settings → Cloud to give your apps (and the agent) a persistent cloud database."
              action={
                <Button size="sm" variant="outline" onClick={() => router.push(ROUTES.SETTINGS_CLOUD)}>
                  Open Settings → Cloud
                </Button>
              }
            />
          ) : state.phase === "error" ? (
            <EmptyState
              icon={<FileText className="h-5 w-5" aria-hidden />}
              title="Couldn't load the database"
              body={state.message}
              action={
                <Button size="sm" variant="outline" onClick={() => void refresh()}>
                  Try again
                </Button>
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<Database className="h-5 w-5" aria-hidden />}
              title={query ? "No matches" : "No data yet"}
              body={
                query
                  ? "Try a different search."
                  : "Ask the agent to store something (it uses the manage_database tool), or create your first document."
              }
              action={
                !query ? (
                  <Button size="sm" variant="outline" onClick={() => setDialog({ mode: "new" })}>
                    New document
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="border-border divide-y divide-border/60 overflow-hidden rounded-xl border">
              {filtered.map((record) => (
                <button
                  key={record.key}
                  type="button"
                  onClick={() => setDialog({ mode: "view", record })}
                  className="hover:bg-foreground/[0.03] flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors"
                >
                  <span
                    className={cn(
                      "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                      record.isJson ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                    )}
                    aria-hidden
                  >
                    {record.isJson ? <Braces className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{record.name}</span>
                    <span className="text-muted-foreground block truncate font-mono text-[11px]">
                      {record.value.slice(0, 120)}
                    </span>
                  </span>
                  <span className="text-muted-foreground hidden shrink-0 font-mono text-[10px] tabular-nums sm:block">
                    {record.size.toLocaleString()} ch
                  </span>
                  <Pencil className="text-muted-foreground/60 h-3.5 w-3.5 shrink-0" aria-hidden />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Record count */}
        {state.phase === "ready" && (
          <p className="text-muted-foreground mt-3 text-center text-[11px]">
            {filtered.length} document{filtered.length === 1 ? "" : "s"}
            {query && filtered.length !== state.records.length
              ? ` · ${state.records.length} total`
              : ""}
          </p>
        )}
      </div>

      {dialog?.mode === "new" && clientRef.current && (
        <RecordDialog
          mode="new"
          onClose={() => setDialog(null)}
          onSaved={async (name, value) => {
            await clientRef.current!.kv.set(codeDbKey(name), value);
            toast.success(`Document "${name}" saved`);
          }}
          onDone={() => {
            setDialog(null);
            void refresh();
          }}
        />
      )}
      {dialog?.mode === "view" && clientRef.current && (
        <RecordDialog
          mode="edit"
          record={dialog.record}
          onClose={() => setDialog(null)}
          onSaved={async (name, value) => {
            await clientRef.current!.kv.set(codeDbKey(name), value);
            toast.success(`Document "${name}" saved`);
          }}
          onDelete={async (name) => {
            await clientRef.current!.kv.delete(codeDbKey(name));
            toast.success(`Document "${name}" deleted`);
          }}
          onDone={() => {
            setDialog(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Record create/view/edit dialog                                       */
/* ------------------------------------------------------------------ */

function RecordDialog({
  mode,
  record,
  onClose,
  onSaved,
  onDelete,
  onDone,
}: {
  mode: "new" | "edit";
  record?: CodeDbRecord;
  onClose: () => void;
  onSaved: (name: string, value: string) => Promise<void>;
  onDelete?: (name: string) => Promise<void>;
  /** Always called after a successful save/delete (closes + refreshes). */
  onDone: () => void;
}) {
  const [name, setName] = useState(record?.name ?? "");
  const [value, setValue] = useState(
    record?.isJson ? JSON.stringify(record.parsed, null, 2) : (record?.value ?? "{\n  \n}"),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pretty = useCallback(() => {
    try {
      setValue(JSON.stringify(JSON.parse(value), null, 2));
      setError(null);
    } catch {
      setError("Value is not valid JSON — it will be stored as plain text.");
    }
  }, [value]);

  const save = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    if (mode === "edit" && trimmedName !== record?.name) {
      setError("Renaming is not supported yet — delete and recreate the document.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (/^[\s{[]/.test(value)) {
        // Validate JSON when it looks like JSON — but allow plain text saves.
        try {
          JSON.parse(value);
        } catch {
          // store as-is (plain text) — same rule the agent tool uses
        }
      }
      await onSaved(trimmedName, value);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!record) return;
    setSaving(true);
    try {
      await onDelete?.(record.name);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete.");
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === "new" ? "New document" : `Edit "${record?.name}"`}</DialogTitle>
          <DialogDescription>
            Stored in OnyxBase under{" "}
            <code className="font-mono text-[11px]">code:db:{name || "…"}</code> — shared with
            the agent&apos;s manage_database tool.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label htmlFor="code-db-name" className="text-foreground mb-1 block text-xs font-medium">
              Name
            </label>
            <Input
              id="code-db-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. app-config"
              disabled={mode === "edit"}
              className="h-9"
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label htmlFor="code-db-value" className="text-foreground block text-xs font-medium">
                Value (JSON or text)
              </label>
              <button
                type="button"
                onClick={pretty}
                className="text-primary text-[11px] font-medium hover:underline"
              >
                Format JSON
              </button>
            </div>
            <Textarea
              id="code-db-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="scrollbar-thin min-h-[200px] font-mono text-xs"
              spellCheck={false}
            />
          </div>
          {error && (
            <p className="text-destructive text-xs" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          {mode === "edit" && onDelete && (
            <Button
              variant="ghost"
              size="sm"
              onClick={remove}
              disabled={saving}
              className="text-destructive hover:text-destructive mr-auto gap-1.5"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
              Delete
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-14 text-center">
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

// Re-export for the tool-result card (single record rendering).
export { makeRecord };
