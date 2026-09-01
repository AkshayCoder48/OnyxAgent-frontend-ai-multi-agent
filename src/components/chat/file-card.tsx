"use client";

import { X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shared file card component — used in both the chat input (attached files)
 * and the sent message bubble (file attachments on user messages).
 *
 * Matches the reference design:
 *   ┌──────────────────────────────────────┐
 *   │ ┌────┐  filename.truncate...    [X]  │
 *   │ │CSV │  CSV · 292.0 B                │
 *   │ └────┘                                │
 *   └──────────────────────────────────────┘
 *
 * The colored badge on the left shows the file extension (uppercase, 3 chars
 * max). Different extensions get different colors:
 *   - csv/xls/xlsx → green
 *   - py/js/ts/json → blue
 *   - md/txt → gray
 *   - png/jpg/svg → terracotta
 *   - pdf/doc → red
 *   - default → gray
 */

interface FileCardProps {
  filename: string;
  size?: number;
  mimeType?: string;
  /** When provided, clicking opens the file preview. */
  onClick?: () => void;
  /** When provided, shows the remove (X) button. */
  onRemove?: () => void;
  /** When provided, clicking opens in new tab (legacy fallback). */
  href?: string;
  /** Compact variant for smaller spaces. */
  compact?: boolean;
  /** Upload progress (0-100). When > 0 and < 100, shows a progress bar. */
  uploadProgress?: number;
  className?: string;
}

/** Extension → color class mapping for the badge. */
function badgeColorFor(ext: string): string {
  const e = ext.toLowerCase();
  // Green: spreadsheets/data
  if (["csv", "xls", "xlsx", "tsv"].includes(e)) {
    return "bg-emerald-500 text-white";
  }
  // Blue: code
  if (["py", "js", "ts", "tsx", "jsx", "json", "yaml", "yml", "toml", "sh", "sql"].includes(e)) {
    return "bg-blue-500 text-white";
  }
  // Purple: images
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"].includes(e)) {
    return "bg-[#c4552f] text-white";
  }
  // Red: documents
  if (["pdf", "doc", "docx"].includes(e)) {
    return "bg-rose-500 text-white";
  }
  // Amber: archives
  if (["zip", "tar", "gz", "rar", "7z"].includes(e)) {
    return "bg-amber-500 text-white";
  }
  // Teal: media
  if (["mp3", "mp4", "wav", "avi", "mov", "mkv", "flv"].includes(e)) {
    return "bg-teal-500 text-white";
  }
  // Default gray: md, txt, html, css, etc.
  return "bg-muted-foreground/60 text-white";
}

function formatSize(bytes: number | undefined): string | null {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getExt(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : "";
}

export function FileCard({
  filename,
  size,
  mimeType: _mimeType,
  onClick,
  onRemove,
  href,
  compact = false,
  uploadProgress,
  className,
}: FileCardProps) {
  const ext = getExt(filename);
  const sizeStr = formatSize(size);
  const badgeColor = badgeColorFor(ext);
  const badgeLabel = ext ? ext.slice(0, 4).toUpperCase() : "FILE";

  // Upload in progress — show a progress bar overlay.
  const isUploading = uploadProgress !== undefined && uploadProgress >= 0 && uploadProgress < 100;
  const progressPct = isUploading ? Math.round(uploadProgress ?? 0) : 100;

  // Truncate filename to ~24 chars
  const displayName =
    filename.length > 28
      ? filename.slice(0, 25) + "…"
      : filename;

  // Subtitle: "EXT · SIZE" or just one of them. While uploading, show the
  // percentage instead of the size.
  const subtitleParts: string[] = [];
  if (ext) subtitleParts.push(ext.toUpperCase());
  if (isUploading) {
    subtitleParts.push(`Uploading… ${progressPct}%`);
  } else if (sizeStr) {
    subtitleParts.push(sizeStr);
  }
  const subtitle = subtitleParts.join(" · ");

  const inner = (
    <>
      {/* Colored extension badge */}
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-lg font-mono text-[9px] font-bold tracking-tight",
          compact ? "h-8 w-8 text-[8px]" : "h-9 w-9 text-[9px]",
          badgeColor,
          isUploading && "opacity-50",
        )}
      >
        {isUploading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          badgeLabel
        )}
      </div>
      {/* Filename + subtitle */}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <span
          className={cn(
            "truncate font-medium text-foreground leading-tight",
            compact ? "text-[11px]" : "text-xs",
          )}
        >
          {displayName}
        </span>
        {subtitle && (
          <span className="text-[10px] text-muted-foreground leading-tight">
            {subtitle}
          </span>
        )}
        {/* Progress bar — shown while uploading */}
        {isUploading && (
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-200 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}
      </div>
      {/* Remove button (only in input mode, and only when not uploading) */}
      {onRemove && !isUploading && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="hover:bg-muted ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors"
          aria-label={`Remove ${filename}`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </>
  );

  const baseClass = cn(
    "group relative flex items-center gap-2.5 rounded-xl border border-border bg-card transition-colors",
    compact ? "max-w-[200px] px-2 py-1.5" : "max-w-[240px] px-2.5 py-2",
    (onClick || href) && "cursor-pointer hover:border-foreground/30",
    className,
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={baseClass} title={filename}>
        {inner}
      </button>
    );
  }

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={baseClass}
        title={filename}
      >
        {inner}
      </a>
    );
  }

  return (
    <div className={baseClass} title={filename}>
      {inner}
    </div>
  );
}

/**
 * FileCardImage — variant for image files that shows a thumbnail preview
 * instead of the colored badge. Used when the file is an image and a
 * preview URL is available.
 */
export function FileCardImage({
  filename,
  previewUrl,
  size,
  onClick,
  onRemove,
  compact = false,
}: {
  filename: string;
  previewUrl: string;
  size?: number;
  onClick?: () => void;
  onRemove?: () => void;
  compact?: boolean;
}) {
  const sizeStr = formatSize(size);
  const displayName =
    filename.length > 28 ? filename.slice(0, 25) + "…" : filename;

  const inner = (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={previewUrl}
        alt={filename}
        className={cn(
          "shrink-0 rounded-lg object-cover",
          compact ? "h-8 w-8" : "h-9 w-9",
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <span
          className={cn(
            "truncate font-medium text-foreground leading-tight",
            compact ? "text-[11px]" : "text-xs",
          )}
        >
          {displayName}
        </span>
        {sizeStr && (
          <span className="text-[10px] text-muted-foreground leading-tight">
            {sizeStr}
          </span>
        )}
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="hover:bg-muted ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors"
          aria-label={`Remove ${filename}`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </>
  );

  const baseClass = cn(
    "group relative flex items-center gap-2.5 rounded-xl border border-border bg-card transition-colors",
    compact ? "max-w-[200px] px-2 py-1.5" : "max-w-[240px] px-2.5 py-2",
    onClick && "cursor-pointer hover:border-foreground/30",
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={baseClass} title={filename}>
        {inner}
      </button>
    );
  }

  return (
    <div className={baseClass} title={filename}>
      {inner}
    </div>
  );
}
