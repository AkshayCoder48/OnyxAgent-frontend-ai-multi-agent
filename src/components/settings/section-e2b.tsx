"use client";

import * as React from "react";
import {
  ExternalLink,
  Info,
  KeyRound,
  RefreshCw,
  Snowflake,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import { useSettings } from "@/hooks/use-data";

/** Human age for a sandbox ("3h 12m"). */
function ageLabel(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins - h * 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Workspace lifecycle panel — the E2B pause/resume persistency STATUS
 *  view (docs.e2b.dev/sandbox/persistence). The lifecycle itself is FULLY
 *  AUTOMATIC (user directive: no manual controls — ever):
 *   · leaving the app AUTO-PAUSES every idle workspace (pagehide beacon);
 *   · a paused sandbox AUTO-RESUMES in place the next time anything needs
 *     it (any tool call / file op / bg poll reconnects via Sandbox.connect);
 *   · a sandbox with live processes is never paused (the live-run guard).
 *  This panel only SHOWS the state — there is nothing to manage. */
function WorkspaceLifecycle() {
  const [key, setKey] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<
    Array<{
      sandboxId: string;
      state: string;
      ageMs: number;
      scope: string | null;
      conversationId: string | null;
    }>
  >([]);
  const [busy, setBusy] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);

  const load = React.useCallback(async () => {
    setBusy(true);
    try {
      let apiKey = key;
      if (!apiKey) {
        const [{ settingsService }, { useAuthStore }] = await Promise.all([
          import("@/lib/services"),
          import("@/stores"),
        ]);
        const userId = useAuthStore.getState().user?.id;
        if (!userId) return;
        apiKey = await settingsService.getDecryptedSandboxKey(userId);
        if (!apiKey) return;
        setKey(apiKey);
      }
      const { fetchLifecycleStatus } = await import("@/lib/e2b/lifecycle-client");
      setItems(await fetchLifecycleStatus(apiKey));
    } catch {
      // best-effort — the panel just stays empty
    } finally {
      setLoaded(true);
      setBusy(false);
    }
  }, [key]);

  React.useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Workspace lifecycle</p>
        <Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => void load()} disabled={busy} aria-label="Refresh sandbox states">
          <RefreshCw className={busy ? "size-3.5 animate-spin" : "size-3.5"} />
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Fully automatic — nothing to manage manually. Workspaces freeze when you leave (the full
        state — filesystem + RAM — is preserved with no auto-deletion) and resume instantly, exactly
        where they froze, the next time anything needs them. Sandboxes with live processes are never paused.
      </p>
      {items.length === 0 ? (
        <p className="text-muted-foreground py-1 font-mono text-[11px]">
          {loaded ? "No active sandboxes on this account." : "…"}
        </p>
      ) : (
        <ul className="max-h-96 space-y-1.5 overflow-y-auto pr-1">
          {items.map((s) => (
            <li
              key={s.sandboxId}
              className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-2"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-[11px]" title={s.sandboxId}>
                  {s.sandboxId}
                </p>
                <p className="text-muted-foreground text-[10px]">
                  {s.scope === "separate" ? "per-chat workspace" : "shared workspace"}
                  {" · "}age {ageLabel(s.ageMs)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <span
                  className={
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase " +
                    (s.state === "paused"
                      ? "bg-sky-500/10 text-sky-600 dark:text-sky-400"
                      : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400")
                  }
                  title={
                    s.state === "paused"
                      ? "Frozen (full state preserved) — resumes automatically on next use"
                      : "Live — auto-pauses when you leave the app"
                  }
                >
                  {s.state === "paused" ? <Snowflake className="size-3" /> : <span className="size-1.5 rounded-full bg-current" />}
                  {s.state}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SectionE2B() {
  const { settings, loading } = useSettings();
  const hasStored = !!settings?.sandbox_api_key_present || !!settings?.e2b_api_key_present;

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
        <RefreshCw className="size-4 animate-spin" /> Loading…
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
          .
        </AlertDescription>
      </Alert>

      {/*
        KEY MANAGEMENT MOVED (task 2026-11-14): every key input in the app
        lives in Settings → API Keys — this section keeps only the sandbox
        lifecycle view. The pointer below is the one honest hand-off.
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

      {/* ── E2B persistency: pause/resume lifecycle of the workspace sandboxes ── */}
      {hasStored && <WorkspaceLifecycle />}
    </div>
  );
}

export default SectionE2B;
