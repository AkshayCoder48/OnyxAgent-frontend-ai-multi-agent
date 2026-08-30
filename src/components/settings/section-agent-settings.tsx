"use client";

import * as React from "react";
import { toast } from "sonner";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { useSettings } from "@/hooks/use-data";
import { useAuthStore } from "@/stores";
import type { UserSettings } from "@/types";

type ThinkingEffort = "low" | "medium" | "high";

interface EnvRow {
  id: string;
  key: string;
  value: string;
}

/** Convert settings.env_vars (Array<{ name, is_secret, value_present }>)
 *  into editable rows. Values are loaded async via getDecryptedEnvVars
 *  because the settings object only has metadata (not actual values). */
function envVarsMetadataToRows(
  vars: Array<{ name: string; is_secret: boolean; value_present: boolean }>,
): EnvRow[] {
  return vars.map((v) => ({
    id: crypto.randomUUID(),
    key: v.name,
    value: "", // actual value loaded separately below
  }));
}

function rowsToEnvVars(rows: EnvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) continue;
    out[k] = r.value;
  }
  return out;
}

export function SectionAgentSettings() {
  const { settings, loading, update } = useSettings();

  const [defaultModel, setDefaultModel] = React.useState("");
  const [temperature, setTemperature] = React.useState(0.7);
  const [thinkingEnabled, setThinkingEnabled] = React.useState(false);
  const [thinkingEffort, setThinkingEffort] = React.useState<ThinkingEffort>("medium");
  const [, setSystemPrompt] = React.useState("");
  const [, setSystemPromptEnabled] = React.useState(false);
  const [envRows, setEnvRows] = React.useState<EnvRow[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [hydrated, setHydrated] = React.useState(false);

  // Hydrate form when settings load
  React.useEffect(() => {
    if (settings && !hydrated) {
      setDefaultModel(settings.default_model ?? "");
      setTemperature(settings.default_temperature ?? 0.7);
      setThinkingEnabled(settings.default_thinking_enabled ?? false);
      setThinkingEffort((settings.default_thinking_effort ?? "medium") as ThinkingEffort);
      setSystemPrompt(settings.system_prompt ?? "");
      setSystemPromptEnabled(settings.system_prompt_enabled);
      // Convert env vars metadata to rows (names only — values loaded below).
      const ev = settings.env_vars;
      const evArray = Array.isArray(ev) ? ev : [];
      setEnvRows(envVarsMetadataToRows(evArray));
      setHydrated(true);
    }
  }, [settings, hydrated]);

  // Load actual env var values from the service (the settings object only
  // has metadata — name + is_secret + value_present — not the actual values).
  React.useEffect(() => {
    if (!hydrated || !settings) return;
    const userId = useAuthStore.getState().user?.id;
    if (!userId) return;
    (async () => {
      try {
        const { settingsService } = await import("@/lib/services");
        const values = await settingsService.getDecryptedEnvVars(userId);
        setEnvRows((prev) =>
          prev.map((row) => ({
            ...row,
            value: values[row.key] ?? "",
          })),
        );
      } catch {
        // vault locked or error — leave values empty
      }
    })();
  }, [hydrated, settings]);

  function addEnvRow() {
    setEnvRows((r) => [...r, { id: crypto.randomUUID(), key: "", value: "" }]);
  }
  function updateEnvRow(id: string, patch: Partial<EnvRow>) {
    setEnvRows((r) => r.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }
  function removeEnvRow(id: string) {
    setEnvRows((r) => r.filter((row) => row.id !== id));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const patch: Partial<UserSettings> = {
        default_model: defaultModel.trim() || null,
        default_temperature: temperature,
        default_thinking_enabled: thinkingEnabled,
        default_thinking_effort: thinkingEffort,
        // System prompt removed — the runtime now uses a built-in rich prompt.
        system_prompt: null,
        system_prompt_enabled: false,
        env_vars: rowsToEnvVars(envRows),
      };
      await update(patch);
      toast.success("Agent settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  if (loading || !settings) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
        <Loader2 className="size-4 animate-spin" /> Loading settings…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Model & generation */}
      <section className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="default-model">Default model</Label>
          <Input
            id="default-model"
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
            placeholder="e.g. gpt-4.1-mini"
          />
          <p className="text-muted-foreground text-xs">
            Used when starting a new conversation without an explicit selection.
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="temperature">Default temperature</Label>
            <span className="text-muted-foreground text-xs tabular-nums">
              {temperature.toFixed(2)}
            </span>
          </div>
          <Slider
            id="temperature"
            min={0}
            max={2}
            step={0.05}
            value={[temperature]}
            onValueChange={(v) => setTemperature(v[0] ?? 0)}
          />
          <div className="text-muted-foreground flex justify-between text-xs">
            <span>Precise (0)</span>
            <span>Creative (2)</span>
          </div>
        </div>
      </section>

      <Separator />

      {/* Thinking */}
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label htmlFor="thinking-enabled">Extended thinking</Label>
            <p className="text-muted-foreground text-xs">
              Let the model reason before answering (where supported).
            </p>
          </div>
          <Switch
            id="thinking-enabled"
            checked={thinkingEnabled}
            onCheckedChange={setThinkingEnabled}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="thinking-effort">Thinking effort</Label>
          <Select
            value={thinkingEffort}
            onValueChange={(v: ThinkingEffort) => setThinkingEffort(v)}
            disabled={!thinkingEnabled}
          >
            <SelectTrigger id="thinking-effort" className="w-full sm:w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>

      <Separator />

      {/* Env vars */}
      <section className="space-y-3">
        <div>
          <Label>Environment variables</Label>
          <p className="text-muted-foreground text-xs">
            Injected into Python sandboxes and tool calls. Stored as a JSON object on your settings.
          </p>
        </div>
        <div className="space-y-2">
          {envRows.length === 0 ? (
            <p className="text-muted-foreground rounded-md border border-dashed py-6 text-center text-xs">
              No environment variables set.
            </p>
          ) : (
            envRows.map((row) => (
              <div key={row.id} className="flex items-center gap-2">
                <Input
                  value={row.key}
                  onChange={(e) => updateEnvRow(row.id, { key: e.target.value })}
                  placeholder="KEY"
                  className="font-mono text-sm"
                  autoComplete="off"
                />
                <Input
                  value={row.value}
                  onChange={(e) => updateEnvRow(row.id, { value: e.target.value })}
                  placeholder="value"
                  className="font-mono text-sm"
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-destructive hover:text-destructive shrink-0"
                  onClick={() => removeEnvRow(row.id)}
                  aria-label="Remove row"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))
          )}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={addEnvRow}>
          <Plus className="size-4" /> Add variable
        </Button>
      </section>

      {/* Sticky footer save bar */}
      <div className="bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky bottom-0 -mx-4 mt-4 border-t backdrop-blur md:-mx-8">
        <div className="flex items-center justify-end gap-2 px-4 py-3 md:px-8">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save changes
          </Button>
        </div>
      </div>
    </div>
  );
}

export default SectionAgentSettings;
