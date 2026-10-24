"use client";

// ============================================================================
// Settings → Cloud Tasks — the Trigger.dev Cloud panel (zero-setup).
//
// ONE clean card, four states — a key is the ENTIRE setup (no self-hosting,
// no local mode, no worker wiring):
//
//   · not connected                → paste an environment secret key + Connect
//   · connected + live             → active on the cloud (masked key,
//                                    project/org, verified, test/disconnect,
//                                    runs link)
//   · connected + deploying        → the one-time worker deploy, with a live
//                                    log tail (auto-polled every 5s)
//   · connected + undeployed       → one-click "Deploy worker"
//
// The key is verified live against api.trigger.dev before anything is stored,
// sealed AES-256-GCM (server-side, or vault-sealed in this browser on
// read-only serverless deployments) and only ever shown masked.
// ============================================================================

import * as React from "react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  Rocket,
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

import { SettingsSection } from "./settings-section";
import { useCloudOrchestrator, type CloudOrchestratorStatus } from "@/hooks";
import { qk } from "@/lib/query-keys";

// ---------------------------------------------------------------------------
// Constants / small helpers.
// ---------------------------------------------------------------------------

/** tr_prod_sk_/tr_dev_sk_… (environment secret keys), tr_trigger_/tr_pat_…
 *  (other accepted shapes). Mirrors the server's /api/tasks/cloud check. */
const CLOUD_KEY_RE = /^tr_[A-Za-z0-9_\-]{16,}$/;
const GET_KEY_URL = "https://cloud.trigger.dev/settings/api-keys";

/** Last few deploy log lines — mono, scrollable, never contains the key. */
function DeployTail({ tail }: { tail: string[] }) {
  if (tail.length === 0) return null;
  return (
    <pre className="bg-muted/60 scrollbar-thin max-h-24 overflow-y-auto rounded-md border px-3 py-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
      {tail.slice(-6).join("\n")}
    </pre>
  );
}

/** Card-header status pill for the connected states. */
function StatusPill({ state }: { state: "active" | "deploying" | "attention" }) {
  if (state === "active") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 font-mono text-[10px] font-medium tracking-wide text-emerald-600 uppercase dark:text-emerald-400">
        <CheckCircle2 className="size-3" />
        active
      </span>
    );
  }
  if (state === "deploying") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2.5 py-1 font-mono text-[10px] font-medium tracking-wide text-sky-600 uppercase dark:text-sky-400">
        <Loader2 className="size-3 animate-spin" />
        deploying
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 font-mono text-[10px] font-medium tracking-wide text-amber-600 uppercase dark:text-amber-400">
      <AlertTriangle className="size-3" />
      needs deploy
    </span>
  );
}

/** "tr_••••••••UmzU · onyxgpt-Fgbo · Onyx" — the connection identity line. */
function ConnectionLine({ cloud }: { cloud: CloudOrchestratorStatus["cloud"] | null }) {
  if (!cloud) return null;
  const project = cloud.account?.projects?.[0] ?? null;
  const parts: React.ReactNode[] = [];
  if (cloud.maskedKey) {
    parts.push(
      <span key="key" className="font-mono">
        {cloud.maskedKey}
      </span>,
    );
  }
  if (project) {
    parts.push(project.orgName ? `${project.name} · ${project.orgName}` : project.name);
  } else if (cloud.account?.note) {
    parts.push(cloud.account.note);
  }
  if (cloud.keySource === "env") parts.push("supplied via the TRIGGER_CLOUD_KEY env var");
  if (parts.length === 0) return null;
  return (
    <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && " · "}
          {part}
        </React.Fragment>
      ))}
    </p>
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
    disconnect,
    isDisconnecting,
    deployWorker,
  } = useCloudOrchestrator();
  const qc = useQueryClient();

  const [key, setKey] = React.useState("");
  const [showKey, setShowKey] = React.useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false);

  const cloud = status?.cloud ?? null;
  const bootstrap = status?.bootstrap ?? null;
  const connected = !!cloud?.configured;
  const envSourced = cloud?.keySource === "env";
  const deploy = bootstrap?.deploy ?? null;
  const deployRunning = deploy?.state === "running";
  const deployFailed = deploy?.state === "failed";
  const live = bootstrap?.liveness === "live";

  // While the one-time worker deploy is in flight, poll the status every 5s
  // so the progress + log tail stream in without user action. The interval
  // dies the moment the deploy leaves the "running" state.
  React.useEffect(() => {
    if (!deployRunning) return;
    const t = setInterval(() => {
      void qc.invalidateQueries({ queryKey: qk.tasks.cloudConfig() });
    }, 5_000);
    return () => clearInterval(t);
  }, [deployRunning, qc]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) {
      toast.error("Enter your Trigger.dev key first");
      return;
    }
    if (!CLOUD_KEY_RE.test(trimmed)) {
      toast.error("Key format looks invalid", {
        description:
          "Expected an environment secret key — tr_prod_sk_… or tr_dev_sk_… from cloud.trigger.dev → API keys.",
        icon: <XCircle className="size-4" />,
      });
      return;
    }
    try {
      const result = await connect({ apiKey: trimmed });
      setKey("");
      setShowKey(false);
      const liveness = result.bootstrap?.liveness;
      toast.success(
        result.cloud.ephemeral
          ? "Connected to Trigger.dev Cloud (session mode)"
          : liveness === "live"
            ? "Connected — active on Trigger.dev Cloud"
            : "Connected — deploying the cloud worker",
        {
          description: result.cloud.ephemeral
            ? "This deployment has a read-only filesystem, so the key is stored encrypted in THIS browser and re-applied automatically."
            : liveness === "live"
              ? "Background tasks now run durably on your Trigger.dev project."
              : "The worker deploys once to your project (about 2 minutes); the settings page tracks the progress.",
          icon: <CheckCircle2 className="size-4" />,
        },
      );
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
      toast.success("Connection verified", {
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

  async function handleDeploy() {
    try {
      await deployWorker();
      toast.success("Deploy started", {
        description: "The worker deploys to your Trigger.dev project — about 2 minutes, one time only.",
        icon: <Rocket className="size-4" />,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start the deploy");
    }
  }

  async function handleDisconnect() {
    setConfirmDisconnect(false);
    try {
      await disconnect();
      toast.success("Disconnected", {
        description:
          "Background tasks stop dispatching to the cloud until you connect a key again. Runs already executing on trigger.dev keep running to completion.",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect");
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (isLoading && !status) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    );
  }

  const pill = deployRunning ? "deploying" : live ? "active" : "attention";

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Trigger.dev Cloud"
        description={
          connected
            ? undefined
            : "Run your chat agent, sub-agents, projects and businesses durably on your own Trigger.dev Cloud — no self-hosting, no setup."
        }
        action={connected ? <StatusPill state={pill} /> : undefined}
      >
        <div className="space-y-4">
          {/* ── Session-mode notice (serverless deployments, connected only) ── */}
          {connected && cloud?.ephemeral && (
            <Alert>
              <Cloud className="size-4" />
              <AlertTitle>Session mode — serverless deployment</AlertTitle>
              <AlertDescription>
                This deployment&apos;s server has a read-only filesystem, so the connection is
                re-applied from this browser automatically — no reconnect needed.
              </AlertDescription>
            </Alert>
          )}

          {/* ── State 1 · Not connected — paste a key, that's the setup ───── */}
          {!connected && (
            <form onSubmit={handleConnect} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="trigger-cloud-key">API key</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <div className="relative min-w-0 flex-1">
                    <KeyRound className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                    <Input
                      id="trigger-cloud-key"
                      type={showKey ? "text" : "password"}
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      placeholder="tr_prod_sk_… · tr_dev_sk_…"
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
                  <Button type="submit" className="shrink-0" disabled={isConnecting || !key.trim()}>
                    {isConnecting ? <Loader2 className="animate-spin" /> : <Rocket />}
                    Connect
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs leading-relaxed">
                  Paste an environment secret key (tr_prod_sk_… / tr_dev_sk_…) —{" "}
                  <a
                    href={GET_KEY_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground inline-flex items-center gap-0.5 underline underline-offset-4"
                  >
                    get one at cloud.trigger.dev → API keys
                    <ExternalLink className="size-3" />
                  </a>
                  . Verified live before anything is stored; encrypted at rest and only ever shown
                  masked afterwards.
                </p>
              </div>
            </form>
          )}

          {/* ── State 2 · Connected + deploying (one-time worker deploy) ──── */}
          {connected && deployRunning && (
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-sky-500/10">
                  <Loader2 className="size-4 animate-spin text-sky-600 dark:text-sky-400" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-snug font-medium">Deploying the cloud worker…</p>
                  <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                    About 2 minutes, one time only — the deployment then lives on your Trigger.dev
                    project. This page tracks the progress automatically.
                  </p>
                  <ConnectionLine cloud={cloud} />
                </div>
              </div>
              <DeployTail tail={deploy?.tail ?? []} />
            </div>
          )}

          {/* ── State 3 · Connected + live — active on the cloud ──────────── */}
          {connected && !deployRunning && live && (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/10">
                  <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-snug font-medium">
                    Active — running on Trigger.dev Cloud
                  </p>
                  <ConnectionLine cloud={cloud} />
                  {cloud?.verifiedAt && (
                    <p className="text-muted-foreground mt-1 text-xs">
                      Verified{" "}
                      {formatDistanceToNow(new Date(cloud.verifiedAt), { addSuffix: true })}
                      {bootstrap?.probedAt
                        ? ` · worker checked ${formatDistanceToNow(new Date(bootstrap.probedAt), { addSuffix: true })}`
                        : ""}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleRetest}
                  disabled={isRetesting}
                >
                  {isRetesting ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
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
                    {isDisconnecting ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                    Disconnect
                  </Button>
                )}
                {cloud?.dashboardBase && (
                  <Button type="button" variant="ghost" size="sm" asChild>
                    <a
                      href={`${cloud.dashboardBase}/runs`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Runs on cloud.trigger.dev
                      <ExternalLink className="size-3.5" />
                    </a>
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* ── State 4 · Connected + undeployed/unknown/failed ───────────── */}
          {connected && !deployRunning && !live && (
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-500/10">
                  <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-snug font-medium">
                    The cloud worker needs a one-time deploy to your Trigger.dev project.
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                    {deployFailed
                      ? "The last deploy attempt failed — check the log below and try again."
                      : "The key works, but the agent-run task isn't deployed on the project yet. One deploy and every background task after runs on the cloud."}
                  </p>
                  <ConnectionLine cloud={cloud} />
                </div>
              </div>
              <div>
                <Button type="button" size="sm" onClick={handleDeploy}>
                  <Rocket />
                  Deploy worker
                </Button>
              </div>
              <DeployTail tail={deploy?.tail ?? []} />
            </div>
          )}
        </div>
      </SettingsSection>

      {/* ── Disconnect confirmation ──────────────────────────────────────── */}
      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Trigger.dev Cloud?</AlertDialogTitle>
            <AlertDialogDescription>
              The encrypted key will be removed and background tasks stop dispatching to the cloud
              until you connect a key again. Runs already executing on trigger.dev keep running to
              completion.
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
