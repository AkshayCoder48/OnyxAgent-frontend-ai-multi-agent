"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  Lock,
  Pencil,
  Plus,
  Search,
  Trash2,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";

import {
  Button,
  Input,
  Label,
  Switch,
  Textarea,
} from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SectionCard as SettingsSectionCard } from "@/components/settings/settings-section";
import { useAuth } from "@/hooks";
import { customToolService } from "@/lib/services";
// Side-effect: registers every built-in tool with the central registry.
// Imported for its side effects — `listTools` below would return an empty
// list without it.
import "@/lib/tools";
import { listTools } from "@/lib/tools/registry";

interface CustomTool {
  id: string;
  name: string;
  description: string;
  parameters_schema: Record<string, unknown>;
  impl_kind: "http_webhook" | "python_snippet";
  http_url?: string | null;
  http_headers: Record<string, string>;
  python_source?: string | null;
  is_active: boolean;
}

const EMPTY_FORM = {
  name: "",
  description: "",
  impl_kind: "python_snippet" as "http_webhook" | "python_snippet",
  http_url: "",
  http_headers: "{}",
  python_source: "return {'hello': 'world'}",
  parameters_schema: '{"type":"object","properties":{}}',
};

export default function ToolsSettingsPage() {
  const { user } = useAuth();
  const [tools, setTools] = useState<CustomTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<CustomTool | null>(null);

  // Built-in tools come from the central registry (populated by the
  // side-effect `import "@/lib/tools"` above). They're read-only — the user
  // can't edit or delete them, but listing them here gives transparency
  // about what the agent can call.
  const builtinTools = useMemo(() => listTools(), []);

  const fetchData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const rows = await customToolService.list(user.id);
      setTools(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          parameters_schema: r.parameters_schema,
          impl_kind: r.impl_kind,
          http_url: r.http_url ?? null,
          http_headers: r.http_headers ?? {},
          python_source: r.python_source ?? null,
          is_active: r.is_active,
        })),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const filtered = tools.filter(
    (t) =>
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.description.toLowerCase().includes(search.toLowerCase()),
  );

  // Built-in tools are also affected by the search box — a single search
  // filters both lists so the user can find any tool by name.
  const filteredBuiltin = builtinTools.filter(
    (t) =>
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.description.toLowerCase().includes(search.toLowerCase()),
  );

  const handleToggle = async (tool: CustomTool, active: boolean) => {
    try {
      await customToolService.update(tool.id, { is_active: active });
      setTools((prev) =>
        prev.map((t) => (t.id === tool.id ? { ...t, is_active: active } : t)),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Toggle failed");
    }
  };

  const handleDelete = async (tool: CustomTool) => {
    if (!confirm(`Delete tool "${tool.name}"?`)) return;
    try {
      await customToolService.delete(tool.id);
      toast.success("Tool deleted", { description: tool.name });
      await fetchData();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Wrench className="h-6 w-6" />
          Available tools
        </h1>
        <p className="text-muted-foreground mt-1">
          Available tools are functions the AI can call. Define them as HTTP
          webhooks or Python snippets — the AI picks them up automatically on
          the next chat turn.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search tools…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setEditorOpen(true);
          }}
        >
          <Plus className="h-4 w-4 mr-2" />
          New tool
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <SettingsSectionCard
            title="Built-in tools"
            description="Always-available tools shipped with the app. The agent can call these on any chat turn. Read-only — you can't edit or delete them."
          >
            {filteredBuiltin.length === 0 ? (
              <div className="rounded-xl border border-dashed border-foreground/15 p-6 text-center text-sm text-muted-foreground">
                No built-in tools match your search.
              </div>
            ) : (
              <div className="grid gap-3 max-h-96 overflow-y-auto scrollbar-thin pr-1">
                {filteredBuiltin.map((tool) => (
                  <Card
                    key={tool.name}
                    className="animate-fade-in opacity-95"
                  >
                    <CardContent className="py-3 px-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-sm font-medium">
                              {tool.name}
                            </span>
                            <Badge variant="outline" className="text-[10px]">
                              {tool.category ?? "general"}
                            </Badge>
                            {tool.requires_approval && (
                              <Badge
                                variant="outline"
                                className="text-[10px] gap-1 text-amber-600 dark:text-amber-400 border-amber-500/40"
                                title="Asks for your approval before running"
                              >
                                <Lock className="h-2.5 w-2.5" />
                                approval
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {tool.description || "No description"}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Badge variant="secondary" className="text-[10px]">
                            built-in
                          </Badge>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </SettingsSectionCard>

          <SettingsSectionCard
            title="Your tools"
            description="Tools you've created. These are available to the AI on every chat turn."
          >
            {filtered.length === 0 ? (
              <div className="rounded-xl border border-dashed border-foreground/15 p-8 text-center">
                <Wrench className="mx-auto h-8 w-8 text-muted-foreground mb-3" />
                <p className="font-medium">No tools yet</p>
                <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
                  Click <em>New tool</em> above to define your first tool. Tools
                  can be HTTP webhooks or Python snippets the AI calls
                  automatically when your task matches.
                </p>
              </div>
            ) : (
              <div className="grid gap-3">
                {filtered.map((tool) => (
                  <Card key={tool.id} className="animate-fade-in hover:shadow-md transition-shadow">
                    <CardContent className="py-3 px-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-sm font-medium">
                              {tool.name}
                            </span>
                            <Badge variant="outline" className="text-[10px]">
                              {tool.impl_kind === "http_webhook" ? "HTTP" : "Python"}
                            </Badge>
                            <Badge variant={tool.is_active ? "default" : "secondary"}>
                              {tool.is_active ? "Enabled" : "Disabled"}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {tool.description || "No description"}
                          </p>
                          {tool.impl_kind === "http_webhook" && tool.http_url && (
                            <p className="text-[10px] font-mono text-muted-foreground/60 truncate">
                              POST {tool.http_url}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Switch
                            checked={tool.is_active}
                            onCheckedChange={(v) => handleToggle(tool, v)}
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setEditing(tool);
                              setEditorOpen(true);
                            }}
                            title="Edit"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleDelete(tool)}
                            title="Delete"
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </SettingsSectionCard>
        </>
      )}

      <ToolEditor
        open={editorOpen}
        tool={editing}
        onClose={() => {
          setEditorOpen(false);
          setEditing(null);
        }}
        onSaved={() => {
          setEditorOpen(false);
          setEditing(null);
          void fetchData();
        }}
      />
    </div>
  );
}

/* -------------------- Tool editor -------------------- */

interface ToolEditorProps {
  open: boolean;
  tool: CustomTool | null;
  onClose: () => void;
  onSaved: () => void;
}

function ToolEditor({ open, tool, onClose, onSaved }: ToolEditorProps) {
  const { user } = useAuth();
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (tool) {
      setForm({
        name: tool.name,
        description: tool.description,
        impl_kind: tool.impl_kind,
        http_url: tool.http_url ?? "",
        http_headers: JSON.stringify(tool.http_headers ?? {}, null, 2),
        python_source: tool.python_source ?? "return {'hello': 'world'}",
        parameters_schema: JSON.stringify(tool.parameters_schema ?? {}, null, 2),
      });
    } else {
      setForm({ ...EMPTY_FORM });
    }
  }, [tool, open]);

  const handleSave = async () => {
    if (!user) return;
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    let parsedHeaders: Record<string, string> = {};
    let parsedSchema: Record<string, unknown> = {};
    try {
      parsedHeaders = form.http_headers.trim() ? JSON.parse(form.http_headers) : {};
    } catch {
      toast.error("HTTP headers must be a JSON object");
      return;
    }
    try {
      parsedSchema = form.parameters_schema.trim()
        ? JSON.parse(form.parameters_schema)
        : {};
    } catch {
      toast.error("Parameters schema must be a JSON object");
      return;
    }
    if (form.impl_kind === "http_webhook" && !form.http_url.trim()) {
      toast.error("HTTP webhook requires a URL");
      return;
    }
    if (form.impl_kind === "python_snippet" && !form.python_source.trim()) {
      toast.error("Python snippet requires source code");
      return;
    }

    setSaving(true);
    try {
      const input = {
        name: form.name.trim(),
        description: form.description.trim() || "Custom tool",
        parameters_schema: parsedSchema,
        impl_kind: form.impl_kind,
        // Use `undefined` (not `null`) so the create() signature's optional
        // fields accept the value. update() takes Record<string, unknown>
        // and treats `undefined` as "skip" — the underlying row keeps its
        // existing value, which is what we want when switching impl_kind.
        http_url: form.impl_kind === "http_webhook" ? form.http_url.trim() : undefined,
        http_headers: parsedHeaders,
        python_source: form.impl_kind === "python_snippet" ? form.python_source : undefined,
        is_active: true,
      };
      if (tool) {
        await customToolService.update(tool.id, input);
        toast.success("Tool updated", { description: form.name });
      } else {
        await customToolService.create(user.id, input);
        toast.success("Tool created", { description: form.name });
      }
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{tool ? "Edit tool" : "Create custom tool"}</DialogTitle>
          <DialogDescription>
            Define a tool the AI can call. Choose HTTP webhook (POST args to a
            URL) or Python snippet (run in a sandbox).
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto space-y-4 py-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tool-name" className="text-xs uppercase">Name (snake_case)</Label>
              <Input
                id="tool-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="my_custom_tool"
                className="font-mono"
                disabled={!!tool}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tool-kind" className="text-xs uppercase">Implementation</Label>
              <select
                id="tool-kind"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={form.impl_kind}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    impl_kind: e.target.value as "http_webhook" | "python_snippet",
                  }))
                }
              >
                <option value="python_snippet">Python snippet (sandboxed)</option>
                <option value="http_webhook">HTTP webhook (POST)</option>
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tool-desc" className="text-xs uppercase">Description</Label>
            <Textarea
              id="tool-desc"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="What does this tool do? When should the AI call it?"
              rows={2}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tool-schema" className="text-xs uppercase">
              Parameters JSON Schema
            </Label>
            <Textarea
              id="tool-schema"
              value={form.parameters_schema}
              onChange={(e) => setForm((f) => ({ ...f, parameters_schema: e.target.value }))}
              className="font-mono text-xs"
              rows={4}
              spellCheck={false}
            />
          </div>

          {form.impl_kind === "http_webhook" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="tool-url" className="text-xs uppercase">HTTP URL</Label>
                <Input
                  id="tool-url"
                  value={form.http_url}
                  onChange={(e) => setForm((f) => ({ ...f, http_url: e.target.value }))}
                  placeholder="https://example.com/webhook"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tool-headers" className="text-xs uppercase">Headers (JSON)</Label>
                <Textarea
                  id="tool-headers"
                  value={form.http_headers}
                  onChange={(e) => setForm((f) => ({ ...f, http_headers: e.target.value }))}
                  className="font-mono text-xs"
                  rows={3}
                  spellCheck={false}
                />
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="tool-src" className="text-xs uppercase">Python source</Label>
              <Textarea
                id="tool-src"
                value={form.python_source}
                onChange={(e) => setForm((f) => ({ ...f, python_source: e.target.value }))}
                className="font-mono text-xs"
                rows={10}
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                The snippet runs in a restricted Python sandbox (no imports
                beyond math/json/datetime/re). The kwargs are available as a
                dict named <code>_args</code>. Use <code>return</code> to
                return a value.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {tool ? "Save changes" : "Create tool"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
