"use client";

import * as React from "react";
import { toast } from "sonner";
import type { OnyxBaseKV } from "@/lib/onyxbase/kv-client";
import { kbSave } from "@/lib/onyxbase/kb-store";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { KBItemForm, type KBItemFormSubmit } from "./kb-item-form";
import { kbErrorMessage } from "./kb-shared";

interface KBAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kv: OnyxBaseKV;
  userId: string;
  /** Bump to re-list after a successful save. */
  onSaved: () => void;
}

const EMPTY_INITIAL = {
  title: "",
  type: "knowledge" as const,
  category: "",
  tags: "",
  content: "",
};

/**
 * "Add knowledge" dialog — user-created items (source: "user") saved straight
 * into the workspace's persistent Knowledge Base.
 */
export function KBAddDialog({ open, onOpenChange, kv, userId, onSaved }: KBAddDialogProps) {
  const [saving, setSaving] = React.useState(false);

  async function handleSubmit(values: KBItemFormSubmit) {
    setSaving(true);
    try {
      await kbSave(kv, userId, { ...values, source: "user" });
      toast.success("Knowledge saved", { description: values.title });
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error("Could not save knowledge", { description: kbErrorMessage(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Add knowledge</DialogTitle>
          <DialogDescription>
            Saved to this workspace&apos;s persistent Knowledge Base — it survives chats, sessions
            and restarts.
          </DialogDescription>
        </DialogHeader>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {open && (
            <KBItemForm
              key="kb-add-form"
              initial={EMPTY_INITIAL}
              submitLabel="Save knowledge"
              submitting={saving}
              onSubmit={handleSubmit}
              onCancel={() => onOpenChange(false)}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
