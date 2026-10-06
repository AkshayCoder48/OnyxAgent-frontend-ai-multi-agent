"use client";

import * as React from "react";
import { toast } from "sonner";
import { Copy, Loader2, Paperclip, Pencil, Trash2 } from "lucide-react";
import type { OnyxBaseKV } from "@/lib/onyxbase/kv-client";
import { kbDelete, kbGet, kbUpdate, type KBItem, type KBItemSummary } from "@/lib/onyxbase/kb-store";
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
import { Button } from "@/components/ui/button";
import { KBItemForm } from "./kb-item-form";
import { AISavedBadge, TypeBadge, formatDateTime, kbErrorMessage, timeAgo } from "./kb-shared";

interface KBItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kv: OnyxBaseKV;
  userId: string;
  itemId: string | null;
  /** Summary of the opened row — powers the header instantly while kbGet runs. */
  summary: KBItemSummary | null;
  /** Open straight into edit mode (card "Edit" action). */
  initialEdit?: boolean;
  onSaved: () => void;
  onDeleted: () => void;
}

/**
 * Knowledge item detail dialog — read-only view (with copy) plus an edit mode
 * (title / type / category / tags / content) backed by kbUpdate. Full content
 * is fetched lazily via kbGet each time the dialog opens.
 */
export function KBItemDialog({
  open,
  onOpenChange,
  kv,
  userId,
  itemId,
  summary,
  initialEdit = false,
  onSaved,
  onDeleted,
}: KBItemDialogProps) {
  const [item, setItem] = React.useState<KBItem | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  // Fetch the full item (content included) each time the dialog opens.
  React.useEffect(() => {
    if (!open || !itemId) return;
    let cancelled = false;
    setItem(null);
    setLoading(true);
    setLoadError(null);
    setEditing(initialEdit);
    (async () => {
      try {
        const full = await kbGet(kv, userId, itemId);
        if (cancelled) return;
        if (!full) {
          setLoadError("This item could not be found — it may have been deleted elsewhere.");
        } else {
          setItem(full);
        }
      } catch (e) {
        if (!cancelled) setLoadError(kbErrorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, itemId, kv, userId, initialEdit]);

  /** What the header shows — the loaded item, else the row summary. */
  const display: KBItemSummary | null = item ?? summary;

  async function handleCopy() {
    if (!item) return;
    try {
      await navigator.clipboard.writeText(item.content);
      toast.success("Copied to clipboard", { description: item.title });
    } catch (e) {
      toast.error("Copy failed", { description: kbErrorMessage(e) });
    }
  }

  async function handleSave(values: {
    title: string;
    type: KBItem["type"];
    category: string | null;
    tags: string[];
    content: string;
  }) {
    if (!itemId) return;
    setSaving(true);
    try {
      const updated = await kbUpdate(kv, userId, itemId, values);
      setItem(updated);
      setEditing(false);
      toast.success("Knowledge updated", { description: updated.title });
      onSaved();
    } catch (e) {
      toast.error("Could not update knowledge", { description: kbErrorMessage(e) });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!itemId) return;
    setDeleting(true);
    try {
      await kbDelete(kv, userId, itemId);
      toast.success("Knowledge deleted", { description: display?.title ?? undefined });
      setDeleteOpen(false);
      onOpenChange(false);
      onDeleted();
    } catch (e) {
      toast.error("Could not delete knowledge", { description: kbErrorMessage(e) });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="truncate">{display?.title ?? "Knowledge item"}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            {display ? (
              <>
                <TypeBadge type={display.type} />
                {display.source === "ai" ? <AISavedBadge /> : null}
                <span>Updated {timeAgo(display.updatedAt)}</span>
              </>
            ) : (
              <span>From the workspace Knowledge Base</span>
            )}
          </DialogDescription>
        </DialogHeader>

        {editing ? (
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {item ? (
              <KBItemForm
                key={`kb-edit-form-${item.id}`}
                initial={{
                  title: item.title,
                  type: item.type,
                  category: item.category ?? "",
                  tags: item.tags.join(", "),
                  content: item.content,
                }}
                submitLabel="Save changes"
                submitting={saving}
                onSubmit={handleSave}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <div className="flex items-center justify-center py-10 text-muted-foreground">
                <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />
                Loading item…
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {loading ? (
                <div className="flex items-center justify-center py-10 text-muted-foreground">
                  <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />
                  Loading item…
                </div>
              ) : loadError ? (
                <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                  {loadError}
                </p>
              ) : item ? (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
                    <span>
                      <span className="text-foreground/70">Created</span>{" "}
                      {formatDateTime(item.createdAt)}
                    </span>
                    <span>
                      <span className="text-foreground/70">Updated</span>{" "}
                      {formatDateTime(item.updatedAt)}
                    </span>
                    <span>
                      <span className="text-foreground/70">Size</span>{" "}
                      {item.size.toLocaleString()} chars
                    </span>
                  </div>

                  {item.category && (
                    <p className="text-sm text-muted-foreground">
                      <span className="text-foreground/70">Category:</span> {item.category}
                    </p>
                  )}

                  {item.tags.length > 0 && (
                    <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                      <span className="text-foreground/70">Tags:</span>
                      {item.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full bg-foreground/[0.05] px-2 py-0.5 text-[11px]"
                        >
                          {tag}
                        </span>
                      ))}
                    </p>
                  )}

                  <div className="rounded-lg border bg-muted/40 p-4">
                    <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-foreground/90">
                      {item.content || "This item has no content."}
                    </p>
                  </div>

                  {item.fileId && (
                    <p className="flex items-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                      <Paperclip aria-hidden className="h-3.5 w-3.5 shrink-0" />
                      Linked hosted file <span className="font-mono">{item.fileId}</span>
                    </p>
                  )}
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t px-6 py-4">
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
                disabled={!display || deleting}
              >
                <Trash2 aria-hidden />
                Delete
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={handleCopy} disabled={!item}>
                  <Copy aria-hidden />
                  Copy
                </Button>
                <Button size="sm" onClick={() => setEditing(true)} disabled={!item || saving}>
                  <Pencil aria-hidden />
                  Edit
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this knowledge?</AlertDialogTitle>
            <AlertDialogDescription>
              “{display?.title ?? "This item"}” will be permanently removed from the workspace
              Knowledge Base. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Keep the dialog open while the delete runs (no auto-close flash).
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
    </Dialog>
  );
}
