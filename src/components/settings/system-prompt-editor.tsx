"use client";

import * as React from "react";
import { FileUp, Loader2, Save } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSettings } from "@/hooks/use-data";
import { ONYX_AI_SYSTEM_PROMPT } from "@/hooks/use-chat";
import type { UserSettings } from "@/types";

/**
 * System prompt editor — the user-facing override for the built-in Onyx
 * agent prompt (applied per turn in buildTurnOptions: the custom prompt is
 * used only when enabled AND non-empty; the live tool list is always
 * appended afterwards, so this sets identity and behavior only).
 *
 * Two lanes:
 *  - `<SystemPromptEditor>` — CONTROLLED (value/enabled + change
 *    callbacks). Used inside the Agent Settings form, where one sticky Save
 *    bar persists every field together.
 *  - `<SystemPromptSection>` — SELF-CONTAINED (loads + saves through
 *    useSettings on its own). Used by the /settings/config route page.
 *
 * The prompt has NO length cap (user directive 2026-11-04) — the only bound
 * is the model provider's own context window. Long prompts usually arrive
 * as files, so the editor also imports .md / .txt files (optional): the
 * file's text is appended below the current prompt (or fills the empty
 * field), never silently replacing typed content.
 */

/** Browser-practicality bound on a single import (storage/UI sanity — the
 *  prompt content itself is uncapped). 32 MB ≈ millions of words. */
const MAX_IMPORT_BYTES = 32 * 1024 * 1024;

export function SystemPromptEditor({
  value,
  enabled,
  onValueChange,
  onEnabledChange,
}: {
  value: string;
  enabled: boolean;
  onValueChange: (v: string) => void;
  onEnabledChange: (v: boolean) => void;
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [importing, setImporting] = React.useState(false);

  async function handleFile(file: File) {
    const nameOk = /\.(md|markdown|txt)$/i.test(file.name);
    const typeOk = file.type === "text/markdown" || file.type === "text/plain";
    if (!nameOk && !typeOk) {
      toast.error(`"${file.name}" is not a .md or .txt file.`);
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      toast.error(
        `"${file.name}" is ${(file.size / 1048576).toFixed(1)} MB — a single import must stay under ${
          MAX_IMPORT_BYTES / 1048576
        } MB so the editor stays responsive.`,
      );
      return;
    }
    setImporting(true);
    try {
      const text = (await file.text()).replace(/\r\n/g, "\n");
      if (!text.trim()) {
        toast.error(`"${file.name}" is empty — nothing to import.`);
        return;
      }
      // Append below the current prompt; fill directly when the field is
      // empty. Never silently replace typed content.
      if (value.trim()) {
        onValueChange(value.replace(/\s*$/, "\n\n") + text);
        toast.success(`Imported "${file.name}" (${text.length.toLocaleString()} chars) — appended below the current prompt.`);
      } else {
        onValueChange(text);
        toast.success(`Imported "${file.name}" (${text.length.toLocaleString()} chars).`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not read "${file.name}".`);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label htmlFor="system-prompt-enabled">Custom system prompt</Label>
          <p className="text-muted-foreground text-xs">
            Replaces the built-in Onyx prompt on every turn. The live tool list is
            always appended — this sets identity and behavior. No length cap; or
            import a .md / .txt file.
          </p>
        </div>
        <Switch
          id="system-prompt-enabled"
          checked={enabled}
          onCheckedChange={onEnabledChange}
        />
      </div>
      <textarea
        id="system-prompt"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        disabled={!enabled}
        placeholder="Leave empty to use the built-in Onyx prompt, insert the default and tweak it, or import a .md / .txt file."
        className="bg-background focus:border-primary/50 min-h-[140px] w-full resize-y rounded-md border p-3 font-mono text-xs leading-relaxed outline-none transition-colors disabled:opacity-60"
      />
      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.markdown,.txt,text/markdown,text/plain"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
          // Reset so picking the same file twice fires change again.
          e.target.value = "";
        }}
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onValueChange(ONYX_AI_SYSTEM_PROMPT)}
            disabled={!enabled}
            className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 transition-colors hover:underline disabled:opacity-50"
          >
            Insert default prompt
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!enabled || importing}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-2 transition-colors hover:underline disabled:opacity-50"
          >
            {importing ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : (
              <FileUp className="h-3 w-3" aria-hidden="true" />
            )}
            Import .md / .txt
          </button>
        </div>
        <span className="text-muted-foreground text-xs tabular-nums">
          {value.length.toLocaleString()} chars · no cap
        </span>
      </div>
    </div>
  );
}

/** Self-contained lane: hydrates from settings, saves on its own button. */
export function SystemPromptSection() {
  const { settings, loading, update } = useSettings();

  const [value, setValue] = React.useState("");
  const [enabled, setEnabled] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [hydrated, setHydrated] = React.useState(false);

  React.useEffect(() => {
    if (settings && !hydrated) {
      setValue(settings.system_prompt ?? "");
      setEnabled(settings.system_prompt_enabled);
      setHydrated(true);
    }
  }, [settings, hydrated]);

  async function handleSave() {
    setSaving(true);
    try {
      const trimmed = value.trim();
      const patch: Partial<UserSettings> = {
        // Applies per turn only when enabled AND non-empty — an empty
        // custom prompt falls back to the built-in Onyx prompt.
        system_prompt: trimmed || null,
        system_prompt_enabled: enabled && !!trimmed,
      };
      await update(patch);
      toast.success("System prompt saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save system prompt");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <SystemPromptEditor
        value={value}
        enabled={enabled}
        onValueChange={setValue}
        onEnabledChange={setEnabled}
      />
      <div className="flex items-center justify-end gap-2">
        {loading && !hydrated ? (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </span>
        ) : null}
        <Button size="sm" onClick={handleSave} disabled={saving || loading}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save prompt
        </Button>
      </div>
    </div>
  );
}
