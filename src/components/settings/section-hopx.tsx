"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  Eye,
  EyeOff,
  ExternalLink,
  Info,
  KeyRound,
  Loader2,
  Save,
  Trash2,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

// E2B sandbox keys are opaque tokens (e.g. e2b_...); we do a light
// structural check only.
const HOPX_KEY_RE = /^[A-Za-z0-9_\-]{8,}$/;

export function SectionHopx() {
  const { settings, loading, setHopxKey } = useSettings();
  const [key, setKey] = React.useState("");
  const [show, setShow] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [clearOpen, setClearOpen] = React.useState(false);

  const hasStored = !!settings?.sandbox_api_key_present || !!settings?.hopx_api_key_present;

  React.useEffect(() => {
    // We never decrypt the key for display; just show whether one is stored.
  }, [settings]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) {
      toast.error("Enter an API key first");
      return;
    }
    if (!HOPX_KEY_RE.test(trimmed)) {
      toast.error("Key format looks invalid", {
        description: "Expected 16+ alphanumeric/underscore/hyphen characters.",
        icon: <XCircle className="size-4" />,
      });
      return;
    }
    setSaving(true);
    try {
      await setHopxKey(trimmed);
      setKey("");
      toast.success("E2B Sandbox API key saved", {
        description: "Encrypted at rest with AES-GCM in your browser.",
        icon: <CheckCircle2 className="size-4" />,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save key");
    } finally {
      setSaving(false);
    }
  }

  async function handleTestFormat() {
    const trimmed = key.trim();
    if (!trimmed) {
      toast.error("Enter an API key first");
      return;
    }
    if (HOPX_KEY_RE.test(trimmed)) {
      toast.success("Key format looks valid", {
        description: "This is a structural check only; no request was made.",
        icon: <CheckCircle2 className="size-4" />,
      });
    } else {
      toast.error("Key format looks invalid", {
        description: "Expected 16+ alphanumeric/underscore/hyphen characters.",
        icon: <XCircle className="size-4" />,
      });
    }
  }

  async function handleClear() {
    setSaving(true);
    try {
      await setHopxKey(null);
      setKey("");
      toast.success("E2B Sandbox API key cleared");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to clear key");
    } finally {
      setSaving(false);
      setClearOpen(false);
    }
  }

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Alert>
        <Info className="size-4" />
        <AlertTitle>What is the E2B Sandbox?</AlertTitle>
        <AlertDescription>
          E2B provides a remote sandbox for running Python code, terminal commands, and file
          operations. Get your API key at{" "}
          <a
            href="https://e2b.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline underline-offset-4 inline-flex items-center gap-0.5"
          >
            e2b.dev <ExternalLink className="size-3" />
          </a>
          . Your key is encrypted with AES-GCM and stored locally in your browser only.
        </AlertDescription>
      </Alert>

      <form onSubmit={handleSave} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="hopx-key">E2B Sandbox API key</Label>
          <div className="relative">
            <KeyRound className="text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2" />
            <Input
              id="hopx-key"
              type={show ? "text" : "password"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={hasStored ? "•••••••• (stored) — enter new to replace" : "e2b_..."}
              className="pl-9 pr-10 font-mono"
              autoComplete="off"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute top-1/2 right-1 h-7 w-7 -translate-y-1/2"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? "Hide key" : "Show key"}
            >
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            {hasStored
              ? "A key is currently stored. Entering a new one will replace it."
              : "No key stored yet."}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={saving || !key.trim()}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save key
          </Button>
          <Button type="button" variant="outline" onClick={handleTestFormat} disabled={!key.trim()}>
            Test format
          </Button>
          {hasStored && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setClearOpen(true)}
              className="text-destructive hover:text-destructive"
              disabled={saving}
            >
              <Trash2 className="size-4" /> Clear key
            </Button>
          )}
        </div>
      </form>

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove E2B Sandbox API key?</AlertDialogTitle>
            <AlertDialogDescription>
              The encrypted key will be deleted from your browser. You can re-add it at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={handleClear}
            >
              Remove key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default SectionHopx;
