"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button, Input, Label } from "@/components/ui";
import { SectionCard as SettingsSectionCard } from "@/components/settings/settings-section";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks";
import { settingsService } from "@/lib/services";

interface EnvVar {
  name: string;
  value: string;
  /** Whether the value is masked in the UI by default (secrets). */
  is_secret: boolean;
}

const EMPTY_FORM = {
  name: "",
  value: "",
  is_secret: true as boolean,
};

export default function EnvSettingsPage() {
  const { user } = useAuth();
  const [vars, setVars] = useState<EnvVar[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [editingName, setEditingName] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [settings, decrypted] = await Promise.all([
        settingsService.get(user.id),
        settingsService.getDecryptedEnvVars(user.id),
      ]);
      const next: EnvVar[] = settings.env_vars.map((v) => ({
        name: v.name,
        // `getDecryptedEnvVars` returns the decrypted value for both secret
        // and plain vars — we keep the actual value in state so the reveal
        // toggle can show it. The UI masks secrets with dots by default.
        value: decrypted[v.name] ?? "",
        is_secret: v.is_secret,
      }));
      // Sort by name for stable rendering.
      next.sort((a, b) => a.name.localeCompare(b.name));
      setVars(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Build the full env-vars dict from the current UI state and persist it via
   * `settingsService.setEnvVars` — the service handles vault-encryption of
   * secret values. We always send the complete dict (existing + change) so
   * the persisted row reflects the full intended state.
   */
  const persistVars = async (next: EnvVar[]): Promise<void> => {
    if (!user) return;
    const asDict = Object.fromEntries(
      next.map((v) => [
        v.name,
        // Preserve the original `is_secret` flag; the value is the decrypted
        // string the UI holds in memory.
        { value: v.value, is_secret: v.is_secret },
      ]),
    );
    await settingsService.setEnvVars(user.id, asDict);
  };

  const handleSave = async () => {
    if (!user) return;
    const name = form.name.trim();
    if (!name) {
      toast.error("Name is required");
      return;
    }
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      toast.error("Name must be UPPER_SNAKE_CASE (A-Z, 0-9, _)");
      return;
    }
    if (!form.value) {
      toast.error("Value is required");
      return;
    }

    setSaving(true);
    try {
      // Build the next state: drop any existing entry with the same name
      // (for both create and edit), then add the new one.
      const next = vars
        .filter((v) => v.name !== name && v.name !== editingName)
        .concat([
          {
            name,
            value: form.value,
            is_secret: form.is_secret,
          },
        ]);
      await persistVars(next);
      toast.success(editingName ? `Updated ${name}` : `Added ${name}`);
      setForm({ ...EMPTY_FORM });
      setEditingName(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (v: EnvVar) => {
    setEditingName(v.name);
    setForm({ name: v.name, value: "", is_secret: v.is_secret });
    // Scroll to top so the form is visible.
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  const handleDelete = async (v: EnvVar) => {
    if (!user) return;
    if (!confirm(`Delete env var ${v.name}?`)) return;
    try {
      const next = vars.filter((x) => x.name !== v.name);
      await persistVars(next);
      toast.success(`Removed ${v.name}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const handleCancelEdit = () => {
    setForm({ ...EMPTY_FORM });
    setEditingName(null);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <KeyRound className="h-6 w-6" />
          Environment variables
        </h1>
        <p className="text-muted-foreground mt-1">
          Secret values the AI can read at chat time. These are stored encrypted
          in your local vault — the agent runtime decrypts them on demand when
          running tools on your behalf.
        </p>
      </div>

      <SettingsSectionCard
        title={editingName ? `Edit ${editingName}` : "Add an env var"}
        description="Use UPPER_SNAKE_CASE names. Secret values are encrypted at rest and only revealed when you toggle the eye icon."
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="env-name" className="text-xs uppercase">
                Name
              </Label>
              <Input
                id="env-name"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""),
                  }))
                }
                placeholder="OPENAI_API_KEY"
                className="font-mono"
                disabled={!!editingName}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="env-secret" className="text-xs uppercase">
                Type
              </Label>
              <select
                id="env-secret"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={form.is_secret ? "secret" : "plain"}
                onChange={(e) =>
                  setForm((f) => ({ ...f, is_secret: e.target.value === "secret" }))
                }
              >
                <option value="secret">Secret (masked)</option>
                <option value="plain">Plain (visible)</option>
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="env-value" className="text-xs uppercase">
              Value
            </Label>
            <Input
              id="env-value"
              value={form.value}
              onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
              placeholder={editingName ? "Enter new value to replace" : "Enter value"}
              type={form.is_secret ? "password" : "text"}
              className="font-mono"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Saving…
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4 mr-1.5" />
                  {editingName ? "Update var" : "Add var"}
                </>
              )}
            </Button>
            {editingName && (
              <Button variant="outline" onClick={handleCancelEdit} disabled={saving}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      </SettingsSectionCard>

      <SettingsSectionCard
        title="Your env vars"
        description="Stored encrypted in your local vault."
      >
        <div className="mb-3 flex items-center justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void load()}
            disabled={loading}
            className="h-7 text-xs"
          >
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : vars.length === 0 ? (
          <div className="rounded-xl border border-dashed border-foreground/15 p-8 text-center">
            <KeyRound className="mx-auto h-8 w-8 text-muted-foreground mb-3" />
            <p className="font-medium">No env vars set</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              Add your first env var above. The agent will be able to read it
              at chat time when running tools on your behalf.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {vars.map((v) => {
              const isRevealed = revealed[v.name];
              const display = v.is_secret
                ? isRevealed
                  ? v.value
                  : "•".repeat(Math.min(12, Math.max(8, (v.value || "").length || 8)))
                : v.value;
              return (
                <li key={v.name} className="flex items-start gap-3 py-3">
                  <KeyRound
                    className={cn(
                      "mt-0.5 h-4 w-4 shrink-0",
                      v.is_secret ? "text-amber-500" : "text-muted-foreground",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-mono text-sm font-medium">{v.name}</p>
                      <span
                        className={cn(
                          "text-[10px] font-mono uppercase rounded px-1.5 py-0.5",
                          v.is_secret
                            ? "bg-amber-500/10 text-amber-700"
                            : "bg-foreground/5 text-muted-foreground",
                        )}
                      >
                        {v.is_secret ? "secret" : "plain"}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 font-mono break-all">
                      {display}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {v.is_secret && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={() =>
                          setRevealed((r) => ({ ...r, [v.name]: !r[v.name] }))
                        }
                        title={isRevealed ? "Hide" : "Reveal"}
                      >
                        {isRevealed ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      onClick={() => handleEdit(v)}
                      title="Edit"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleDelete(v)}
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsSectionCard>
    </div>
  );
}
