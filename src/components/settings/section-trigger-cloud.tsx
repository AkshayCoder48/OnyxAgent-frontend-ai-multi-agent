"use client";

// ============================================================================
// Settings → Cloud Tasks — the Trigger.dev CLOUD orchestrator panel
// (Background Task Execution Framework, third execution mode).
//
// Connect an api.trigger.dev key (verified live against
// GET /api/v3/projects) and background tasks execute durably on
// trigger.dev Cloud — NO self-hosting. The panel covers:
//
//   · live orchestration-mode badge (local / self-hosted / cloud),
//   · the cloud API key input (verify + connect, retest, disconnect),
//   · the verification snapshot (projects / environments),
//   · the kicked task id (agent-run by default),
//   · the deployed-worker setup checklist (deploy command, cloud project
//     env vars incl. the minted WORKER_TOKEN with copy buttons),
//   · recent cloud-orchestrated runs with dashboard links.
//
// SECURITY: the key is stored server-side (AES-256-GCM, SQLite) and only its
// masked form is ever displayed. The WORKER_TOKEN shown here is the
// operator's own shared secret for wiring the deployed cloud worker.
// ============================================================================

import * as React from "react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import {
  CheckCircle2,
  Cloud,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  Rocket,
  Save,
  Trash2,
  XCircle,
  Zap,
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

import { SettingsRow, SettingsSection } from "./settings-section";
import { MoreOptions } from "./more-options";
import { useAuth, useCloudOrchestrator, useCopyToClipboard } from "@/hooks";
import { listTaskRuns } from "@/lib/tasks/client";
import type { TaskStatusRun } from "@/lib/tasks/protocol";
import type { CloudAccountSnapshot } from "@/hooks/use-cloud-orchestrator";

// ---------------------------------------------------------------------------
// Validation (mirrors the server's /api/tasks/cloud checks).
// ---------------------------------------------------------------------------

/** tr_trigger_… (environment) / tr_pat_… (personal access). */
const CLOUD_KEY_RE = /^tr_[A-Za-z0-9_\-]{16,}$/;
const TASK_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

// ---------------------------------------------------------------------------
// Small presentational helpers.
// ---------------------------------------------------------------------------

function ModePill({ mode }: { mode: "local" | "selfhosted" | "cloud" }) {
  if (mode === "cloud") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[10px] font-medium uppercase text-emerald-600 dark:text-emerald-400">
        <Cloud className="size-3" />
        trigger.dev cloud
      </span>
    );
  }
  if (mode === "selfhosted") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-0.5 font-mono text-[10px] font-medium uppercase text-amber-600 dark:text-amber-400">
        self-hosted
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-2.5 py-0.5 font-mono text-[10px] font-medium uppercase text-sky-600 dark:text-sky-400">
      local
    </span>
  );
}

function RunStatusPill({ status }: { status: TaskStatusRun["status"] }) {
  const cls =
    status === "completed"
      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : status === "failed"
        ? "bg-destructive/10 text-destructive"
        : status === "cancelled"
          ? "bg-foreground/[0.06] text-muted-foreground"
          : status === "running"
            ? "bg-sky-500/10 text-sky-600 dark:text-sky-400"
            : "bg-amber-500/10 text-amber-600 dark:text-amber-400";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] uppercase ${cls}`}>
      {status}
    </span>
  );
}

/** A copyable config line (mono value + copy button; secret adds show/hide). */
function CopyLine({
  label,
  value,
  secret = false,
  placeholder = "not set",
}: {
  label: string;
  value: string | null;
  secret?: boolean;
  placeholder?: string;
}) {
  const { copy, copied } = useCopyToClipboard();
  const [show, setShow] = React.useState(!secret);
  const display = !value ? placeholder : show ? value : "•".repeat(Math.min(value.length, 28));
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-2">
      <div className="min-w-0">
        <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
        <p className="truncate font-mono text-xs" title={value ?? undefined}>
          {display}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {secret && value && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? `Hide ${label}` : `Show ${label}`}
          >
            {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={!value}
          onClick={() => void copy(value ?? "")}
          aria-label={`Copy ${label}`}
        >
          {copied ? <CheckCircle2 className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verification snapshot — projects / environments the key can see.
// ---------------------------------------------------------------------------

function AccountSnapshot({ account }: { account: CloudAccountSnapshot | null }) {
  if (!account) return null;
  if (account.partial) {
    return (
      <p className="text-muted-foreground text-xs leading-relaxed">
        {account.note ?? "Environment key connected — project details are not visible through the management API."}
      </p>
    );
  }
  if (account.projects.length === 0) {
    return <p className="text-muted-foreground text-xs">No projects visible to this key.</p>;
  }
  return (
    <ul className="scrollbar-thin max-h-56 space-y-1.5 overflow-y-auto pr-1">
      {account.projects.slice(0, 8).map((p) => (
        <li key={p.id} className="rounded-md border px-2.5 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-xs font-medium">{p.name}</p>
            {p.orgName && (
              <span className="text-muted-foreground truncate font-mono text-[10px]">{p.orgName}</span>
            )}
          </div>
          {p.environments.length > 0 && (
            <p className="text-muted-foreground mt-1 font-mono text-[10px]">
              {p.environments.map((e) => e.slug || e.name).join(" · ")}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Recent cloud-orchestrated runs (with dashboard links).
// ---------------------------------------------------------------------------

function RecentCloudRuns({ dashboardBase }: { dashboardBase: string | null }) {
  const { user } = useAuth();
  const [runs, setRuns] = React.useState<TaskStatusRun[] | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!user?.id) return;
    setBusy(true);
    try {
      const all = await listTaskRuns(user.id);
      setRuns(all.filter((r) => r.orchestrator !== "local").slice(0, 6));
    } catch {
      setRuns([]);
    } finally {
      setBusy(false);
    }
  }, [user?.id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Light auto-refresh while any shown run is live.
  const hasLive = runs?.some((r) => r.status === "queued" || r.status === "running") ?? false;
  React.useEffect(() => {
    if (!hasLive) return;
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [hasLive, load]);

  const linkFor = (run: TaskStatusRun): string | null => {
    if (!run.cloudRunId) return null;
    return dashboardBase && dashboardBase !== "https://cloud.trigger.dev"
      ? `${dashboardBase}/runs/${run.cloudRunId}`
      : "https://cloud.trigger.dev";
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          The latest background tasks dispatched to trigger.dev.
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => void load()}
          disabled={busy}
          aria-label="Refresh cloud runs"
        >
          <RefreshCw className={busy ? "size-3.5 animate-spin" : "size-3.5"} />
        </Button>
      </div>
      {runs === null ? (
        <p className="text-muted-foreground py-1 font-mono text-[11px]">…</p>
      ) : runs.length === 0 ? (
        <p className="text-muted-foreground py-1 text-xs">
          No cloud runs yet — start a background task (or fire a schedule) and it will appear here.
        </p>
      ) : (
        <ul className="scrollbar-thin max-h-72 space-y-1.5 overflow-y-auto pr-1">
          {runs.map((run) => {
            const href = linkFor(run);
            return (
              <li
                key={run.runId}
                className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-2"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <RunStatusPill status={run.status} />
                    <p className="truncate text-xs font-medium">
                      {run.title ?? run.prompt.slice(0, 60)}
                    </p>
                  </div>
                  <p className="text-muted-foreground mt-1 text-[10px]">
                    started {formatDistanceToNow(new Date(run.startedAt), { addSuffix: true })}
                  </p>
                </div>
                {href && (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[10px] transition-colors"
                    aria-label="Open the run on cloud.trigger.dev"
                  >
                    cloud <ExternalLink className="size-3" />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section.
// ---------------------------------------------------------------------------

export function SectionTriggerCloud() {
  const {
    status,
    isLoading,
    connect,
    isConnecting,
    refresh,
    isRetesting,
    setTaskSlug,
    isSavingSlug,
    disconnect,
    isDisconnecting,
  } = useCloudOrchestrator();

  const [key, setKey] = React.useState("");
  const [showKey, setShowKey] = React.useState(false);
  const [slug, setSlug] = React.useState("");
  const [slugDirty, setSlugDirty] = React.useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false);

  const cloud = status?.cloud ?? null;
  const connected = !!cloud?.configured;
  const mode = status?.mode ?? "local";

  // Keep the slug input seeded from the server (until the user edits it).
  React.useEffect(() => {
    if (cloud?.taskSlug && !slugDirty) setSlug(cloud.taskSlug);
  }, [cloud?.taskSlug, slugDirty]);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) {
      toast.error("Enter your trigger.dev API key first");
      return;
    }
    if (!CLOUD_KEY_RE.test(trimmed)) {
      toast.error("Key format looks invalid", {
        description: "Expected tr_trigger_… (environment) or tr_pat_… (personal access).",
        icon: <XCircle className="size-4" />,
      });
      return;
    }
    const slugTrimmed = slug.trim();
    if (slugTrimmed && !TASK_SLUG_RE.test(slugTrimmed)) {
      toast.error("Task id looks invalid", {
        description: "Letters, digits, dots, underscores and hyphens (max 64 chars).",
      });
      return;
    }
    try {
      const result = await connect({
        apiKey: trimmed,
        ...(slugTrimmed && slugTrimmed !== "agent-run" ? { taskSlug: slugTrimmed } : {}),
      });
      setKey("");
      const account = result.cloud.account;
      toast.success("Connected to Trigger.dev Cloud", {
        description: account?.partial
          ? "Environment key verified — background tasks now dispatch to the cloud."
          : (account?.projects.length ?? 0) > 0
            ? `Verified — ${account!.projects.length} project${account!.projects.length === 1 ? "" : "s"} visible to this key.`
            : "Key verified — background tasks now dispatch to the cloud.",
        icon: <CheckCircle2 className="size-4" />,
      });
    } catch (err) {
      toast.error("Could not connect", {
        description: err instanceof Error ? err.message : "Verification failed",
        icon: <XCircle className="size-4" />,
      });
    }
  }

  async function handleRetest() {
    try {
      await refresh();
      toast.success("Key verified", {
        description: "The stored key still works against api.trigger.dev.",
        icon: <CheckCircle2 className="size-4" />,
      });
    } catch (err) {
      toast.error("Verification failed", {
        description: err instanceof Error ? err.message : "The key was rejected",
        icon: <XCircle className="size-4" />,
      });
    }
  }

  async function handleSaveSlug() {
    const trimmed = slug.trim();
    if (!TASK_SLUG_RE.test(trimmed)) {
      toast.error("Task id looks invalid", {
        description: "Letters, digits, dots, underscores and hyphens (max 64 chars).",
      });
      return;
    }
    try {
      await setTaskSlug(trimmed);
      setSlugDirty(false);
      toast.success("Task id saved", { description: `The app now kicks "${trimmed}".` });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save the task id");
    }
  }

  async function handleDisconnect() {
    setConfirmDisconnect(false);
    try {
      await disconnect();
      setSlug("");
      setSlugDirty(false);
      toast.success("Disconnected", {
        description: "Back to the local orchestrator — background tasks run in this app's server.",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect");
    }
  }

  if (isLoading && !status) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    );
  }

  const envSourced = cloud?.keySource === "env";

  return (
    <div className="space-y-6">
      {/* ── What this is ─────────────────────────────────────────────────── */}
      <Alert>
        <Zap className="size-4" />
        <AlertTitle>Trigger.dev Cloud orchestration</AlertTitle>
        <AlertDescription>
          Connect a{" "}
          <a
            href="https://cloud.trigger.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground inline-flex items-center gap-0.5 underline underline-offset-4"
          >
            trigger.dev Cloud <ExternalLink className="size-3" />
          </a>{" "}
          API key and background tasks (agent runs, terminal commands, cron schedules) execute
          durably on trigger.dev&apos;s infrastructure — no self-hosting required. The key is
          verified live against api.trigger.dev, stored encrypted (AES-256-GCM) on this app&apos;s
          server, and never shown again after saving.
        </AlertDescription>
      </Alert>

      {/* ── Mode ─────────────────────────────────────────────────────────── */}
      <SettingsSection
        title="Orchestration mode"
        description="Who executes background tasks right now."
      >
        <SettingsRow
          label="Active orchestrator"
          description={
            mode === "cloud"
              ? "Trigger.dev Cloud — every new background task is kicked to the deployed agent-run task on api.trigger.dev the moment it's created; a deployed worker's poll loop is the backstop."
              : mode === "selfhosted"
                ? "Self-hosted Trigger.dev (TRIGGER_DEV_URL + TRIGGER_DEV_TOKEN env vars) — it takes priority over a cloud key."
                : "Local — the in-process driver executes tasks in this app's own server. Connect a cloud key below to switch."
          }
          control={<ModePill mode={mode} />}
        />
        {mode === "selfhosted" && connected && (
          <SettingsRow
            label="Cloud key stored"
            description="A cloud key is connected, but the self-hosted env config takes priority. Disconnect the env vars to activate cloud mode."
            control={<Badge variant="outline">standby</Badge>}
          />
        )}
      </SettingsSection>

      {/* ── Connection ───────────────────────────────────────────────────── */}
      <SettingsSection
        title={connected ? "Cloud connection" : "Connect a key"}
        description={
          connected
            ? undefined
            : "Get a key with runs:write access — a project environment key (tr_trigger_…) from your project's settings, or a personal access token (tr_pat_…)."
        }
        action={
          connected ? (
            <div className="flex flex-wrap items-center gap-2">
              {cloud?.maskedKey && (
                <Badge variant="secondary" className="gap-1 font-mono">
                  <CheckCircle2 className="size-3 text-emerald-500" />
                  {cloud.maskedKey}
                </Badge>
              )}
            </div>
          ) : undefined
        }
      >
        {!connected ? (
          <form onSubmit={handleConnect} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="trigger-cloud-key">Trigger.dev API key</Label>
              <div className="relative">
                <KeyRound className="text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2" />
                <Input
                  id="trigger-cloud-key"
                  type={showKey ? "text" : "password"}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="tr_trigger_… or tr_pat_…"
                  className="pr-10 pl-9 font-mono"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute top-1/2 right-1 size-7 -translate-y-1/2"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? "Hide key" : "Show key"}
                >
                  {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                Verified against api.trigger.dev before anything is stored. Encrypted at rest —
                only its masked form is ever shown afterwards.
              </p>
            </div>

            <MoreOptions label="Advanced — custom task id">
              <div className="space-y-1.5 rounded-lg border p-3">
                <Label htmlFor="trigger-cloud-slug">Worker task id</Label>
                <Input
                  id="trigger-cloud-slug"
                  value={slug}
                  onChange={(e) => {
                    setSlug(e.target.value);
                    setSlugDirty(true);
                  }}
                  placeholder="agent-run"
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-muted-foreground text-xs">
                  Only change this if you renamed the worker&apos;s agent-run task in
                  trigger-worker/. Default: <span className="font-mono">agent-run</span>.
                </p>
              </div>
            </MoreOptions>

            <Button type="submit" disabled={isConnecting || !key.trim()}>
              {isConnecting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Rocket className="size-4" />
              )}
              Verify &amp; connect
            </Button>
          </form>
        ) : (
          <div className="space-y-4">
            <SettingsRow
              label="API key"
              description={
                cloud?.verifiedAt
                  ? `Verified ${formatDistanceToNow(new Date(cloud.verifiedAt), { addSuffix: true })}${envSourced ? " · supplied via the TRIGGER_CLOUD_KEY env var" : ""}.`
                  : envSourced
                    ? "Supplied via the TRIGGER_CLOUD_KEY env var — manage it in the server environment."
                    : undefined
              }
              control={
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={handleRetest} disabled={isRetesting}>
                    {isRetesting ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                    Test connection
                  </Button>
                  {!envSourced && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setConfirmDisconnect(true)}
                      disabled={isDisconnecting}
                    >
                      <Trash2 className="size-3.5" />
                      Disconnect
                    </Button>
                  )}
                </div>
              }
            />

            {!envSourced && (
              <SettingsRow
                label="Worker task id"
                description="The deployed task the app kicks for every background run."
                align="start"
                control={
                  <div className="flex items-center gap-2">
                    <Input
                      value={slug}
                      onChange={(e) => {
                        setSlug(e.target.value);
                        setSlugDirty(true);
                      }}
                      placeholder="agent-run"
                      className="w-44 font-mono"
                      aria-label="Worker task id"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleSaveSlug}
                      disabled={isSavingSlug || !slugDirty || !slug.trim()}
                    >
                      {isSavingSlug ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                      Save
                    </Button>
                  </div>
                }
              />
            )}

            <div className="space-y-1.5">
              <p className="text-sm font-medium">Account</p>
              <AccountSnapshot account={cloud?.account ?? null} />
            </div>
          </div>
        )}
      </SettingsSection>

      {/* ── Worker setup checklist (connected only) ─────────────────────── */}
      {connected && (
        <SettingsSection
          title="Cloud worker setup"
          description="One-time wiring so trigger.dev Cloud can execute and report back."
        >
          <ol className="space-y-4">
            <li className="space-y-1.5">
              <p className="text-sm font-medium">
                <span className="text-muted-foreground mr-1.5 font-mono text-xs">1.</span>
                Deploy the worker from this repo to trigger.dev Cloud
              </p>
              <pre className="bg-muted/60 scrollbar-thin overflow-x-auto rounded-md border px-3 py-2 font-mono text-[11px]">
                cd trigger-worker{"\n"}npx trigger.dev@latest deploy
              </pre>
              <p className="text-muted-foreground text-xs">
                The CLI asks for a trigger.dev access token on first use; see{" "}
                <span className="font-mono">trigger-worker/README.md</span>.
              </p>
            </li>
            <li className="space-y-1.5">
              <p className="text-sm font-medium">
                <span className="text-muted-foreground mr-1.5 font-mono text-xs">2.</span>
                Set these environment variables on the cloud project
              </p>
              <div className="space-y-1.5">
                <CopyLine label="APP_URL" value={status?.appUrl ?? null} />
                <CopyLine label="WORKER_TOKEN" value={cloud?.workerToken ?? null} secret />
                <CopyLine
                  label="E2B_API_KEY"
                  value={null}
                  placeholder="your E2B key (Settings → Sandbox (E2B))"
                />
              </div>
              {cloud?.workerTokenSource === "env" && (
                <p className="text-muted-foreground text-xs">
                  WORKER_TOKEN comes from this server&apos;s env var — the cloud project must use
                  the same value.
                </p>
              )}
            </li>
            <li className="space-y-1.5">
              <p className="text-sm font-medium">
                <span className="text-muted-foreground mr-1.5 font-mono text-xs">3.</span>
                Done — schedules fire from the cloud too
              </p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Once deployed, the worker&apos;s <span className="font-mono">sweep-schedules</span>{" "}
                and <span className="font-mono">poll-claims</span> crons keep everything running
                even while this app is closed. Manually-triggered tasks are kicked instantly over
                the cloud API the moment you start them.
              </p>
            </li>
          </ol>
        </SettingsSection>
      )}

      {/* ── Recent cloud runs (connected only) ───────────────────────────── */}
      {connected && (
        <SettingsSection
          title="Recent cloud runs"
          description="Live status of the background tasks dispatched to trigger.dev."
        >
          <RecentCloudRuns dashboardBase={cloud?.dashboardBase ?? null} />
        </SettingsSection>
      )}

      {/* ── Disconnect confirmation ──────────────────────────────────────── */}
      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Trigger.dev Cloud?</AlertDialogTitle>
            <AlertDialogDescription>
              The encrypted key will be deleted from this app&apos;s server and background tasks
              go back to the local orchestrator. Runs already executing on trigger.dev keep
              running to completion.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                void handleDisconnect();
              }}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default SectionTriggerCloud;
