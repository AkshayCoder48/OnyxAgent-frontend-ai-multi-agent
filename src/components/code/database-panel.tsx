"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Database, Loader2, Pencil, PlusCircle, RefreshCw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { CodeRecordView } from "@/components/terra/types";

function relativeTime(at: number): string {
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function dataPreview(data: string, length = 90): string {
  const text = data.replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length)}…` : text || "{}";
}

interface EditorState {
  key: string;
  data: string;
  originalKey: string | null;
}

/**
 * OnyxCode Database tab — a workspace-scoped document/KV browser over the
 * same records the agent writes through the manage_database tool.
 */
export function DatabasePanel({ workspaceId }: { workspaceId: string }) {
  const [records, setRecords] = useState<CodeRecordView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(
    (silent = false) => {
      if (!workspaceId) return;
      if (!silent) setLoading(true);
      fetch(`/api/code/database?workspace=${encodeURIComponent(workspaceId)}`, { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
        .then((data: { records?: CodeRecordView[] }) => {
          setRecords(data.records ?? []);
          setError(null);
        })
        .catch(() => setError("Records could not be loaded."))
        .finally(() => setLoading(false));
    },
    [workspaceId],
  );

  useEffect(() => {
    setRecords([]);
    refresh();
  }, [refresh]);

  // Live refresh while the tab is visible (the agent may be writing).
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !editor) refresh(true);
    }, 8000);
    return () => clearInterval(timer);
  }, [refresh, editor]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return records;
    return records.filter(
      (record) => record.key.toLowerCase().includes(needle) || record.data.toLowerCase().includes(needle),
    );
  }, [records, search]);

  const openNew = () => setEditor({ key: "", data: "{\n  \n}" , originalKey: null });
  const openEdit = (record: CodeRecordView) =>
    setEditor({ key: record.key, data: record.data, originalKey: record.key });

  const save = async () => {
    if (!editor || saving) return;
    const key = editor.key.trim();
    if (!key) {
      toast.error("Give the record a key.");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(editor.data || "null");
    } catch {
      toast.error("The data must be valid JSON.");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/code/database", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, action: "set", key, data: parsed }),
      });
      const result = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) {
        toast.error(result.error ?? "Could not save the record.");
        return;
      }
      toast.success(`Saved “${key}”.`);
      setEditor(null);
      refresh(true);
    } catch {
      toast.error("Could not reach the database.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (key: string) => {
    try {
      const response = await fetch("/api/code/database", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, action: "delete", key }),
      });
      if (!response.ok) throw new Error("HTTP");
      toast(`Deleted “${key}”.`);
      setEditor(null);
      refresh(true);
    } catch {
      toast.error("Could not delete the record.");
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <label htmlFor="onyx-db-search" className="sr-only">
            Search records
          </label>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-muted"
            aria-hidden
          />
          <input
            id="onyx-db-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search keys and data…"
            autoComplete="off"
            className="h-9 w-full rounded-lg border border-hairline bg-background pr-3 pl-9 text-sm text-ink placeholder:text-ink-muted/70 transition-colors focus:border-terra/50 focus:ring-2 focus:ring-terra/25 focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() => refresh()}
          aria-label="Refresh records"
          title="Refresh"
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-hairline bg-background text-ink-muted transition-colors hover:bg-terra-soft hover:text-terra-deep"
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} aria-hidden />
        </button>
        <button
          type="button"
          onClick={openNew}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-terra px-3.5 text-[13px] font-semibold text-white shadow-[0_1px_3px_rgba(166,63,26,0.35)] transition-colors hover:bg-terra-deep"
        >
          <PlusCircle className="h-4 w-4" aria-hidden />
          New document
        </button>
      </div>

      {/* List */}
      <div className="overflow-hidden rounded-xl border border-hairline bg-paper">
        {loading && records.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-14 text-[13px] text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin text-terra" aria-hidden />
            Loading workspace data…
          </div>
        ) : error ? (
          <div className="py-14 text-center text-[13px] text-terra-deep">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-14 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full border border-terra-soft-border bg-terra-soft">
              <Database className="h-5 w-5 text-terra" aria-hidden />
            </span>
            <p className="max-w-sm text-[13px] leading-relaxed text-ink-muted">
              {search
                ? `No records match “${search.trim()}”.`
                : "No data yet. Ask OnyxCode to store something — “save the app config to the database” — or create a document."}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-hairline/60">
            {filtered.map((record) => (
              <li key={record.id}>
                <button
                  type="button"
                  onClick={() => openEdit(record)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-terra-soft/40"
                >
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-terra-soft-border bg-terra-soft"
                    aria-hidden
                  >
                    <Database className="h-3.5 w-3.5 text-terra" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate font-mono text-[13px] font-medium text-ink">
                        {record.key}
                      </span>
                      <span className="shrink-0 rounded-full bg-background px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted">
                        {record.kind}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-ink-muted">
                      {dataPreview(record.data)}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] text-ink-muted">
                    {relativeTime(record.updatedAt)}
                  </span>
                  <Pencil className="h-3.5 w-3.5 shrink-0 text-ink-muted/70" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-[11px] text-ink-muted">
        {records.length} record{records.length === 1 ? "" : "s"} in this workspace · the agent
        reads and writes the same data via the manage_database tool.
      </p>

      {/* Editor dialog */}
      <Dialog open={editor !== null} onOpenChange={(open) => !open && setEditor(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-serif">
              {editor?.originalKey ? "Edit record" : "New document"}
            </DialogTitle>
            <DialogDescription>
              Workspace records are JSON documents shared with the agent.
            </DialogDescription>
          </DialogHeader>
          {editor && (
            <div className="space-y-3">
              <div>
                <label htmlFor="onyx-db-key" className="mb-1 block text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">
                  Key
                </label>
                <input
                  id="onyx-db-key"
                  value={editor.key}
                  onChange={(event) => setEditor({ ...editor, key: event.target.value })}
                  placeholder="e.g. app-config"
                  className="h-9 w-full rounded-lg border border-hairline bg-background px-3 font-mono text-[13px] text-ink focus:border-terra/50 focus:ring-2 focus:ring-terra/25 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="onyx-db-data" className="mb-1 block text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">
                  Data (JSON)
                </label>
                <textarea
                  id="onyx-db-data"
                  value={editor.data}
                  onChange={(event) => setEditor({ ...editor, data: event.target.value })}
                  spellCheck={false}
                  className="terra-scroll min-h-[200px] w-full resize-y rounded-lg border border-hairline bg-background p-3 font-mono text-[12px] leading-relaxed text-ink focus:border-terra/50 focus:ring-2 focus:ring-terra/25 focus:outline-none"
                />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            {editor?.originalKey && (
              <button
                type="button"
                onClick={() => void remove(editor.originalKey as string)}
                className="mr-auto inline-flex h-9 items-center gap-1.5 rounded-lg border border-hairline px-3 text-[13px] font-medium text-ink-muted transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                Delete
              </button>
            )}
            <button
              type="button"
              onClick={() => setEditor(null)}
              className="inline-flex h-9 items-center rounded-lg px-3 text-[13px] font-medium text-ink-muted transition-colors hover:bg-paper"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-terra px-4 text-[13px] font-semibold text-white transition-colors hover:bg-terra-deep disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              Save
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
