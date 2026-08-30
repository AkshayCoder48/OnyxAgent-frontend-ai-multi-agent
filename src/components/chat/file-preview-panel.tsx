"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, ExternalLink, FileAudio, FileCode, FileImage, FileText, FileVideo, Loader2, X } from "lucide-react";

import { useFilePreviewStore } from "@/stores";
import { getFileUrl, loadFileUrl } from "@/lib/file-api";
import { cn } from "@/lib/utils";
import { FilePreviewCard, extOf, previewKind, type PreviewKind } from "./file-preview-card";

const DEFAULT_WIDTH = 480;
const MIN_WIDTH = 320;
const MAX_WIDTH = 1100;
const STORAGE_KEY = "filePreviewPanelWidth";

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Read the persisted panel width from localStorage (client-only value). */
function initialWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (!stored) return DEFAULT_WIDTH;
  const n = parseInt(stored, 10);
  return Number.isFinite(n) ? clamp(n, MIN_WIDTH, MAX_WIDTH) : DEFAULT_WIDTH;
}

/**
 * Module-level icon switcher — rendering `<KindIcon kind={…} />` keeps the
 * component identity static (the React Compiler lint forbids assigning
 * component references to variables during render, which the previous
 * `const KindIcon = iconFor(kind)` pattern violated).
 */
function KindIcon({ kind, className }: { kind: PreviewKind; className?: string }) {
  switch (kind) {
    case "image":
      return <FileImage className={className} />;
    case "audio":
      return <FileAudio className={className} />;
    case "video":
      return <FileVideo className={className} />;
    case "code":
    case "json":
    case "html":
      return <FileCode className={className} />;
    default:
      return <FileText className={className} />;
  }
}

/**
 * Right-hand sidebar that previews the file currently selected in the chat.
 * Switches viewer based on MIME type / extension; the user can drag the left
 * edge to resize, and the chosen width persists across sessions.
 */
export function FilePreviewPanel() {
  const file = useFilePreviewStore((s) => s.file);

  if (!file) return null;

  // Keyed on the file id so the inner component's lazily-initialized state
  // (panel width, cached blob URL) resets whenever a different file is
  // opened — no effects needed for the reset.
  return <FilePreviewContent key={file.id} />;
}

/**
 * Inner content — separated so hooks can live after the outer early-return
 * guard. Mounted only when a file is selected; remounted per file via key.
 */
function FilePreviewContent() {
  const file = useFilePreviewStore((s) => s.file);
  const close = useFilePreviewStore((s) => s.close);

  // Lazy initializers — read localStorage / the blob-URL cache exactly once
  // per mounted file instead of syncing through an effect.
  const [width, setWidth] = useState<number>(initialWidth);
  const [isDragging, setIsDragging] = useState(false);
  const [inlineUrl, setInlineUrl] = useState<string>(() =>
    file ? getFileUrl(file.id) : "",
  );
  const [urlError, setUrlError] = useState<string | null>(null);

  // Load the blob URL when it isn't already cached. `getFileUrl` is
  // synchronous and returns "" when the URL isn't warm (e.g. when opening a
  // file from conversation history). `loadFileUrl` reads the file from OPFS
  // and caches a fresh blob URL — without this, the viewers get url="" and
  // fetch("") throws "Failed to fetch".
  const fileId = file?.id;
  useEffect(() => {
    if (!fileId || getFileUrl(fileId)) return;
    let cancelled = false;
    loadFileUrl(fileId)
      .then((url) => {
        if (cancelled) return;
        if (url) {
          setInlineUrl(url);
        } else {
          setUrlError("File not found in local storage");
        }
      })
      .catch((e) => {
        if (!cancelled) setUrlError(e instanceof Error ? e.message : "Failed to load file");
      });
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => {
      // Width = distance from cursor to right edge of viewport.
      const next = clamp(window.innerWidth - e.clientX, MIN_WIDTH, MAX_WIDTH);
      setWidth(next);
    };
    const onUp = () => {
      setIsDragging(false);
      try {
        localStorage.setItem(STORAGE_KEY, String(width));
      } catch {
        /* private mode / quota — drop persistence silently */
      }
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDragging, width]);

  if (!file) return null;

  // For blob URLs, just use inlineUrl directly — the <a download> attribute
  // forces the browser to download. Appending ?disposition=attachment to a
  // blob: URL makes it invalid and breaks the download.
  const downloadUrl = inlineUrl;
  const ext = extOf(file.filename);
  const kind = previewKind(file.mime_type, ext);

  // Loading state while the blob URL is being fetched from OPFS.
  if (!inlineUrl && !urlError) {
    return (
      <aside
        className="border-foreground/10 bg-card relative flex h-full max-w-full shrink-0 flex-col border-l animate-slide-in-right"
        style={{ width: `${width}px` }}
        aria-label="File preview"
      >
        <header className="border-foreground/10 flex items-center gap-2 border-b px-3 py-2">
          <span className="bg-foreground/8 text-foreground/65 flex h-7 w-7 shrink-0 items-center justify-center rounded-md">
            <KindIcon kind={kind} className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-foreground truncate text-sm font-medium" title={file.filename}>
              {file.filename}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            className="text-foreground/55 hover:bg-foreground/5 hover:text-foreground inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors"
            aria-label="Close preview"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="text-foreground/55 flex min-h-0 flex-1 items-center justify-center gap-2 text-xs">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading file…
        </div>
      </aside>
    );
  }

  // Error state — file not in OPFS / load failed.
  if (urlError) {
    return (
      <aside
        className="border-foreground/10 bg-card relative flex h-full max-w-full shrink-0 flex-col border-l"
        style={{ width: `${width}px` }}
        aria-label="File preview"
      >
        <header className="border-foreground/10 flex items-center gap-2 border-b px-3 py-2">
          <span className="bg-foreground/8 text-foreground/65 flex h-7 w-7 shrink-0 items-center justify-center rounded-md">
            <KindIcon kind={kind} className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-foreground truncate text-sm font-medium" title={file.filename}>
              {file.filename}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            className="text-foreground/55 hover:bg-foreground/5 hover:text-foreground inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors"
            aria-label="Close preview"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="text-destructive/80 flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs">
          <p>Couldn&apos;t load file</p>
          <p className="text-foreground/55 font-mono text-[10px] tracking-wider uppercase">{urlError}</p>
          <p className="text-foreground/45 mt-2 max-w-[280px] leading-relaxed">
            The file may have been uploaded in a different browser session. Files are stored locally
            (OPFS) and don&apos;t sync across devices.
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside
      className="border-foreground/10 bg-card relative flex h-full max-w-full shrink-0 flex-col border-l"
      style={{ width: `${width}px` }}
      aria-label="File preview"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize file preview"
        onMouseDown={onMouseDown}
        className={cn(
          "group absolute top-0 left-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize",
          isDragging && "bg-foreground/20",
        )}
      >
        <div className="bg-foreground/0 group-hover:bg-foreground/15 absolute top-1/2 left-1/2 h-12 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors" />
      </div>

      <header className="border-foreground/10 flex items-center gap-2 border-b px-3 py-2">
        <span className="bg-foreground/8 text-foreground/65 flex h-7 w-7 shrink-0 items-center justify-center rounded-md">
          <KindIcon kind={kind} className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-foreground truncate text-sm font-medium" title={file.filename}>
            {file.filename}
          </p>
          <p className="text-foreground/50 truncate font-mono text-[10px] tracking-wider uppercase">
            {ext ?? file.mime_type ?? "file"}
          </p>
        </div>
        <a
          href={inlineUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground/55 hover:bg-foreground/5 hover:text-foreground inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors"
          title="Open in new tab"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <a
          href={downloadUrl}
          className="text-foreground/55 hover:bg-foreground/5 hover:text-foreground inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors"
          title="Download"
        >
          <Download className="h-3.5 w-3.5" />
        </a>
        <button
          type="button"
          onClick={close}
          className="text-foreground/55 hover:bg-foreground/5 hover:text-foreground inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors"
          aria-label="Close preview"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {/* Viewer — flex column so iframe/video can use h-full reliably */}
      <div className="flex min-h-0 flex-1 flex-col">
        <FilePreviewCard
          kind={kind}
          url={inlineUrl}
          downloadUrl={downloadUrl}
          filename={file.filename}
          ext={ext}
        />
      </div>
    </aside>
  );
}
