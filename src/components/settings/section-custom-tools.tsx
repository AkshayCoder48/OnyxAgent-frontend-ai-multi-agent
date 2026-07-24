"use client";

import * as React from "react";
import { toast } from "sonner";
import { Code2, Loader2, Pencil, Plus, Trash2, Webhook } from "lucide-react";

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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { useCustomTools } from "@/hooks/use-data";
import type { CustomTool, CustomToolImpl } from "@/types";

interface HeaderRow {
  id: string;
  key: string;
  value: string;
}

interface FormState {
  name: string;
  description: string;
  impl_kind: CustomToolImpl;
  parameters_schema: string; // JSON string
  http_url: string;
  http_headers: HeaderRow[];
  python_source: string;
  is_active: boolean;
}

const DEFAULT_SCHEMA = JSON.stringify(
  {
    type: "object",
    properties: {
      input: { type: "string", description: "Input to the tool" },
    },
    required: ["input"],
  },
  null,
  2,
);

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  impl_kind: "http_webhook",
  parameters_schema: DEFAULT_SCHEMA,
  http_url: "",
  http_headers: [],
  python_source: "",
  is_active: true,
};

function headersToRows(h: Record<string, string> | null): HeaderRow[] {
  if (!h) return [];
  return Object.entries(h).map(([k, v]) => ({
    id: crypto.randomUUID(),
    key: k,
    value: v,
  }));
}

function rowsToHeaders(rows: HeaderRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) continue;
    out[k] = r.value;
  }
  return out;
}

export function SectionCustomTools() {
  const { tools, loading, create, update, remove } = useCustomTools();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<CustomTool | null>(null);
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<CustomTool | null>(null);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(t: CustomTool) {
    setEditing(t);
    setForm({
      name: t.name,
      description: t.description,
      impl_kind: t.impl_kind,
      parameters_schema: JSON.stringify(t.parameters_schema ?? {}, null, 2),
      http_url: t.http_url ?? "",
      http_headers: headersToRows(t.http_headers),
      python_source: t.python_source ?? "",
      is_active: t.is_active,
    });
    setDialogOpen(true);
  }

  function addHeader() {
    setForm((f) => ({
      ...f,
      http_headers: [...f.http_headers, { id: crypto.randomUUID(), key: "", value: "" }],
    }));
  }
  function updateHeader(id: string, patch: Partial<HeaderRow>) {
    setForm((f) => ({
      ...f,
      http_headers: f.http_headers.map((h) => (h.id === id ? { ...h, ...patch } : h)),
    }));
  }
  function removeHeader(id: string) {
    setForm((f) => ({ ...f, http_headers: f.http_headers.filter((h) => h.id !== id) }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.description.trim()) {
      toast.error("Name and description are required");
      return;
    }
    let parsedSchema: Record<string, unknown>;
    try {
      parsedSchema = form.parameters_schema.trim()
        ? JSON.parse(form.parameters_schema)
        : {};
    } catch {
      toast.error("Parameters schema is not valid JSON");
      return;
    }
    if (form.impl_kind === "http_webhook" && !form.http_url.trim()) {
      toast.error("Webhook URL is required for webhook tools");
      return;
    }
    if (form.impl_kind === "python_snippet" && !form.python_source.trim()) {
      toast.error("Python source is required for python tools");
      return;
    }
    setSaving(true);
    try {
      const headers = rowsToHeaders(form.http_headers);
      if (editing) {
        await update({
          id: editing.id,
          patch: {
            name: form.name.trim(),
            description: form.description.trim(),
            impl_kind: form.impl_kind,
            parameters_schema: parsedSchema,
            http_url: form.impl_kind === "http_webhook" ? form.http_url.trim() : null,
            http_headers: form.impl_kind === "http_webhook" ? headers : null,
            python_source: form.impl_kind === "python_snippet" ? form.python_source : null,
            is_active: form.is_active,
          },
        });
        toast.success("Tool updated");
      } else {
        await create({
          name: form.name.trim(),
          description: form.description.trim(),
          impl_kind: form.impl_kind,
          parameters_schema: parsedSchema,
          http_url: form.impl_kind === "http_webhook" ? form.http_url.trim() : null,
          http_headers: form.impl_kind === "http_webhook" ? headers : null,
          python_source: form.impl_kind === "python_snippet" ? form.python_source : null,
          is_active: form.is_active,
        });
        toast.success("Tool created");
      }
      setDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save tool");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await remove(deleteTarget.id);
      toast.success("Tool deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleteTarget(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          Define tools the agent can call. Webhooks hit an external URL; Python snippets run in the
          E2B Sandbox.
        </p>
        <Button onClick={openCreate} size="sm" className="shrink-0">
          <Plus className="size-4" /> Add Tool
        </Button>
      </div>

      {loading ? (
        <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading tools…
        </div>
      ) : tools.length === 0 ? (
        <div className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">
          No custom tools yet.
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden sm:table-cell">Description</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tools.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell className="text-muted-foreground hidden max-w-[260px] truncate text-xs sm:table-cell">
                    {t.description}
                  </TableCell>
                  <TableCell>
                    {t.impl_kind === "http_webhook" ? (
                      <Badge variant="secondary" className="gap-1">
                        <Webhook className="size-3" /> webhook
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="gap-1">
                        <Code2 className="size-3" /> python
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {t.is_active ? <Badge>Active</Badge> : <Badge variant="outline">Inactive</Badge>}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(t)}>
                        <Pencil className="size-3.5" />
                        <span className="hidden sm:inline">Edit</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteTarget(t)}
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

      {/* Add / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit tool" : "Add custom tool"}</DialogTitle>
            <DialogDescription>
              Tools expose additional capabilities to the agent. The schema must be valid JSON.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="t-name">Name</Label>
                <Input
                  id="t-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. fetch_weather"
                  className="font-mono"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label>Implementation</Label>
                <Select
                  value={form.impl_kind}
                  onValueChange={(v: CustomToolImpl) => setForm({ ...form, impl_kind: v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http_webhook">HTTP webhook</SelectItem>
                    <SelectItem value="python_snippet">Python snippet</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t-desc">Description</Label>
              <Input
                id="t-desc"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="What does this tool do? Be specific — the model reads this."
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t-schema">Parameters schema (JSON)</Label>
              <Textarea
                id="t-schema"
                value={form.parameters_schema}
                onChange={(e) => setForm({ ...form, parameters_schema: e.target.value })}
                className="font-mono text-sm min-h-[140px]"
                spellCheck={false}
              />
            </div>

            {form.impl_kind === "http_webhook" ? (
              <div className="space-y-3 rounded-md border p-3">
                <div className="space-y-1.5">
                  <Label htmlFor="t-url">Webhook URL</Label>
                  <Input
                    id="t-url"
                    value={form.http_url}
                    onChange={(e) => setForm({ ...form, http_url: e.target.value })}
                    placeholder="https://example.com/hooks/weather"
                    className="font-mono text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Headers</Label>
                    <Button type="button" variant="outline" size="sm" onClick={addHeader}>
                      <Plus className="size-3.5" /> Add header
                    </Button>
                  </div>
                  {form.http_headers.length === 0 ? (
                    <p className="text-muted-foreground text-xs">No custom headers.</p>
                  ) : (
                    <div className="space-y-2">
                      {form.http_headers.map((h) => (
                        <div key={h.id} className="flex items-center gap-2">
                          <Input
                            value={h.key}
                            onChange={(e) => updateHeader(h.id, { key: e.target.value })}
                            placeholder="Header-Name"
                            className="font-mono text-sm"
                            autoComplete="off"
                          />
                          <Input
                            value={h.value}
                            onChange={(e) => updateHeader(h.id, { value: e.target.value })}
                            placeholder="value"
                            className="font-mono text-sm"
                            autoComplete="off"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive shrink-0"
                            onClick={() => removeHeader(h.id)}
                            aria-label="Remove header"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-1.5 rounded-md border p-3">
                <Label htmlFor="t-py">Python source</Label>
                <Textarea
                  id="t-py"
                  value={form.python_source}
                  onChange={(e) => setForm({ ...form, python_source: e.target.value })}
                  placeholder={"def run(args):\n    return {\"ok\": True}"}
                  className="font-mono text-sm min-h-[160px]"
                  spellCheck={false}
                />
                <p className="text-muted-foreground text-xs">
                  Executed in the E2B Sandbox. Define a <code>run(args)</code> function returning a
                  JSON-serialisable value.
                </p>
              </div>
            )}

            <div className="flex items-center justify-between gap-2 rounded-md border p-3">
              <div>
                <Label htmlFor="t-active">Active</Label>
                <p className="text-muted-foreground text-xs">Inactive tools are hidden from the model.</p>
              </div>
              <Switch
                id="t-active"
                checked={form.is_active}
                onCheckedChange={(v) => setForm({ ...form, is_active: v })}
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                {editing ? "Save changes" : "Create tool"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete tool?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove <strong>{deleteTarget?.name}</strong>. This action cannot be undone.
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

export default SectionCustomTools;
