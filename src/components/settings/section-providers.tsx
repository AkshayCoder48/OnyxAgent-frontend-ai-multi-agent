"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  PlugZap,
  Plus,
  Trash2,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Alert, AlertDescription } from "@/components/ui/alert";

import { useProviders } from "@/hooks/use-data";
import type { AIProvider, AIModelType } from "@/types";

interface FormState {
  name: string;
  base_url: string;
  api_key: string;
  models: string; // comma-separated
  model_type: AIModelType;
  tools_enabled: boolean;
  thinking_enabled: boolean;
  is_active: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  base_url: "https://api.openai.com",
  api_key: "",
  models: "",
  model_type: "chat",
  tools_enabled: true,
  thinking_enabled: false,
  is_active: false,
};

export function SectionProviders() {
  const { providers, loading, create, update, remove, test } = useProviders();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AIProvider | null>(null);
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [showKey, setShowKey] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [testingId, setTestingId] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<AIProvider | null>(null);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowKey(false);
    setDialogOpen(true);
  }

  function openEdit(p: AIProvider) {
    setEditing(p);
    setForm({
      name: p.name,
      base_url: p.base_url,
      api_key: "", // never prefill secret; user enters new if changing
      models: p.models.join(", "),
      model_type: p.model_type,
      tools_enabled: p.tools_enabled,
      thinking_enabled: (p as { thinking_enabled?: boolean }).thinking_enabled ?? false,
      is_active: p.is_active,
    });
    setShowKey(false);
    setDialogOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.base_url.trim()) {
      toast.error("Name and base URL are required");
      return;
    }
    if (!editing && !form.api_key.trim()) {
      toast.error("API key is required for new providers");
      return;
    }
    setSaving(true);
    try {
      const models = form.models
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
      if (editing) {
        const patch: Record<string, unknown> = {
          name: form.name.trim(),
          base_url: form.base_url.trim(),
          models,
          model_type: form.model_type,
          tools_enabled: form.tools_enabled,
          thinking_enabled: form.thinking_enabled,
          is_active: form.is_active,
        };
        if (form.api_key.trim()) patch.api_key = form.api_key.trim();
        await update({ id: editing.id, patch });
        toast.success("Provider updated");
      } else {
        await create({
          name: form.name.trim(),
          base_url: form.base_url.trim(),
          api_key: form.api_key.trim(),
          models,
          model_type: form.model_type,
          tools_enabled: form.tools_enabled,
          thinking_enabled: form.thinking_enabled,
          is_active: form.is_active,
        });
        toast.success("Provider added");
      }
      setDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save provider");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(p: AIProvider) {
    if (p.models.length === 0) {
      toast.error("Add at least one model before testing");
      return;
    }
    setTestingId(p.id);
    try {
      const result = await test({ id: p.id, model: p.models[0] });
      if (result.ok) {
        toast.success(`Connection OK · ${result.status_code}`, {
          description: result.detail,
          icon: <CheckCircle2 className="size-4" />,
        });
      } else {
        toast.error("Provider test failed", {
          description: result.detail,
          icon: <XCircle className="size-4" />,
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    } finally {
      setTestingId(null);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await remove(deleteTarget.id);
      toast.success("Provider deleted");
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
          Bring your own API keys. Keys are encrypted with AES-GCM and stored locally in your browser.
        </p>
        <Button onClick={openCreate} size="sm" className="shrink-0">
          <Plus className="size-4" /> Add Provider
        </Button>
      </div>

      {loading ? (
        <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading providers…
        </div>
      ) : providers.length === 0 ? (
        <Alert>
          <PlugZap className="size-4" />
          <AlertDescription>
            No providers yet. Add one (e.g. OpenAI, Anthropic, OpenRouter) to start chatting.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden sm:table-cell">Base URL</TableHead>
                <TableHead>Models</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell className="text-muted-foreground hidden max-w-[200px] truncate text-xs sm:table-cell">
                    {p.base_url}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{p.models.length}</Badge>
                  </TableCell>
                  <TableCell>
                    {p.is_active ? (
                      <Badge>Active</Badge>
                    ) : (
                      <Badge variant="outline">Inactive</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleTest(p)}
                        disabled={testingId === p.id}
                      >
                        {testingId === p.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <PlugZap className="size-3.5" />
                        )}
                        <span className="hidden sm:inline">Test</span>
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(p)}>
                        <Pencil className="size-3.5" />
                        <span className="hidden sm:inline">Edit</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteTarget(p)}
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

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Provider" : "Add Provider"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Update provider details. Leave the API key blank to keep the existing one."
                : "Configure a new OpenAI-compatible provider."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="p-name">Name</Label>
              <Input
                id="p-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. OpenAI"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-base">Base URL</Label>
              <Input
                id="p-base"
                value={form.base_url}
                onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                placeholder="https://api.openai.com"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-key">API Key</Label>
              <div className="relative">
                <Input
                  id="p-key"
                  type={showKey ? "text" : "password"}
                  value={form.api_key}
                  onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                  placeholder={editing ? "•••••••• (leave blank to keep)" : "sk-..."}
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute top-1/2 right-1 h-7 w-7 -translate-y-1/2"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? "Hide key" : "Show key"}
                >
                  {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-models">Models (comma-separated)</Label>
              <Input
                id="p-models"
                value={form.models}
                onChange={(e) => setForm({ ...form, models: e.target.value })}
                placeholder="gpt-4.1-mini, gpt-4.1, o4-mini"
              />
              <p className="text-muted-foreground text-xs">
                These IDs are sent verbatim to the provider&apos;s API.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Model type</Label>
                <Select
                  value={form.model_type}
                  onValueChange={(v: AIModelType) => setForm({ ...form, model_type: v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="chat">chat (chat/completions)</SelectItem>
                    <SelectItem value="responses">responses</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-col gap-3 rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <Label htmlFor="p-tools">Tools enabled</Label>
                  <p className="text-muted-foreground text-xs">Allow function/tool calls.</p>
                </div>
                <Switch
                  id="p-tools"
                  checked={form.tools_enabled}
                  onCheckedChange={(v) => setForm({ ...form, tools_enabled: v })}
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <Label htmlFor="p-thinking">Thinking enabled</Label>
                  <p className="text-muted-foreground text-xs">
                    Sends <code className="text-[10px]">chat_template_kwargs: {"{enable_thinking: true}"}</code> for providers like Poolside that support native reasoning tokens.
                  </p>
                </div>
                <Switch
                  id="p-thinking"
                  checked={form.thinking_enabled}
                  onCheckedChange={(v) => setForm({ ...form, thinking_enabled: v })}
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <Label htmlFor="p-active">Active</Label>
                  <p className="text-muted-foreground text-xs">Only one provider can be active.</p>
                </div>
                <Switch
                  id="p-active"
                  checked={form.is_active}
                  onCheckedChange={(v) => setForm({ ...form, is_active: v })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                {editing ? "Save changes" : "Add provider"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete provider?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove <strong>{deleteTarget?.name}</strong> and its encrypted key. This
              action cannot be undone.
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

export default SectionProviders;
