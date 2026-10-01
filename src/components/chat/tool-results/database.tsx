"use client";

import type { ReactNode } from "react";
import { Database } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useCodePanelStore } from "@/stores/code-panel-store";
import { cn } from "@/lib/utils";
import type { CodeDatabaseOverview } from "@/lib/code/db-namespace";

/**
 * Rich card for the OnyxCode database/storage tools (OnyxBase PRD §12–§15,
 * §28). Task C's tools return `{ kind: "database", ok, op, … }` payloads —
 * this renders a COMPACT, honest result per op: the tool op title with its
 * target, a real result summary (value preview, counts, entity table), and
 * error styling with op + target + the REAL OnyxBase reason for failures.
 * Success is only ever shown from a real backend-confirmed payload.
 */

/** The union of `kind: "database"` tool result payloads (code_database.ts). */
export interface DatabasePayload {
  kind: "database";
  ok: boolean;
  op:
    | "inspect"
    | "kv_get"
    | "kv_set"
    | "kv_delete"
    | "kv_list"
    | "storage_list"
    | "storage_read"
    | "storage_write"
    | "storage_delete"
    | "storage_metadata"
    | "schema_upsert";
  error?: string;

  // KV
  key?: string;
  isJson?: boolean;
  size?: number;
  value?: unknown;
  text?: string;
  truncated?: boolean;
  fullSize?: number;
  fullChars?: number;
  note?: string;
  count?: number;
  prefix?: string;
  search?: string;
  migrated?: number;
  records?: Array<{ key: string; isJson?: boolean; size?: number; preview?: string }>;

  // Storage
  path?: string;
  mime?: string;
  chunks?: number;
  chunkSize?: number;
  encoding?: string;
  updatedAt?: string;
  deleted?: boolean;
  chunksRemoved?: number;
  isImage?: boolean;
  base64?: string;
  base64Preview?: string;
  files?: Array<{ path: string; mime?: string; size?: number; chunks?: number; updatedAt?: string }>;

  // Schema
  entity?: string;
  fieldCount?: number;
  entities?: string[];
  label?: string;

  // inspect
  namespace?: string;
  overview?: CodeDatabaseOverview;
  hint?: string;
}

export function parseDatabaseResult(result: unknown): DatabasePayload | null {
  try {
    const p = typeof result === "string" ? JSON.parse(result) : result;
    if (p && typeof p === "object" && (p as { kind?: string }).kind === "database") {
      return p as DatabasePayload;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function opTitle(op: DatabasePayload["op"]): string {
  switch (op) {
    case "inspect":
      return "Inspect database";
    case "kv_get":
      return "KV Get";
    case "kv_set":
      return "KV Set";
    case "kv_delete":
      return "KV Delete";
    case "kv_list":
      return "KV List";
    case "storage_list":
      return "Storage List";
    case "storage_read":
      return "Storage Read";
    case "storage_write":
      return "Storage Write";
    case "storage_delete":
      return "Storage Delete";
    case "storage_metadata":
      return "Storage Metadata";
    case "schema_upsert":
      return "Schema Upsert";
  }
}

function payloadTarget(data: DatabasePayload): string | null {
  if (data.key) return data.key;
  if (data.path) return data.path;
  if (data.entity) return data.entity;
  return null;
}

function formatBytes(n: number | undefined): string {
  if (!n || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Compact monospace value preview (KV get / storage read text). */
function ValuePreview({ text, max = 480 }: { text: string; max?: number }) {
  const clipped = text.length > max ? `${text.slice(0, max)}…` : text;
  return (
    <pre className="scrollbar-thin bg-muted/40 border-border/60 max-h-40 overflow-auto rounded-lg border p-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap">
      {clipped || "—"}
    </pre>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="bg-muted text-muted-foreground inline-flex max-w-full items-center rounded px-1.5 py-0.5 font-mono text-[10px]">
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Opens the docked Database panel (docks beside the chat on /code). */
function OpenPanelButton() {
  return (
    <Button
      size="sm"
      variant="outline"
      className="animate-press h-7 gap-1.5 px-2.5 text-[11px]"
      onClick={() => useCodePanelStore.getState().setOpen("database")}
    >
      <Database className="h-3 w-3" aria-hidden />
      Open database panel
    </Button>
  );
}

export function DatabaseToolResult({ data }: { data: DatabasePayload }) {
  const target = payloadTarget(data);

  // ── Failure (§28): op + target + the REAL reason — never a fake success. ──
  if (!data.ok) {
    return (
      <div className="space-y-1 py-1">
        <p className="text-foreground text-xs font-semibold">
          {opTitle(data.op)}
          {target ? <span className="text-muted-foreground font-normal"> — </span> : null}
          {target ? <span className="font-mono text-[11px] font-medium">{target}</span> : null}
        </p>
        <p className="text-destructive text-xs leading-relaxed">{data.error ?? "The operation failed."}</p>
      </div>
    );
  }

  const title = (
    <p className="text-foreground min-w-0 truncate text-xs font-semibold">
      {opTitle(data.op)}
      {target ? <span className="text-muted-foreground font-normal"> — </span> : null}
      {target ? <span className="font-mono text-[11px] font-medium">{target}</span> : null}
    </p>
  );

  // ── inspect — compact overview stats (§14, never a dump) ─────────────────
  if (data.op === "inspect" && data.overview) {
    const ov = data.overview;
    return (
      <div className="space-y-2 py-1">
        <div className="flex flex-wrap items-center gap-2">
          <Database className="text-primary h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="text-foreground text-xs font-semibold">Database overview</span>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-semibold",
              ov.onyxbase.reachable
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-destructive/10 text-destructive",
            )}
          >
            {ov.onyxbase.reachable ? "OnyxBase connected" : "OnyxBase unreachable"}
          </span>
        </div>
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          {ov.kv.count.toLocaleString()} record{ov.kv.count === 1 ? "" : "s"} ·{" "}
          {ov.storage.files.toLocaleString()} file{ov.storage.files === 1 ? "" : "s"} (
          {formatBytes(ov.storage.totalBytes)}) · {ov.schema.entityCount} schema entit
          {ov.schema.entityCount === 1 ? "y" : "ies"}
        </p>
        {ov.kv.sampleKeys.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {ov.kv.sampleKeys.slice(0, 6).map((k) => (
              <Chip key={k}>{k}</Chip>
            ))}
          </div>
        )}
        {data.hint && <p className="text-muted-foreground text-[11px] leading-relaxed">{data.hint}</p>}
        <OpenPanelButton />
      </div>
    );
  }

  // ── kv_get — the value (parsed JSON or text preview) ─────────────────────
  if (data.op === "kv_get") {
    const body =
      data.value !== undefined
        ? JSON.stringify(data.value, null, 2)
        : (data.text ?? "");
    return (
      <div className="space-y-1.5 py-1">
        {title}
        <ValuePreview text={body} />
        <p className="text-muted-foreground text-[10px]">
          {data.isJson ? "JSON" : "Text"} · {(data.size ?? 0).toLocaleString()} chars
          {data.truncated ? ` · truncated (full ${(data.fullSize ?? 0).toLocaleString()})` : ""}
        </p>
        {data.note && <p className="text-muted-foreground text-[10px] leading-relaxed">{data.note}</p>}
      </div>
    );
  }

  // ── kv_set / kv_delete ───────────────────────────────────────────────────
  if (data.op === "kv_set") {
    return (
      <div className="space-y-1 py-1">
        {title}
        <p className="text-muted-foreground text-[11px]">
          Saved to OnyxBase · {(data.size ?? 0).toLocaleString()} chars
        </p>
      </div>
    );
  }
  if (data.op === "kv_delete") {
    return (
      <div className="space-y-1 py-1">
        {title}
        <p className="text-muted-foreground text-[11px]">Record deleted from this chat&apos;s namespace.</p>
      </div>
    );
  }

  // ── kv_list — count + first keys ─────────────────────────────────────────
  if (data.op === "kv_list") {
    const records = data.records ?? [];
    return (
      <div className="space-y-1.5 py-1">
        {title}
        <p className="text-muted-foreground text-[11px]">
          {data.count ?? records.length} record{(data.count ?? records.length) === 1 ? "" : "s"}
          {data.prefix ? ` · prefix "${data.prefix}"` : ""}
          {data.search ? ` · search "${data.search}"` : ""}
          {data.migrated ? ` · adopted ${data.migrated} legacy record(s)` : ""}
        </p>
        {records.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {records.slice(0, 6).map((r) => (
              <Chip key={r.key}>{r.key}</Chip>
            ))}
            {records.length > 6 && <Chip>+{records.length - 6} more</Chip>}
          </div>
        )}
      </div>
    );
  }

  // ── storage_list ─────────────────────────────────────────────────────────
  if (data.op === "storage_list") {
    const files = data.files ?? [];
    return (
      <div className="space-y-1.5 py-1">
        {title}
        <p className="text-muted-foreground text-[11px]">
          {data.count ?? files.length} file{(data.count ?? files.length) === 1 ? "" : "s"}
          {data.prefix ? ` · prefix "${data.prefix}"` : ""}
        </p>
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {files.slice(0, 6).map((f) => (
              <Chip key={f.path}>{f.path}</Chip>
            ))}
            {files.length > 6 && <Chip>+{files.length - 6} more</Chip>}
          </div>
        )}
      </div>
    );
  }

  // ── storage_read ─────────────────────────────────────────────────────────
  if (data.op === "storage_read") {
    return (
      <div className="space-y-1.5 py-1">
        {title}
        {data.encoding === "utf8" && data.text ? (
          <ValuePreview text={data.text} />
        ) : (
          <p className="text-muted-foreground text-[11px]">
            {data.isImage ? "Image" : "Binary"} payload · {data.mime} · {formatBytes(data.size)}
            {data.chunks ? ` · ${data.chunks} chunk(s)` : ""}
          </p>
        )}
        {data.encoding === "utf8" && (
          <p className="text-muted-foreground text-[10px]">
            {data.mime} · {formatBytes(data.size)}
            {data.truncated ? ` · truncated (full ${((data.fullChars ?? 0)).toLocaleString()} chars)` : ""}
          </p>
        )}
        {data.note && <p className="text-muted-foreground text-[10px] leading-relaxed">{data.note}</p>}
      </div>
    );
  }

  // ── storage_write ────────────────────────────────────────────────────────
  if (data.op === "storage_write") {
    return (
      <div className="space-y-1 py-1">
        {title}
        <p className="text-muted-foreground text-[11px]">
          Stored in OnyxBase · {formatBytes(data.size)} · {data.mime}
          {data.chunks ? ` · ${data.chunks} chunk(s)` : ""}
        </p>
      </div>
    );
  }

  // ── storage_delete ───────────────────────────────────────────────────────
  if (data.op === "storage_delete") {
    return (
      <div className="space-y-1 py-1">
        {title}
        <p className="text-muted-foreground text-[11px]">
          Deleted{data.chunksRemoved ? ` · ${data.chunksRemoved} chunk record(s) removed` : ""}
        </p>
      </div>
    );
  }

  // ── storage_metadata ─────────────────────────────────────────────────────
  if (data.op === "storage_metadata") {
    return (
      <div className="space-y-1 py-1">
        {title}
        <p className="text-muted-foreground text-[11px]">
          {data.mime} · {formatBytes(data.size)} · {data.chunks} chunk(s) ×{" "}
          {(data.chunkSize ?? 0).toLocaleString()} chars · {data.encoding}
          {data.updatedAt ? ` · updated ${new Date(data.updatedAt).toLocaleString()}` : ""}
        </p>
      </div>
    );
  }

  // ── schema_upsert — entity + fields + the entity list ────────────────────
  if (data.op === "schema_upsert") {
    return (
      <div className="space-y-1.5 py-1">
        {title}
        <p className="text-muted-foreground text-[11px]">
          {data.fieldCount ?? 0} field{(data.fieldCount ?? 0) === 1 ? "" : "s"} · application
          schema metadata (not native tables)
          {data.updatedAt ? ` · ${new Date(data.updatedAt).toLocaleString()}` : ""}
        </p>
        {data.entities && data.entities.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {data.entities.map((e) => (
              <Chip key={e}>{e}</Chip>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Fallback — a valid payload with an unknown op: show the title + note.
  return (
    <div className="space-y-1 py-1">
      {title}
      {data.note && <p className="text-muted-foreground text-[11px] leading-relaxed">{data.note}</p>}
    </div>
  );
}
