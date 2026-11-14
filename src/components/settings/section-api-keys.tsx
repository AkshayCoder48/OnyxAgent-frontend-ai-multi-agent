"use client";

import * as React from "react";
import { toast } from "sonner";

import {
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plug,
  RefreshCw,
  Save,
  Trash2,
  XCircle,
} from "lucide-react";

import { Badge, Button, Input } from "@/components/ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { SectionCard } from "@/components/settings/settings-section";
import { useAuth } from "@/hooks";
import { useSettings, useProviders } from "@/hooks/use-data";
import { useCloudOrchestrator } from "@/hooks";
import { settingsService } from "@/lib/services";
import { usePollinationsStore } from "@/lib/pollinations/store";
import { resolveOnyxBaseUrl, OnyxBaseKV } from "@/lib/onyxbase/kv-client";
import { apiComposioConnect, looksLikeComposioKey } from "@/lib/composio/browser";
import { cn } from "@/lib/utils";

import {
  PlatformLogo,
  resolvePlatformMark,
  type PlatformMark,
} from "./platform-logos";

// ============================================================================
// Settings → API Keys — the ONE home for every credential the app uses
// (task 2026-11-14: "sort all api keys input in a single setting tab and
// remove extras, with platform logos").
//
// Every key input that used to live in its own section moved here:
//   · E2B Sandbox          (was Sandbox (E2B))
//   · Trigger.dev Cloud    (was Cloud Tasks — connect/disconnect + retest)
//   · Pollinations         (was Pollinations AI — the paste-key path)
//   · OnyxBase             (was Cloud Workspace)
//   · Composio             (was Integrations)
//   · LangSearch           (was the /settings/api-keys route)
//   · SkillsMP             (was the /settings/api-keys route)
//   · AI Providers         — per-provider key rows; entity management
//                            (base URL, models, toggles) stays in AI
//                            Providers, the KEY itself lives here now.
//
// The original sections keep their non-key settings and point here. Values
// are masked, never logged, and stored encrypted (vault) — same rules as
// before, one address.
// ============================================================================

// ---------------------------------------------------------------------------
// Shared row primitives.
// ---------------------------------------------------------------------------

function StatusBadge({
  state,
  label,
}: {
  state: "connected" | "partial" | "off";
  label?: string;
}) {
  const cfg = {
    connected: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25",
    partial: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25",
    off: "bg-muted/60 text-muted-foreground border-transparent",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
        cfg[state],
      )}
    >
      {state === "connected" && <CheckCircle2 className="size-3" />}
      {label ?? (state === "connected" ? "connected" : state === "partial" ? "attention" : "not set")}
    </span>
  );
}

function KeyInput({
  id,
  value,
  onChange,
  revealed,
  onToggleReveal,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  revealed: boolean;
  onToggleReveal: () => void;
  placeholder: string;
}) {
  return (
    <div className="relative min-w-0 flex-1 basis-56">
      <Input
        id={id}
        type={revealed ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="pr-9 font-mono"
      />
      <button
        type="button"
        onClick={onToggleReveal}
        aria-label={revealed ? "Hide key" : "Show key"}
        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1 transition-colors"
      >
        {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
    </div>
  );
}

function KeyRow({
  platform,
  title,
  href,
  badge,
  description,
  children,
}: {
  platform: PlatformMark;
  title: string;
  href?: string;
  badge: React.ReactNode;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3">
        <PlatformLogo platform={platform} size={34} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">{title}</p>
            {badge}
            {href && (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 text-xs underline underline-offset-2"
              >
                get a key <ExternalLink className="size-3" />
              </a>
            )}
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{description}</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">{children}</div>
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The section.
// ---------------------------------------------------------------------------

const POLLINATIONS_KEY_RE = /^(sk|pk)_[A-Za-z0-9_\-]{16,}$/;
const ONYXBASE_GET_KEY_URL = "https://onyxbase-chi.vercel.app";

export function SectionApiKeys() {
  const { user } = useAuth();
  const userId = user?.id;
  const { settings, loading, setSandboxKey, setOnyxBaseApiKey, setComposioApiKey, update: updateSettings } = useSettings();
  const cloud = useCloudOrchestrator();
  const pollinations = usePollinationsStore();
  const { providers, update, test } = useProviders();

  // ── Generic per-row input state ────────────────────────────────────────
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [revealed, setRevealed] = React.useState<Record<string, boolean>>({});
  const [busy, setBusy] = React.useState<Record<string, boolean>>({});
  const [testingE2B, setTestingE2B] = React.useState(false);
  const [testingOnyxBase, setTestingOnyxBase] = React.useState(false);
  const [cloudKeyInput, setCloudKeyInput] = React.useState("");

  const setValue = (k: string, v: string) => setValues((p) => ({ ...p, [k]: v }));
  const toggleReveal = (k: string) => setRevealed((p) => ({ ...p, [k]: !p[k] }));
  const setRowBusy = (k: string, b: boolean) => setBusy((p) => ({ ...p, [k]: b }));
  const spin = (k: string) =>
    busy[k] ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Save className="mr-0.5 size-3.5" />;

  const flags = {
    e2b: !!settings ? !!(settings as { sandbox_api_key_present?: boolean }).sandbox_api_key_present || !!(settings as { e2b_api_key_present?: boolean }).e2b_api_key_present : false,
    onyxbase: !!settings?.onyxbase_api_key_present,
    composio: !!settings?.composio_api_key_present,
    langsearch: !!(settings as { langsearch_api_key_present?: boolean } | null)?.langsearch_api_key_present,
    skillsmp: !!(settings as { skillsmp_api_key_present?: boolean } | null)?.skillsmp_api_key_present,
  };

  // ── E2B ─────────────────────────────────────────────────────────────────
  async function saveE2B() {
    const key = (values.e2b ?? "").trim();
    if (!key) return;
    if (!userId) return;
    setRowBusy("e2b", true);
    try {
      await setSandboxKey(key);
      if (typeof window !== "undefined") window.localStorage.setItem("e2b_api_key", key);
      try {
        const { evictAllE2BClients } = await import("@/lib/e2b/client");
        evictAllE2BClients();
      } catch { /* next turn re-reads the key anyway */ }
      setValue("e2b", "");
      toast.success("E2B Sandbox key saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setRowBusy("e2b", false);
    }
  }

  async function testE2B() {
    if (!userId) return;
    setTestingE2B(true);
    try {
      let apiKey = (values.e2b ?? "").trim();
      if (!apiKey) apiKey = (await settingsService.getDecryptedSandboxKey(userId)) ?? "";
      if (!apiKey) {
        toast.error("No key to test yet");
        return;
      }
      const { E2BClient } = await import("@/lib/e2b/client");
      const items = await E2BClient.listSandboxes(apiKey);
      toast.success(`E2B key valid · ${items.length} running sandbox${items.length === 1 ? "" : "es"}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Connection failed";
      toast.error(/auth|401|403|invalid/i.test(msg) ? "Invalid E2B key — check it at e2b.dev" : msg, {
        icon: <XCircle className="size-4" />,
      });
    } finally {
      setTestingE2B(false);
    }
  }

  // ── Trigger.dev Cloud ───────────────────────────────────────────────────
  async function connectCloud() {
    const key = cloudKeyInput.trim();
    if (!key) {
      toast.error("Paste a Trigger.dev environment key first (tr_…)");
      return;
    }
    setRowBusy("triggerdev", true);
    try {
      await cloud.connect({ apiKey: key });
      setCloudKeyInput("");
      toast.success("Trigger.dev Cloud connected", {
        description: "Background runs now execute durably on your cloud project.",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Verification failed", {
        icon: <XCircle className="size-4" />,
      });
    } finally {
      setRowBusy("triggerdev", false);
    }
  }

  // ── Pollinations ────────────────────────────────────────────────────────
  async function savePollinations() {
    const key = (values.pollinations ?? "").trim();
    if (!key) return;
    if (!POLLINATIONS_KEY_RE.test(key)) {
      toast.error("Key format looks invalid", {
        description: "Pollinations keys start with sk_ (secret) or pk_ (publishable).",
      });
      return;
    }
    setRowBusy("pollinations", true);
    try {
      await usePollinationsStore.getState().connect(key, {
        method: "manual",
        connectedAt: new Date().toISOString(),
        expiresAt: undefined,
      });
      setValue("pollinations", "");
      toast.success("Pollinations key saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setRowBusy("pollinations", false);
    }
  }

  // ── OnyxBase ────────────────────────────────────────────────────────────
  async function saveOnyxBase() {
    const key = (values.onyxbase ?? "").trim();
    if (!key || !userId) return;
    setRowBusy("onyxbase", true);
    try {
      await setOnyxBaseApiKey(key);
      setValue("onyxbase", "");
      toast.success("OnyxBase key saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setRowBusy("onyxbase", false);
    }
  }

  async function testOnyxBase() {
    if (!userId) return;
    setTestingOnyxBase(true);
    try {
      let candidate = (values.onyxbase ?? "").trim();
      if (!candidate) {
        candidate = (await settingsService.getDecryptedOnyxBaseApiKey(userId)) ?? "";
      }
      if (!candidate) {
        toast.error("Add your OnyxBase key first");
        return;
      }
      const kv = new OnyxBaseKV(candidate, resolveOnyxBaseUrl(null));
      const who = await kv.whoami();
      const name =
        (typeof who.apiKey?.name === "string" && who.apiKey.name) ||
        (typeof who.user === "string" && who.user) ||
        "your account";
      toast.success("Connected to OnyxBase", { description: `Verified as ${name}` });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Connection failed", {
        icon: <XCircle className="size-4" />,
      });
    } finally {
      setTestingOnyxBase(false);
    }
  }

  // ── Composio / LangSearch / SkillsMP ───────────────────────────────────
  async function saveSimple(
    row: "composio" | "langsearch" | "skillsmp",
    saver: (key: string) => Promise<void>,
    okLabel: string,
  ) {
    const key = (values[row] ?? "").trim();
    if (!key || !userId) return;
    if (row === "composio" && !looksLikeComposioKey(key)) {
      toast.error("Key format looks invalid", {
        description: "Composio keys are 10+ alphanumeric characters from your dashboard.",
      });
      return;
    }
    setRowBusy(row, true);
    try {
      if (row === "composio") {
        // REAL verification (same flow the Integrations page used): Composio
        // answers 401 for bad keys — the key + session are only stored after
        // a successful validation (no fake success states).
        const r = await apiComposioConnect({ apiKey: key, userId });
        await saver(key);
        await updateSettings({ composio_session_id: r.session.sessionId });
        toast.success("Composio connected", {
          description: `Verified against ${r.totalToolkits}+ available platforms. Session created.`,
        });
      } else {
        await saver(key);
        toast.success(okLabel);
      }
      setValue(row, "");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setRowBusy(row, false);
    }
  }

  // ── Provider key rows ──────────────────────────────────────────────────
  const [providerValues, setProviderValues] = React.useState<Record<string, string>>({});
  const [providerBusy, setProviderBusy] = React.useState<Record<string, boolean>>({});

  async function saveProviderKey(providerId: string) {
    const key = (providerValues[providerId] ?? "").trim();
    if (!key) return;
    setProviderBusy((p) => ({ ...p, [providerId]: true }));
    try {
      await update({ id: providerId, patch: { api_key: key } });
      setProviderValues((p) => ({ ...p, [providerId]: "" }));
      toast.success("Provider key updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setProviderBusy((p) => ({ ...p, [providerId]: false }));
    }
  }

  async function testProvider(providerId: string, model?: string) {
    try {
      const result = await test({ id: providerId, model });
      if (result.ok) {
        toast.success(`Connection OK · ${result.status_code}`, { icon: <CheckCircle2 className="size-4" /> });
      } else {
        toast.error(result.detail || "Connection failed", { icon: <XCircle className="size-4" /> });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    }
  }

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
        <Loader2 className="size-4 animate-spin" /> Loading keys…
      </div>
    );
  }

  const cloudConfigured = cloud.status?.cloud.configured === true;

  return (
    <div className="space-y-6">
      <Alert>
        <KeyRound className="size-4" />
        <AlertTitle>One tab for every key</AlertTitle>
        <AlertDescription>
          All credentials the app uses live here — each row is saved separately, stored encrypted
          (AES-GCM) in your browser vault, and never shown unmasked or logged. Blank fields keep the
          existing key; type a new one to replace it.
        </AlertDescription>
      </Alert>

      <SectionCard
        title="Platform & app keys"
        description="Sandbox, background runs, media, cloud storage, integrations and search — with the platform each key belongs to."
      >
        <ul className="divide-y divide-border">
          {/* ── E2B ── */}
          <KeyRow
            platform="e2b"
            title="E2B Sandbox"
            href="https://e2b.dev"
            badge={<StatusBadge state={flags.e2b ? "connected" : "off"} />}
            description="Runs Python, terminal commands and the workspace filesystem in the remote sandbox."
          >
            <KeyInput
              id="api-key-e2b"
              value={values.e2b ?? ""}
              onChange={(v) => setValue("e2b", v)}
              revealed={!!revealed.e2b}
              onToggleReveal={() => toggleReveal("e2b")}
              placeholder={flags.e2b ? "•••••••• (saved) — enter a new key to replace" : "e2b_…"}
            />
            <Button size="sm" onClick={() => void saveE2B()} disabled={busy.e2b || !(values.e2b ?? "").trim()}>
              {spin("e2b")} Save
            </Button>
            <Button size="sm" variant="outline" onClick={() => void testE2B()} disabled={testingE2B}>
              {testingE2B ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Plug className="mr-0.5 size-3.5" />}
              Test
            </Button>
          </KeyRow>

          {/* ── Trigger.dev Cloud ── */}
          <KeyRow
            platform="triggerdev"
            title="Trigger.dev Cloud"
            href="https://cloud.trigger.dev/settings/api-keys"
            badge={
              <StatusBadge
                state={cloudConfigured ? "connected" : "off"}
                label={cloudConfigured ? (cloud.status?.cloud.ephemeral ? "connected (session)" : "connected") : "not set"}
              />
            }
            description="Durable background runs (close-and-resume turns, schedules, long terminal jobs) execute on your own Trigger.dev Cloud project."
          >
            {cloudConfigured ? (
              <>
                <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
                  {cloud.status?.cloud.maskedKey ?? "tr_••••••••"}
                  {cloud.status?.cloud.account?.projects?.[0]
                    ? ` · ${cloud.status.cloud.account.projects[0].name}`
                    : ""}
                </span>
                <Button size="sm" variant="outline" onClick={() => void cloud.refresh()} disabled={cloud.isRetesting}>
                  {cloud.isRetesting ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <RefreshCw className="mr-0.5 size-3.5" />}
                  Retest
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => void cloud.disconnect()}
                  disabled={cloud.isDisconnecting}
                >
                  {cloud.isDisconnecting ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Trash2 className="mr-0.5 size-3.5" />}
                  Disconnect
                </Button>
              </>
            ) : (
              <>
                <KeyInput
                  id="api-key-triggerdev"
                  value={cloudKeyInput}
                  onChange={setCloudKeyInput}
                  revealed={!!revealed.triggerdev}
                  onToggleReveal={() => toggleReveal("triggerdev")}
                  placeholder="tr_prod_sk_… / tr_trigger_… / tr_pat_…"
                />
                <Button
                  size="sm"
                  onClick={() => void connectCloud()}
                  disabled={busy.triggerdev || cloud.isConnecting || !cloudKeyInput.trim()}
                >
                  {busy.triggerdev || cloud.isConnecting ? (
                    <Loader2 className="mr-1 size-3.5 animate-spin" />
                  ) : (
                    <Plug className="mr-0.5 size-3.5" />
                  )}
                  Connect
                </Button>
              </>
            )}
          </KeyRow>

          {/* ── Pollinations ── */}
          <KeyRow
            platform="pollinations"
            title="Pollinations"
            href="https://enter.pollinations.ai/keys"
            badge={
              <StatusBadge
                state={pollinations.connectionStatus === "connected" ? "connected" : pollinations.connectionStatus === "expired" ? "partial" : "off"}
                label={
                  pollinations.connectionStatus === "connected"
                    ? pollinations.connectionMeta?.method === "oauth"
                      ? "connected via OAuth"
                      : "connected with key"
                    : pollinations.connectionStatus === "expired"
                      ? "expired"
                      : "not set"
                }
              />
            }
            description="Image, video, audio and 3D generation. OAuth lives in Settings → Pollinations AI; the raw key lives here."
          >
            {pollinations.connectionStatus === "connected" ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => void pollinations.disconnect()}
              >
                <Trash2 className="mr-0.5 size-3.5" /> Disconnect key
              </Button>
            ) : (
              <>
                <KeyInput
                  id="api-key-pollinations"
                  value={values.pollinations ?? ""}
                  onChange={(v) => setValue("pollinations", v)}
                  revealed={!!revealed.pollinations}
                  onToggleReveal={() => toggleReveal("pollinations")}
                  placeholder="sk_… or pk_…"
                />
                <Button
                  size="sm"
                  onClick={() => void savePollinations()}
                  disabled={busy.pollinations || !(values.pollinations ?? "").trim()}
                >
                  {spin("pollinations")} Save
                </Button>
              </>
            )}
          </KeyRow>

          {/* ── OnyxBase ── */}
          <KeyRow
            platform="onyxbase"
            title="OnyxBase"
            href={ONYXBASE_GET_KEY_URL}
            badge={<StatusBadge state={flags.onyxbase ? "connected" : "off"} />}
            description="One key for everything that stores data in the cloud: Knowledge Base, workspace snapshots, code database, skill backups."
          >
            <KeyInput
              id="api-key-onyxbase"
              value={values.onyxbase ?? ""}
              onChange={(v) => setValue("onyxbase", v)}
              revealed={!!revealed.onyxbase}
              onToggleReveal={() => toggleReveal("onyxbase")}
              placeholder={flags.onyxbase ? "•••••••• (saved) — enter a new key to replace" : "kv_live_…"}
            />
            <Button size="sm" onClick={() => void saveOnyxBase()} disabled={busy.onyxbase || !(values.onyxbase ?? "").trim()}>
              {spin("onyxbase")} Save
            </Button>
            <Button size="sm" variant="outline" onClick={() => void testOnyxBase()} disabled={testingOnyxBase}>
              {testingOnyxBase ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Plug className="mr-0.5 size-3.5" />}
              Test
            </Button>
            {flags.onyxbase && (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => void setOnyxBaseApiKey(null)}
                disabled={busy.onyxbase}
              >
                <Trash2 className="mr-0.5 size-3.5" /> Clear
              </Button>
            )}
          </KeyRow>

          {/* ── Composio ── */}
          <KeyRow
            platform="composio"
            title="Composio"
            href="https://app.composio.dev"
            badge={<StatusBadge state={flags.composio ? "connected" : "off"} />}
            description="Platform integrations (GitHub, Slack, …) for the agent's integration tools."
          >
            <KeyInput
              id="api-key-composio"
              value={values.composio ?? ""}
              onChange={(v) => setValue("composio", v)}
              revealed={!!revealed.composio}
              onToggleReveal={() => toggleReveal("composio")}
              placeholder={flags.composio ? "•••••••• (saved) — enter a new key to replace" : "Your Composio project API key"}
            />
            <Button
              size="sm"
              onClick={() =>
                void saveSimple("composio", (k) => setComposioApiKey(k), "Composio key saved")
              }
              disabled={busy.composio || !(values.composio ?? "").trim()}
            >
              {spin("composio")} Save
            </Button>
            {flags.composio && (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => void setComposioApiKey(null)}
                disabled={busy.composio}
              >
                <Trash2 className="mr-0.5 size-3.5" /> Clear
              </Button>
            )}
          </KeyRow>

          {/* ── LangSearch ── */}
          <KeyRow
            platform="langsearch"
            title="LangSearch"
            href="https://langsearch.com"
            badge={<StatusBadge state={flags.langsearch ? "connected" : "off"} label={flags.langsearch ? "connected" : "optional"} />}
            description="Optional — richer web_search summaries; falls back to DuckDuckGo when blank."
          >
            <KeyInput
              id="api-key-langsearch"
              value={values.langsearch ?? ""}
              onChange={(v) => setValue("langsearch", v)}
              revealed={!!revealed.langsearch}
              onToggleReveal={() => toggleReveal("langsearch")}
              placeholder={flags.langsearch ? "•••••••• (saved) — enter a new key to replace" : "sk-…"}
            />
            <Button
              size="sm"
              onClick={() =>
                userId &&
                void saveSimple(
                  "langsearch",
                  (k) => settingsService.setLangSearchKey(userId, k),
                  "LangSearch key saved",
                )
              }
              disabled={busy.langsearch || !(values.langsearch ?? "").trim()}
            >
              {spin("langsearch")} Save
            </Button>
          </KeyRow>

          {/* ── SkillsMP ── */}
          <KeyRow
            platform="skillsmp"
            title="SkillsMP"
            href="https://skillsmp.com"
            badge={<StatusBadge state={flags.skillsmp ? "connected" : "off"} label={flags.skillsmp ? "connected" : "optional"} />}
            description="Optional — raises the skill-marketplace rate limit from 50 to 500 requests/day."
          >
            <KeyInput
              id="api-key-skillsmp"
              value={values.skillsmp ?? ""}
              onChange={(v) => setValue("skillsmp", v)}
              revealed={!!revealed.skillsmp}
              onToggleReveal={() => toggleReveal("skillsmp")}
              placeholder={flags.skillsmp ? "•••••••• (saved) — enter a new key to replace" : "sk_live_skillsmp_…"}
            />
            <Button
              size="sm"
              onClick={() =>
                userId &&
                void saveSimple(
                  "skillsmp",
                  (k) => settingsService.setSkillsMPApiKey(userId, k),
                  "SkillsMP key saved",
                )
              }
              disabled={busy.skillsmp || !(values.skillsmp ?? "").trim()}
            >
              {spin("skillsmp")} Save
            </Button>
            {flags.skillsmp && (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => userId && void settingsService.setSkillsMPApiKey(userId, null)}
                disabled={busy.skillsmp}
              >
                <Trash2 className="mr-0.5 size-3.5" /> Clear
              </Button>
            )}
          </KeyRow>
        </ul>
      </SectionCard>

      {/* ── AI Providers — per-provider key rows ─────────────────────────── */}
      <SectionCard
        title="AI Providers"
        description="Every configured provider with its key. Base URLs, models and toggles stay in Settings → AI Providers — the keys live here."
      >
        {providers.length === 0 ? (
          <p className="text-muted-foreground py-3 text-sm">
            No providers configured yet — add one in Settings → AI Providers, then set its key here.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {providers.map((p) => {
              const pid = p.id;
              const mark = resolvePlatformMark(p.name);
              const hasKey = !!p.api_key_encrypted;
              return (
                <li key={pid} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex items-start gap-3">
                    <PlatformLogo platform={mark} size={34} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold">{p.name}</p>
                        <StatusBadge state={hasKey ? "connected" : "partial"} label={hasKey ? "key set" : "no key"} />
                        {!p.is_active && (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">
                            inactive
                          </Badge>
                        )}
                        <span className="text-muted-foreground hidden min-w-0 truncate font-mono text-[11px] sm:inline">
                          {p.base_url.replace(/^https?:\/\//, "")}
                        </span>
                        <span className="text-muted-foreground text-[11px">{p.models.length} models</span>
                      </div>
                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <KeyInput
                          id={`api-key-provider-${pid}`}
                          value={providerValues[pid] ?? ""}
                          onChange={(v) => setProviderValues((prev) => ({ ...prev, [pid]: v }))}
                          revealed={!!revealed[pid]}
                          onToggleReveal={() => toggleReveal(pid)}
                          placeholder={hasKey ? "•••••••• (saved) — enter a new key to replace" : `A key for ${p.name}`}
                        />
                        <Button
                          size="sm"
                          onClick={() => void saveProviderKey(pid)}
                          disabled={providerBusy[pid] || !(providerValues[pid] ?? "").trim()}
                        >
                          {providerBusy[pid] ? (
                            <Loader2 className="mr-1 size-3.5 animate-spin" />
                          ) : (
                            <Save className="mr-0.5 size-3.5" />
                          )}
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void testProvider(pid, p.models[0])}
                          disabled={p.models.length === 0}
                        >
                          <Plug className="mr-0.5 size-3.5" /> Test
                        </Button>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

export default SectionApiKeys;
