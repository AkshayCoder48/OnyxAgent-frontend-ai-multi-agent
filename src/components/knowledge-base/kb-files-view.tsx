"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Clock,
  Copy,
  ExternalLink,
  FileText,
  Link2,
  Loader2,
  Paperclip,
  Trash2,
} from "lucide-react";
import type { KBClients } from "@/lib/onyxbase/kb-store";
import {
  formatBytes,
  type OnyxBaseFile,
  type OnyxBaseFileLink,
} from "@/lib/onyxbase/files-client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { kbErrorMessage, timeAgo } from "./kb-shared";

interface KBFilesViewProps {
  clients: KBClients;
  /** Bumped by the parent's refresh / after mutations. */
  refreshKey: number;
  /** Notify the parent so the storage strip re-reads stats(). */
  onChanged: () => void;
}

/** The file's human-facing name (label first, then original name). */
function fileLabel(f: OnyxBaseFile): string {
  return f.label || f.name || f.fileId || f.id;
}

/** Hosted-file share URL — proxyUrl is preferred, made absolute when relative. */
function shareUrl(link: OnyxBaseFileLink, baseUrl: string): string {
  const url = link.proxyUrl || link.url;
  if (/^https?:\/\//i.test(url)) return url;
  return `${baseUrl.replace(/\/+$/, "")}${url.startsWith("/") ? "" : "/"}${url}`;
}

/**
 * Files tab — items hosted in the OnyxBase file store via the AI's
 * knowledge_base tool. They outlive the sandbox; links are freshly minted
 * (~55-min signed tokens) on demand.
 */
export function KBFilesView({ clients, refreshKey, onChanged }: KBFilesViewProps) {
  const [files, setFiles] = React.useState<OnyxBaseFile[]>([]);
  const [maxBytes, setMaxBytes] = React.useState<number | undefined>(undefined);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [linkFile, setLinkFile] = React.useState<OnyxBaseFile | null>(null);
  const [link, setLink] = React.useState<OnyxBaseFileLink | null>(null);
  const [minting, setMinting] = React.useState(false);
  const [mintingFor, setMintingFor] = React.useState<string | null>(null);
  const [deleteFile, setDeleteFile] = React.useState<OnyxBaseFile | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const reload = React.useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError(null);
      try {
        const listing = await clients.files.list();
        setFiles(listing.files);
        setMaxBytes(listing.maxFileUploadBytes);
      } catch (e) {
        setError(kbErrorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [clients],
  );

  React.useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  async function openLinkDialog(file: OnyxBaseFile) {
    setLinkFile(file);
    setLink(null);
    setMinting(true);
    try {
      setLink(await clients.files.mintLink(file.id));
    } catch (e) {
      toast.error("Could not mint a link", { description: kbErrorMessage(e) });
      setLinkFile(null);
    } finally {
      setMinting(false);
    }
  }

  async function copyLink(file: OnyxBaseFile) {
    setMintingFor(file.id);
    try {
      const fresh = await clients.files.mintLink(file.id);
      await navigator.clipboard.writeText(shareUrl(fresh, clients.baseUrl));
      toast.success("Link copied", {
        description: "Fresh signed link — expires in about 55 minutes.",
      });
    } catch (e) {
      toast.error("Could not copy the link", { description: kbErrorMessage(e) });
    } finally {
      setMintingFor(null);
    }
  }

  async function handleDelete() {
    if (!deleteFile) return;
    setDeleting(true);
    try {
      await clients.files.deleteFile(deleteFile.id);
      toast.success("File deleted", { description: fileLabel(deleteFile) });
      setDeleteFile(null);
      await reload(true);
      onChanged();
    } catch (e) {
      toast.error("Could not delete the file", { description: kbErrorMessage(e) });
    } finally {
      setDeleting(false);
    }
  }

  const currentUrl = link ? shareUrl(link, clients.baseUrl) : "";

  return (
    <div className="space-y-4">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm leading-relaxed text-muted-foreground">
        <Paperclip aria-hidden className="h-4 w-4 shrink-0" />
        <span>
          Important files the AI hosts here live beyond any single sandbox session — share them with
          freshly minted links.
        </span>
        {typeof maxBytes === "number" && (
          <span className="rounded-md bg-foreground/[0.05] px-2 py-0.5 font-mono text-[11px] text-foreground/70">
            up to {formatBytes(maxBytes)} per file
          </span>
        )}
      </p>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Could not list hosted files</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && files.length === 0 && !error ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : !error && files.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-14 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-foreground/[0.04]">
            <FileText aria-hidden className="h-5 w-5 text-muted-foreground" />
          </div>
          <h3 className="mt-4 font-display text-base font-semibold text-foreground">
            No files hosted yet
          </h3>
          <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
            The AI can host important files here via the Knowledge Base tool (they outlive the
            sandbox).
          </p>
        </div>
      ) : (
        <div className="scrollbar-thin max-h-[65dvh] space-y-3 overflow-y-auto pr-1">
          {files.map((f) => (
            <div
              key={f.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-foreground/20"
            >
              <div className="flex min-w-0 items-start gap-3">
                <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.04]">
                  <FileText aria-hidden className="h-4 w-4 text-muted-foreground" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{fileLabel(f)}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {formatBytes(f.size)}
                    {" · "}
                    uploaded {timeAgo(f.uploadedAt ?? f.createdAt)}
                    {f.fileId ? (
                      <>
                        {" · "}
                        <span className="font-mono">{f.fileId}</span>
                      </>
                    ) : null}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {/* min-h/w-11 = 44px touch targets (spec). */}
                <IconButton
                  size="icon"
                  className="min-h-11 min-w-11"
                  aria-label={`Get a link for ${fileLabel(f)}`}
                  onClick={() => void openLinkDialog(f)}
                >
                  <Link2 aria-hidden />
                </IconButton>
                <IconButton
                  size="icon"
                  className="min-h-11 min-w-11"
                  aria-label={`Copy a fresh link for ${fileLabel(f)}`}
                  disabled={mintingFor === f.id}
                  onClick={() => void copyLink(f)}
                >
                  {mintingFor === f.id ? (
                    <Loader2 aria-hidden className="animate-spin" />
                  ) : (
                    <Copy aria-hidden />
                  )}
                </IconButton>
                <IconButton
                  size="icon"
                  className="min-h-11 min-w-11 text-muted-foreground hover:text-destructive"
                  aria-label={`Delete ${fileLabel(f)}`}
                  onClick={() => setDeleteFile(f)}
                >
                  <Trash2 aria-hidden />
                </IconButton>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Share-link dialog — a fresh ~55-min signed link. */}
      <Dialog
        open={linkFile !== null}
        onOpenChange={(o) => {
          if (!o) {
            setLinkFile(null);
            setLink(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Share link</DialogTitle>
            <DialogDescription className="truncate">
              {linkFile ? fileLabel(linkFile) : "Hosted file"}
            </DialogDescription>
          </DialogHeader>
          {minting ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />
              Minting a fresh link…
            </div>
          ) : link ? (
            <>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={currentUrl}
                  aria-label="File link"
                  className="font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="min-h-11 min-w-11"
                  aria-label="Copy link"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(currentUrl)
                      .then(() => toast.success("Link copied"))
                      .catch(() => toast.error("Copy failed"));
                  }}
                >
                  <Copy aria-hidden />
                </Button>
              </div>
              <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
                <Clock aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Signed link — expires in about 55 minutes. Mint a fresh one anytime.
              </p>
              <div className="flex justify-end">
                <Button asChild variant="ghost" size="sm">
                  <a href={currentUrl} target="_blank" rel="noopener noreferrer">
                    Open
                    <ExternalLink aria-hidden />
                  </a>
                </Button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteFile !== null} onOpenChange={(o) => !o && setDeleteFile(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this file?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleteFile ? fileLabel(deleteFile) : "This file"}” will be permanently removed from
              OnyxBase storage. Existing links will stop working. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? <Loader2 aria-hidden className="animate-spin" /> : <Trash2 aria-hidden />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
