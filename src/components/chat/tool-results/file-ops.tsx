"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  FileMinus,
  FilePlus,
  FileSearch,
  FolderOpen,
  FolderPlus,
  Globe,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { ToolCall } from "@/types";
import { cn } from "@/lib/utils";
import { DeltaChip, paperCardClass } from "@/components/assistant-ui/elements";
import { CopyButton } from "../copy-button";

/**
 * Parsed "nice UI" cards for the workspace file tools — the same treatment
 * `edit_file` gets from the CodeDiff: every file operation renders a real
 * card built from the tool's actual result, instead of a JSON dump.
 *
 * Covered tools (result shapes verified against src/lib/tools/e2b_files.ts
 * and file_writer.ts):
 *  - create_file / write_file / create_file_chunk → FileCreatedCard
 *  - read_file / read_file_section               → FileReadCard
 *  - verify_path                                  → PathVerifyCard
 *  - list_folder / list_files / list_workspace_files → FolderListCard
 *  - delete_file / delete_folder                  → FileDeletedCard
 *  - create_folder                                → FolderCreatedCard
 *  - move_file / rename_file                      → FileMoveCard
 *  - web_fetch / fetch_url                        → WebFetchCard
 *
 * Terminal/command tools intentionally have NO card here — their output is
 * freeform, so they keep the live log view.
 *
 * Every card renders ONLY for completed, successful calls; anything else
 * (error, pending) returns null and the card falls back to the generic
 * renderer. Shown in technical display mode; simple mode keeps its plain
 * sentences.
 */

// ── shared parsing helpers ─────────────────────────────────────────────────

/** Best-effort object view of a tool result (handles JSON-string results). */
function asObject(result: unknown): Record<string, unknown> | null {
  if (result == null) return null;
  if (typeof result === "object") return result as Record<string, unknown>;
  if (typeof result === "string") {
    try {
      const parsed = JSON.parse(result);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The tool landed (completed, no error field). */
function landed(toolCall: ToolCall): boolean {
  if (toolCall.status !== "completed") return false;
  const parsed = asObject(toolCall.result);
  return !(parsed && parsed.error !== undefined);
}

/** A path's bare name — "src/app/page.tsx" → "page.tsx". */
function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Line count that doesn't count the phantom line after a trailing newline. */
function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

/** 1536 → "1.5 KB". */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** unknown → number | null (typeof-safe, no boolean leakage into ?? chains). */
function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

const PREVIEW_LINES = 12;

/** Shared card chrome: paper surface + mono header row (CodeDiff anatomy). */
function CardShell({
  icon: Icon,
  title,
  children,
  titleExtra,
}: {
  icon: LucideIcon;
  title: string;
  titleExtra?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={cn(paperCardClass, "max-w-full overflow-hidden")}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate font-mono text-[11px] font-medium text-foreground/85">
          {title}
        </span>
        {titleExtra && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5">{titleExtra}</span>
        )}
      </div>
      {children}
    </div>
  );
}

/** Mono body with a copy button — the preview block for file content. */
function ContentPreview({
  text,
  totalLines,
  copyLabel,
}: {
  text: string;
  totalLines: number;
  copyLabel: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const lines = text.replace(/\n$/, "").split("\n");
  const shown = showAll ? lines.slice(0, 400) : lines.slice(0, PREVIEW_LINES);
  const hidden = lines.length - shown.length;
  return (
    <div className="group relative">
      <div className="scrollbar-thin max-h-64 overflow-x-auto overflow-y-auto py-1 font-mono text-[11px] leading-relaxed">
        {shown.map((line, i) => (
          <div key={i} className="flex gap-2 px-3 whitespace-pre text-foreground/75">
            <span className="w-3 shrink-0 text-right text-muted-foreground/50 select-none">
              {i + 1}
            </span>
            <span className="min-w-0">{line}</span>
          </div>
        ))}
        {!showAll && hidden > 0 && (
          <div className="px-3 py-1 text-[10px] text-muted-foreground/70 select-none">
            … {hidden} more line{hidden === 1 ? "" : "s"}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-border/60 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase transition-colors hover:text-foreground"
        >
          {showAll ? "Show less" : `Show all ${totalLines} lines`}
        </button>
        <CopyButton text={text} label={copyLabel} className="opacity-0 group-hover:opacity-100" />
      </div>
    </div>
  );
}

// ── create_file / write_file / create_file_chunk ──────────────────────────

/**
 * FileCreatedCard — a created/written file as a real card: filename, net
 * line count, byte size, and the actual content preview (expandable, with
 * copy). The chunk variant labels which chunk of how many landed.
 */
export function FileCreatedCard({ toolCall }: { toolCall: ToolCall }) {
  const spec = useMemo(() => {
    if (!landed(toolCall)) return null;
    const args = (toolCall.args ?? {}) as Record<string, unknown>;
    const parsed = asObject(toolCall.result);
    const path =
      (typeof args.path === "string" && args.path) ||
      (typeof parsed?.path === "string" && parsed.path) ||
      null;
    if (!path) return null;
    const content = typeof args.content === "string" ? args.content : "";
    const size =
      num(parsed?.size) ??
      num(parsed?.bytes) ??
      num(parsed?.bytes_written) ??
      num(parsed?.file_size);
    const chunkIndex = typeof parsed?.chunk_index === "number" ? parsed.chunk_index : null;
    const totalChunks = typeof parsed?.total_chunks === "number" ? parsed.total_chunks : null;
    if (!content && size == null) return null; // nothing presentable
    return { path, content, size, chunkIndex, totalChunks };
  }, [toolCall]);

  if (!spec) return null;
  const lines = spec.content ? countLines(spec.content) : 0;
  return (
    <CardShell
      icon={FilePlus}
      title={spec.path}
      titleExtra={
        <>
          {spec.chunkIndex != null && spec.totalChunks != null && (
            <span className="font-mono text-[10px] text-muted-foreground">
              chunk {spec.chunkIndex + 1}/{spec.totalChunks}
            </span>
          )}
          {lines > 0 && <DeltaChip value={lines} kind="added" />}
          {spec.size != null && (
            <span className="font-mono text-[10px] text-muted-foreground">
              {humanSize(spec.size)}
            </span>
          )}
        </>
      }
    >
      {spec.content && (
        <ContentPreview text={spec.content} totalLines={lines} copyLabel="Copy file content" />
      )}
    </CardShell>
  );
}

// ── read_file / read_file_section ─────────────────────────────────────────

/**
 * FileReadCard — what the agent actually read: filename, line count, and
 * the content it saw (preview, expandable, copy). Truncated reads (files
 * over the 256 KB tool cap) are honestly badged.
 */
export function FileReadCard({ toolCall }: { toolCall: ToolCall }) {
  const spec = useMemo(() => {
    if (!landed(toolCall)) return null;
    const args = (toolCall.args ?? {}) as Record<string, unknown>;
    const parsed = asObject(toolCall.result);
    const content =
      (typeof parsed?.content === "string" && parsed.content) ||
      (typeof toolCall.result === "string" && !parsed ? toolCall.result : null);
    const path = typeof args.path === "string" ? args.path : null;
    if (!content || !path) return null;
    const truncated = parsed?.truncated === true;
    const totalSize = typeof parsed?.total_size === "number" ? parsed.total_size : null;
    return { path, content, truncated, totalSize };
  }, [toolCall]);

  if (!spec) return null;
  const lines = countLines(spec.content);
  return (
    <CardShell
      icon={FileSearch}
      title={spec.path}
      titleExtra={
        <>
          <span className="font-mono text-[10px] text-muted-foreground">{lines} lines</span>
          {spec.totalSize != null && (
            <span className="font-mono text-[10px] text-muted-foreground">
              {humanSize(spec.totalSize)}
            </span>
          )}
        </>
      }
    >
      {spec.truncated && (
        <p className="border-b border-border/60 px-3 py-1 text-[10px] text-muted-foreground">
          Truncated — the file is larger than the read limit.
        </p>
      )}
      <ContentPreview text={spec.content} totalLines={lines} copyLabel="Copy what was read" />
    </CardShell>
  );
}

// ── verify_path ────────────────────────────────────────────────────────────

/** PathVerifyCard — one quiet row: the path and whether it exists. */
export function PathVerifyCard({ toolCall }: { toolCall: ToolCall }) {
  const spec = useMemo(() => {
    if (!landed(toolCall)) return null;
    const parsed = asObject(toolCall.result);
    if (!parsed || typeof parsed.path !== "string") return null;
    return {
      path: parsed.path,
      exists: parsed.exists !== false,
      createdDirs: Array.isArray(parsed.created_dirs) ? parsed.created_dirs.length : 0,
    };
  }, [toolCall]);

  if (!spec) return null;
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border bg-secondary/40 px-3 py-2">
      {spec.exists ? (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-primary/80" aria-hidden />
      ) : (
        <XCircle className="h-4 w-4 shrink-0 text-destructive/80" aria-hidden />
      )}
      <span className="min-w-0 truncate font-mono text-[11px] text-foreground/80">
        {spec.path}
      </span>
      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
        {spec.exists
          ? spec.createdDirs > 0
            ? "exists · folders created"
            : "exists"
          : "not found"}
      </span>
    </div>
  );
}

// ── list_folder / list_files / list_workspace_files ───────────────────────

interface ListEntry {
  name: string;
  isFolder: boolean;
  size: number | null;
}

/**
 * FolderListCard — a real folder listing: folder header, N items, then one
 * row per entry (folder-first, alphabetical), with human sizes. Entries
 * beyond 60 collapse into a "+N more" row.
 */
export function FolderListCard({ toolCall }: { toolCall: ToolCall }) {
  const spec = useMemo(() => {
    if (!landed(toolCall)) return null;
    const args = (toolCall.args ?? {}) as Record<string, unknown>;
    const parsed = asObject(toolCall.result);
    const path =
      (typeof parsed?.path === "string" && parsed.path) ||
      (typeof args.path === "string" && args.path) ||
      ".";
    // entries: [{name, type, size}] — also accept files: string[] or objects.
    const raw =
      (Array.isArray(parsed?.entries) && parsed.entries) ||
      (Array.isArray(parsed?.files) && parsed.files) ||
      null;
    if (!raw) return null;
    const entries: ListEntry[] = [];
    for (const item of raw) {
      if (typeof item === "string") {
        entries.push({ name: item, isFolder: false, size: null });
      } else if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const name =
          (typeof obj.name === "string" && obj.name) ||
          (typeof obj.path === "string" && basename(obj.path)) ||
          null;
        if (!name) continue;
        const type = typeof obj.type === "string" ? obj.type : "";
        const isFolder = type === "dir" || type === "folder" || type === "directory" || name.endsWith("/");
        entries.push({
          name: name.replace(/\/$/, ""),
          isFolder,
          size: typeof obj.size === "number" ? obj.size : null,
        });
      }
    }
    entries.sort((a, b) =>
      a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1,
    );
    return { path, entries };
  }, [toolCall]);

  if (!spec) return null;
  const MAX_ROWS = 60;
  const shown = spec.entries.slice(0, MAX_ROWS);
  const hidden = spec.entries.length - shown.length;
  return (
    <CardShell
      icon={FolderOpen}
      title={spec.path}
      titleExtra={
        <span className="font-mono text-[10px] text-muted-foreground">
          {spec.entries.length} item{spec.entries.length === 1 ? "" : "s"}
        </span>
      }
    >
      <div className="scrollbar-thin max-h-56 overflow-y-auto py-1">
        {shown.map((entry) => (
          <div
            key={entry.name}
            className="flex items-center gap-2 px-3 py-0.5 font-mono text-[11px] text-foreground/75"
          >
            {entry.isFolder ? (
              <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <FileSearch className="h-3 w-3 shrink-0 text-muted-foreground/60" aria-hidden />
            )}
            <span className={cn("min-w-0 truncate", entry.isFolder && "text-foreground/90")}>
              {entry.name}
            </span>
            {entry.size != null && (
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
                {humanSize(entry.size)}
              </span>
            )}
          </div>
        ))}
        {hidden > 0 && (
          <div className="px-3 py-1 text-[10px] text-muted-foreground/70 select-none">
            + {hidden} more…
          </div>
        )}
        {spec.entries.length === 0 && (
          <p className="px-3 py-2 text-[11px] text-muted-foreground italic">Empty folder.</p>
        )}
      </div>
    </CardShell>
  );
}

// ── delete / create folder / move & rename ────────────────────────────────

/** One quiet confirmation row (delete_file, delete_folder, create_folder). */
function MiniCard({
  icon: Icon,
  label,
  path,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  path: string;
  tone: "default" | "removed" | "created";
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-lg border px-3 py-2",
        tone === "removed" && "border-destructive/25 bg-destructive/[0.06]",
        tone === "created" && "border-border bg-secondary/40",
        tone === "default" && "border-border bg-secondary/40",
      )}
    >
      <Icon
        className={cn(
          "h-4 w-4 shrink-0",
          tone === "removed" ? "text-destructive/80" : "text-muted-foreground",
        )}
        aria-hidden
      />
      <span className="min-w-0 truncate font-mono text-[11px] text-foreground/80">{path}</span>
      <span
        className={cn(
          "ml-auto shrink-0 text-[11px]",
          tone === "removed" ? "text-destructive/80" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
    </div>
  );
}

/** delete_file / delete_folder — "path · Removed". */
export function FileDeletedCard({ toolCall }: { toolCall: ToolCall }) {
  const spec = useMemo(() => {
    if (!landed(toolCall)) return null;
    const args = (toolCall.args ?? {}) as Record<string, unknown>;
    const parsed = asObject(toolCall.result);
    const path =
      (typeof parsed?.path === "string" && parsed.path) ||
      (typeof args.path === "string" && args.path) ||
      null;
    return path ? { path } : null;
  }, [toolCall]);
  if (!spec) return null;
  return (
    <MiniCard
      icon={FileMinus}
      label="Removed"
      path={spec.path}
      tone="removed"
    />
  );
}

/** create_folder — "path · Created". */
export function FolderCreatedCard({ toolCall }: { toolCall: ToolCall }) {
  const spec = useMemo(() => {
    if (!landed(toolCall)) return null;
    const args = (toolCall.args ?? {}) as Record<string, unknown>;
    const parsed = asObject(toolCall.result);
    const path =
      (typeof parsed?.path === "string" && parsed.path) ||
      (typeof args.path === "string" && args.path) ||
      null;
    return path ? { path } : null;
  }, [toolCall]);
  if (!spec) return null;
  return (
    <MiniCard
      icon={FolderPlus}
      label="Created"
      path={spec.path}
      tone="created"
    />
  );
}

/** move_file / rename_file — "old → new" with the size. */
export function FileMoveCard({ toolCall }: { toolCall: ToolCall }) {
  const spec = useMemo(() => {
    if (!landed(toolCall)) return null;
    const args = (toolCall.args ?? {}) as Record<string, unknown>;
    const parsed = asObject(toolCall.result);
    const from =
      (typeof parsed?.source === "string" && parsed.source) ||
      (typeof parsed?.old_path === "string" && parsed.old_path) ||
      (typeof args.source === "string" && args.source) ||
      (typeof args.path === "string" && args.path) ||
      null;
    const to =
      (typeof parsed?.destination === "string" && parsed.destination) ||
      (typeof parsed?.new_path === "string" && parsed.new_path) ||
      (typeof args.destination === "string" && args.destination) ||
      (typeof args.new_path === "string" && args.new_path) ||
      null;
    if (!from || !to) return null;
    const size = num(parsed?.size) ?? num(parsed?.file_size);
    return { from, to, size };
  }, [toolCall]);
  if (!spec) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2">
      <span className="min-w-0 truncate font-mono text-[11px] text-foreground/80">{spec.from}</span>
      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 truncate font-mono text-[11px] font-medium text-foreground/90">
        {spec.to}
      </span>
      {spec.size != null && (
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {humanSize(spec.size)}
        </span>
      )}
    </div>
  );
}

// ── web_fetch / fetch_url ─────────────────────────────────────────────────

/**
 * WebFetchCard — the page the agent read as a card: domain, page title,
 * and a readable snippet of the extracted text (expandable, copy), with an
 * external link to the source.
 */
export function WebFetchCard({ toolCall }: { toolCall: ToolCall }) {
  const spec = useMemo(() => {
    if (!landed(toolCall)) return null;
    const args = (toolCall.args ?? {}) as Record<string, unknown>;
    const parsed = asObject(toolCall.result);
    const url =
      (typeof parsed?.url === "string" && parsed.url) ||
      (typeof args.url === "string" && args.url) ||
      null;
    if (!url) return null;
    const title = typeof parsed?.title === "string" ? parsed.title : null;
    const content = typeof parsed?.content === "string" ? parsed.content : null;
    let domain = "";
    try {
      domain = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      domain = url;
    }
    return { url, domain, title, content };
  }, [toolCall]);

  if (!spec) return null;
  return (
    <CardShell
      icon={Globe}
      title={spec.domain}
      titleExtra={
        <a
          href={spec.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-foreground transition-colors"
          title="Open the page"
          aria-label="Open the page in a new tab"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      }
    >
      {spec.title && (
        <p className="border-b border-border/60 px-3 py-1.5 text-[12px] font-medium text-foreground/85">
          {spec.title}
        </p>
      )}
      {spec.content && (
        <div className="group relative">
          <p className="scrollbar-thin max-h-40 overflow-y-auto px-3 py-2 text-[12px] leading-relaxed break-words whitespace-pre-wrap text-foreground/70">
            {spec.content.length > 700
              ? `${spec.content.slice(0, 700).trimEnd()}…`
              : spec.content}
          </p>
          <div className="flex justify-end border-t border-border/60 px-2 py-1.5">
            <CopyButton
              text={spec.content}
              label="Copy page text"
              className="opacity-0 group-hover:opacity-100"
            />
          </div>
        </div>
      )}
    </CardShell>
  );
}
