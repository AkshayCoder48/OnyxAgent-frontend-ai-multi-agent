"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  Cloud,
  ExternalLink,
  KeyRound,
  Loader2,
  RotateCcw,
  Save,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import { useSettings } from "@/hooks/use-data";
import { useAuth } from "@/hooks";
import {
  ONYXBASE_DEFAULT_BASE_URL,
  resolveOnyxBaseUrl,
} from "@/lib/onyxbase/kv-client";

/**
 * OnyxBase settings — one simple screen (Task 21):
 *   1. the base URL — the custom-instance override, PROMOTED out of the old
 *      "More options" drawer. Default https://onyxbase-chi.vercel.app, a
 *      one-click reset, live "effective endpoint" display, and the same
 *      normalization the app uses at call time (resolveOnyxBaseUrl).
 *   2. the API key itself MOVED to Settings → API Keys (task 2026-11-14) —
 *      every key input in the app lives in that one tab.
 *
 * The key is vault-encrypted at rest and NEVER reaches the LLM, the system
 * prompt, tool arguments, or the E2B sandbox.
 */

/** Same normalization the clients use — never store a second variant. */
function normalizeForStore(raw: string): string {
  return resolveOnyxBaseUrl(raw);
}

export function SectionCloudWorkspace() {
  const { settings, loading, update } = useSettings();
  // useAuth (not the raw store) — its mount effect runs authStore.init(),
  // which rehydrates the real user + vault on a cold direct navigation to
  // /settings/cloud. Without it the store stays on the default local-user
  // and key saves land on the wrong row (auth-hydration race).
  useAuth();

  const [baseUrl, setBaseUrl] = React.useState("");

  const hasStored = !!settings?.onyxbase_api_key_present;
  const hasCustomUrl = !!settings?.onyxbase_base_url?.trim();
  /** The endpoint that will actually be used on the next call. */
  const effectiveBaseUrl = resolveOnyxBaseUrl(baseUrl || settings?.onyxbase_base_url);

  React.useEffect(() => {
    if (settings?.onyxbase_base_url && !baseUrl) {
      setBaseUrl(settings.onyxbase_base_url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.onyxbase_base_url]);

  async function handleBaseUrlSave() {
    const raw = baseUrl.trim();
    if (!raw) {
      // Empty input = reset to the default.
      await update({ onyxbase_base_url: undefined });
      toast.success("Endpoint reset to default", {
        description: ONYXBASE_DEFAULT_BASE_URL,
        icon: <CheckCircle2 className="size-4" />,
      });
      return;
    }
    const normalized = normalizeForStore(raw);
    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      toast.error("That doesn't look like a URL", {
        description: "Example: https://onyxbase-chi.vercel.app",
        icon: <XCircle className="size-4" />,
      });
      return;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      toast.error("Only http(s) endpoints are supported", {
        icon: <XCircle className="size-4" />,
      });
      return;
    }
    if (normalized === ONYXBASE_DEFAULT_BASE_URL) {
      // Equal to the default — store nothing; the default applies.
      await update({ onyxbase_base_url: undefined });
      setBaseUrl("");
      toast.success("Using the default endpoint", {
        description: ONYXBASE_DEFAULT_BASE_URL,
        icon: <CheckCircle2 className="size-4" />,
      });
      return;
    }
    try {
      await update({ onyxbase_base_url: normalized });
      setBaseUrl(normalized);
      toast.success("Custom endpoint saved", {
        description: normalized,
        icon: <CheckCircle2 className="size-4" />,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save endpoint");
    }
  }

  async function handleBaseUrlReset() {
    try {
      await update({ onyxbase_base_url: undefined });
      setBaseUrl("");
      toast.success("Endpoint reset to default", {
        description: ONYXBASE_DEFAULT_BASE_URL,
        icon: <CheckCircle2 className="size-4" />,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reset endpoint");
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
        <AlertTitle>OnyxBase</AlertTitle>
        <AlertDescription>
          One free key connects everything that stores data in the cloud: the Knowledge Base, workspace
          snapshots, the code database, and skill backups. Get a key at{" "}
          <a
            href={ONYXBASE_DEFAULT_BASE_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 font-medium underline underline-offset-2"
          >
            {ONYXBASE_DEFAULT_BASE_URL.replace(/^https?:\/\//, "")}
            <ExternalLink className="size-3" />
          </a>
          . The key is encrypted in your browser and never sent to the AI model.
        </AlertDescription>
      </Alert>

      {/*
        KEY MANAGEMENT MOVED (task 2026-11-14): every key input lives in
        Settings → API Keys. This section keeps the endpoint (base URL)
        configuration and the sync surfaces.
      */}
      <div className="text-muted-foreground flex items-start gap-3 rounded-lg border border-dashed p-4">
        <KeyRound className="text-foreground/70 mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium">The key moved to Settings → API Keys</p>
          <p className="mt-0.5 text-xs leading-relaxed">
            {hasStored
              ? "A key is stored (encrypted). Replace, test or clear it in the API Keys tab — the single home for every credential."
              : "No key stored yet. Add one in the API Keys tab — the single home for every credential."}
          </p>
        </div>
      </div>

      {/* ── Base URL — custom endpoint, in the open (Task 21) ── */}
      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="space-y-0.5">
            <Label htmlFor="onyxbase-url">Base URL</Label>
            <p className="text-xs text-muted-foreground">
              Only change this if you run your own OnyxBase instance.
            </p>
          </div>
          <Badge variant={hasCustomUrl ? "secondary" : "outline"} className="gap-1 shrink-0">
            {hasCustomUrl ? (
              <>
                <CheckCircle2 className="size-3 text-emerald-500" /> Custom
              </>
            ) : (
              <>
                <Cloud className="size-3 text-muted-foreground" /> Default
              </>
            )}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="onyxbase-url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={ONYXBASE_DEFAULT_BASE_URL}
            spellCheck={false}
            className="min-w-52 flex-1 font-mono text-xs"
          />
          <Button type="button" variant="outline" size="sm" onClick={handleBaseUrlSave}>
            <Save className="size-4" />
            Save
          </Button>
          {hasCustomUrl && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleBaseUrlReset}
              className="text-muted-foreground"
            >
              <RotateCcw className="size-4" />
              Use default
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Effective endpoint:{" "}
          <span className={`font-mono ${hasCustomUrl ? "text-foreground" : ""}`}>
            {effectiveBaseUrl}
          </span>
          {hasCustomUrl ? " (custom)" : " (default)"}
        </p>
      </div>

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
            Fixed identifier — not a secret. The OnyxBase workspace your data syncs to.
          </p>
        </div>
      </div>

    </div>
  );
}
