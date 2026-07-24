"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Blocks, Loader2, Plus, Power, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button, Input, Label } from "@/components/ui";
import { SectionCard as SettingsSectionCard } from "@/components/settings/settings-section";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks";
import { mcpService } from "@/lib/services";

type MCPTransport = "sse" | "streamable_http";

interface MCPServer {
  id: string;
  name: string;
  transport: MCPTransport;
  command?: string | null;
  args: string[];
  env: Record<string, string>;
  url?: string | null;
  headers: Record<string, string>;
  is_active: boolean;
}

const EMPTY_FORM = {
  name: "",
  transport: "sse" as MCPTransport,
  command: "",
  args: "",
  env: "",
  url: "",
  headers: "",
};

export default function McpsSettingsPage() {
  const { user } = useAuth();
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const rows = await mcpService.list(user.id);
      setServers(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          // Coerce legacy "stdio" rows to "sse" so the UI keeps rendering —
          // stdio isn't supported in backendless mode but old rows may still
          // exist in the DB from earlier prototypes.
          transport: (r.transport === "streamable_http" ? "streamable_http" : "sse") as MCPTransport,
          command: r.command ?? null,
          args: r.args ?? [],
          env: r.env ?? {},
          url: r.url ?? null,
          headers: r.headers ?? {},
          is_active: r.is_active,
        })),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = async () => {
    if (!user) return;
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    setSaving(true);
    try {
      const payload: {
        name: string;
        transport: MCPTransport;
        is_active: boolean;
        url: string;
        headers: Record<string, string>;
      } = {
        name: form.name.trim(),
        transport: form.transport,
        is_active: true,
        url: form.url.trim(),
        headers: {},
      };
      try {
        payload.headers = form.headers.trim() ? JSON.parse(form.headers) : {};
      } catch {
        throw new Error("headers must be a JSON object");
      }

      await mcpService.create(user.id, payload);
      toast.success(`Added MCP server: ${form.name}`);
      setForm({ ...EMPTY_FORM });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Add failed");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (s: MCPServer) => {
    try {
      await mcpService.update(s.id, { is_active: !s.is_active });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Toggle failed");
    }
  };

  const handleDelete = async (s: MCPServer) => {
    if (!confirm(`Delete MCP server ${s.name}?`)) return;
    try {
      await mcpService.delete(s.id);
      toast.success(`Removed ${s.name}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  };

  return (
    <div className="space-y-6">
      <SettingsSectionCard
        title="MCP servers"
        description="Model Context Protocol (MCP) servers expose tools and data sources to the AI. Add an SSE / streamable-HTTP server below — the AI picks up its tools on the next chat turn."
      >
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Only HTTP/SSE MCP transports are supported in backendless mode.
            The browser can&apos;t spawn local processes, so <code>stdio</code> servers
            aren&apos;t available.
          </span>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : servers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-foreground/15 p-8 text-center">
            <Blocks className="mx-auto h-8 w-8 text-muted-foreground mb-3" />
            <p className="font-medium">No MCP servers connected</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              Add a server using the form below. Common choices: Slack (SSE),
              Zapier (streamable-http), remote MCP gateways.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {servers.map((s) => (
              <li key={s.id} className="flex items-start gap-3 py-3">
                <Blocks
                  className={cn(
                    "mt-0.5 h-4 w-4 shrink-0",
                    s.is_active ? "text-brand" : "text-muted-foreground",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-sm">{s.name}</p>
                    <span className="text-[10px] font-mono uppercase rounded bg-foreground/5 px-1.5 py-0.5">
                      {s.transport}
                    </span>
                    {!s.is_active && (
                      <span className="text-[10px] font-mono uppercase text-amber-600">disabled</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                    {s.url ?? ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => toggleActive(s)}
                  title={s.is_active ? "Disable" : "Enable"}
                >
                  <Power className={cn("h-3.5 w-3.5", s.is_active && "text-emerald-500")} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-muted-foreground hover:text-destructive"
                  onClick={() => handleDelete(s)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSectionCard>

      <SettingsSectionCard
        title="Add an MCP server"
        description="Configure a new MCP server. Pick the transport, then fill in the corresponding fields."
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="mcp-name" className="text-xs uppercase">Name</Label>
              <Input
                id="mcp-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. slack"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mcp-transport" className="text-xs uppercase">Transport</Label>
              <select
                id="mcp-transport"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={form.transport}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    transport: e.target.value as MCPTransport,
                  }))
                }
              >
                <option value="sse">sse</option>
                <option value="streamable_http">streamable_http</option>
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mcp-url" className="text-xs uppercase">URL</Label>
            <Input
              id="mcp-url"
              value={form.url}
              onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
              placeholder="https://example.com/mcp"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mcp-headers" className="text-xs uppercase">Headers (JSON)</Label>
            <Input
              id="mcp-headers"
              value={form.headers}
              onChange={(e) => setForm((f) => ({ ...f, headers: e.target.value }))}
              placeholder='{"Authorization":"Bearer …"}'
              className="font-mono text-xs"
            />
          </div>

          <Button onClick={handleAdd} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Saving…
              </>
            ) : (
              <>
                <Plus className="h-4 w-4 mr-1.5" /> Add server
              </>
            )}
          </Button>
        </div>
      </SettingsSectionCard>
    </div>
  );
}
