"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { KB_ITEM_TYPES, type KBItemType } from "@/lib/onyxbase/kb-store";
import { KB_LIMITS, KB_TYPE_META, parseTags } from "./kb-shared";

/** Raw (string-based) form state — tags stay comma-separated until submit. */
export interface KBItemFormValues {
  title: string;
  type: KBItemType;
  category: string;
  tags: string;
  content: string;
}

/** Normalized values handed to kbSave / kbUpdate. */
export interface KBItemFormSubmit {
  title: string;
  type: KBItemType;
  category: string | null;
  tags: string[];
  content: string;
}

interface KBItemFormProps {
  initial: KBItemFormValues;
  submitLabel: string;
  submitting: boolean;
  onSubmit: (values: KBItemFormSubmit) => void | Promise<void>;
  onCancel?: () => void;
}

/**
 * The knowledge item form shared by the "Add knowledge" dialog and the edit
 * mode of the detail dialog. Owns its field state (mounted fresh per dialog
 * open by the parents), validates title + content, and normalizes tags.
 */
export function KBItemForm({
  initial,
  submitLabel,
  submitting,
  onSubmit,
  onCancel,
}: KBItemFormProps) {
  const [title, setTitle] = React.useState(initial.title);
  const [type, setType] = React.useState<KBItemType>(initial.type);
  const [category, setCategory] = React.useState(initial.category);
  const [tags, setTags] = React.useState(initial.tags);
  const [content, setContent] = React.useState(initial.content);

  const valid = title.trim().length > 0 && content.trim().length > 0;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || submitting) return;
    void onSubmit({
      title: title.trim(),
      type,
      category: category.trim() || null,
      tags: parseTags(tags),
      content,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="kb-item-title">Title</Label>
        <Input
          id="kb-item-title"
          value={title}
          maxLength={KB_LIMITS.title}
          required
          autoComplete="off"
          placeholder="e.g. Deployment conventions"
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="kb-item-type">Type</Label>
          <Select value={type} onValueChange={(v) => setType(v as KBItemType)}>
            <SelectTrigger id="kb-item-type" className="w-full" aria-label="Item type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KB_ITEM_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {KB_TYPE_META[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="kb-item-category">Category</Label>
          <Input
            id="kb-item-category"
            value={category}
            autoComplete="off"
            placeholder="Optional, e.g. Architecture"
            onChange={(e) => setCategory(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="kb-item-tags">Tags</Label>
        <Input
          id="kb-item-tags"
          value={tags}
          autoComplete="off"
          placeholder="Comma-separated, e.g. api, conventions"
          onChange={(e) => setTags(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="kb-item-content">Content</Label>
          <span
            aria-hidden
            className="font-mono text-[11px] tabular-nums text-muted-foreground/70"
          >
            {content.length.toLocaleString()} / {KB_LIMITS.content.toLocaleString()}
          </span>
        </div>
        <Textarea
          id="kb-item-content"
          value={content}
          rows={12}
          maxLength={KB_LIMITS.content}
          required
          placeholder="The knowledge itself — decisions, conventions, research findings, notes…"
          className="scrollbar-thin leading-relaxed"
          onChange={(e) => setContent(e.target.value)}
        />
      </div>

      <div className="flex items-center justify-end gap-2 border-t pt-4">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={submitting || !valid}>
          {submitting ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
