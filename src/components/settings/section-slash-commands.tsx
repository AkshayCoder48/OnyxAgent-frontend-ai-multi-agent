"use client";

import * as React from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Terminal, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { useSlashCommands } from "@/hooks/use-data";
import type { UserSlashCommand } from "@/types";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

interface FormState {
  name: string;
  prompt: string;
  is_enabled: boolean;
}

const EMPTY_FORM: FormState = { name: "", prompt: "", is_enabled: true };

export function SectionSlashCommands() {
  const { commands, loading, create, update, toggleBuiltin, remove } = useSlashCommands();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<UserSlashCommand | null>(null);
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<UserSlashCommand | null>(null);

  const builtins = commands.filter((c) => c.is_builtin);
  const customs = commands.filter((c) => !c.is_builtin);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(c: UserSlashCommand) {
    setEditing(c);
    setForm({ name: c.name, prompt: c.prompt ?? "", is_enabled: c.is_enabled });
    setDialogOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!NAME_RE.test(form.name)) {
      toast.error("Name must match ^[a-z0-9][a-z0-9-]{0,31}$", {
        description: "Lowercase letters, digits, and hyphens. Max 32 chars. Must start alphanumeric.",
      });
      return;
    }
    if (!form.prompt.trim()) {
      toast.error("Prompt is required");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await update({
          id: editing.id,
          patch: {
            name: form.name,
            prompt: form.prompt,
            is_enabled: form.is_enabled,
          },
        });
        toast.success("Command updated");
      } else {
        await create({
          name: form.name,
          prompt: form.prompt,
          isEnabled: form.is_enabled,
        });
        toast.success("Command created");
      }
      setDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save command");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleBuiltin(c: UserSlashCommand, next: boolean) {
    try {
      await toggleBuiltin({ name: c.name, isEnabled: next });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to toggle command");
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await remove(deleteTarget.id);
      toast.success("Command deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleteTarget(null);
    }
  }

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
        <Loader2 className="size-4 animate-spin" /> Loading commands…
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Built-in */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Terminal className="text-muted-foreground size-4" />
          <h3 className="text-sm font-semibold">Built-in commands</h3>
          <Badge variant="secondary">{builtins.length}</Badge>
        </div>
        <div className="rounded-md border divide-y">
          {builtins.length === 0 ? (
            <p className="text-muted-foreground p-4 text-sm">No built-in commands available.</p>
          ) : (
            builtins.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-3 p-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="text-sm font-medium">/{c.name}</code>
                    {!c.is_enabled && (
                      <Badge variant="outline" className="text-xs">
                        Disabled
                      </Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground truncate text-xs">
                    {c.prompt}
                  </p>
                </div>
                <Switch
                  checked={c.is_enabled}
                  onCheckedChange={(v) => handleToggleBuiltin(c, v)}
                  aria-label={`Toggle ${c.name}`}
                />
              </div>
            ))
          )}
        </div>
      </section>

      {/* Custom */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">Custom commands</h3>
            <Badge variant="secondary">{customs.length}</Badge>
          </div>
          <Button onClick={openCreate} size="sm">
            <Plus className="size-4" /> Add Command
          </Button>
        </div>

        {customs.length === 0 ? (
          <div className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">
            No custom commands yet. Create one to reuse prompts across chats.
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Prompt</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customs.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <code className="text-sm font-medium">/{c.name}</code>
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden max-w-[280px] truncate text-xs sm:table-cell">
                      {c.prompt}
                    </TableCell>
                    <TableCell>
                      {c.is_enabled ? (
                        <Badge>Enabled</Badge>
                      ) : (
                        <Badge variant="outline">Disabled</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(c)}>
                          <Pencil className="size-3.5" />
                          <span className="hidden sm:inline">Edit</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteTarget(c)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {/* Add / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit command" : "New custom command"}</DialogTitle>
            <DialogDescription>
              Trigger with <code>/name</code> in the chat box. Names are lowercase, may contain
              hyphens, and must be unique.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cmd-name">Name</Label>
              <Input
                id="cmd-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. summarize-doc"
                className="font-mono"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                disabled={!!editing}
                required
              />
              <p className="text-muted-foreground text-xs">
                Pattern: <code>^[a-z0-9][a-z0-9-]{"{0,31}"}$</code>
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cmd-prompt">Prompt</Label>
              <Textarea
                id="cmd-prompt"
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                placeholder="Summarize the following content in 5 bullet points."
                className="min-h-[120px]"
                required
              />
            </div>
            <div className="flex items-center justify-between gap-2 rounded-md border p-3">
              <div>
                <Label htmlFor="cmd-enabled">Enabled</Label>
                <p className="text-muted-foreground text-xs">
                  Disabled commands won&apos;t appear in autocomplete.
                </p>
              </div>
              <Switch
                id="cmd-enabled"
                checked={form.is_enabled}
                onCheckedChange={(v) => setForm({ ...form, is_enabled: v })}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                {editing ? "Save changes" : "Create command"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete command?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove <code>/{deleteTarget?.name}</code>. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={handleDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default SectionSlashCommands;
