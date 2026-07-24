"use client";

import * as React from "react";
import { toast } from "sonner";
import { Info, Loader2, Pencil, Plus, Server, Trash2 } from "lucide-react";

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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import { useMCPServers } from "@/hooks/use-data";
import type { MCPServer, MCPTransport } from "@/types";

interface HeaderRow {
  id: string;
  key: string;
  value: string;
}

interface FormState {
  name: string;
  transport: MCPTransport;
  url: string;
  headers: HeaderRow[];
  is_active: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  transport: "streamable_http",
  url: "",
  headers: [],
  is_active: true,
};

function headersToRows(h: Record<string, string> | undefined): HeaderRow[] {
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

export function SectionMcp() {
  const { servers, loading, create, update, remove } = useMCPServers();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MCPServer | null>(null);
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<MCPServer | null>(null);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(s: MCPServer) {
    setEditing(s);
    setForm({
      name: s.name,
      transport: s.transport,
      url: s.url,
      headers: headersToRows(s.headers),
      is_active: s.is_active,
    });
    setDialogOpen(true);
  }

  function addHeader() {
    setForm((f) => ({
      ...f,
      headers: [...f.headers, { id: crypto.randomUUID(), key: "", value: "" }],
    }));
  }
  function updateHeader(id: string, patch: Partial<HeaderRow>) {
    setForm((f) => ({
      ...f,
      headers: f.headers.map((h) => (h.id === id ? { ...h, ...patch } : h)),
    }));
  }
  function removeHeader(id: string) {
    setForm((f) => ({ ...f, headers: f.headers.filter((h) => h.id !== id) }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.url.trim()) {
      toast.error("Name and URL are required");
      return;
    }
    try {
      new URL(form.url);
    } catch {
      toast.error("URL is not valid");
      return;
    }
    setSaving(true);
    try {
      const headers = rowsToHeaders(form.headers);
      if (editing) {
        await update({
          id: editing.id,
          patch: {
            name: form.name.trim(),
            transport: form.transport,
            url: form.url.trim(),
            headers,
            is_active: form.is_active,
          },
        });
        toast.success("Server updated");
      } else {
        await create({
          name: form.name.trim(),
          transport: form.transport,
          url: form.url.trim(),
          headers,
          is_active: form.is_active,
        });
        toast.success("Server added");
      }
      setDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save server");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await remove(deleteTarget.id);
      toast.success("Server deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleteTarget(null);
    }
  }

  return (
    <div className="space-y-4">
      <Alert>
        <Info className="size-4" />
        <AlertTitle>HTTP/SSE only</AlertTitle>
        <AlertDescription>
          Only HTTP/SSE MCP transports are supported in backendless mode (no stdio). The agent
          connects directly from your browser.
        </AlertDescription>
      </Alert>

      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          Connect external tool servers via the Model Context Protocol.
        </p>
        <Button onClick={openCreate} size="sm" className="shrink-0">
          <Plus className="size-4" /> Add Server
        </Button>
      </div>

      {loading ? (
        <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading servers…
        </div>
      ) : servers.length === 0 ? (
        <div className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">
          <Server className="mx-auto mb-2 size-6 opacity-50" />
          No MCP servers yet.
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Transport</TableHead>
                <TableHead className="hidden sm:table-cell">URL</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {servers.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono text-xs">
                      {s.transport}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden max-w-[220px] truncate text-xs sm:table-cell">
                    {s.url}
                  </TableCell>
                  <TableCell>
                    {s.is_active ? <Badge>Active</Badge> : <Badge variant="outline">Inactive</Badge>}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(s)}>
                        <Pencil className="size-3.5" />
                        <span className="hidden sm:inline">Edit</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteTarget(s)}
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

      {/* Add / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit server" : "Add MCP server"}</DialogTitle>
            <DialogDescription>
              Configure an HTTP/SSE transport server. Headers are sent on every request.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="mcp-name">Name</Label>
              <Input
                id="mcp-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Filesystem MCP"
                required
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[160px_1fr]">
              <div className="space-y-1.5">
                <Label>Transport</Label>
                <Select
                  value={form.transport}
                  onValueChange={(v: MCPTransport) => setForm({ ...form, transport: v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sse">sse</SelectItem>
                    <SelectItem value="streamable_http">streamable_http</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-url">URL</Label>
                <Input
                  id="mcp-url"
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder="https://mcp.example.com/v1"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Headers</Label>
                <Button type="button" variant="outline" size="sm" onClick={addHeader}>
                  <Plus className="size-3.5" /> Add header
                </Button>
              </div>
              {form.headers.length === 0 ? (
                <p className="text-muted-foreground text-xs">No custom headers.</p>
              ) : (
                <div className="space-y-2">
                  {form.headers.map((h) => (
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

            <div className="flex items-center justify-between gap-2 rounded-md border p-3">
              <div>
                <Label htmlFor="mcp-active">Active</Label>
                <p className="text-muted-foreground text-xs">Inactive servers are skipped at runtime.</p>
              </div>
              <Switch
                id="mcp-active"
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
                {editing ? "Save changes" : "Add server"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete server?</AlertDialogTitle>
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

export default SectionMcp;
