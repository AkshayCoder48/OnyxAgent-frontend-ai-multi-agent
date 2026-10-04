"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  Cloud,
  Eye,
  EyeOff,
  ExternalLink,
  KeyRound,
  Loader2,
  Save,
  Trash2,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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

import { useSettings } from "@/hooks/use-data";
import { useAuth } from "@/hooks";
import { MoreOptions } from "@/components/settings/more-options";
import {
  OnyxBaseKV,
  ONYXBASE_DEFAULT_BASE_URL,
  looksLikeOnyxBaseKey,
} from "@/lib/onyxbase/kv-client";

/**
 * OnyxBase cloud settings — the API key that powers the OnyxBase-backed
 * cloud features: skills cloud backup (Settings → Skills) and the
 * server-side workspace sync for scheduled tasks (each scheduled run
 * restores its workspace from the cloud before it starts and syncs it
 * back after it finishes).
 *
 * The key is vault-encrypted at rest and NEVER reaches the LLM, the system
 * prompt, tool arguments, or the E2B sandbox.
 */

export function SectionCloudWorkspace() {
  const { settings, loading, setOnyxBaseApiKey, update } = useSettings();
  // useAuth (not the raw store) — its mount effect runs authStore.init(),
  // which rehydrates the real user + vault on a cold direct navigation to
  // /settings/cloud. Without it the store stays on the default local-user
  // and key saves land on the wrong row (auth-hydration race).
  const { user } = useAuth();
  const userId = user?.id;

  const [key, setKey] = React.useState("");
  const [show, setShow] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [clearOpen, setClearOpen] = React.useState(false);
  const [baseUrl, setBaseUrl] = React.useState("");

  const hasStored = !!settings?.onyxbase_api_key_present;
  const effectiveBaseUrl =
    (baseUrl || settings?.onyxbase_base_url || ONYXBASE_DEFAULT_BASE_URL).replace(/\/+$/, "");

  React.useEffect(() => {
    if (settings?.onyxbase_base_url && !baseUrl) {
      setBaseUrl(settings.onyxbase_base_url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.onyxbase_base_url]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) {
      toast.error("Enter an API key first");
      return;
    }
    if (!looksLikeOnyxBaseKey(trimmed)) {
      toast.error("Key format looks invalid", {
        description: "OnyxBase keys look like kv_live_… (16+ URL-safe characters).",
        icon: <XCircle className="size-4" />,
      });
      return;
    }
    setSaving(true);
    try {
      await setOnyxBaseApiKey(trimmed);
      setKey("");
      // Persist a custom base URL alongside the key if one was entered.
      if (baseUrl.trim() && baseUrl.trim() !== ONYXBASE_DEFAULT_BASE_URL) {
        await update({ onyxbase_base_url: baseUrl.trim() });
      }
      toast.success("OnyxBase API key saved", {
        description: "Encrypted at rest with AES-GCM in your browser.",
        icon: <CheckCircle2 className="size-4" />,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save key");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    if (!userId) {
      toast.error("Sign in first");
      return;
    }
    setTesting(true);
    try {
      // Prefer the key typed into the field; fall back to the stored one.
      let candidate = key.trim();
      if (!candidate) {
        const { settingsService } = await import("@/lib/services");
        candidate = (await settingsService.getDecryptedOnyxBaseApiKey(userId)) ?? "";
      }
      if (!candidate) {
        toast.error("Add your OnyxBase API key first", {
          description: "Enter a kv_live_… key, then test the connection.",
          icon: <XCircle className="size-4" />,
        });
        return;
      }
      const kv = new OnyxBaseKV(candidate, effectiveBaseUrl);
      const who = await kv.whoami();
      const name =
        (typeof who.apiKey?.name === "string" && who.apiKey.name) ||
        (typeof who.user === "string" && who.user) ||
        "your account";
      toast.success("Connected to OnyxBase", {
        description: `Verified as ${name}.`,
        icon: <CheckCircle2 className="size-4" />,
      });
    } catch (err) {
      toast.error("Unable to connect", {
        description: err instanceof Error ? err.message : "Connection failed",
        icon: <XCircle className="size-4" />,
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleClear() {
    if (!userId) return;
    try {
      await setOnyxBaseApiKey(null);
      toast.success("OnyxBase API key removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to clear key");
    } finally {
      setClearOpen(false);
    }
  }

  async function handleBaseUrlSave() {
    const trimmed = baseUrl.trim();
    try {
      await update({ onyxbase_base_url: trimmed || undefined });
      toast.success(trimmed ? "OnyxBase endpoint saved" : "Endpoint reset to default");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save endpoint");
    }
  }

  if (loading && !settings) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* What this is */}
      <Alert>
        <Cloud className="size-4" />
        <AlertTitle>OnyxBase cloud backup</AlertTitle>
        <AlertDescription>
          The OnyxBase API key connects Onyx to your private OnyxBase KV account. It
          powers the skills cloud backup (every installed skill is pushed to the cloud
          and can be restored from it — see Skills) and keeps scheduled tasks persistent:
          each scheduled run restores its workspace from the cloud before it starts and
          syncs it back after it finishes. Get a free key at{" "}
          <a
            href="https://onyxbase-chi.vercel.app"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 font-medium underline underline-offset-2"
          >
            onyxbase-chi.vercel.app
            <ExternalLink className="size-3" />
          </a>
          .
        </AlertDescription>
      </Alert>

      {/* API key */}
      <form onSubmit={handleSave} className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="onyxbase-key">OnyxBase API Key</Label>
          <div className="relative">
            <KeyRound className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="onyxbase-key"
              type={show ? "text" : "password"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={hasStored ? "•••••••••••• (a key is stored)" : "kv_live_…"}
              autoComplete="off"
              spellCheck={false}
              className="pl-9 pr-10 font-mono"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
              aria-label={show ? "Hide key" : "Show key"}
            >
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {hasStored
              ? "A key is stored, encrypted. Type a new one to replace it."
              : "Stored encrypted (AES-GCM) in your browser. Never sent to the AI model."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={saving || !key.trim()}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            {hasStored ? "Replace key" : "Save key"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleTest}
            disabled={testing}
          >
            {testing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Cloud className="size-4" />
            )}
            Test Connection
          </Button>
          {hasStored && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setClearOpen(true)}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="size-4" />
              Remove
            </Button>
          )}
        </div>
      </form>

      {/* Status — workspace id (non-secret) */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border bg-muted/30 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Workspace ID</span>
            <Badge variant={hasStored ? "secondary" : "outline"} className="gap-1">
              {hasStored ? (
                <CheckCircle2 className="size-3 text-emerald-500" />
              ) : (
                <XCircle className="size-3 text-muted-foreground" />
              )}
              {hasStored ? "Active" : "Inactive"}
            </Badge>
          </div>
          <p className="mt-1 font-mono text-sm">{settings?.onyxbase_workspace_id ?? "workspace_default"}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Fixed identifier — not a secret. The OnyxBase workspace your skill backups and
            scheduled-task files sync to.
          </p>
        </div>
      </div>

      {/* ── Advanced — custom OnyxBase endpoint ── */}
      <MoreOptions>
        <div className="flex items-end gap-2 rounded-lg border p-3">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="onyxbase-url" className="text-xs">
              API endpoint
            </Label>
            <Input
              id="onyxbase-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={ONYXBASE_DEFAULT_BASE_URL}
              spellCheck={false}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Only change this if you run your own OnyxBase deployment. Default:{" "}
              <span className="font-mono">{ONYXBASE_DEFAULT_BASE_URL}</span>
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={handleBaseUrlSave}>
            <Save className="size-4" />
            Save
          </Button>
        </div>
      </MoreOptions>

      {/* Clear-key confirmation */}
      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove OnyxBase API key?</AlertDialogTitle>
            <AlertDialogDescription>
              Skills cloud backup and scheduled-task workspace sync will stop working
              until a new key is added. Everything already stored in your OnyxBase
              account stays there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleClear}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
