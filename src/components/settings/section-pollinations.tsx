"use client";

/**
 * Settings → Pollinations AI (Task 5-b) — the dedicated management surface
 * for the Pollinations media_generation integration.
 *
 * Everything is driven by the live provider state in usePollinationsStore:
 *   1. Connection    — BYOP OAuth (official authorization-code + PKCE flow)
 *                      or a pasted sk_/pk_ key (vault-encrypted at rest).
 *   2. Pollen        — the account balance + Quest/Paid split, straight
 *                      from the provider (never fabricated).
 *   3. Model defaults— per-modality defaults picked from the LIVE catalogue
 *                      (free models first, marked as recommended).
 *   4. Preferences   — image/video/audio defaults, prompt enhancement,
 *                      the official safety filter.
 *   5. Logs          — the persisted local activity log (estimates at
 *                      confirmation time), provider-reported usage, and
 *                      this session's jobs.
 *
 * Honesty rules mirrored from the lib: unknown balances/prices are rendered
 * as "unknown", and the model catalogue is refetched on every mount (never
 * trusted from a stale cache).
 */

import * as React from "react";
import { toast } from "sonner";
import {
  AtSign,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Eye,
  EyeOff,
  Flower2,
  KeyRound,
  Loader2,
  Plug,
  RefreshCw,
  Save,
  Star,
  TriangleAlert,
  Unplug,
  XCircle,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { useAuthStore } from "@/stores";
import { SectionCard, SettingsRow } from "@/components/settings/settings-section";
import { completeOAuth, fetchUsage, startOAuth } from "@/lib/pollinations/api";
import { compatibleModels, isFreeModel, priceLinesOf } from "@/lib/pollinations/capabilities";
import { usePollinationsStore } from "@/lib/pollinations/store";
import type {
  ActivityLogEntry,
  ConnectionStatus,
  GenerationJob,
  GenerationJobStatus,
  ModalityKey,
  PollinationsModel,
  PollinationsPrefs,
  UsageRow,
} from "@/lib/pollinations/types";

// ---------------------------------------------------------------------------
// Constants + small formatting helpers (never invent a number — unknown is
// rendered as "unknown").
// ---------------------------------------------------------------------------

const POLLEN_URL = "https://enter.pollinations.ai/pollen";
const DOCS_URL = "https://gen.pollinations.ai/docs";
/** Pollinations keys: sk_ (secret) / pk_ (publishable). */
const KEY_RE = /^(sk|pk)_/;

const MODALITIES: Array<{ key: ModalityKey; label: string; description: string }> = [
  { key: "text", label: "Text", description: "Chat completions and text generation" },
  { key: "image", label: "Image", description: "Image generation from prompts" },
  { key: "video", label: "Video", description: "Video generation from prompts" },
  { key: "audio", label: "Audio", description: "Speech / audio generation (TTS)" },
  { key: "realtime", label: "Realtime", description: "Live realtime sessions" },
  { key: "embedding", label: "Embeddings", description: "Text embeddings for similarity search" },
  { key: "3d", label: "3D", description: "3D asset (GLB) generation" },
];

/** Standard OpenAI voices — valid across the hosted TTS models. */
const OPENAI_VOICES = [
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
  "ash",
  "ballad",
  "coral",
  "sage",
  "verse",
] as const;

const AUDIO_FORMATS: Array<PollinationsPrefs["audioFormat"]> = ["mp3", "opus", "aac", "flac", "wav", "pcm"];

const VIDEO_RESOLUTIONS = ["720p", "480p", "1080p"];

const SAFETY_OPTIONS = [
  { value: "off", label: "Off (default)" },
  { value: "privacy,secrets", label: "privacy,secrets" },
  { value: "sexual,violence", label: "sexual,violence" },
  { value: "shield", label: "shield" },
];

const OAUTH_ERROR_NOTES: Record<string, string> = {
  access_denied: "You declined the authorization.",
  state_mismatch: "The session expired mid-flow — try again.",
  invalid_callback: "The provider returned an invalid callback.",
};

function fmtPollen(v: number): string {
  if (!Number.isFinite(v)) return "unknown";
  if (v === 0) return "0";
  if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (Math.abs(v) >= 1) return String(Number(v.toFixed(2)));
  return v.toPrecision(2).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  try {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
    return new Date(iso).toLocaleDateString();
  } catch {
    return "never";
  }
}

function fmtClock(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour12: false });
  } catch {
    return "";
  }
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Tiny presentational atoms (the app's badge idiom, mini-sized for rows).
// ---------------------------------------------------------------------------

type Tone = "emerald" | "amber" | "gray" | "destructive";

function MiniBadge({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-px text-[10px] leading-4 font-medium whitespace-nowrap",
        tone === "emerald" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        tone === "amber" && "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
        tone === "gray" && "border-border bg-muted/50 text-muted-foreground",
        tone === "destructive" && "border-destructive/30 bg-destructive/10 text-destructive",
        className,
      )}
    >
      {children}
    </span>
  );
}

function StatusDot({ tone, pulse }: { tone: "emerald" | "amber" | "gray"; pulse?: boolean }) {
  return (
    <span
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        tone === "emerald" && "bg-emerald-500",
        tone === "amber" && "bg-amber-500",
        tone === "gray" && "bg-muted-foreground/50",
        pulse && "animate-pulse",
      )}
    />
  );
}

function HealthDot({ status }: { status?: string }) {
  const s = status?.toLowerCase();
  const tone = s === "healthy" ? "bg-emerald-500" : s === "degraded" ? "bg-amber-500" : s === "down" || s === "unavailable" || s === "offline" ? "bg-destructive" : "bg-muted-foreground/40";
  // The adjacent text already names the status — the dot stays decorative.
  return <span aria-hidden="true" className={cn("inline-block size-1.5 shrink-0 rounded-full", tone)} />;
}

function LogStatusBadge({ status }: { status: ActivityLogEntry["status"] }) {
  if (status === "completed") return <MiniBadge tone="emerald">completed</MiniBadge>;
  if (status === "failed") return <MiniBadge tone="destructive">failed</MiniBadge>;
  return <MiniBadge tone="gray">cancelled</MiniBadge>;
}

function JobStatusBadge({ status }: { status: GenerationJobStatus }) {
  switch (status) {
    case "completed":
      return <MiniBadge tone="emerald">completed</MiniBadge>;
    case "failed":
      return <MiniBadge tone="destructive">failed</MiniBadge>;
    case "running":
      return (
        <MiniBadge tone="amber">
          <Loader2 className="size-2.5 animate-spin" /> running
        </MiniBadge>
      );
    case "pending":
      return <MiniBadge tone="amber">pending</MiniBadge>;
    default:
      return <MiniBadge tone="gray">cancelled</MiniBadge>;
  }
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      <p className="mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model picker (live catalogue, free-first — the sort comes from
// compatibleModels in the lib, this only renders it).
// ---------------------------------------------------------------------------

function ModelOption({ model }: { model: PollinationsModel }) {
  const free = isFreeModel(model);
  const paidOnly = model.paid_only === true;
  const community = model.community === true;
  const successRate =
    typeof model.health?.success_rate === "number" ? `${Math.round(model.health.success_rate)}% ok` : null;
  const priceLine = priceLinesOf(model)[0] ?? "pricing unknown";
  return (
    <SelectItem value={model.name} textValue={model.title ?? model.name} className="py-2">
      <span className="flex flex-col gap-1">
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="truncate font-medium">{model.title ?? model.name}</span>
          <span className="text-muted-foreground shrink-0 text-xs">{model.publisher ?? "unknown"}</span>
          {free && (
            <>
              <MiniBadge tone="emerald">FREE • 0 POLLEN</MiniBadge>
              <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                <Star className="size-2.5 fill-current" /> Recommended
              </span>
            </>
          )}
          {paidOnly && !free && <MiniBadge tone="amber">PAID ONLY</MiniBadge>}
          {community && <MiniBadge tone="gray">community</MiniBadge>}
        </span>
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <HealthDot status={model.health?.status} />
          {model.health?.status ? model.health.status : "health unknown"}
          {successRate ? ` · ${successRate}` : ""} · {priceLine}
        </span>
      </span>
    </SelectItem>
  );
}

function ModelSelect({
  modality,
  label,
  models,
  value,
  onChange,
}: {
  modality: ModalityKey;
  label: string;
  models: PollinationsModel[];
  value: string | undefined;
  onChange: (modelId: string) => void;
}) {
  const list = React.useMemo(() => compatibleModels(models, modality), [models, modality]);
  const selected = value ? (list.find((m) => m.name === value) ?? null) : null;
  const savedMissing = !!value && !selected;

  if (list.length === 0) {
    return (
      <div className="text-muted-foreground flex h-9 w-full items-center rounded-md border border-dashed px-3 text-xs sm:w-[320px]">
        No {label.toLowerCase()} model currently available
      </div>
    );
  }

  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className="w-full sm:w-[320px]" aria-label={`${label} default model`}>
        {selected ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{selected.title ?? selected.name}</span>
            <span className="text-muted-foreground shrink-0 text-xs">{selected.publisher ?? "unknown"}</span>
            {isFreeModel(selected) && <MiniBadge tone="emerald">FREE</MiniBadge>}
            {selected.paid_only === true && !isFreeModel(selected) && <MiniBadge tone="amber">PAID ONLY</MiniBadge>}
          </span>
        ) : savedMissing ? (
          <span className="truncate text-xs text-amber-600 dark:text-amber-400">
            Saved default unavailable — pick a replacement
          </span>
        ) : (
          <span className="text-muted-foreground text-sm">Pick a model…</span>
        )}
      </SelectTrigger>
      <SelectContent className="max-h-80">
        {list.map((m) => (
          <ModelOption key={m.name} model={m} />
        ))}
      </SelectContent>
    </Select>
  );
}

// ---------------------------------------------------------------------------
// Number field — commits on blur/Enter, clamped to [min, max].
// ---------------------------------------------------------------------------

function NumberField({
  value,
  min,
  max,
  onCommit,
  ariaLabel,
  className,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
  ariaLabel: string;
  className?: string;
}) {
  const [draft, setDraft] = React.useState(String(value));
  React.useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const n = Math.round(Number(draft));
    const clamped = Math.min(max, Math.max(min, Number.isFinite(n) ? n : value));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <Input
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      aria-label={ariaLabel}
      className={cn("w-20", className)}
    />
  );
}

// ---------------------------------------------------------------------------
// The section.
// ---------------------------------------------------------------------------

export function SectionPollinations() {
  // Auth-resolved gating (same pattern as use-data.ts — the transient
  // "local-user" id must never own the stored connection).
  const userId = useAuthStore((s) => (s.authResolved ? s.user?.id : null));

  const connectionStatus = usePollinationsStore((s) => s.connectionStatus);
  const connectionMeta = usePollinationsStore((s) => s.connectionMeta);
  const balance = usePollinationsStore((s) => s.balance);
  const balanceError = usePollinationsStore((s) => s.balanceError);
  const balanceLoading = usePollinationsStore((s) => s.balanceLoading);
  const models = usePollinationsStore((s) => s.models);
  const modelsLoading = usePollinationsStore((s) => s.modelsLoading);
  const modelsError = usePollinationsStore((s) => s.modelsError);
  const modelsFetchedAt = usePollinationsStore((s) => s.modelsFetchedAt);
  const defaults = usePollinationsStore((s) => s.defaults);
  const prefs = usePollinationsStore((s) => s.prefs);
  const jobs = usePollinationsStore((s) => s.jobs);
  const activityLog = usePollinationsStore((s) => s.activityLog);

  // OAuth flow / inline key form state.
  const [oauthStarting, setOauthStarting] = React.useState(false);
  const [oauthExchanging, setOauthExchanging] = React.useState(false);
  const [oauthError, setOauthError] = React.useState<string | null>(null);
  const [clientKeyNote, setClientKeyNote] = React.useState<string | null>(null);
  const [showKeyForm, setShowKeyForm] = React.useState(false);
  const [keyInput, setKeyInput] = React.useState("");
  const [showKey, setShowKey] = React.useState(false);
  const [savingKey, setSavingKey] = React.useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false);

  // Provider usage (fetched live whenever the disclosure opens).
  const [usageOpen, setUsageOpen] = React.useState(false);
  const [usage, setUsage] = React.useState<UsageRow[] | null>(null);
  const [usageLoading, setUsageLoading] = React.useState(false);
  const [usageError, setUsageError] = React.useState<string | null>(null);

  const connected = connectionStatus === "connected";
  const bootedRef = React.useRef(false);

  // ── Boot: init the store for the resolved user, ALWAYS refetch the live
  // catalogue, and settle any OAuth return params left in the URL by the
  // /api/auth/pollinations/callback redirect. ─────────────────────────────
  React.useEffect(() => {
    if (!userId || bootedRef.current) return;
    bootedRef.current = true;

    const handleOAuthReturn = async () => {
      const params = new URLSearchParams(window.location.search);
      const code = params.get("pollinations_code");
      const state = params.get("pollinations_state");
      const errorParam = params.get("pollinations_error");
      const cleanUrl = () => window.history.replaceState({}, "", window.location.pathname);

      if (code && state) {
        setOauthExchanging(true);
        try {
          const result = await completeOAuth(code, state);
          await usePollinationsStore.getState().connect(result.access_token, {
            method: "oauth",
            connectedAt: new Date().toISOString(),
            expiresAt: result.expires_at,
            scope: result.scope,
            profile: result.profile ?? undefined,
          });
          toast.success("Pollinations connected", {
            description: result.profile?.githubUsername
              ? `Connected as @${result.profile.githubUsername} — media generation is ready.`
              : "Media generation is ready.",
            icon: <CheckCircle2 className="size-4" />,
          });
        } catch (err) {
          setOauthError(
            err instanceof Error ? err.message : "Could not complete the Pollinations connection.",
          );
        } finally {
          setOauthExchanging(false);
          cleanUrl();
        }
      } else if (errorParam) {
        setOauthError(
          OAUTH_ERROR_NOTES[errorParam] ?? `The connection flow failed (${errorParam}). Try again.`,
        );
        cleanUrl();
      } else if (code || state) {
        setOauthError("The connection flow returned an incomplete response — try again.");
        cleanUrl();
      }
    };

    (async () => {
      const store = usePollinationsStore.getState();
      await store.init(userId);
      // The catalogue must never be stale — live fetch on every mount.
      void store.refreshModels();
      await handleOAuthReturn();
    })();
  }, [userId]);

  // ── OAuth start (official authorization-code + PKCE flow). ──────────────
  async function handleConnect() {
    setOauthStarting(true);
    setOauthError(null);
    setClientKeyNote(null);
    try {
      const start = await startOAuth();
      if (start.clientIdConfigured === false) {
        // VERIFIED against the live provider (2026-10): the authorize
        // endpoint requires a client_id (App Key) for the code flow — it
        // answers "Couldn't connect: client_id is required for the
        // authorization code flow". Don't navigate into a dead end; tell the
        // user exactly what the app owner must configure and offer the
        // manual key path instead.
        setOauthStarting(false);
        setClientKeyNote(
          `OAuth isn't configured on this deployment yet — the app owner must set POLLINATIONS_CLIENT_ID (a Pollinations App Key, pk_…) and register this exact redirect URI with it: ${start.redirectUri} (in production: https://onyx-agent-frontend-ai-multi-agent-wine.vercel.app/api/auth/pollinations/callback). Until then, connect by pasting your own API key below — get one at enter.pollinations.ai/keys.`,
        );
        return;
      }
      window.location.href = start.authorizeUrl;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start the connection flow.");
      setOauthStarting(false);
    }
  }

  // ── Manual key (sk_/pk_) — vault-encrypted via store.connect. ───────────
  async function handleKeySubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = keyInput.trim();
    if (!trimmed) {
      toast.error("Enter an API key first");
      return;
    }
    if (!KEY_RE.test(trimmed)) {
      toast.error("Key format looks invalid", {
        description: "Pollinations keys start with sk_ (secret) or pk_ (publishable).",
        icon: <XCircle className="size-4" />,
      });
      return;
    }
    setSavingKey(true);
    try {
      await usePollinationsStore.getState().connect(trimmed, {
        method: "manual",
        connectedAt: new Date().toISOString(),
        expiresAt: undefined,
      });
      setKeyInput("");
      setShowKeyForm(false);
      toast.success("Pollinations API key saved", {
        description: "Encrypted at rest with AES-GCM in your browser.",
        icon: <CheckCircle2 className="size-4" />,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save key");
    } finally {
      setSavingKey(false);
    }
  }

  async function handleDisconnect() {
    try {
      await usePollinationsStore.getState().disconnect();
      setUsage(null);
      setUsageError(null);
      toast.success("Pollinations disconnected");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setConfirmDisconnect(false);
    }
  }

  // ── Provider usage — live fetch every time the disclosure opens. ────────
  function handleUsageToggle(open: boolean) {
    setUsageOpen(open);
    if (!open) return;
    const token = usePollinationsStore.getState().getToken();
    if (!token) {
      setUsage(null);
      setUsageError("Not connected — connect your Pollinations account to see provider usage.");
      return;
    }
    setUsageLoading(true);
    setUsageError(null);
    fetchUsage(token, { limit: 20, days: 30 })
      .then((rows) => setUsage(rows))
      .catch((err) => {
        setUsage(null);
        setUsageError(err instanceof Error ? err.message : "Could not load provider usage.");
      })
      .finally(() => setUsageLoading(false));
  }

  const setPrefs = (patch: Partial<PollinationsPrefs>) => void usePollinationsStore.getState().setPrefs(patch);

  // Voice options: the standard OpenAI voices + the union of live audio
  // model voices (plus the persisted voice if it dropped out of the union,
  // so the select never lies about what is saved).
  const voiceOptions = React.useMemo(() => {
    const known = new Set<string>(OPENAI_VOICES);
    const rest = new Set<string>();
    for (const m of models) {
      if (m.category !== "audio") continue;
      for (const v of m.voices ?? []) {
        const t = v.trim();
        if (t && !known.has(t)) rest.add(t);
      }
    }
    const saved = prefs.audioVoice;
    const extra = saved && !known.has(saved) && !rest.has(saved) ? [saved] : [];
    return [...OPENAI_VOICES, ...extra, ...[...rest].sort((a, b) => a.localeCompare(b))];
  }, [models, prefs.audioVoice]);

  if (!userId) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    );
  }

  const profileName = connectionMeta?.profile?.githubUsername || connectionMeta?.profile?.name || null;
  const modelsEmptyAndErrored = !!modelsError && models.length === 0;
  const showModelSkeletons =
    modelsLoading || (!modelsFetchedAt && models.length === 0 && !modelsError);

  return (
    <div className="space-y-6">
      {/* ── Intro ─────────────────────────────────────────────────────────── */}
      <Alert>
        <Flower2 className="size-4" />
        <AlertTitle>What is Pollinations?</AlertTitle>
        <AlertDescription>
          Image, video, audio, 3D and text generation through Pollinations.ai, paid with Pollen credits. Free
          models are marked and cost 0 Pollen; everything else estimates its Pollen cost and asks you to
          confirm before generating. Docs:{" "}
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground inline-flex items-center gap-0.5 underline underline-offset-4"
          >
            gen.pollinations.ai/docs <ExternalLink className="size-3" />
          </a>
        </AlertDescription>
      </Alert>

      {/* ── 1. Connection ────────────────────────────────────────────────── */}
      <SectionCard
        title="Connection"
        description="Connect your Pollinations account via OAuth, or paste an API key. The key is encrypted (AES-GCM) and stored only in your browser."
        action={<ConnectionPill status={connectionStatus} method={connectionMeta?.method} />}
      >
        <div className="space-y-4">
          {/* Status row */}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {connectionStatus === "connected" && (
              <>
                <StatusDot tone="emerald" />
                <span className="font-medium">
                  {connectionMeta?.method === "oauth" ? "Connected via OAuth" : "Connected with API key"}
                </span>
              </>
            )}
            {connectionStatus === "expired" && (
              <>
                <StatusDot tone="amber" />
                <span className="font-medium text-amber-600 dark:text-amber-400">
                  Key expired — reconnect
                </span>
              </>
            )}
            {connectionStatus === "checking" && (
              <>
                <StatusDot tone="gray" pulse />
                <span className="text-muted-foreground">Checking connection…</span>
              </>
            )}
            {connectionStatus === "disconnected" && (
              <>
                <StatusDot tone="gray" />
                <span className="text-muted-foreground">Not connected</span>
              </>
            )}

            {profileName && (
              <span className="bg-muted/50 text-muted-foreground inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs">
                <AtSign className="size-3" />
                {profileName}
              </span>
            )}
            {connectionMeta?.scope && (
              <span className="bg-muted/50 text-muted-foreground inline-flex max-w-full items-center rounded-md border px-2 py-0.5 font-mono text-[10px] break-all">
                {connectionMeta.scope}
              </span>
            )}
            {connectionMeta?.expiresAt && (
              <span className="bg-muted/50 text-muted-foreground inline-flex items-center rounded-md border px-2 py-0.5 text-xs">
                expires {fmtDate(connectionMeta.expiresAt)}
              </span>
            )}
          </div>

          {/* OAuth exchange in progress (post-redirect) */}
          {oauthExchanging && (
            <p className="text-muted-foreground flex items-center gap-2 text-xs">
              <Loader2 className="size-3.5 animate-spin" /> Completing the connection…
            </p>
          )}

          {/* Honest OAuth failure banner */}
          {oauthError && (
            <Alert variant="destructive">
              <XCircle className="size-4" />
              <AlertTitle>Connection failed</AlertTitle>
              <AlertDescription>{oauthError}</AlertDescription>
            </Alert>
          )}

          {/* App-owner note (no POLLINATIONS_CLIENT_ID configured) */}
          {clientKeyNote && (
            <Alert>
              <TriangleAlert className="size-4 text-amber-500" />
              <AlertTitle className="text-amber-600 dark:text-amber-400">App key not configured</AlertTitle>
              <AlertDescription>{clientKeyNote}</AlertDescription>
            </Alert>
          )}

          {/* Inline paste-key form */}
          {showKeyForm && (
            <form onSubmit={handleKeySubmit} className="space-y-2">
              <Label htmlFor="pollinations-key" className="sr-only">
                Pollinations API key
              </Label>
              <div className="relative">
                <KeyRound className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                <Input
                  id="pollinations-key"
                  type={showKey ? "text" : "password"}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder="sk_… or pk_…"
                  autoComplete="off"
                  spellCheck={false}
                  className="pr-10 pl-9 font-mono"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="absolute top-1/2 right-1 size-7 -translate-y-1/2"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? "Hide key" : "Show key"}
                >
                  {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                Keys start with sk_ (secret) or pk_ (publishable). Stored encrypted in your browser only.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" disabled={savingKey || !keyInput.trim()}>
                  {savingKey ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                  Save key
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowKeyForm(false);
                    setKeyInput("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            {!connected && (
              <Button size="sm" onClick={() => void handleConnect()} disabled={oauthStarting}>
                {oauthStarting ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
                {connectionStatus === "expired" ? "Reconnect" : "Connect account"}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowKeyForm((v) => !v)}
              disabled={savingKey}
            >
              <KeyRound className="size-4" />
              Paste API key
            </Button>
            {(connected || connectionStatus === "expired") && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmDisconnect(true)}
              >
                <Unplug className="size-4" />
                Disconnect
              </Button>
            )}
          </div>
        </div>
      </SectionCard>

      {/* ── 2. Pollen balance (only when connected) ──────────────────────── */}
      {connected && (
        <SectionCard
          title="Pollen balance"
          description="Pollen is the credit every Pollinations generation spends."
          action={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh balance"
              disabled={balanceLoading}
              onClick={() => void usePollinationsStore.getState().refreshBalance()}
            >
              <RefreshCw className={cn("size-4", balanceLoading && "animate-spin")} />
            </Button>
          }
        >
          <div className="space-y-4">
            {balanceError && (
              <Alert variant="destructive">
                <XCircle className="size-4" />
                <AlertDescription>{balanceError}</AlertDescription>
              </Alert>
            )}
            <div>
              {balanceLoading && !balance ? (
                <Skeleton className="h-9 w-32" />
              ) : balance ? (
                <p className="flex items-baseline gap-2">
                  <span className="font-display text-3xl font-semibold tracking-tight">
                    {fmtPollen(balance.balance)}
                  </span>
                  <span className="text-muted-foreground text-sm font-medium">Pollen</span>
                </p>
              ) : (
                <p className="text-muted-foreground text-sm">Balance unknown</p>
              )}
              {balance && (
                <p className="text-muted-foreground mt-1 text-xs">Last checked {timeAgo(balance.checkedAt)}</p>
              )}
            </div>

            {balance?.accountBalance ? (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <StatTile label="Total" value={fmtPollen(balance.accountBalance.total)} />
                  <StatTile label="Quest Pollen" value={fmtPollen(balance.accountBalance.tier)} />
                  <StatTile label="Paid Pollen" value={fmtPollen(balance.accountBalance.paid)} />
                </div>
                <p className="text-muted-foreground text-xs">
                  Quest Pollen comes from free daily credits; paid-only models can ONLY spend Paid Pollen.
                </p>
              </>
            ) : (
              !balanceError && (
                <p className="text-muted-foreground text-xs">
                  The connected key doesn&apos;t expose the account-level split.
                </p>
              )
            )}

            <a
              href={POLLEN_URL}
              target="_blank"
              rel="noreferrer"
              className="text-foreground inline-flex items-center gap-0.5 text-xs font-medium underline underline-offset-2"
            >
              Manage Pollen at enter.pollinations.ai
              <ExternalLink className="size-3" />
            </a>
          </div>
        </SectionCard>
      )}

      {/* ── 3. Model defaults (live catalogue) ───────────────────────────── */}
      <SectionCard
        title="Model defaults"
        description="The default model per modality, picked from the live catalogue — free models first, marked as recommended."
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void usePollinationsStore.getState().refreshModels()}
            disabled={modelsLoading}
          >
            {modelsLoading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Refresh models
          </Button>
        }
      >
        <div className="space-y-4">
          <p className="text-muted-foreground text-xs">
            {models.length} model{models.length === 1 ? "" : "s"} —{" "}
            {modelsFetchedAt
              ? timeAgo(modelsFetchedAt) === "just now"
                ? "fetched live just now"
                : `fetched live ${timeAgo(modelsFetchedAt)}`
              : "fetching the live catalogue…"}
          </p>

          {modelsError && (
            <Alert variant="destructive">
              <XCircle className="size-4" />
              <AlertTitle>Could not load the model catalogue</AlertTitle>
              <AlertDescription className="flex flex-col gap-2">
                <span>{modelsError}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() => void usePollinationsStore.getState().refreshModels()}
                >
                  <RefreshCw className="size-3.5" /> Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {showModelSkeletons && !modelsError ? (
            <div className="space-y-4">
              {MODALITIES.map((m) => (
                <div
                  key={m.key}
                  className="flex flex-col gap-2 border-t pt-4 first:border-t-0 first:pt-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="space-y-1.5">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                  <Skeleton className="h-9 w-full sm:w-[320px]" />
                </div>
              ))}
            </div>
          ) : (
            !modelsEmptyAndErrored && (
              <div>
                {MODALITIES.map((m) => {
                  const value = defaults[m.key];
                  const list = compatibleModels(models, m.key);
                  const savedMissing = !!value && !list.some((x) => x.name === value);
                  return (
                    <SettingsRow
                      key={m.key}
                      label={m.label}
                      description={
                        list.length === 0
                          ? `No ${m.label.toLowerCase()} model currently available.`
                          : m.description
                      }
                      align="start"
                      control={
                        <div className="w-full sm:w-[320px]">
                          <ModelSelect
                            modality={m.key}
                            label={m.label}
                            models={models}
                            value={value}
                            onChange={(id) =>
                              void usePollinationsStore.getState().setDefaultModel(m.key, id)
                            }
                          />
                          {savedMissing && (
                            <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                              Saved default is no longer available — pick a replacement
                            </p>
                          )}
                        </div>
                      }
                    />
                  );
                })}
              </div>
            )
          )}
        </div>
      </SectionCard>

      {/* ── 4. Generation preferences ────────────────────────────────────── */}
      <SectionCard
        title="Generation preferences"
        description="Defaults applied when the agent prepares a generation — the confirmation dialog always shows the exact values before anything is charged."
      >
        <SettingsRow
          label="Image default size"
          description="Width × height in pixels (256–2048)."
          control={
            <div className="flex items-center gap-2">
              <NumberField
                value={prefs.imageWidth}
                min={256}
                max={2048}
                onCommit={(v) => setPrefs({ imageWidth: v })}
                ariaLabel="Default image width"
              />
              <span className="text-muted-foreground">×</span>
              <NumberField
                value={prefs.imageHeight}
                min={256}
                max={2048}
                onCommit={(v) => setPrefs({ imageHeight: v })}
                ariaLabel="Default image height"
              />
            </div>
          }
        />
        <SettingsRow
          label="Video default duration"
          description="Seconds of generated video (1–30) and the default resolution."
          control={
            <div className="flex items-center gap-2">
              <NumberField
                value={prefs.videoDuration}
                min={1}
                max={30}
                onCommit={(v) => setPrefs({ videoDuration: v })}
                ariaLabel="Default video duration in seconds"
              />
              <Select
                value={prefs.videoResolution}
                onValueChange={(v) => setPrefs({ videoResolution: v })}
              >
                <SelectTrigger className="w-28" aria-label="Default video resolution">
                  {prefs.videoResolution}
                </SelectTrigger>
                <SelectContent>
                  {VIDEO_RESOLUTIONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          }
        />
        <SettingsRow
          label="Audio defaults"
          description="Voice for speech generation (live catalogue voices + the standard OpenAI set) and the output format."
          control={
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={prefs.audioVoice}
                onValueChange={(v) => setPrefs({ audioVoice: v })}
              >
                <SelectTrigger className="w-36" aria-label="Default audio voice">
                  {prefs.audioVoice}
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {voiceOptions.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={prefs.audioFormat}
                onValueChange={(v) => setPrefs({ audioFormat: v as PollinationsPrefs["audioFormat"] })}
              >
                <SelectTrigger className="w-28" aria-label="Default audio format">
                  {prefs.audioFormat}
                </SelectTrigger>
                <SelectContent>
                  {AUDIO_FORMATS.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          }
        />
        <SettingsRow
          label="Prompt enhancement"
          description="Offer AI prompt enhancement in the generation dialog (always uses a free text model)."
          control={
            <Switch
              checked={prefs.enhanceByDefault}
              onCheckedChange={(v) => setPrefs({ enhanceByDefault: v })}
              aria-label="Offer AI prompt enhancement in the generation dialog"
            />
          }
        />
        <SettingsRow
          label="Safety filter"
          description="Official Pollinations safety filters applied to every generation."
          control={
            <Select
              value={prefs.safe || "off"}
              onValueChange={(v) => setPrefs({ safe: v === "off" ? "" : v })}
            >
              <SelectTrigger className="w-44" aria-label="Safety filter">
                {SAFETY_OPTIONS.find((o) => o.value === (prefs.safe || "off"))?.label ?? "Off"}
              </SelectTrigger>
              <SelectContent>
                {SAFETY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SectionCard>

      {/* ── 5. Logs ──────────────────────────────────────────────────────── */}
      <SectionCard
        title="Logs"
        description="Local activity history with the estimates shown at confirmation time, plus provider-reported usage."
      >
        <div className="space-y-4">
          {activityLog.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No Pollinations activity yet — generate something!
            </p>
          ) : (
            <div className="scrollbar-thin max-h-96 overflow-y-auto rounded-lg border">
              <ul className="divide-y">
                {activityLog.map((entry) => (
                  <ActivityRow key={entry.id} entry={entry} />
                ))}
              </ul>
            </div>
          )}

          {/* Provider usage — actual costs, fetched live on open */}
          <Collapsible open={usageOpen} onOpenChange={handleUsageToggle}>
            <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
              <ChevronDown className={cn("size-3.5 transition-transform", usageOpen && "rotate-180")} />
              Provider usage (last 30 days)
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-2 pt-3">
                {usageLoading ? (
                  <p className="text-muted-foreground flex items-center gap-2 text-xs">
                    <Loader2 className="size-3.5 animate-spin" /> Fetching provider usage…
                  </p>
                ) : usageError ? (
                  <Alert variant="destructive">
                    <XCircle className="size-4" />
                    <AlertDescription>{usageError}</AlertDescription>
                  </Alert>
                ) : !connected ? (
                  <p className="text-muted-foreground text-xs">
                    Connect your Pollinations account to see provider-reported usage.
                  </p>
                ) : usage && usage.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    No provider-side usage reported for the last 30 days.
                  </p>
                ) : usage ? (
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>When</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Model</TableHead>
                          <TableHead className="text-right">Cost</TableHead>
                          <TableHead>Meter</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {usage.map((u, i) => (
                          <UsageRowView key={u.cursor_event_id ?? `${u.timestamp ?? ""}-${i}`} row={u} />
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : null}
                <p className="text-muted-foreground text-xs">
                  Actual costs reported by Pollinations (the local log above shows estimates shown at
                  confirmation time).
                </p>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Recent jobs (this session) */}
          <div className="space-y-2">
            <p className="text-foreground text-xs font-medium">Recent jobs (this session)</p>
            {jobs.length === 0 ? (
              <p className="text-muted-foreground text-xs">No jobs this session yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {jobs.slice(0, 10).map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </SectionCard>

      {/* Disconnect confirm */}
      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Pollinations?</AlertDialogTitle>
            <AlertDialogDescription>
              The encrypted key will be deleted from your browser. Media generation will stop working until
              you connect again. Your model defaults and preferences are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => void handleDisconnect()}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row renderers (logs / usage / jobs).
// ---------------------------------------------------------------------------

function ActivityRow({ entry }: { entry: ActivityLogEntry }) {
  const tip = [entry.detail, entry.prompt].filter(Boolean).join("\n\n");
  const pollenBits: string[] = [];
  if (typeof entry.estimatedPollen === "number") pollenBits.push(`est. ≈ ${fmtPollen(entry.estimatedPollen)}`);
  else if (entry.estimatedPollen === null) pollenBits.push("est. unknown");
  if (typeof entry.actualPollen === "number") pollenBits.push(`actual ${fmtPollen(entry.actualPollen)}`);

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex min-w-0 flex-1 cursor-help items-center gap-2 text-left">
            <span className="text-muted-foreground shrink-0 font-mono tabular-nums">
              {fmtClock(entry.ts)}
            </span>
            <span className="shrink-0 font-medium">{entry.operation}</span>
            {entry.model && (
              <span className="text-muted-foreground truncate font-mono">{entry.model}</span>
            )}
          </span>
        </TooltipTrigger>
        {tip && (
          <TooltipContent className="max-w-xs whitespace-pre-wrap break-words">
            {tip.slice(0, 400)}
            {tip.length > 400 ? "…" : ""}
          </TooltipContent>
        )}
      </Tooltip>
      <span className="flex shrink-0 items-center gap-2">
        {pollenBits.length > 0 && (
          <span className="text-muted-foreground font-mono tabular-nums">{pollenBits.join(" · ")}</span>
        )}
        <LogStatusBadge status={entry.status} />
      </span>
    </li>
  );
}

function UsageRowView({ row }: { row: UsageRow }) {
  const meter = row.meter_source === "tier" ? "Quest" : row.meter_source === "pack" ? "Paid" : (row.meter_source ?? "—");
  let cost = "—";
  if (typeof row.cost === "number") cost = fmtPollen(row.cost);
  else if (typeof row.cost === "string" && row.cost.trim() !== "" && Number.isFinite(Number(row.cost)))
    cost = fmtPollen(Number(row.cost));
  return (
    <TableRow>
      <TableCell className="text-muted-foreground whitespace-nowrap font-mono text-xs">
        {fmtDateTime(row.timestamp)}
      </TableCell>
      <TableCell className="text-xs">{row.type ?? "—"}</TableCell>
      <TableCell className="max-w-[200px] truncate font-mono text-xs">{row.model ?? "—"}</TableCell>
      <TableCell className="text-right font-mono text-xs tabular-nums">{cost}</TableCell>
      <TableCell className="text-xs">{meter}</TableCell>
    </TableRow>
  );
}

function JobRow({ job }: { job: GenerationJob }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
      <span className="text-muted-foreground shrink-0 font-mono tabular-nums">
        {fmtClock(job.createdAt)}
      </span>
      <span className="shrink-0 font-medium">{job.operation}</span>
      <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono">{job.model}</span>
      <JobStatusBadge status={job.status} />
    </li>
  );
}

// ---------------------------------------------------------------------------
// Connection status pill (the card's header action).
// ---------------------------------------------------------------------------

function ConnectionPill({ status, method }: { status: ConnectionStatus; method?: string }) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <StatusDot tone="emerald" />
        {method === "oauth" ? "Connected via OAuth" : "Connected with API key"}
      </span>
    );
  }
  if (status === "expired") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
        <StatusDot tone="amber" />
        Key expired — reconnect
      </span>
    );
  }
  if (status === "checking") {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs font-medium">
        <StatusDot tone="gray" pulse />
        Checking…
      </span>
    );
  }
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs font-medium">
      <StatusDot tone="gray" />
      Not connected
    </span>
  );
}

export default SectionPollinations;
