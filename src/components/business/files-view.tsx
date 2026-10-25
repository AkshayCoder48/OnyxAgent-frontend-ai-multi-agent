"use client";

/**
 * Business Mode — FilesView (the "files" workspace tab).
 *
 * READ-ONLY browser for this business's own directory in the E2B sandbox
 * workspace: `businesses/<businessId>` (relative to /home/user, the sandbox
 * root). Specialist agents write their deliverables (documents, code, data)
 * into that directory; this view lists it (folders first, then files,
 * alphabetical), drills into subfolders via a breadcrumb trail, and
 * previews / downloads files in a side sheet.
 *
 * Guarantees:
 *  - Never mutates the sandbox EXCEPT the best-effort creation of the
 *    business ROOT directory (first load + root refresh), so a brand-new
 *    business shows an honest empty state instead of a "not found" error.
 *  - No E2B key → honest empty state + a link to Settings → Config.
 *  - A missing/empty directory is the EMPTY state, never an error.
 *  - All copy comes from bt() (files.* keys) — no hardcoded strings.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  ArrowUp,
  ChevronRight,
  Download,
  File as FileIcon,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  Folder,
  FolderOpen,
  Music,
  RefreshCw,
  RotateCcw,
  ServerOff,
  Settings,
  Video,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

import { getE2BClient, type E2BClient, type E2BFile } from "@/lib/e2b/client";
import { bt } from "@/lib/business/ui-text";
import { ROUTES } from "@/lib/constants";
import { useAuthStore } from "@/stores/auth-store";
import { useBusinessStore } from "@/stores/business-store";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Helpers — entry shaping, sizes, extension-aware icons.
// ---------------------------------------------------------------------------

interface FileEntry {
  name: string;
  /** Sandbox path exactly as listed (works for follow-up list/read calls). */
  path: string;
  type: "dir" | "file";
  size: number;
}

function fileExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : "";
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Extensions previewed as text via client.readFile(). */
const TEXT_PREVIEW_EXTS = new Set([
  "md", "txt", "json", "csv", "html", "js", "ts", "py", "css", "xml",
  "yml", "yaml", "log", "tsx", "jsx", "sh", "sql",
]);

const EXT_ICONS: Record<string, LucideIcon> = {
  md: FileText,
  txt: FileText,
  rtf: FileText,
  py: FileCode,
  js: FileCode,
  ts: FileCode,
  tsx: FileCode,
  jsx: FileCode,
  json: FileCode,
  html: FileCode,
  css: FileCode,
  yaml: FileCode,
  yml: FileCode,
  sh: FileCode,
  sql: FileCode,
  xml: FileCode,
  csv: FileSpreadsheet,
  xls: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  tsv: FileSpreadsheet,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  svg: FileImage,
  webp: FileImage,
  bmp: FileImage,
  ico: FileImage,
  pdf: FileType,
  doc: FileType,
  docx: FileType,
  zip: FileArchive,
  tar: FileArchive,
  gz: FileArchive,
  rar: FileArchive,
  "7z": FileArchive,
  mp3: Music,
  wav: Music,
  mp4: Video,
  mov: Video,
  avi: Video,
  mkv: Video,
};

/** Icon colors per extension — theme + status hues only (no blue/indigo). */
const EXT_ICON_COLORS: Record<string, string> = {
  py: "text-primary",
  js: "text-primary",
  ts: "text-primary",
  tsx: "text-primary",
  jsx: "text-primary",
  json: "text-primary",
  html: "text-primary",
  css: "text-primary",
  yaml: "text-primary",
  yml: "text-primary",
  sh: "text-primary",
  sql: "text-primary",
  xml: "text-primary",
  csv: "text-emerald-600 dark:text-emerald-400",
  xls: "text-emerald-600 dark:text-emerald-400",
  xlsx: "text-emerald-600 dark:text-emerald-400",
  tsv: "text-emerald-600 dark:text-emerald-400",
  png: "text-primary",
  jpg: "text-primary",
  jpeg: "text-primary",
  gif: "text-primary",
  svg: "text-primary",
  webp: "text-primary",
  bmp: "text-primary",
  ico: "text-primary",
  pdf: "text-rose-600 dark:text-rose-400",
  doc: "text-rose-600 dark:text-rose-400",
  docx: "text-rose-600 dark:text-rose-400",
  zip: "text-amber-600 dark:text-amber-400",
  tar: "text-amber-600 dark:text-amber-400",
  gz: "text-amber-600 dark:text-amber-400",
  rar: "text-amber-600 dark:text-amber-400",
  "7z": "text-amber-600 dark:text-amber-400",
  mp3: "text-teal-600 dark:text-teal-400",
  wav: "text-teal-600 dark:text-teal-400",
  mp4: "text-teal-600 dark:text-teal-400",
  mov: "text-teal-600 dark:text-teal-400",
  avi: "text-teal-600 dark:text-teal-400",
  mkv: "text-teal-600 dark:text-teal-400",
};

function entryIconClass(entry: FileEntry): string {
  if (entry.type === "dir") return "text-primary";
  return EXT_ICON_COLORS[fileExtension(entry.name)] ?? "text-muted-foreground";
}

/** Listing errors that mean "directory does not exist (yet)" — the honest
 *  empty state, not an error (no specialist may have written files so far). */
function isNotFoundListingError(message: string): boolean {
  return /not found|no such|enoent|does not exist/i.test(message);
}

/** E2BFile[] → sorted FileEntry[] (folders first, then files, alphabetical). */
function toEntries(files: E2BFile[]): FileEntry[] {
  const entries: FileEntry[] = files.map((f) => {
    const name =
      (typeof f.name === "string" && f.name.trim()) ||
      f.path.split("/").filter(Boolean).pop() ||
      f.path;
    // Defensive: anything that isn't exactly "file" is treated as a folder
    // (handles "directory" / "FILE_TYPE_DIRECTORY" variants).
    const isDir = f.type !== "file";
    return { name, path: f.path, type: isDir ? "dir" : "file", size: f.size ?? 0 };
  });
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

// ---------------------------------------------------------------------------
// FilesView
// ---------------------------------------------------------------------------

export function FilesView() {
  const params = useParams<{ businessId?: string }>();
  const activeBusinessId = useBusinessStore((s) => s.activeBusinessId);
  const activeBusiness = useBusinessStore((s) => s.activeBusiness);
  const businessId = params?.businessId ?? activeBusinessId ?? "";

  const user = useAuthStore((s) => s.user);
  const authResolved = useAuthStore((s) => s.authResolved);
  const userId = user?.id ?? "local-user";

  const reduceMotion = useReducedMotion();

  // ── Sandbox client (resolved from the user's stored E2B key) ───────────
  const [client, setClient] = useState<E2BClient | null>(null);
  const [clientLoaded, setClientLoaded] = useState(false);

  useEffect(() => {
    if (!authResolved) return; // don't query the transient pre-auth user id
    let cancelled = false;
    setClientLoaded(false);
    (async () => {
      try {
        const { settingsService } = await import("@/lib/services");
        const key = await settingsService.getDecryptedSandboxKey(userId);
        if (cancelled) return;
        setClient(key ? getE2BClient(key, null, "shared") : null);
      } catch {
        if (!cancelled) setClient(null);
      } finally {
        if (!cancelled) setClientLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authResolved, userId]);

  // ── Directory browsing state ────────────────────────────────────────────
  /** Path segments BELOW the business root (empty = at the root). */
  const [dirSegments, setDirSegments] = useState<string[]>([]);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<FileEntry | null>(null);

  const rootDir = businessId ? `businesses/${businessId}` : "";
  const currentPath = useMemo(
    () => (dirSegments.length > 0 ? `${rootDir}/${dirSegments.join("/")}` : rootDir),
    [rootDir, dirSegments],
  );

  // Switching businesses in place (same mount, new route param) resets the
  // trail — the "adjust state during render" pattern keeps this consistent
  // with the currentPath computed below.
  const [lastBusinessId, setLastBusinessId] = useState(businessId);
  if (businessId !== lastBusinessId) {
    setLastBusinessId(businessId);
    setDirSegments([]);
    setEntries(null);
    setError(null);
  }

  /** List one directory. Best-effort ensures the business ROOT exists. */
  const load = useCallback(
    async (path: string) => {
      if (!client || !rootDir) return;
      setLoading(true);
      setError(null);
      try {
        if (path === rootDir) {
          try {
            await client.createFolder(rootDir);
          } catch {
            // best-effort — "already exists" and transient errors are fine,
            // the listing below is the source of truth.
          }
        }
        setEntries(toEntries(await client.listFiles(path)));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isNotFoundListingError(message)) {
          // The directory doesn't exist yet (no specialist has written
          // files) — that's the empty state, not an error.
          setEntries([]);
        } else {
          setError(message);
        }
      } finally {
        setLoading(false);
      }
    },
    [client, rootDir],
  );

  useEffect(() => {
    if (!client || !businessId) return;
    void load(currentPath);
  }, [businessId, client, currentPath, load]);

  function handleOpenEntry(entry: FileEntry) {
    if (entry.type === "dir") {
      setDirSegments((segs) => [...segs, entry.name]);
      setEntries(null); // show skeletons for the new folder
    } else {
      setPreviewFile(entry);
    }
  }

  /** Jump to a breadcrumb position: `segmentCount` segments kept. */
  function handleNavigate(segmentCount: number) {
    setDirSegments((segs) => segs.slice(0, segmentCount));
    setEntries(null);
  }

  function handleUp() {
    setDirSegments((segs) => segs.slice(0, -1));
    setEntries(null);
  }

  function handleReload() {
    if (client && currentPath) void load(currentPath);
  }

  // ── Guards: no business id / key resolving / no key ────────────────────
  if (!businessId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-14 text-center">
        <FolderOpen className="size-10 text-muted-foreground/60" aria-hidden />
        <p className="text-sm font-medium">{bt("files.emptyTitle")}</p>
        <p className="max-w-md text-sm text-muted-foreground">{bt("files.emptySubtitle")}</p>
      </div>
    );
  }

  if (!clientLoaded) {
    return (
      <div className="flex h-full flex-col gap-4" aria-busy="true">
        <div className="space-y-2">
          <Skeleton className="h-6 w-44" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (!client) {
    return (
      <div className="flex h-full flex-col gap-4">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">{bt("files.title")}</h1>
          <p className="text-sm text-muted-foreground">{bt("files.subtitle")}</p>
        </header>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-4 py-14 text-center">
          <ServerOff className="size-10 text-muted-foreground/60" aria-hidden />
          <p className="text-sm font-medium">{bt("files.noKeyTitle")}</p>
          <p className="max-w-md text-sm text-muted-foreground">{bt("files.noKeySubtitle")}</p>
          <Button asChild className="mt-1 h-11">
            <Link href={ROUTES.SETTINGS_CONFIG}>
              <Settings className="mr-2 size-4" aria-hidden />
              {bt("files.openSettings")}
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  const atRoot = dirSegments.length === 0;
  const rootLabel =
    activeBusiness && activeBusiness.id === businessId ? activeBusiness.name : businessId;

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{bt("files.title")}</h1>
          <p className="text-sm text-muted-foreground">{bt("files.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {entries && (
            <Badge variant="secondary" className="tabular-nums">
              {bt("files.items", { count: entries.length })}
            </Badge>
          )}
          <Button
            variant="outline"
            className="h-11"
            onClick={handleReload}
            disabled={loading}
            aria-label={bt("files.refresh")}
          >
            <RefreshCw className={cn("mr-2 size-4", loading && "animate-spin")} aria-hidden />
            {bt("files.refresh")}
          </Button>
        </div>
      </header>

      {/* Current sandbox directory chip, e.g. businesses/<id>/reports */}
      <div className="shrink-0">
        <span className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-full border bg-muted/30 px-3.5 py-1.5 text-xs">
          <FolderOpen className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="shrink-0 font-medium text-muted-foreground">{bt("files.dirPath")}</span>
          <code className="min-w-0 truncate font-mono" title={currentPath}>
            {currentPath}
          </code>
        </span>
      </div>

      <section
        className="flex min-h-0 flex-1 flex-col gap-3 rounded-xl border p-4"
        aria-label={bt("files.title")}
      >
        {/* Breadcrumb trail + up-one-level */}
        <nav aria-label={bt("files.dirPath")} className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            onClick={handleUp}
            disabled={atRoot}
            aria-label={bt("files.parentDir")}
            title={bt("files.parentDir")}
          >
            <ArrowUp className="size-4" aria-hidden />
          </Button>
          <ol className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-sm">
            <li className="flex min-w-0 items-center">
              <button
                type="button"
                onClick={() => handleNavigate(0)}
                aria-current={atRoot ? "page" : undefined}
                className={cn(
                  "flex min-h-11 min-w-0 items-center gap-1.5 rounded-md px-1.5 font-medium transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  atRoot ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <FolderOpen className="size-4 shrink-0 text-primary" aria-hidden />
                <span className="max-w-[180px] truncate">{rootLabel}</span>
              </button>
            </li>
            {dirSegments.map((segment, i) => {
              const isCurrent = i === dirSegments.length - 1;
              return (
                <li key={`${i}-${segment}`} className="flex min-w-0 items-center gap-x-1">
                  <span className="text-muted-foreground/60" aria-hidden>
                    /
                  </span>
                  <button
                    type="button"
                    onClick={() => handleNavigate(i + 1)}
                    aria-current={isCurrent ? "page" : undefined}
                    className={cn(
                      "flex min-h-11 min-w-0 items-center rounded-md px-1.5 font-medium transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      isCurrent ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <span className="max-w-[180px] truncate">{segment}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        {/* Listing — skeletons / error / empty / entries */}
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pr-1" aria-busy={loading}>
          {loading && entries === null ? (
            <div className="flex flex-col gap-2" role="status" aria-label={bt("common.loading")}>
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-xl" />
              ))}
            </div>
          ) : error ? (
            <div className="flex flex-col items-start gap-3 py-2">
              <Alert variant="destructive">
                <AlertTriangle className="size-4" />
                <AlertDescription className="break-words">
                  {bt("files.error", { error })}
                </AlertDescription>
              </Alert>
              <Button variant="outline" className="h-11" onClick={handleReload}>
                <RotateCcw className="mr-2 size-4" aria-hidden />
                {bt("common.retry")}
              </Button>
            </div>
          ) : entries && entries.length === 0 ? (
            <div className="flex min-h-[16rem] flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-14 text-center">
              <FolderOpen className="size-10 text-muted-foreground/60" aria-hidden />
              <p className="text-sm font-medium">{bt("files.emptyTitle")}</p>
              <p className="max-w-md text-sm text-muted-foreground">{bt("files.emptySubtitle")}</p>
            </div>
          ) : entries ? (
            <ul className="flex flex-col gap-2 pb-1">
              {entries.map((entry, i) => (
                <FileRow
                  key={entry.path}
                  entry={entry}
                  index={i}
                  reduceMotion={reduceMotion}
                  onActivate={handleOpenEntry}
                />
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      {/* File preview sheet */}
      <FilePreviewSheet
        file={previewFile}
        client={client}
        open={previewFile !== null}
        onOpenChange={(o) => {
          if (!o) setPreviewFile(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// File row.
// ---------------------------------------------------------------------------

function FileRow({
  entry,
  index,
  reduceMotion,
  onActivate,
}: {
  entry: FileEntry;
  index: number;
  reduceMotion: boolean | null;
  onActivate: (entry: FileEntry) => void;
}) {
  // NOTE: static lookup only — a helper CALL returning a component would
  // trip react-hooks/static-components ("created during render").
  const Icon = entry.type === "dir" ? Folder : EXT_ICONS[fileExtension(entry.name)] ?? FileIcon;
  const isDir = entry.type === "dir";
  const size = isDir ? "" : formatSize(entry.size);

  return (
    <motion.li
      initial={reduceMotion ? undefined : { opacity: 0, y: 8 }}
      animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.2) }}
    >
      <button
        type="button"
        onClick={() => onActivate(entry)}
        className="flex min-h-14 w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        aria-label={size ? `${entry.name} · ${size}` : entry.name}
      >
        <Icon className={cn("size-5 shrink-0", entryIconClass(entry))} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={entry.path}>
          {entry.name}
        </span>
        {size && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{size}</span>}
        <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />
      </button>
    </motion.li>
  );
}

// ---------------------------------------------------------------------------
// File preview sheet — text preview / binary note + download.
// ---------------------------------------------------------------------------

function FilePreviewSheet({
  file,
  client,
  open,
  onOpenChange,
}: {
  file: FileEntry | null;
  client: E2BClient;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const isText = file ? TEXT_PREVIEW_EXTS.has(fileExtension(file.name)) : false;

  // Load the text preview whenever a file is opened (binary files skip the
  // fetch entirely — the sheet shows the binary note).
  useEffect(() => {
    if (!open || !file || !client || !isText) return;
    let alive = true;
    setContent(null);
    setError(null);
    setLoading(true);
    (async () => {
      try {
        const text = await client.readFile(file.path);
        if (alive) setContent(text);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, file, client, isText]);

  async function handleRetryPreview() {
    if (!file || !client || !isText) return;
    setLoading(true);
    setError(null);
    try {
      setContent(await client.readFile(file.path));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleDownload() {
    if (!file) return;
    setDownloading(true);
    setError(null);
    try {
      const blob = await client.readFileBytes(file.path);
      if (!blob) {
        // Practically unreachable (server always returns base64) — surface
        // the raw path rather than inventing copy.
        setError(file.path);
        return;
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }

  const PreviewIcon = file ? EXT_ICONS[fileExtension(file.name)] ?? FileIcon : FileIcon;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl">
        <SheetHeader>
          <div className="flex min-w-0 items-center gap-3">
            <PreviewIcon className="size-5 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate">{file?.name ?? ""}</SheetTitle>
              <SheetDescription className="truncate text-xs">
                {file ? `${bt("files.previewTitle")} · ${formatSize(file.size) || "—"}` : ""}
              </SheetDescription>
            </div>
            <SheetClose onClick={() => onOpenChange(false)} aria-label={bt("common.close")} />
          </div>
        </SheetHeader>

        {file && (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto scrollbar-thin p-4">
            {/* Actions */}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void handleDownload()} disabled={downloading} className="h-11">
                {downloading ? (
                  <Spinner className="mr-2 size-4" />
                ) : (
                  <Download className="mr-2 size-4" aria-hidden />
                )}
                {bt("files.download")}
              </Button>
              <Button variant="outline" onClick={() => onOpenChange(false)} className="h-11">
                {bt("files.backToList")}
              </Button>
            </div>

            {loading ? (
              <div
                className="flex flex-1 flex-col items-center justify-center gap-2 py-14 text-sm text-muted-foreground"
                role="status"
              >
                <Spinner className="size-5" />
                {bt("common.loading")}
              </div>
            ) : error ? (
              <div className="flex flex-col items-start gap-3">
                <Alert variant="destructive">
                  <AlertTriangle className="size-4" />
                  <AlertDescription className="break-words">{error}</AlertDescription>
                </Alert>
                {isText && (
                  <Button variant="outline" className="h-11" onClick={() => void handleRetryPreview()}>
                    <RotateCcw className="mr-2 size-4" aria-hidden />
                    {bt("common.retry")}
                  </Button>
                )}
              </div>
            ) : isText ? (
              <div className="rounded-lg border bg-muted/30 p-3">
                <pre className="scrollbar-thin max-h-[28rem] overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
                  {content}
                </pre>
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-14 text-center">
                <FileIcon className="size-10 text-muted-foreground/60" aria-hidden />
                <p className="max-w-md text-sm text-muted-foreground">{bt("files.binaryNote")}</p>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
