"use client";

import { useEffect, useState } from "react";
import { useSubagentStore, type SubagentConfig } from "@/stores/subagent-store";
import { aiProviderService } from "@/lib/services";
import { useAuth } from "@/hooks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Bot, Plus, Trash2, Save, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface AIProvider {
  id: string;
  name: string;
  base_url: string;
  models: string[];
  is_active: boolean;
}

export default function SubagentsSettingsPage() {
  const { subagents, updateSubagent, deleteSubagent, loadFromStorage } = useSubagentStore();
  const { user } = useAuth();
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    loadFromStorage();
  }, [loadFromStorage]);

  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      try {
        const list = await aiProviderService.list(user.id);
        setProviders(list);
      } catch {
        // ignore
      }
    })();
  }, [user?.id]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Subagents</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Subagents are created automatically by the AI orchestrator when it detects a large task.
          You can configure each subagent's API provider, model, and system prompt here. All subagents
          share the same sandbox + file system as the main agent.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{subagents.length} subagent{subagents.length !== 1 ? "s" : ""}</p>
      </div>

      <div className="space-y-3">
        {subagents.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center">
            <Bot className="mx-auto h-10 w-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium">No subagents yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              The AI will create subagents automatically when you ask it to do complex tasks.
            </p>
          </div>
        ) : (
          subagents.map((s) => (
            <SubagentCard
              key={s.id}
              subagent={s}
              providers={providers}
              editing={editingId === s.id}
              onEdit={() => setEditingId(editingId === s.id ? null : s.id)}
              onUpdate={(updates) => updateSubagent(s.id, updates)}
              onDelete={() => {
                if (confirm(`Delete subagent "${s.name}"?`)) {
                  deleteSubagent(s.id);
                  toast.success("Subagent deleted");
                }
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}

function SubagentCard({
  subagent,
  providers,
  editing,
  onEdit,
  onUpdate,
  onDelete,
}: {
  subagent: SubagentConfig;
  providers: AIProvider[];
  editing: boolean;
  onEdit: () => void;
  onUpdate: (updates: Partial<SubagentConfig>) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(subagent.name);
  const [description, setDescription] = useState(subagent.description);
  const [systemPrompt, setSystemPrompt] = useState(subagent.systemPrompt);
  const [specialty, setSpecialty] = useState(subagent.specialty);
  const [providerId, setProviderId] = useState(subagent.providerId ?? "");
  const [model, setModel] = useState(subagent.model ?? "");
  const [apiKey, setApiKey] = useState(subagent.apiKey ?? "");
  const [enabled, setEnabled] = useState(subagent.enabled);

  const selectedProvider = providers.find((p) => p.id === providerId);

  const handleSave = () => {
    onUpdate({
      name,
      description,
      systemPrompt,
      specialty,
      providerId: providerId || null,
      model: model || null,
      apiKey: apiKey || null,
      enabled,
    });
    toast.success("Subagent saved");
    onEdit();
  };

  return (
    <div className={cn(
      "rounded-xl border border-border bg-card overflow-hidden",
      !enabled && "opacity-60",
    )}>
      {/* Summary header (always visible) */}
      <div className="flex items-center justify-between p-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Bot className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="font-medium truncate">{subagent.name}</p>
            <p className="text-xs text-muted-foreground truncate">
              {subagent.specialty} · {subagent.model || subagent.providerId ? "custom config" : "inherits main agent"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={onEdit}>
            {editing ? "Cancel" : "Edit"}
          </Button>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive" onClick={onDelete}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Edit form */}
      {editing && (
        <div className="border-t border-border p-4 space-y-3">
          {/* Name */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 h-9" />
          </div>

          {/* Specialty */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Specialty</label>
            <select
              value={specialty}
              onChange={(e) => setSpecialty(e.target.value as SubagentConfig["specialty"])}
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
            >
              <option value="general">General</option>
              <option value="research">Research</option>
              <option value="code">Code</option>
              <option value="analysis">Analysis</option>
              <option value="writing">Writing</option>
            </select>
          </div>

          {/* Description */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Description</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1 h-9" />
          </div>

          {/* System Prompt */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">System Prompt</label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm resize-y"
              placeholder="Instructions for this subagent..."
            />
          </div>

          {/* Provider override */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              API Provider (leave empty to inherit main agent's)
            </label>
            <select
              value={providerId}
              onChange={(e) => {
                setProviderId(e.target.value);
                setModel(""); // reset model when provider changes
              }}
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
            >
              <option value="">Inherit from main agent</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Model override */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Model (leave empty to inherit)
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={!providerId && !selectedProvider}
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm disabled:opacity-50"
            >
              <option value="">Inherit</option>
              {(selectedProvider?.models ?? []).map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>

          {/* API Key override */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              API Key (leave empty to inherit provider's key)
            </label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="mt-1 h-9"
              placeholder="Inherit from provider"
            />
          </div>

          {/* Enabled toggle */}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4"
            />
            Enabled (orchestrator can call this subagent)
          </label>

          {/* Save */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={onEdit}>Cancel</Button>
            <Button size="sm" className="gap-2" onClick={handleSave}>
              <Save className="h-4 w-4" />
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
