"use client";

import * as React from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks";
import { settingsService } from "@/lib/services";
import type { UserSettings } from "@/types";

/**
 * SectionBrowserLicense — the CloakBrowser license-key field for the
 * ROUTE-BASED settings (Task 53: "add input in main setting page").
 *
 * The same field already lived in the in-app settings OVERLAY's Agent
 * Settings section, which is unreachable from the route pages (the sidebar
 * gear navigates here instead) — users had no way to paste a key from the
 * main settings surface. This component is the route-page twin: same env
 * var (CLOAKBROWSER_LICENSE_KEY), same vault-encrypted storage, same
 * browser-driver effect (with a key the browser tool runs CloakBrowser —
 * stealth Chromium, humanized input; without one it falls back to
 * patchright, then stock Chromium).
 *
 * WRITE PATH (must preserve the user's other env vars):
 * settingsService.update({ env_vars }) REPLACES the whole dict, and
 * setEnvVars does too — so a naive save with only the license would wipe
 * every other variable. The save loads the decrypted dict FIRST, sets or
 * deletes just the license entry, and writes the merged dict back. The
 * name matches the service's secret heuristic (/key/i), so the value is
 * vault-encrypted exactly like the overlay's save path.
 */
const CLOAK_LICENSE_ENV = "CLOAKBROWSER_LICENSE_KEY";

export function SectionBrowserLicense() {
  const { user } = useAuth();
  const [license, setLicense] = React.useState("");
  const [reveal, setReveal] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);

  // Load the current value once (decrypted — the settings row only carries
  // metadata). Failures leave the field blank: an empty field on a vault
  // error must NOT be saved as "remove the key" — hence the `loaded` gate.
  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const values = await settingsService.getDecryptedEnvVars(user.id);
        if (!cancelled) setLicense(values[CLOAK_LICENSE_ENV] ?? "");
      } catch {
        // Vault locked or read error — leave blank; save is gated on `loaded`.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleSave = async () => {
    if (!user) return;
    if (!loaded) {
      toast.error("Settings are still loading — try again in a moment");
      return;
    }
    setSaving(true);
    try {
      // MERGE-PRESERVE: update({env_vars}) replaces the entire dict, so
      // load every existing var and write them all back with the license
      // entry set (or removed when the field is cleared).
      const current = await settingsService.getDecryptedEnvVars(user.id);
      const trimmed = license.trim();
      if (trimmed) current[CLOAK_LICENSE_ENV] = trimmed;
      else delete current[CLOAK_LICENSE_ENV];
      await settingsService.update(user.id, { env_vars: current } as Partial<UserSettings>);
      toast.success(
        trimmed
          ? "CloakBrowser license key saved — the browser tool will use it on the next session"
          : "CloakBrowser license key removed — the browser falls back to patchright",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save license key");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor="cloak-license-route">CloakBrowser license key</Label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            id="cloak-license-route"
            type={reveal ? "text" : "password"}
            value={license}
            onChange={(e) => setLicense(e.target.value)}
            placeholder="cb_… (get one free at cloakbrowser.dev)"
            autoComplete="off"
            spellCheck={false}
            className="pr-10 font-mono text-sm"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={reveal ? "Hide license key" : "Show license key"}
            onClick={() => setReveal((r) => !r)}
            className="absolute inset-y-0 right-0 h-full w-10 px-0"
          >
            {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
        </div>
        <Button type="button" onClick={handleSave} disabled={saving || !user}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          Save
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        The browser tool runs CloakBrowser (stealth Chromium, humanized input) when a
        license key is set — it needs one even on the free tier. Without a key the
        browser falls back to patchright (a patched stealth Chromium), then stock
        Chromium. Stored encrypted as the{" "}
        <code className="font-mono text-[11px]">CLOAKBROWSER_LICENSE_KEY</code> env
        var and injected into the sandbox automatically. Clearing the field removes it.
      </p>
    </div>
  );
}
