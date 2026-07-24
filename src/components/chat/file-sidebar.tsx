"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Folder,
  Download,
  FolderDown,
  MoreVertical,
  Pencil,
  Trash2,
  RefreshCw,
  ChevronRight,
  Home,
  Loader2,
  Search,
  ServerOff,
  Settings,
  Upload,
  FileText,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileArchive,
  FileType,
  File as FileIcon,
  Music,
  Video,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks";
import { getE2BClient, E2BClient, type E2BFile } from "@/lib/e2b/client";
import { settingsService } from "@/lib/services";

interface WorkspaceEntry {
  name: string;
  type: "file" | "dir";
  size: number;
}

interface WorkspaceListing {
  path: string;
  absolute: string;
  parent: string | null;
  entries: WorkspaceEntry[];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : "";
}

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

/** Color per file extension for the SVG icon — matches the FileCard badge colors. */
const FILE_ICON_COLORS: Record<string, string> = {
  // Code → blue
  py: "text-blue-500", js: "text-blue-500", ts: "text-blue-500", tsx: "text-blue-500",
  jsx: "text-blue-500", json: "text-blue-500", html: "text-blue-500", css: "text-blue-500",
  yaml: "text-blue-500", yml: "text-blue-500", sh: "text-blue-500", sql: "text-blue-500",
  xml: "text-blue-500",
  // Spreadsheets → green
  csv: "text-emerald-500", xls: "text-emerald-500", xlsx: "text-emerald-500", tsv: "text-emerald-500",
  // Images → purple
  png: "text-purple-500", jpg: "text-purple-500", jpeg: "text-purple-500", gif: "text-purple-500",
  svg: "text-purple-500", webp: "text-purple-500", bmp: "text-purple-500", ico: "text-purple-500",
  // Documents → red
  pdf: "text-rose-500", doc: "text-rose-500", docx: "text-rose-500",
  // Archives → amber
  zip: "text-amber-500", tar: "text-amber-500", gz: "text-amber-500", rar: "text-amber-500",
  "7z": "text-amber-500",
  // Media → teal
  mp3: "text-teal-500", wav: "text-teal-500", mp4: "text-teal-500", mov: "text-teal-500",
  avi: "text-teal-500", mkv: "text-teal-500",
};

/** Compute the parent path for breadcrumb navigation. "." is the root. */
function parentOf(path: string): string | null {
  if (path === "." || !path) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return ".";
  return parts.slice(0, -1).join("/");
}

function e2bFilesToListing(path: string, files: E2BFile[]): WorkspaceListing {
  const entries: WorkspaceEntry[] = files.map((f) => {
    // Extract the name from the path (the API doesn't return a separate name field).
    const name = f.path.split("/").filter(Boolean).pop() ?? f.path;
    // The E2B API returns type as "directory" or "file". Treat anything that
    // isn't exactly "file" as a directory (defensive — handles "FILE_TYPE_DIRECTORY"
    // and other enum variants that might slip through).
    const isDir = f.type !== "file";
    return {
      name,
      type: (isDir ? "dir" : "file") as "file" | "dir",
      size: f.size ?? 0,
    };
  });
  // Stable order: dirs first, then files, alphabetical within each group.
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return {
    path,
    absolute: path,
    parent: parentOf(path),
    entries,
  };
}

export function FileSidebar({ onRefreshKey }: { onRefreshKey?: string }) {
  const { user } = useAuth();
  const [client, setClient] = useState<E2BClient | null>(null);
  const [clientLoaded, setClientLoaded] = useState(false);
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [currentPath, setCurrentPath] = useState(".");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  // Bump on every "workspace might have changed" signal so the listing
  // re-fetches. Driven by both the parent's `onRefreshKey` prop and the
  // local WS-listener below.
  const [refreshTick, setRefreshTick] = useState(0);

  // Resolve the file system: E2B client (if key + mode allows) or local OPFS.
  const [useLocal, setUseLocal] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!user?.id) {
      setClientLoaded(false);
      setClient(null);
      return;
    }
    (async () => {
      try {
        const mode = await settingsService.getFileSystemMode(user.id);
        const apiKey = await settingsService.getDecryptedSandboxKey(user.id);
        if (cancelled) return;

        // ALWAYS use local (OPFS) for file storage. The E2B sandbox is only
        // a code runner — files are stored in OPFS and auto-synced to the
        // sandbox before code execution. This keeps the sidebar and the AI's
        // file tools looking at the same file system.
        setUseLocal(true);
        setClient(null);
        void mode; void apiKey; // referenced to avoid unused warnings
      } catch {
        if (!cancelled) {
          setUseLocal(true);
          setClient(null);
        }
      } finally {
        if (!cancelled) setClientLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const fetchListing = useCallback(
    async (path: string) => {
      setLoading(true);
      try {
        if (useLocal && user?.id) {
          // Local OPFS mode — list files with real sizes
          const { listDir } = await import("@/lib/storage/opfs");
          const subPath = path === "." ? "workspace" : `workspace/${path}`;
          const entries = await listDir(user.id, subPath);
          const fileEntries = entries.map((e) => ({
            name: e.name,
            type: (e.kind === "directory" ? "dir" : "file") as "file" | "dir",
            size: e.size ?? 0,
          }));
          setListing({
            path,
            absolute: path,
            parent: parentOf(path),
            entries: fileEntries,
          });
        } else if (client) {
          // E2B sandbox mode
          const files = await client.listFiles(path);
          setListing(e2bFilesToListing(path, files));
        }
      } catch (e) {
        console.warn("[file-sidebar] Failed to load files:", e);
        setListing(null);
      } finally {
        setLoading(false);
      }
    },
    [client, useLocal, user?.id],
  );

  // Auto-refresh when the agent completes a workspace-mutating tool call
  // (create_file / write_file / delete_file / run_terminal / etc.). The
  // chat-container's WS hook fires a window event for every tool_result;
  // we filter here to the names that actually change the workspace.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ tool_name: string }>).detail;
      const name = detail?.tool_name ?? "";
      if (
        [
          "create_file", "write_file", "edit_file", "delete_file",
          "create_folder", "delete_folder", "run_terminal", "send_file",
          "send_folder", "upload",
        ].includes(name)
      ) {
        setRefreshTick((t) => t + 1);
      }
    };
    window.addEventListener("tool_result", handler as EventListener);
    return () => window.removeEventListener("tool_result", handler as EventListener);
  }, []);

  // Fetch only when (a) a E2B client is available, (b) the path changes,
  // or (c) a workspace-mutating tool call signals a refresh. When client
  // is null we intentionally skip the fetch — calling listFiles() with no
  // API key is what produces the "failed to fetch" toast spam.
  useEffect(() => {
    if (client || useLocal) void fetchListing(currentPath);
    else if (clientLoaded) setLoading(false);
  }, [currentPath, fetchListing, onRefreshKey, refreshTick, client, useLocal, clientLoaded]);

  const navigateTo = (path: string) => {
    setCurrentPath(path);
    setSearch("");
  };

  const handleDownloadFile = async (entry: WorkspaceEntry) => {
    if (entry.type !== "file") return;
    const fullPath = currentPath === "." ? entry.name : `${currentPath}/${entry.name}`;
    try {
      let blob: Blob;
      if (useLocal && user?.id) {
        // Read as Blob (NOT readTextFile) to preserve binary data.
        // readTextFile decodes as UTF-8, which corrupts binary files
        // (e.g. 0xFF → EF BF BD, inflating 102KB → 184KB + breaking the file).
        const { readFile } = await import("@/lib/storage/opfs");
        blob = await readFile(`users/${user.id}/workspace/${fullPath}`);
      } else if (client) {
        // Use readFileBytes (returns Blob) not readFile (returns string).
        const result = await client.readFileBytes(fullPath);
        if (!result) return;
        blob = result;
      } else {
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = entry.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error("Download failed", {
        description: e instanceof Error ? e.message : "Unknown error",
      });
    }
  };

  const handleDownloadFolder = async (entry: WorkspaceEntry) => {
    if (entry.type !== "dir") return;
    const fullPath = currentPath === "." ? entry.name : `${currentPath}/${entry.name}`;
    try {
      if (useLocal && user?.id) {
        // Local mode: zip the folder from OPFS.
        // Read files as Blobs (not text) to preserve binary data.
        const { listDir, readFile } = await import("@/lib/storage/opfs");
        const { zipSync } = await import("fflate");
        const entries = await listDir(user.id, `workspace/${fullPath}`);
        const files: Record<string, Uint8Array> = {};
        for (const e of entries) {
          if (e.kind === "file") {
            try {
              const blob = await readFile(`users/${user.id}/workspace/${fullPath}/${e.name}`);
              const buf = new Uint8Array(await blob.arrayBuffer());
              files[e.name] = buf;
            } catch {}
          }
        }
        const zipped = zipSync(files);
        const blob = new Blob([zipped], { type: "application/zip" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${entry.name}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } else if (client) {
        const content = await client.readFile(fullPath);
        const blob = new Blob([content], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${entry.name}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      toast.error("Download failed", {
        description: e instanceof Error ? e.message : "Unknown error",
      });
    }
  };

  const entries = listing?.entries || [];
  const filtered = search
    ? entries.filter((e) => e.name.toLowerCase().includes(search.toLowerCase()))
    : entries;
  const dirs = filtered.filter((e) => e.type === "dir");
  const files = filtered.filter((e) => e.type === "file");

  // No sandbox: show an empty state instead of erroring on every keystroke.
  const noSandbox = clientLoaded && !client && !useLocal;

  // File upload from the sidebar — opens the native file selector, then
  // uploads the file to the sandbox (or OPFS in local mode). Shows a toast
  // with progress, then refreshes the file listing.
  const sidebarFileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingToSidebar, setUploadingToSidebar] = useState(false);

  const handleSidebarUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileInput = e.target;
    const files = fileInput.files;
    if (!files || files.length === 0) return;
    // Convert to array BEFORE clearing the input — some browsers nullify
    // the FileList reference when value is set to "".
    const fileArray = Array.from(files);
    fileInput.value = "";
    if (!user) {
      console.error("[file-sidebar] Upload aborted: no authenticated user");
      return;
    }

    setUploadingToSidebar(true);
    let successCount = 0;
    let failureCount = 0;
    const uploadedFileMetas: Array<{ name: string; size: number; mime_type: string; uploaded_at: string }> = [];
    for (const file of fileArray) {
      try {
        const { writeFileAtPath, isOPFSAvailable } = await import("@/lib/storage/opfs");
        if (!isOPFSAvailable()) {
          throw new Error("OPFS is not available in this browser");
        }
        const parts = file.name.split("/");
        const filename = (parts.pop() || file.name).replace(/[\\/]+/g, "_");
        const raw = new Uint8Array(await file.arrayBuffer());
        const buf = new ArrayBuffer(raw.byteLength);
        new Uint8Array(buf).set(raw);
        const blob = new Blob([buf], { type: file.type || "application/octet-stream" });
        const dirPath = `users/${user.id}/workspace`;
        await writeFileAtPath(dirPath, filename, blob);
        // Track metadata for the manifest file (invisible tagging for AI).
        uploadedFileMetas.push({
          name: filename,
          size: file.size,
          mime_type: file.type || "application/octet-stream",
          uploaded_at: new Date().toISOString(),
        });
        successCount++;
        toast.success(`Uploaded ${file.name}`);
      } catch (err) {
        failureCount++;
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error(`[file-sidebar] Failed to upload ${file.name}:`, err);
        toast.error(`Failed to upload ${file.name}: ${message}`);
      }
    }

    // === INVISIBLE FILE TAGGING FOR AI ===
    // Write/update a `.onyxagent_files.json` manifest in the workspace that
    // lists ALL uploaded files with their metadata. This file is synced to
    // the sandbox by syncOpfsToSandbox() before code execution, so the AI
    // can read it to discover what files exist in the workspace.
    if (successCount > 0 && user) {
      try {
        const { writeFileAtPath, listDir, readTextFile } = await import("@/lib/storage/opfs");
        const manifestPath = `users/${user.id}/workspace`;
        const manifestFile = ".onyxagent_files.json";

        // Read the existing manifest (if any) and merge new files.
        let existing: Array<{ name: string; size: number; mime_type: string; uploaded_at: string }> = [];
        try {
          const oldContent = await readTextFile(`${manifestPath}/${manifestFile}`);
          const parsed = JSON.parse(oldContent);
          if (Array.isArray(parsed)) existing = parsed;
        } catch {
          // No existing manifest — start fresh.
        }

        // Merge: add new files, deduplicate by name (keep latest).
        const byName = new Map<string, typeof uploadedFileMetas[number]>();
        for (const f of existing) byName.set(f.name, f);
        for (const f of uploadedFileMetas) byName.set(f.name, f);
        const merged = Array.from(byName.values());

        await writeFileAtPath(manifestPath, manifestFile, JSON.stringify({
          description: "Auto-generated manifest of uploaded files. The AI can read this to discover what files exist in the workspace.",
          generated_at: new Date().toISOString(),
          files: merged,
        }, null, 2));
      } catch (manifestErr) {
        console.warn("[file-sidebar] Failed to write file manifest:", manifestErr);
      }
    }

    setUploadingToSidebar(false);

    setRefreshTick((t) => t + 1);
    try {
      await fetchListing(currentPath);
    } catch (e) {
      console.error("[file-sidebar] Post-upload listing refresh failed:", e);
    }

    if (successCount > 0 && failureCount === 0) {
      toast.success(`Uploaded ${successCount} file${successCount !== 1 ? "s" : ""}`);
    } else if (failureCount > 0 && successCount > 0) {
      toast.message(`Uploaded ${successCount}, failed ${failureCount}`);
    }
  }, [user, currentPath, fetchListing]);

  return (
    <div className="flex h-full flex-col bg-card">
      {/* Hidden file input for sidebar uploads — sr-only (NOT display:none)
       * so .click() works reliably across all browsers + mobile WebViews. */}
      <input
        ref={sidebarFileInputRef}
        type="file"
        onChange={handleSidebarUpload}
        multiple
        className="sr-only"
        id="sidebar-upload-input"
      />
      {/* Header */}
      <div className="border-b border-border px-3 py-3 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <Folder className="h-4 w-4" />
            Files
          </h3>
          <div className="flex items-center gap-1">
            {/* Upload button — opens the native file selector */}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => sidebarFileInputRef.current?.click()}
              disabled={uploadingToSidebar}
              className="h-8 w-8 p-0"
              title="Upload file"
              aria-label="Upload file"
            >
              {uploadingToSidebar ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
            </Button>
            {/* Refresh button */}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => fetchListing(currentPath)}
              disabled={loading}
              className="h-8 w-8 p-0"
              title="Refresh"
              aria-label="Refresh file list"
            >
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </Button>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input
            placeholder="Search files..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 pl-7 text-xs"
            disabled={noSandbox}
          />
        </div>
        {/* Breadcrumb */}
        <div className="flex items-center gap-1 text-xs text-muted-foreground overflow-x-auto scrollbar-thin">
          <button
            onClick={() => navigateTo(".")}
            className="hover:text-foreground transition-colors shrink-0"
          >
            <Home className="h-3 w-3" />
          </button>
          {currentPath !== "." &&
            currentPath
              .split("/")
              .filter(Boolean)
              .map((part, idx, arr) => {
                const path = arr.slice(0, idx + 1).join("/");
                return (
                  <span key={path} className="flex items-center gap-1 shrink-0">
                    <ChevronRight className="h-3 w-3" />
                    <button
                      onClick={() => navigateTo(path)}
                      className="hover:text-foreground transition-colors"
                    >
                      {part}
                    </button>
                  </span>
                );
              })}
        </div>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {loading && !listing ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : noSandbox ? (
          <div className="flex flex-col gap-4 px-3 py-4">
            {/* OPFS Skills section — shows even without E2B sandbox */}
            <OPFSSkillsSection userId={user?.id} />
            {/* No sandbox warning */}
            <div className="flex flex-col items-center justify-center text-center gap-2 pt-4 border-t border-border">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <ServerOff className="h-4 w-4" />
              </div>
              <p className="text-xs font-medium text-foreground">No sandbox available</p>
              <p className="text-[11px] text-muted-foreground max-w-[200px] leading-relaxed">
                Add an E2B Sandbox API key in{" "}
                <Link href="/settings/config" className="font-medium text-foreground underline underline-offset-2">
                  Settings → Config
                </Link>{" "}
                to enable workspace files.
              </p>
            </div>
          </div>
        ) : !listing ? (
          <div className="text-center py-8 text-sm text-muted-foreground px-4">
            No files yet. Ask the AI to create a file or upload one in chat.
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground px-4">
            {search ? "No matching files." : "This folder is empty."}
          </div>
        ) : (
          <ul className="py-1 animate-fade-in">
            {/* Parent dir link */}
            {listing.parent && (
              <li>
                <button
                  onClick={() => navigateTo(listing.parent!)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-foreground/5 transition-colors"
                >
                  <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">..</span>
                </button>
              </li>
            )}
            {/* Directories */}
            {dirs.map((entry) => {
              const fullPath =
                currentPath === "." ? entry.name : `${currentPath}/${entry.name}`;
              return (
                <li
                  key={entry.name}
                  className="group flex items-center hover:bg-foreground/5 transition-colors"
                >
                  <button
                    onClick={() => navigateTo(fullPath)}
                    className="flex flex-1 items-center gap-2 px-3 py-1.5 text-xs min-w-0"
                  >
                    <Folder className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                    <span className="truncate">{entry.name}</span>
                  </button>
                  <FileItemMenu
                    entry={entry}
                    onDownload={() => handleDownloadFolder(entry)}
                    onDelete={async () => {
                      if (!user) return;
                      try {
                        const { removeDir } = await import("@/lib/storage/opfs");
                        await removeDir(user.id, `workspace/${fullPath}`);
                        toast.success(`Deleted folder: ${entry.name}`);
                        fetchListing(currentPath);
                      } catch (e) {
                        toast.error(`Delete failed: ${e instanceof Error ? e.message : "Unknown"}`);
                      }
                    }}
                    onRename={async (newName) => {
                      if (!user || !newName.trim()) return;
                      try {
                        const { readFile, writeFile, removeDir } = await import("@/lib/storage/opfs");
                        const parentPath = currentPath === "." ? "" : currentPath;
                        // Read all files in old folder, write to new folder, delete old
                        const oldEntries = await (await import("@/lib/storage/opfs")).listDir(user.id, `workspace/${fullPath}`);
                        for (const e of oldEntries) {
                          if (e.kind === "file") {
                            const content = await readFile(`users/${user.id}/workspace/${fullPath}/${e.name}`);
                            await writeFile(user.id, `workspace/${parentPath ? parentPath + "/" : ""}${newName}`, e.name, content);
                          }
                        }
                        await removeDir(user.id, `workspace/${fullPath}`);
                        toast.success(`Renamed to: ${newName}`);
                        fetchListing(currentPath);
                      } catch (e) {
                        toast.error(`Rename failed: ${e instanceof Error ? e.message : "Unknown"}`);
                      }
                    }}
                  />
                </li>
              );
            })}
            {/* Files */}
            {files.map((entry) => {
              const ext = fileExtension(entry.name);
              const IconComp = EXT_ICONS[ext] || FileIcon;
              const iconColor = FILE_ICON_COLORS[ext] || "text-muted-foreground";
              return (
                <li
                  key={entry.name}
                  className="group flex items-center hover:bg-foreground/5 transition-colors"
                >
                  <div className="flex flex-1 items-center gap-2 px-3 py-1.5 text-xs min-w-0">
                    <IconComp className={cn("h-3.5 w-3.5 shrink-0", iconColor)} />
                    <span className="truncate" title={entry.name}>
                      {entry.name}
                    </span>
                    <span className="text-muted-foreground text-[10px] shrink-0 ml-auto pr-1">
                      {formatSize(entry.size)}
                    </span>
                  </div>
                  <FileItemMenu
                    entry={entry}
                    onDownload={() => handleDownloadFile(entry)}
                    onDelete={async () => {
                      if (!user) return;
                      try {
                        const { deleteFile } = await import("@/lib/storage/opfs");
                        const fullPath = currentPath === "." ? entry.name : `${currentPath}/${entry.name}`;
                        await deleteFile(`users/${user.id}/workspace/${fullPath}`);
                        toast.success(`Deleted: ${entry.name}`);
                        fetchListing(currentPath);
                      } catch (e) {
                        toast.error(`Delete failed: ${e instanceof Error ? e.message : "Unknown"}`);
                      }
                    }}
                    onRename={async (newName) => {
                      if (!user || !newName.trim()) return;
                      try {
                        const { readTextFile, writeFile, deleteFile } = await import("@/lib/storage/opfs");
                        const fullPath = currentPath === "." ? entry.name : `${currentPath}/${entry.name}`;
                        const parentDir = currentPath === "." ? "" : currentPath;
                        const content = await readTextFile(`users/${user.id}/workspace/${fullPath}`);
                        await writeFile(user.id, `workspace/${parentDir ? parentDir + "/" : ""}`, newName, content);
                        await deleteFile(`users/${user.id}/workspace/${fullPath}`);
                        toast.success(`Renamed to: ${newName}`);
                        fetchListing(currentPath);
                      } catch (e) {
                        toast.error(`Rename failed: ${e instanceof Error ? e.message : "Unknown"}`);
                      }
                    }}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Footer stats */}
      {listing && (
        <div className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
          {dirs.length} folders · {files.length} files
        </div>
      )}
    </div>
  );
}

// ---- OPFS Skills Section ----
// Shows installed skills from OPFS when no E2B sandbox is available.
function OPFSSkillsSection({ userId }: { userId?: string }) {
  const [skills, setSkills] = useState<Array<{ name: string; description?: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [skillContent, setSkillContent] = useState<string>("");

  useEffect(() => {
    if (!userId) return;
    (async () => {
      try {
        const { skillService } = await import("@/lib/services");
        const rows = await skillService.list(userId);
        setSkills(rows.map((r) => ({ name: r.name, description: r.description ?? undefined })));
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    })();
  }, [userId]);

  const readSkill = async (name: string) => {
    if (expandedSkill === name) {
      setExpandedSkill(null);
      return;
    }
    setExpandedSkill(name);
    setSkillContent("Loading…");
    try {
      const { skillService } = await import("@/lib/services");
      const { readTextFile } = await import("@/lib/storage/opfs");
      const skill = await skillService.getByName(userId!, name);
      if (skill) {
        const content = await readTextFile(`${skill.dir_path}/SKILL.md`);
        setSkillContent(content || "(empty)");
      } else {
        setSkillContent("Skill not found in database.");
      }
    } catch (e) {
      setSkillContent(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (loading) {
    return (
      <div className="text-xs text-muted-foreground p-2">Loading skills…</div>
    );
  }

  if (skills.length === 0) {
    return (
      <div className="text-xs text-muted-foreground p-2">
        No installed skills. Install skills from{" "}
        <Link href="/settings/skills" className="underline">Settings → Skills</Link>.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground px-1 pb-1">
        Installed skills ({skills.length})
      </p>
      {skills.map((skill) => (
        <div key={skill.name}>
          <button
            onClick={() => readSkill(skill.name)}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-xs hover:bg-foreground/5 rounded transition-colors"
          >
            <span className="text-sm">📘</span>
            <span className="truncate font-medium">{skill.name}</span>
            {expandedSkill === skill.name && (
              <ChevronRight className="h-3 w-3 ml-auto rotate-90 transition-transform" />
            )}
          </button>
          {expandedSkill === skill.name && (
            <pre className="max-h-48 overflow-auto rounded bg-muted/50 p-2 mx-1 mb-1 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {skillContent}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

// ---- File Item Menu (three-dot menu) ----
function FileItemMenu({
  entry,
  onDownload,
  onDelete,
  onRename,
}: {
  entry: WorkspaceEntry;
  onDownload: () => void;
  onDelete: () => void;
  onRename: (newName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(entry.name);

  const handleRename = () => {
    setRenaming(false);
    setOpen(false);
    if (newName.trim() && newName !== entry.name) {
      onRename(newName.trim());
    }
  };

  if (renaming) {
    return (
      <div className="flex items-center gap-1 px-2">
        <input
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleRename();
            if (e.key === "Escape") { setRenaming(false); setOpen(false); }
          }}
          onBlur={handleRename}
          className="h-6 w-32 rounded border border-border bg-background px-1.5 text-xs"
        />
      </div>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          className="px-2 py-1 text-muted-foreground hover:text-foreground"
          title="More options"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem onClick={() => { setOpen(false); onDownload(); }}>
          <Download className="h-3.5 w-3.5 mr-2" /> Download
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => { setOpen(false); setRenaming(true); }}>
          <Pencil className="h-3.5 w-3.5 mr-2" /> Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => { setOpen(false); onDelete(); }}
          className="text-rose-600 focus:text-rose-600"
        >
          <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
