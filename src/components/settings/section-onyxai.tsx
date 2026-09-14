"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Cpu,
  ExternalLink,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Smartphone,
  Trash2,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/collapsible";

import { useAuth, useCopyToClipboard } from "@/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { aiProviderService } from "@/lib/services";
import {
  ONYXAI_CATALOG,
  ONYXAI_DEFAULT_BASE_URL,
  ONYXAI_TIER_META,
  buildCustomHfServeEntry,
  buildServeCommand,
  buildServeModelsBlock,
  catalogByAlias,
  catalogByTier,
  hfSrcForInput,
  isNonToolCallingAlias,
  toolCallingForAlias,
  type OnyxAiDeviceTier,
  type OnyxAiModel,
} from "@/lib/onyxai/catalog";
import {
  dismissOnyxAiProvider,
  ensureOnyxAiProvider,
  isOnyxAiDismissed,
  undismissOnyxAiProvider,
} from "@/lib/onyxai/seed";
import type { AIProviderRow } from "@/lib/db";

/**
 * Settings → OnyxAI — the optional default local-inference provider.
 *
 * OnyxAI is powered by QVAC (https://docs.qvac.tether.io): the user runs
 * `qvac serve --openai` on their own device (phone → server) and OnyxAgent
 * talks to it directly from the browser at http://localhost:11434/v1 — the
 * server-side chat proxy can never reach the user's machine, so local
 * providers are routed client-side (see runtime.ts).
 *
 * This section:
 *   1. Connection — URL + optional bearer key + direct Connect & Test probe.
 *   2. Setup guide — install / qvac.config.json / serve command with the
 *      app's own origin pre-filled for `--cors-origin`.
 *   3. Catalog — the curated QVAC model catalog grouped by DEVICE TIER
 *      (mobile-compatible tool-calling models first, latest generations
 *      badged). NON-TOOL-CALLING MODELS ARE MARKED — they won't work well
 *      as the OnyxAgent brain (agent-first app; needs reliable tool calls).
 *   4. Custom HF models — load ANY Hugging Face GGUF via an explicit
 *      `{ src, type: "llm" }` serve.models entry.
 */

// ---------------------------------------------------------------------------
// Custom HF model persistence (localStorage — public URLs, nothing secret).
// ---------------------------------------------------------------------------

interface CustomHfModel {
  alias: string;
  src: string;
}

const CUSTOM_MODELS_KEY = (userId: string) => `onyx:onyxai-custom-models:${userId}`;

function loadCustomModels(userId: string): CustomHfModel[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_MODELS_KEY(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (m): m is CustomHfModel =>
            m && typeof m.alias === "string" && typeof m.src === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function saveCustomModels(userId: string, models: CustomHfModel[]): void {
  try {
    window.localStorage.setItem(CUSTOM_MODELS_KEY(userId), JSON.stringify(models));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function ToolBadge({ toolCalling }: { toolCalling: ReturnType<typeof toolCallingForAlias> }) {
  if (toolCalling === "native") {
    return (
      <Badge
        className="gap-1 border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
        variant="outline"
      >
        <Wrench className="size-3" />
        Tool calling
      </Badge>
    );
  }
  if (toolCalling === "template") {
    return (
      <Badge
        className="gap-1 border-amber-600/40 bg-amber-600/10 text-amber-700 dark:text-amber-400"
        variant="outline"
        title="llama.cpp tool template only — no dedicated tool post-training"
      >
        <AlertTriangle className="size-3" />
        Weak tools
      </Badge>
    );
  }
  if (toolCalling === "none") {
    return (
      <Badge
        className="gap-1 border-destructive/40 bg-destructive/10 text-destructive"
        variant="outline"
        title="This model cannot call tools — OnyxAgent's agent loop will not work well with it"
      >
        <XCircle className="size-3" />
        No tool calling
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground" title="Custom model — capability unknown">
      <AlertTriangle className="size-3" />
      Unknown tools
    </Badge>
  );
}

function ReadinessBadge({ model }: { model: OnyxAiModel }) {
  switch (model.agentReadiness) {
    case "recommended":
      return (
        <Badge className="gap-1" variant="default">
          <Zap className="size-3" />
          Recommended agent
        </Badge>
      );
    case "solid":
      return (
        <Badge variant="secondary" className="gap-1">
          <Check className="size-3" />
          Solid agent brain
        </Badge>
      );
    case "limited":
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground" title="Chats fine; tool invocation is unreliable at this size/quant">
          Limited agent use
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground" title="Chat only — not suitable as the agent brain">
          Chat only
        </Badge>
      );
  }
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const { copy, copied } = useCopyToClipboard(2000);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="gap-1.5 font-mono text-xs"
      onClick={() => {
        copy(text);
        toast.success("Copied to clipboard");
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {label ?? "Copy"}
    </Button>
  );
}

function CodeBlock({ code, caption }: { code: string; caption?: string }) {
  return (
    <div className="space-y-1.5">
      {caption ? <p className="text-xs font-medium text-muted-foreground">{caption}</p> : null}
      <div className="relative">
        <pre className="max-h-64 overflow-auto rounded-md border bg-muted/50 p-3 pr-24 font-mono text-xs leading-relaxed">
          {code}
        </pre>
        <div className="absolute right-2 top-2">
          <CopyButton text={code} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main section
// ---------------------------------------------------------------------------

interface LiveCatalogEntry {
  id: string;
  params?: string;
  quantization?: string;
  configured?: boolean;
}

export function SectionOnyxAI() {
  // useAuth (not the raw store) — its mount effect rehydrates the user +
  // vault on cold navigation to settings (same pattern as Telegram section).
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const qc = useQueryClient();

  const invalidateProviders = React.useCallback(() => {
    if (userId) qc.invalidateQueries({ queryKey: ["ai-providers", userId] });
  }, [qc, userId]);

  const [provider, setProvider] = React.useState<AIProviderRow | null>(null);
  const [seeding, setSeeding] = React.useState(true);
  const [urlDraft, setUrlDraft] = React.useState(ONYXAI_DEFAULT_BASE_URL);
  const [keyDraft, setKeyDraft] = React.useState("");
  const [showKey, setShowKey] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [connectionOk, setConnectionOk] = React.useState<boolean | null>(null);
  const [servedModels, setServedModels] = React.useState<string[] | null>(null);
  const [liveCatalog, setLiveCatalog] = React.useState<LiveCatalogEntry[] | null>(null);
  const [activeTier, setActiveTier] = React.useState<OnyxAiDeviceTier>("mobile");
  const [customModels, setCustomModels] = React.useState<CustomHfModel[]>([]);
  const [hfInput, setHfInput] = React.useState("");
  const [aliasInput, setAliasInput] = React.useState("");
  const [addingHf, setAddingHf] = React.useState(false);
  /** Pending non-tool model selection awaiting confirmation. */
  const [pendingNonTool, setPendingNonTool] = React.useState<string | null>(null);
  const [setupOpen, setSetupOpen] = React.useState(false);
  const [origin, setOrigin] = React.useState("");

  // ── Seed / load the OnyxAI provider row ─────────────────────────────────
  React.useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      setSeeding(true);
      const row = await ensureOnyxAiProvider(userId);
      if (cancelled) return;
      setProvider(row ?? null);
      if (row) {
        setUrlDraft(row.base_url);
        setKeyDraft(""); // never prefill secrets
      }
      setCustomModels(loadCustomModels(userId));
      setSeeding(false);
      // If ensure() just created the row, make the providers table see it.
      invalidateProviders();
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, invalidateProviders]);

  React.useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const refreshProvider = React.useCallback(async () => {
    if (!userId) return;
    const rows = await aiProviderService.list(userId);
    const row = rows.find((r) => r.name === "OnyxAI");
    setProvider(row ?? null);
  }, [userId]);

  // ── Provider mutation helpers ───────────────────────────────────────────
  const patchProvider = React.useCallback(
    async (patch: Record<string, unknown>) => {
      if (!provider || !userId) return;
      try {
        await aiProviderService.update(provider.id, patch);
        await refreshProvider();
        invalidateProviders();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update OnyxAI provider");
      }
    },
    [provider, userId, refreshProvider, invalidateProviders],
  );

  // ── Connect & Test — DIRECT browser → local QVAC probe ──────────────────
  const connectAndTest = React.useCallback(async () => {
    const base = urlDraft.trim().replace(/\/$/, "");
    if (!base) {
      toast.error("Enter the QVAC server URL first");
      return;
    }
    setTesting(true);
    setConnectionOk(null);
    setServedModels(null);
    setLiveCatalog(null);
    try {
      // Persist URL (+ key if provided) to the provider row first.
      if (provider) {
        const patch: Record<string, unknown> = { base_url: base };
        if (keyDraft.trim()) patch.api_key = keyDraft.trim();
        await aiProviderService.update(provider.id, patch);
        await refreshProvider();
        setKeyDraft("");
      }
      const modelsUrl = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
      const headers: Record<string, string> = {};
      const effKey = keyDraft.trim() || "";
      if (effKey) headers.Authorization = `Bearer ${effKey}`;
      const res = await fetch(modelsUrl, {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        setConnectionOk(false);
        toast.error(
          `QVAC server responded HTTP ${res.status} — is \`qvac serve --openai\` running with the right config?`,
        );
        return;
      }
      const data = await res.json();
      const ids: string[] = Array.isArray(data?.data)
        ? data.data
            .map((m: { id?: unknown }) => (typeof m?.id === "string" ? m.id : null))
            .filter((x: unknown): x is string => x !== null)
        : [];
      setConnectionOk(true);
      setServedModels(ids);
      toast.success(`Connected — ${ids.length} model${ids.length === 1 ? "" : "s"} served by QVAC`);
      // Also browse the live SDK catalog (QVAC extension endpoint).
      try {
        const catUrl = /\/v\d+$/.test(base) ? `${base}/models/catalog` : `${base}/v1/models/catalog`;
        const catRes = await fetch(`${catUrl}?role=chat&limit=200`, {
          headers,
          signal: AbortSignal.timeout(8000),
        });
        if (catRes.ok) {
          const cat = await catRes.json();
          if (Array.isArray(cat?.data)) setLiveCatalog(cat.data as LiveCatalogEntry[]);
        }
      } catch {
        // Catalog endpoint optional (older QVAC builds) — ignore.
      }
    } catch (e) {
      setConnectionOk(false);
      toast.error(
        `Can't reach the QVAC server at ${base}. Start it on this device with \`qvac serve --openai --cors-origin ${window.location.origin}\` — see the setup guide below.`,
        { duration: 8000 },
      );
      console.warn("[onyxai] connect test failed:", e);
    } finally {
      setTesting(false);
    }
  }, [urlDraft, keyDraft, provider, refreshProvider]);

  // ── Model selection ─────────────────────────────────────────────────────
  const selectedModels = React.useMemo(() => provider?.models ?? [], [provider]);

  const toggleModel = React.useCallback(
    async (alias: string) => {
      if (!provider) return;
      const isSelected = selectedModels.includes(alias);
      // Selecting a NON-TOOL-CALLING model → explicit confirmation first.
      if (!isSelected && isNonToolCallingAlias(alias)) {
        setPendingNonTool(alias);
        return;
      }
      const next = isSelected
        ? selectedModels.filter((m) => m !== alias)
        : [...selectedModels, alias];
      await patchProvider({ models: next });
    },
    [provider, selectedModels, patchProvider],
  );

  const confirmPendingNonTool = React.useCallback(async () => {
    if (!pendingNonTool || !provider) return;
    const next = [...selectedModels, pendingNonTool];
    await patchProvider({ models: next });
    setPendingNonTool(null);
    toast.warning("Added — remember: this model can't call tools reliably; agent tasks will misfire.");
  }, [pendingNonTool, provider, selectedModels, patchProvider]);

  // ── Custom HF model add ─────────────────────────────────────────────────
  const addCustomModel = React.useCallback(async () => {
    if (!provider || !userId) return;
    const src = hfSrcForInput(hfInput);
    const alias = (aliasInput.trim() || hfInput.trim().split("/").pop() || "custom-model")
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/\.gguf$/, "")
      .slice(0, 40);
    if (!hfInput.trim() || !/^https?:\/\//i.test(src) || !alias) {
      toast.error("Enter a Hugging Face repo (org/name) or a direct .gguf URL");
      return;
    }
    if (selectedModels.includes(alias)) {
      toast.info("A model with this alias is already added");
      return;
    }
    setAddingHf(true);
    try {
      const nextCustom = [...customModels.filter((c) => c.alias !== alias), { alias, src }];
      saveCustomModels(userId, nextCustom);
      setCustomModels(nextCustom);
      await patchProvider({ models: [...selectedModels, alias] });
      setHfInput("");
      setAliasInput("");
      toast.success(`Added "${alias}" — paste its serve.models entry into your qvac.config.json (snippet below)`);
    } finally {
      setAddingHf(false);
    }
  }, [provider, userId, hfInput, aliasInput, customModels, selectedModels, patchProvider]);

  const removeCustomModel = React.useCallback(
    async (alias: string) => {
      if (!provider || !userId) return;
      const nextCustom = customModels.filter((c) => c.alias !== alias);
      saveCustomModels(userId, nextCustom);
      setCustomModels(nextCustom);
      await patchProvider({ models: selectedModels.filter((m) => m !== alias) });
    },
    [provider, userId, customModels, selectedModels, patchProvider],
  );

  // ── Generated serve config (catalog constants + custom src entries) ──────
  const serveConfigJson = React.useMemo(() => {
    const base = JSON.parse(buildServeModelsBlock(selectedModels)) as {
      serve: { models: Record<string, unknown> };
    };
    for (const c of customModels) {
      base.serve.models[c.alias] = JSON.parse(buildCustomHfServeEntry(c.alias, c.src))[c.alias];
    }
    return JSON.stringify(base, null, 2);
  }, [selectedModels, customModels]);

  // Live catalog rows not covered by the curated catalog (future SDK models).
  const extraLiveModels = React.useMemo(() => {
    if (!liveCatalog) return [];
    const known = new Set(ONYXAI_CATALOG.map((m) => m.constant));
    return liveCatalog.filter(
      (e) => !known.has(e.id) && !selectedModels.includes(e.id),
    );
  }, [liveCatalog, selectedModels]);

  // ── Remove provider entirely ────────────────────────────────────────────
  const removeProvider = React.useCallback(async () => {
    if (!provider || !userId) return;
    try {
      await aiProviderService.delete(provider.id);
      dismissOnyxAiProvider(userId);
      setProvider(null);
      setConnectionOk(null);
      setServedModels(null);
      invalidateProviders();
      toast.success("OnyxAI provider removed. You can re-add it anytime from this page.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove provider");
    }
  }, [provider, userId, invalidateProviders]);

  const reAddProvider = React.useCallback(async () => {
    if (!userId) return;
    undismissOnyxAiProvider(userId);
    const row = await ensureOnyxAiProvider(userId);
    if (row) {
      setProvider(row);
      setUrlDraft(row.base_url);
      invalidateProviders();
      toast.success("OnyxAI provider restored");
    } else {
      // ensureOnyxAi skips when dismissed — clear and force-create.
      try {
        const created = await aiProviderService.create(userId, {
          name: "OnyxAI",
          base_url: urlDraft.trim() || ONYXAI_DEFAULT_BASE_URL,
          api_key: "",
          models: ONYXAI_CATALOG.filter((m) => m.recommended).map((m) => m.alias),
          model_type: "chat",
          tools_enabled: true,
          is_active: false,
        });
        setProvider(created);
        invalidateProviders();
        toast.success("OnyxAI provider restored");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to re-add provider");
      }
    }
  }, [userId, urlDraft, invalidateProviders]);

  // ── Render ──────────────────────────────────────────────────────────────
  if (!userId) {
    return (
      <Alert>
        <AlertTitle>Sign in to configure OnyxAI</AlertTitle>
        <AlertDescription>OnyxAI provider settings are per-user.</AlertDescription>
      </Alert>
    );
  }

  if (seeding) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="size-4 animate-spin" /> Loading OnyxAI…
      </div>
    );
  }

  if (!provider) {
    const dismissed = isOnyxAiDismissed(userId);
    return (
      <div className="space-y-4">
        <Alert>
          <Cpu className="size-4" />
          <AlertTitle>OnyxAI — local AI, powered by QVAC</AlertTitle>
          <AlertDescription>
            Run QVAC on your own device (phone → server) and use its models in OnyxAgent —
            fully local, no API keys, no cloud. Models are loaded from the QVAC registry or
            <span className="font-medium"> any Hugging Face repo</span>.
          </AlertDescription>
        </Alert>
        {dismissed ? (
          <Button onClick={reAddProvider} variant="outline" className="gap-2">
            <Plus className="size-4" /> Re-add OnyxAI provider
          </Button>
        ) : null}
      </div>
    );
  }

  const isActive = provider.is_active;
  const tierGroups = catalogByTier();

  return (
    <div className="space-y-6">
      {/* ── Hero / status ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-10 items-center justify-center rounded-lg border bg-muted/50">
            <Cpu className="size-5 text-primary" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-display text-base font-semibold leading-tight">OnyxAI</h3>
              <Badge variant="secondary" className="text-[10px]">Default provider</Badge>
              <Badge variant="outline" className="gap-1 text-[10px]">
                <ExternalLink className="size-3" />
                QVAC
              </Badge>
            </div>
            <p className="text-muted-foreground text-xs">
              Local inference on your device — private, offline-capable, free.
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {connectionOk === true ? (
            <Badge className="gap-1 border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400" variant="outline">
              <CheckCircle2 className="size-3" /> Connected
            </Badge>
          ) : connectionOk === false ? (
            <Badge className="gap-1 border-destructive/40 bg-destructive/10 text-destructive" variant="outline">
              <XCircle className="size-3" /> Offline
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              Not tested
            </Badge>
          )}
        </div>
      </div>

      {/* ── Tool-calling warning (the core capability requirement) ─────── */}
      <Alert>
        <AlertTriangle className="size-4" />
        <AlertTitle>Non tool-calling models won&apos;t work well</AlertTitle>
        <AlertDescription>
          OnyxAgent is agent-first — the model must reliably <span className="font-medium">emit tool calls</span> to
          drive the sandbox, file tools, and scheduled runs. Models without tool-calling training (chat-only tunes)
          will describe actions instead of executing them, then fabricate results. QVAC&apos;s own guidance: reliable
          local tool use generally needs <span className="font-medium">≥14B parameters with agent/coder post-training</span>{" "}
          (e.g. <span className="font-mono text-xs">GPT_OSS_20B</span>); Q4-quantized 4B–8B instruct tunes chat fine
          but often miss tool calls. Every model below is badged accordingly.
        </AlertDescription>
      </Alert>

      {/* ── Connection card ────────────────────────────────────────────── */}
      <div className="rounded-lg border p-4 md:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold">Connect to your QVAC server</h4>
            <p className="text-muted-foreground text-xs">
              The browser talks to QVAC <span className="font-medium">directly on this device</span> — nothing passes
              through any cloud server.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="onyxai-active" className="text-xs text-muted-foreground">
              {isActive ? "Active provider" : "Inactive"}
            </Label>
            <Switch
              id="onyxai-active"
              checked={isActive}
              onCheckedChange={(v) => patchProvider({ is_active: v })}
            />
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-[1fr_240px]">
          <div className="space-y-1.5">
            <Label htmlFor="onyxai-url">Server URL</Label>
            <Input
              id="onyxai-url"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder={ONYXAI_DEFAULT_BASE_URL}
              className="font-mono text-xs"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-[11px]">
              Default: <span className="font-mono">{ONYXAI_DEFAULT_BASE_URL}</span> (qvac serve binds 127.0.0.1:11434)
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="onyxai-key">Bearer token (optional)</Label>
            <div className="relative">
              <Input
                id="onyxai-key"
                type={showKey ? "text" : "password"}
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder="Only if started with --api-key"
                className="pr-9 font-mono text-xs"
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowKey((s) => !s)}
                className="text-muted-foreground hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2"
                aria-label={showKey ? "Hide token" : "Show token"}
              >
                {showKey ? "🙈" : "👁"}
              </button>
            </div>
            <p className="text-muted-foreground text-[11px]">Stored encrypted in your local vault.</p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={connectAndTest} disabled={testing} className="gap-2">
            {testing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {testing ? "Testing…" : "Connect & Test"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-muted-foreground"
            onClick={() => setSetupOpen((s) => !s)}
          >
            Setup guide
            <ChevronDown className={`size-3.5 transition-transform ${setupOpen ? "rotate-180" : ""}`} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto gap-1.5 text-muted-foreground"
            onClick={removeProvider}
          >
            <Trash2 className="size-3.5" /> Remove provider
          </Button>
        </div>

        {/* Live served models */}
        {servedModels ? (
          <div className="mt-4 rounded-md border bg-muted/30 p-3">
            <p className="mb-1.5 text-xs font-medium">
              Served by your QVAC server ({servedModels.length})
            </p>
            <div className="flex flex-wrap gap-1.5">
              {servedModels.map((m) => (
                <Badge key={m} variant="outline" className="gap-1 font-mono text-[10px]">
                  {m}
                  {isNonToolCallingAlias(m) ? (
                    <AlertTriangle className="size-3 text-amber-500" aria-label="No reliable tool calling" />
                  ) : null}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* ── Setup guide ────────────────────────────────────────────────── */}
      <Collapsible open={setupOpen} onOpenChange={setSetupOpen}>
        <CollapsibleContent className="space-y-4 rounded-lg border p-4 md:p-5">
          <div>
            <h4 className="text-sm font-semibold">Run QVAC on your device — 3 steps</h4>
            <p className="text-muted-foreground text-xs">
              Works on desktop &amp; mobile-class hardware. Your app origin is pre-trusted for CORS so the browser can
              call the local server.
            </p>
          </div>

          <CodeBlock
            caption="1 · Install the QVAC CLI (Node 18+)"
            code={"npm install -g @qvac/cli"}
          />

          <CodeBlock
            caption={`2 · qvac.config.json — generated from your ${selectedModels.length} selected model${selectedModels.length === 1 ? "" : "s"} (tools + agent-sized context enabled)`}
            code={serveConfigJson}
          />

          <CodeBlock
            caption="3 · Start the server with this app trusted for CORS"
            code={buildServeCommand(origin || "https://your-app-origin")}
          />

          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              Docs:{" "}
              <a
                className="underline underline-offset-2"
                href="https://docs.qvac.tether.io/cli/http-server"
                target="_blank"
                rel="noopener noreferrer"
              >
                qvac serve --openai
              </a>
            </span>
            <span>
              Model registry:{" "}
              <a
                className="underline underline-offset-2"
                href="https://docs.qvac.tether.io/reference/api"
                target="_blank"
                rel="noopener noreferrer"
              >
                @qvac/sdk API
              </a>
            </span>
            <span>
              HF models:{" "}
              <a
                className="underline underline-offset-2"
                href="https://huggingface.co/qvac"
                target="_blank"
                rel="noopener noreferrer"
              >
                huggingface.co/qvac
              </a>
            </span>
          </div>

          <Alert>
            <AlertTriangle className="size-4" />
            <AlertTitle>Local-model limits</AlertTitle>
            <AlertDescription>
              Interactive chat streams directly from your device — but background &amp; scheduled runs execute in the
              E2B cloud sandbox, which cannot reach your localhost. Use OnyxAI for live chats and a cloud provider for
              unattended scheduled tasks. Same-model requests queue (one decode at a time per model).
            </AlertDescription>
          </Alert>
        </CollapsibleContent>
      </Collapsible>

      {/* ── Catalog browser ────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold">Model catalog</h4>
            <p className="text-muted-foreground text-xs">
              Curated from the QVAC registry — grouped by the device QVAC runs on. Latest tool-calling generations
              first. Selected models become the picker entries in chat.
            </p>
          </div>
          <span className="text-muted-foreground text-xs">
            {selectedModels.length} selected
          </span>
        </div>

        <Tabs value={activeTier} onValueChange={(v) => setActiveTier(v as OnyxAiDeviceTier)}>
          <TabsList className="flex w-full flex-wrap justify-start h-auto gap-1 bg-muted/50 p-1">
            {tierGroups.map(({ tier, models }) => (
              <TabsTrigger
                key={tier}
                value={tier}
                className="gap-1.5 data-[state=active]:bg-background text-xs"
              >
                {tier === "mobile" ? <Smartphone className="size-3.5" /> : <Cpu className="size-3.5" />}
                {ONYXAI_TIER_META[tier].label}
                <Badge variant="secondary" className="ml-1 px-1.5 text-[10px]">
                  {models.filter((m) => m.toolCalling === "native").length} tools
                </Badge>
              </TabsTrigger>
            ))}
          </TabsList>

          {tierGroups.map(({ tier, models }) => (
            <TabsContent key={tier} value={tier} className="mt-3 space-y-2">
              <p className="text-muted-foreground text-xs">{ONYXAI_TIER_META[tier].description}</p>
              <div className="grid gap-2 md:grid-cols-2">
                {models.map((model) => {
                  const selected = selectedModels.includes(model.alias);
                  return (
                    <div
                      key={model.alias}
                      className={`rounded-lg border p-3 transition-colors ${
                        selected ? "border-primary/50 bg-primary/5" : "hover:bg-accent/40"
                      } ${model.toolCalling === "none" || model.toolCalling === "template" ? "opacity-90" : ""}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-sm font-medium">{model.label}</span>
                            {model.latest ? (
                              <Badge variant="default" className="px-1.5 text-[9px] uppercase tracking-wide">
                                Latest
                              </Badge>
                            ) : null}
                          </div>
                          <p className="text-muted-foreground mt-0.5 font-mono text-[10px]">
                            {model.params} · {model.quant} · ~{model.sizeGb < 1 ? `${Math.round(model.sizeGb * 1000)}MB` : `${model.sizeGb.toFixed(1)}GB`}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant={selected ? "default" : "outline"}
                          size="sm"
                          className="h-7 shrink-0 gap-1 px-2.5 text-xs"
                          onClick={() => toggleModel(model.alias)}
                          aria-pressed={selected}
                        >
                          {selected ? <Minus className="size-3" /> : <Plus className="size-3" />}
                          {selected ? "Selected" : "Select"}
                        </Button>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <ToolBadge toolCalling={model.toolCalling} />
                        <ReadinessBadge model={model} />
                      </div>
                      {model.note ? (
                        <p className="text-muted-foreground mt-1.5 text-[11px] leading-snug">{model.note}</p>
                      ) : null}
                      {model.toolCalling === "none" || model.toolCalling === "template" ? (
                        <p className="mt-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                          ⚠ Won&apos;t work well as the agent brain — no reliable tool calling.
                        </p>
                      ) : null}
                      <p className="text-muted-foreground/70 mt-1 font-mono text-[10px]">
                        {model.constant}
                      </p>
                    </div>
                  );
                })}
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </div>

      {/* Live catalog extras (future SDK models discovered from the server) */}
      {extraLiveModels.length > 0 ? (
        <div className="space-y-2 rounded-lg border border-dashed p-4">
          <h4 className="text-sm font-semibold">
            Also in your QVAC SDK catalog ({extraLiveModels.length} not listed above)
          </h4>
          <p className="text-muted-foreground text-xs">
            Discovered live from your server&apos;s <span className="font-mono">/v1/models/catalog</span>. Add any to
            the picker by alias — check its tool-calling capability first.
          </p>
          <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
            {extraLiveModels.map((e) => (
              <button
                key={e.id}
                type="button"
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[10px] hover:bg-accent/50"
                onClick={() => toggleModel(e.id)}
                title={`${e.params ?? "?"} · ${e.quantization ?? "?"}${e.configured ? " · configured" : " · not configured"}`}
              >
                + {e.id}
                {isNonToolCallingAlias(e.id) ? <AlertTriangle className="size-3 text-amber-500" /> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* ── Custom Hugging Face models ─────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border p-4 md:p-5">
        <div>
          <h4 className="text-sm font-semibold">Load any Hugging Face model</h4>
          <p className="text-muted-foreground text-xs">
            QVAC loads GGUF files from any HF repo via an explicit <span className="font-mono">src</span> entry —
            verify the model supports tool calling (Qwen / GPT-OSS / GLM / Hermes-style tunes do; base &amp; most
            instruct chat tunes don&apos;t).
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-[1fr_200px_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="onyxai-hf">HF repo or .gguf URL</Label>
            <Input
              id="onyxai-hf"
              value={hfInput}
              onChange={(e) => setHfInput(e.target.value)}
              placeholder="unsloth/Qwen3-14B-GGUF or https://huggingface.co/…/Q4_K_M.gguf"
              className="font-mono text-xs"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="onyxai-alias">Alias</Label>
            <Input
              id="onyxai-alias"
              value={aliasInput}
              onChange={(e) => setAliasInput(e.target.value)}
              placeholder="auto from repo name"
              className="font-mono text-xs"
              spellCheck={false}
            />
          </div>
          <div className="flex items-end">
            <Button onClick={addCustomModel} disabled={addingHf} className="gap-2">
              {addingHf ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Add model
            </Button>
          </div>
        </div>
        {hfInput.trim() && isNonToolCallingAlias(aliasInput.trim() || hfInput.trim().split("/").pop() || "") ? (
          <p className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
            ⚠ This name doesn&apos;t look like a tool-calling model — it may not work well as the OnyxAgent brain.
          </p>
        ) : null}

        {customModels.length > 0 ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {customModels.map((c) => (
                <Badge key={c.alias} variant="outline" className="gap-1.5 font-mono text-[10px]">
                  {c.alias}
                  <ToolBadge toolCalling={toolCallingForAlias(c.alias)} />
                  <button
                    type="button"
                    onClick={() => removeCustomModel(c.alias)}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${c.alias}`}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
            <CodeBlock
              caption="serve.models entries for your custom HF models — merge into qvac.config.json"
              code={JSON.stringify(
                Object.fromEntries(
                  customModels.map((c) => [
                    c.alias,
                    JSON.parse(buildCustomHfServeEntry(c.alias, c.src))[c.alias],
                  ]),
                ),
                null,
                2,
              )}
            />
          </div>
        ) : null}
      </div>

      {/* ── Selected models summary ────────────────────────────────────── */}
      <div className="space-y-2 rounded-lg border bg-muted/20 p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="text-sm font-semibold">Models in your picker</h4>
          <span className="text-muted-foreground text-xs">{selectedModels.length} total</span>
        </div>
        {selectedModels.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            Nothing selected yet — pick models from the catalog above. Recommended:{" "}
            <span className="font-mono">qwen3.5-9b</span> (laptop) or <span className="font-mono">gpt-oss-20b</span>{" "}
            (desktop).
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {selectedModels.map((m) => {
              const cat = catalogByAlias(m);
              const tools = toolCallingForAlias(m);
              return (
                <Badge
                  key={m}
                  variant={tools === "native" ? "secondary" : "outline"}
                  className={`gap-1.5 font-mono text-[10px] ${
                    tools !== "native" ? "border-amber-600/40 text-amber-700 dark:text-amber-400" : ""
                  }`}
                >
                  {m}
                  {cat ? <span className="text-muted-foreground">{cat.params}</span> : null}
                  {tools !== "native" ? <AlertTriangle className="size-3" /> : <Wrench className="size-3" />}
                  <button
                    type="button"
                    onClick={() => toggleModel(m)}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${m}`}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </Badge>
              );
            })}
          </div>
        )}
      </div>

      {/* Non-tool confirmation dialog */}
      <AlertDialog
        open={pendingNonTool !== null}
        onOpenChange={(o) => {
          if (!o) setPendingNonTool(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-500" />
              This model can&apos;t call tools
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono">{pendingNonTool}</span> has no reliable tool calling. OnyxAgent is
              agent-first: this model will describe actions instead of executing them and fabricate results. It works
              for plain chat only. Add it anyway?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmPendingNonTool}>
              Add anyway (chat only)
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
