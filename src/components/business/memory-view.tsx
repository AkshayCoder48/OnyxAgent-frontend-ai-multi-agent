"use client";

/**
 * Business Mode — MemoryView (Task 4-c).
 *
 * Persistent business knowledge: category filter chips (with counts),
 * pinned-first list (the store pre-sorts), add/edit dialog and pin/delete
 * actions. All writes go through businessMemoryService + memory.updated
 * events and are mirrored into the store.
 */

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { motion, useReducedMotion } from "framer-motion";
import { Brain, Pencil, Pin, PinOff, Plus, Trash2 } from "lucide-react";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

import { businessEventService, businessMemoryService } from "@/lib/business/data";
import { bt } from "@/lib/business/ui-text";
import type { MemoryCategory, BusinessMemoryRow, VerificationStatus } from "@/lib/business/types";
import { useBusinessStore } from "@/stores/business-store";
import { cn, timeAgo } from "@/lib/utils";

const MEMORY_CATEGORIES: MemoryCategory[] = [
  "profile",
  "goal",
  "preference",
  "decision",
  "research",
  "procedure",
  "product",
  "brand",
  "market",
  "outcome",
];

const VERIFICATION_STATUSES: VerificationStatus[] = ["verified", "assumption", "unverified"];

function verificationDotClass(status: VerificationStatus): string {
  switch (status) {
    case "verified":
      return "bg-emerald-500";
    case "assumption":
      return "bg-amber-500";
    default:
      return "bg-muted-foreground/50";
  }
}

function verificationBadgeClass(status: VerificationStatus): string {
  switch (status) {
    case "verified":
      return "border-emerald-500/40 text-emerald-600 dark:text-emerald-400";
    case "assumption":
      return "border-amber-500/40 text-amber-600 dark:text-amber-400";
    default:
      return "border-border text-muted-foreground";
  }
}

interface MemoryForm {
  memory_type: MemoryCategory;
  content: string;
  source: string;
  verification_status: VerificationStatus;
}

const EMPTY_FORM: MemoryForm = {
  memory_type: "preference",
  content: "",
  source: "user",
  verification_status: "unverified",
};

export function MemoryView() {
  const params = useParams<{ businessId?: string }>();
  const activeBusinessId = useBusinessStore((s) => s.activeBusinessId);
  const businessId = params?.businessId ?? activeBusinessId ?? "";
  const memory = useBusinessStore((s) => s.memory);
  const upsertMemory = useBusinessStore((s) => s.upsertMemory);
  const removeMemory = useBusinessStore((s) => s.removeMemory);

  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<BusinessMemoryRow | null>(null);
  const [form, setForm] = useState<MemoryForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BusinessMemoryRow | null>(null);

  const reduceMotion = useReducedMotion();

  // Reset the dialog form each time it opens (prefilled when editing).
  useEffect(() => {
    if (!dialogOpen) return;
    setForm(
      editingRow
        ? {
            memory_type: editingRow.memory_type,
            content: editingRow.content,
            source: editingRow.source,
            verification_status: editingRow.verification_status,
          }
        : EMPTY_FORM,
    );
  }, [dialogOpen, editingRow]);

  const categoryCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of memory) {
      map.set(m.memory_type, (map.get(m.memory_type) ?? 0) + 1);
    }
    return map;
  }, [memory]);

  const visibleMemory = useMemo(() => {
    // The store already sorts pinned-first → newest-updated.
    return memory.filter((m) => categoryFilter === "all" || m.memory_type === categoryFilter);
  }, [memory, categoryFilter]);

  async function emitMemoryEvent(row: BusinessMemoryRow) {
    await businessEventService.append({
      business_id: businessId,
      event_type: "memory.updated",
      payload: { memory_id: row.id, category: row.memory_type, source: row.source },
    });
  }

  async function handleSave() {
    if (!form.content.trim() || !businessId) return;
    setSaving(true);
    try {
      if (editingRow) {
        await businessMemoryService.update(editingRow.id, {
          memory_type: form.memory_type,
          content: form.content.trim(),
          source: form.source.trim() || "user",
          verification_status: form.verification_status,
        });
        const updated: BusinessMemoryRow = {
          ...editingRow,
          memory_type: form.memory_type,
          content: form.content.trim(),
          source: form.source.trim() || "user",
          verification_status: form.verification_status,
          updated_at: new Date().toISOString(),
        };
        upsertMemory(updated);
        await emitMemoryEvent(updated);
      } else {
        const row = await businessMemoryService.create(businessId, {
          memory_type: form.memory_type,
          content: form.content.trim(),
          source: form.source.trim() || "user",
          verification_status: form.verification_status,
        });
        upsertMemory(row);
        await emitMemoryEvent(row);
      }
      toast.success(bt("toast.memorySaved"));
      setDialogOpen(false);
      setEditingRow(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleTogglePin(row: BusinessMemoryRow) {
    try {
      await businessMemoryService.update(row.id, { pinned: !row.pinned });
      upsertMemory({ ...row, pinned: !row.pinned, updated_at: new Date().toISOString() });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await businessMemoryService.remove(deleteTarget.id);
      removeMemory(deleteTarget.id);
      toast.success(bt("toast.deleted"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteTarget(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{bt("memory.title")}</h1>
          <p className="text-sm text-muted-foreground">{bt("memory.subtitle")}</p>
        </div>
        <Button
          onClick={() => {
            setEditingRow(null);
            setDialogOpen(true);
          }}
          className="h-11"
        >
          <Plus className="mr-2 size-4" />
          {bt("memory.add")}
        </Button>
      </header>

      {/* Category chips with real counts. */}
      <div className="flex gap-2 overflow-x-auto scrollbar-none pb-1" role="group" aria-label={bt("memory.category")}>
        <CategoryChip
          active={categoryFilter === "all"}
          onClick={() => setCategoryFilter("all")}
          label={bt("common.all")}
          count={memory.length}
        />
        {MEMORY_CATEGORIES.filter((c) => (categoryCounts.get(c) ?? 0) > 0).map((c) => (
          <CategoryChip
            key={c}
            active={categoryFilter === c}
            onClick={() => setCategoryFilter(c)}
            label={bt(`memoryCategory.${c}`)}
            count={categoryCounts.get(c) ?? 0}
          />
        ))}
      </div>

      {visibleMemory.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-14 text-center">
          <Brain className="size-10 text-muted-foreground/60" aria-hidden="true" />
          <p className="max-w-md text-sm text-muted-foreground">{bt("memory.empty")}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {visibleMemory.map((row, i) => (
            <MemoryRow
              key={row.id}
              row={row}
              index={i}
              reduceMotion={reduceMotion}
              onEdit={() => {
                setEditingRow(row);
                setDialogOpen(true);
              }}
              onTogglePin={() => void handleTogglePin(row)}
              onDelete={() => setDeleteTarget(row)}
            />
          ))}
        </ul>
      )}

      {/* Add / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingRow ? bt("memory.edit") : bt("memory.add")}</DialogTitle>
            <DialogDescription>{bt("memory.subtitle")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="memory-category">{bt("memory.category")}</Label>
              <Select
                value={form.memory_type}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, memory_type: v as MemoryCategory }))
                }
              >
                <SelectTrigger id="memory-category" className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEMORY_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {bt(`memoryCategory.${c}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="memory-content">{bt("memory.content")}</Label>
              <Textarea
                id="memory-content"
                value={form.content}
                onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                placeholder={bt("memory.contentPlaceholder")}
                rows={4}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="memory-source">{bt("memory.source")}</Label>
                <Input
                  id="memory-source"
                  value={form.source}
                  onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}
                  placeholder={bt("memory.sourcePlaceholder")}
                  className="h-11"
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="memory-verification">{bt("memory.verification")}</Label>
                <Select
                  value={form.verification_status}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, verification_status: v as VerificationStatus }))
                  }
                >
                  <SelectTrigger id="memory-verification" className="h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VERIFICATION_STATUSES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {bt(`verification.${v}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} className="h-11">
              {bt("common.cancel")}
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving || !form.content.trim()} className="h-11">
              {saving && <Spinner className="mr-2 size-4" />}
              {bt("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{bt("common.delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.content.slice(0, 140)}
              {(deleteTarget?.content.length ?? 0) > 140 ? "…" : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11">{bt("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDelete()}
              className="h-11 bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {bt("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Category chip.
// ---------------------------------------------------------------------------

function CategoryChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium whitespace-nowrap transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
      )}
    >
      {label}
      <span className={cn("ml-1.5 text-xs", active ? "text-primary/80" : "text-muted-foreground/70")}>
        {count}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Memory row.
// ---------------------------------------------------------------------------

function MemoryRow({
  row,
  index,
  reduceMotion,
  onEdit,
  onTogglePin,
  onDelete,
}: {
  row: BusinessMemoryRow;
  index: number;
  reduceMotion: boolean | null;
  onEdit: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = row.content.length > 220;

  return (
    <motion.li
      initial={reduceMotion ? undefined : { opacity: 0, y: 8 }}
      animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.2) }}
      className="rounded-xl border p-4"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {long ? (
            <button
              type="button"
              className={cn(
                "w-full whitespace-pre-wrap break-words text-left text-sm",
                !expanded && "line-clamp-3",
              )}
              onClick={() => setExpanded((e) => !e)}
              aria-expanded={expanded}
            >
              {row.content}
            </button>
          ) : (
            <p className="whitespace-pre-wrap break-words text-sm">{row.content}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <Badge variant="secondary">{bt(`memoryCategory.${row.memory_type}`)}</Badge>
            <Badge variant="outline" className={verificationBadgeClass(row.verification_status)}>
              <span className={cn("mr-1.5 inline-block size-1.5 rounded-full", verificationDotClass(row.verification_status))} />
              {bt(`verification.${row.verification_status}`)}
            </Badge>
            <span className="text-xs text-muted-foreground">· {row.source}</span>
            <span className="text-xs text-muted-foreground">· {timeAgo(row.updated_at)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            onClick={onTogglePin}
            aria-label={row.pinned ? bt("common.close") : bt("memory.usedInPrompts")}
          >
            {row.pinned ? (
              <PinOff className="size-4 text-primary" />
            ) : (
              <Pin className="size-4 text-muted-foreground" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            onClick={onEdit}
            aria-label={bt("common.edit")}
          >
            <Pencil className="size-4 text-muted-foreground" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            onClick={onDelete}
            aria-label={bt("common.delete")}
          >
            <Trash2 className="size-4 text-muted-foreground" />
          </Button>
        </div>
      </div>
    </motion.li>
  );
}
