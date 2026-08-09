"use client";

import { useState } from "react";
import { Download, Folder, Loader2, FileArchive } from "lucide-react";
import { cn } from "@/lib/utils";

export interface FileDownloadPayload {
  kind: "file_download";
  item_type: "file" | "folder";
  name: string;
  path: string;
  size: number;
  size_human: string;
  file_count?: number;
  extension?: string;
  download_url: string;
}

/** Parse a tool result into a FileDownloadPayload, or null if it isn't a
 *  valid file_download payload. Accepts BOTH shapes:
 *   - string: live WS event results (JSON.stringify of the tool handler's
 *     return value, set by `tool_result` in use-chat.ts).
 *   - object: persisted DB results (the tool handler's return value is
 *     stored as-is by runtime.ts and rehydrated by conversation-to-chat.ts).
 *  Without the object branch, reloading a conversation would fall through
 *  to GenericToolResult and render the raw JSON — including the entire
 *  base64 data URL — as visible text. */
export function parseFileDownloadResult(result: unknown): FileDownloadPayload | null {
  let parsed: unknown = result;
  if (typeof result === "string") {
    const trimmed = result.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  // The tool result is wrapped as { success, output: { kind: "file_download", ... } }
  // Check `.output` first, then fall back to bare spec.
  const output = obj.output as Record<string, unknown> | undefined;
  const target = (output && typeof output === "object" && output.kind === "file_download")
    ? output
    : (obj.kind === "file_download" ? obj : null);
  if (!target) return null;
  if (!target.download_url || typeof target.download_url !== "string") return null;
  return target as unknown as FileDownloadPayload;
}

const EXT_ICONS: Record<string, string> = {
  md: "📝",
  txt: "📄",
  py: "🐍",
  js: "📜",
  ts: "📜",
  tsx: "⚛️",
  jsx: "⚛️",
  json: "⚙️",
  html: "🌐",
  css: "🎨",
  csv: "📊",
  png: "🖼️",
  jpg: "🖼️",
  jpeg: "🖼️",
  gif: "🖼️",
  svg: "🖼️",
  pdf: "📕",
  doc: "📘",
  docx: "📘",
  xls: "📗",
  xlsx: "📗",
  zip: "📦",
  mp3: "🎵",
  mp4: "🎬",
  wav: "🎵",
};

/** A clickable download card for a file or folder returned by the
 *  `send_file` / `send_folder` agent tools. Clicking it triggers a
 *  download (single file, or a zip of the folder's contents). */
export function FileDownloadResult({ payload }: { payload: FileDownloadPayload }) {
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  const isFolder = payload.item_type === "folder";
  const ext = (payload.extension || "").toLowerCase();
  const emoji = isFolder ? "📁" : EXT_ICONS[ext] || "📄";

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      // Convert data: URLs → Blob → object URL before triggering the
      // download. Direct data: URLs can fail silently for large payloads
      // (browser size limits vary, and anchor.click() doesn't throw when
      // it refuses to navigate) — the user just sees nothing happen.
      // Going through a Blob sidesteps those limits AND lets us surface
      // real errors via the catch block.
      const url = payload.download_url;
      let downloadUrl: string;
      let shouldRevoke = false;
      if (url.startsWith("data:")) {
        const resp = await fetch(url);
        const blob = await resp.blob();
        downloadUrl = URL.createObjectURL(blob);
        shouldRevoke = true;
      } else {
        downloadUrl = url;
      }
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = isFolder ? `${payload.name}.zip` : payload.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (shouldRevoke) {
        // Defer revoke — some browsers need the URL to survive the
        // dispatch cycle of the click event.
        setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      }
      setDownloaded(true);
    } catch (e) {
      console.error("Download failed:", e);
      alert(`Download failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <button
      onClick={handleDownload}
      disabled={downloading}
      className={cn(
        "group flex w-full items-center gap-3 rounded-xl border bg-card p-3 text-left transition-all hover:shadow-md hover:border-foreground/30",
        "animate-fade-in focus:outline-none focus:ring-2 focus:ring-primary/40",
        downloading && "opacity-70 cursor-wait",
        downloaded && "border-brand/40",
      )}
    >
      {/* Icon */}
      <div
        className={cn(
          "flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-2xl",
          isFolder ? "bg-blue-500/10" : "bg-muted",
        )}
      >
        {isFolder ? (
          <Folder className="h-6 w-6 text-blue-500" />
        ) : (
          <span className="leading-none">{emoji}</span>
        )}
      </div>

      {/* Name + metadata */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{payload.name}</span>
          {isFolder ? (
            <span className="shrink-0 rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-600">
              ZIP
            </span>
          ) : ext ? (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase">
              {ext}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span>{payload.size_human}</span>
          {isFolder && payload.file_count !== undefined && (
            <>
              <span>·</span>
              <span>
                {payload.file_count} {payload.file_count === 1 ? "file" : "files"}
              </span>
            </>
          )}
          {downloaded && (
            <>
              <span>·</span>
              <span className="text-brand">Downloaded</span>
            </>
          )}
        </div>
      </div>

      {/* Download icon / spinner */}
      <div className="shrink-0 p-2 rounded-lg bg-foreground/5 group-hover:bg-foreground/10 transition-colors">
        {downloading ? (
          <Loader2 className="h-5 w-5 animate-spin text-foreground" />
        ) : isFolder ? (
          <FileArchive className="h-5 w-5 text-foreground" />
        ) : (
          <Download className="h-5 w-5 text-foreground" />
        )}
      </div>
    </button>
  );
}
