"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, Cpu, Search, Settings2, Sliders } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button, Input, Popover, PopoverContent, PopoverTrigger } from "@/components/ui";
import { useConversationStore, useChatStore } from "@/stores";
import { useToolDisplayStore, type ToolDisplayMode } from "@/stores/tool-display-store";
import { useBackgroundRunStore } from "@/stores/background-run-store";
import { cn } from "@/lib/utils";

type ThinkingEffort = "off" | "low" | "medium" | "high";
type Tab = "model" | "settings";

interface CustomProvider {
  id: string;
  name: string;
  base_url: string;
  has_api_key: boolean;
  models: string[];
  is_active?: boolean;
}

interface ChatControlsProps {
  onModelChange?: (model: string | null) => void;
  onTemperatureChange?: (value: number | null) => void;
  onThinkingEffortChange?: (value: "low" | "medium" | "high" | null) => void;
  // When the user picks a model from a custom provider, we pass the provider too
  // so the chat layer can route the request to the right base_url with the right key.
  onProviderSelect?: (provider: CustomProvider | null) => void;
}

/** localStorage persistence for the model preference (PRD §14): saved on
 *  every pick, restored + validated against the live provider list on mount. */
const MODEL_PREF_KEY = "onyx:selected-model";

function saveModelPref(providerId: string | null, model: string | null): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MODEL_PREF_KEY, JSON.stringify({ providerId, model }));
  } catch {
    // Storage unavailable (private mode / quota) — non-fatal, session-only selection.
  }
}

function loadModelPref(): { providerId: string | null; model: string | null } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(MODEL_PREF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { providerId?: string | null; model?: string | null };
    return { providerId: parsed.providerId ?? null, model: parsed.model ?? null };
  } catch {
    return null;
  }
}

const EFFORT_OPTIONS: { label: string; value: ThinkingEffort; hint: string }[] = [
  { label: "Off", value: "off", hint: "Direct answer, no reasoning" },
  { label: "Low", value: "low", hint: "Quick reasoning" },
  { label: "Medium", value: "medium", hint: "Balanced" },
  { label: "High", value: "high", hint: "Deep, slower" },
];

/**
 * Unified popover panel that replaces the 3 separate triggers (KB / Model /
 * Chat settings) with a single button that summarizes current state and opens
 * a tabbed control surface.
 */
export function ChatControls({
  onModelChange,
  onTemperatureChange,
  onThinkingEffortChange,
  onProviderSelect,
}: ChatControlsProps) {
  const [tab, setTab] = useState<Tab>("model");
  const { currentConversationId } = useConversationStore();

  // ── SINGLE SOURCE OF TRUTH (model-desync PRD §10) ──
  // The selection state lives in the chat store — the SAME state the send /
  // regenerate paths read via buildTurnOptions. The old local useState pair
  // here desynced from the runtime refs: after a conversation switch reset
  // the runtime model, the popover still displayed the user's pick while
  // requests silently used the provider default ("UI shows Model B, requests
  // use Model A"). Subscribing to the store makes the selector a pure view
  // of the authoritative state.
  const selectedModel = useChatStore((s) => s.selectedModel);
  const selectedProviderId = useChatStore((s) => s.selectedProviderId);

  const [availableModels] = useState<{ value: string; label: string }[]>([
    { value: "", label: "Default" },
  ]);
  const [providers, setProviders] = useState<CustomProvider[]>([]);

  useEffect(() => {
    // Load AI providers from IndexedDB (backendless — no API route).
    // Each provider has a list of models; we show them all grouped by provider.
    (async () => {
      try {
        const { aiProviderService } = await import("@/lib/services");
        const { useAuthStore } = await import("@/stores");
        const { db } = await import("@/lib/db");
        const userId = useAuthStore.getState().user?.id;
        let userProviders = userId ? await aiProviderService.list(userId) : [];

        // If no providers found for this user ID (e.g. after non-auth migration
        // where the user ID changed), try loading ALL providers from the DB.
        if (userProviders.length === 0) {
          userProviders = await db.ai_providers.toArray();
        }

        // Map to the CustomProvider shape the component expects
        const customProviders: CustomProvider[] = userProviders.map((p) => ({
          id: p.id,
          name: p.name,
          base_url: p.base_url,
          has_api_key: !!p.api_key_encrypted,
          models: p.models || [],
          is_active: p.is_active,
        }));
        setProviders(customProviders);

        // ── SELECTION RESOLUTION (PRD §12–§14) ────────────────────────────
        // Initialize ONLY when there is no valid selection — never overwrite
        // one. Order: live store (session) → persisted preference → default.
        // A fresh page load starts the store at null/null, which is
        // indistinguishable from an explicit "Default" pick — so the
        // persisted localStorage preference (saved on every pick) decides.
        const store = useChatStore.getState();
        /** "default" = explicit no-selection; "valid" = usable; null = gone.
         *  Validation is provider-existence only: a model id NOT in the
         *  provider's list is still valid — the "Custom model ID" input
         *  intentionally sends arbitrary ids to the provider, and the
         *  runtime surfaces a provider error if the id is genuinely dead. */
        const validate = (
          providerId: string | null | undefined,
          model: string | null | undefined,
        ): "default" | "valid" | null => {
          if (providerId == null && (model == null || model === "")) return "default";
          const p = customProviders.find((x) => x.id === providerId);
          if (!p) return null; // provider disappeared → selection unusable
          return "valid";
        };

        let nextProviderId: string | null = store.selectedProviderId;
        let nextModel: string | null = store.selectedModel;
        const storeStatus = validate(nextProviderId, nextModel);

        if (storeStatus !== "valid") {
          const persisted = loadModelPref();
          if (persisted && validate(persisted.providerId, persisted.model) !== null) {
            // Restored preference — covers an explicit "Default" pick too
            // ({null, null} validates as "default", not null).
            nextProviderId = persisted.providerId;
            nextModel = persisted.model;
          } else if (persisted === null) {
            // No preference was EVER saved → first-visit initialization: the
            // active provider's first model. This is the ONLY path that
            // picks a model on the user's behalf (PRD §12: initialization
            // happens only when the active model is genuinely undefined).
            const activeProvider =
              customProviders.find((p) => p.is_active) || customProviders[0];
            if (activeProvider && activeProvider.models.length > 0) {
              nextProviderId = activeProvider.id;
              nextModel = activeProvider.models[0]!;
            } else {
              nextProviderId = null;
              nextModel = null;
            }
          }
          // else: a persisted preference EXISTS but is invalid (provider or
          // model removed since it was saved) → fall back to the "Default"
          // no-selection; buildTurnOptions's provider-default fallback keeps
          // requests working, and the UI honestly shows "Default".
        }

        // Apply ONLY when it differs from what the store already holds — a
        // valid existing selection is never touched, and the runtime refs
        // (modelRef/providerIdRef) are synced by the same setters.
        if (nextProviderId !== store.selectedProviderId || nextModel !== store.selectedModel) {
          const provider = nextProviderId
            ? customProviders.find((x) => x.id === nextProviderId) ?? null
            : null;
          onProviderSelect?.(provider);
          onModelChange?.(nextModel);
          saveModelPref(nextProviderId, nextModel);
        }
      } catch {
        // Vault locked or DB unavailable — model list stays empty
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [temperature, setTemperature] = useState<number | null>(null);
  const [effort, setEffort] = useState<ThinkingEffort>("off");
  const settingsOverridden = temperature !== null || effort !== "off";

  const triggerSummary = useMemo(() => {
    const parts: string[] = [];
    if (selectedModel) parts.push(selectedModel);
    if (settingsOverridden) parts.push("Custom");
    return parts.length ? parts.join(" · ") : "Controls";
  }, [selectedModel, settingsOverridden]);

  const hasOverrides = (selectedModel != null && selectedModel !== "") || settingsOverridden;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Chat controls"
          className={cn(
            "border-foreground/10 bg-card hover:border-foreground/25 hover:bg-foreground/[0.04] inline-flex items-center gap-1.5 rounded-full border py-1 pr-2 pl-2.5 font-mono text-[11px] tracking-wider uppercase transition-colors",
            hasOverrides ? "text-foreground" : "text-foreground/65",
          )}
        >
          <Sliders className="h-3 w-3" />
          <span className="max-w-[200px] truncate">{triggerSummary}</span>
          {hasOverrides && (
            <span aria-hidden className="bg-foreground inline-block h-1 w-1 rounded-full" />
          )}
          <ChevronDown className="text-foreground/45 h-3 w-3" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="border-border bg-popover relative w-[380px] overflow-hidden rounded-2xl border p-0 shadow-md"
      >
        <div className="border-foreground/10 flex items-center gap-1 border-b p-2">
          {onModelChange && (
            <TabButton
              icon={Cpu}
              label="Model"
              active={tab === "model"}
              onClick={() => setTab("model")}
            />
          )}
          {onTemperatureChange && onThinkingEffortChange && (
            <TabButton
              icon={Settings2}
              label="Settings"
              active={tab === "settings"}
              onClick={() => setTab("settings")}
            />
          )}
        </div>

        <div className="max-h-[420px] scrollbar-thin overflow-y-auto p-4">
          {tab === "model" && (
            <ModelPanel
              models={availableModels}
              providers={providers}
              selectedModel={selectedModel}
              selectedProviderId={selectedProviderId}
              onPickDefault={(m) => {
                // Write through the authoritative setters (they update the
                // store AND the runtime refs) + persist the pick.
                onProviderSelect?.(null);
                onModelChange?.(m.value || null);
                saveModelPref(null, m.value || null);
              }}
              onPickProviderModel={(p, modelId) => {
                onProviderSelect?.(p);
                onModelChange?.(modelId);
                saveModelPref(p.id, modelId);
              }}
            />
          )}
          {tab === "settings" && (
            <SettingsPanel
              temperature={temperature}
              effort={effort}
              onTemperatureChange={(v) => {
                setTemperature(v);
                onTemperatureChange?.(v);
              }}
              onEffortChange={(v) => {
                setEffort(v);
                onThinkingEffortChange?.(v === "off" ? null : v);
              }}
            />
          )}
        </div>

        <div className="border-foreground/10 text-foreground/45 flex items-center justify-between border-t px-4 py-2 font-mono text-[10px] tracking-wider uppercase">
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="bg-foreground inline-block h-1 w-1 animate-pulse rounded-full"
            />
            {currentConversationId ? "Saved for this chat" : "Saves on send"}
          </span>
          <span>esc to close</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TabButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 font-mono text-[11px] tracking-wider uppercase transition-colors",
        active
          ? "bg-foreground text-background"
          : "text-foreground/55 hover:bg-foreground/[0.04] hover:text-foreground",
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  );
}

/** Model picker panel. `selectedModel` + `selectedProviderId` come from the
 *  authoritative chat store — this panel is a pure view of that state. */
function ModelPanel({
  models,
  providers,
  selectedModel,
  selectedProviderId,
  onPickDefault,
  onPickProviderModel,
}: {
  models: { value: string; label: string }[];
  providers: CustomProvider[];
  selectedModel: string | null;
  selectedProviderId: string | null;
  onPickDefault: (m: { value: string; label: string }) => void;
  onPickProviderModel: (p: CustomProvider, modelId: string) => void;
}) {
  const [customModelId, setCustomModelId] = useState("");
  const [customProviderId, setCustomProviderId] = useState("");
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();

  // Filter built-in models by name (case-insensitive substring).
  const filteredModels = useMemo(
    () => (q ? models.filter((m) => m.label.toLowerCase().includes(q)) : models),
    [models, q],
  );

  // Filter providers + their models by search query. A provider is shown if
  // either its name matches or any of its model IDs match.
  const filteredProviders = useMemo(() => {
    if (!q) return providers;
    return providers
      .map((p) => {
        const nameMatches = p.name.toLowerCase().includes(q);
        const matchingModels = p.models.filter((m) => m.toLowerCase().includes(q));
        if (nameMatches) return p; // show all models if the provider name matches
        if (matchingModels.length > 0) return { ...p, models: matchingModels };
        return null;
      })
      .filter((p): p is CustomProvider => p !== null);
  }, [providers, q]);

  const hasAnyModels = models.length > 0 || providers.some((p) => p.models.length > 0);
  const noResults =
    q.length > 0 && filteredModels.length === 0 && filteredProviders.length === 0;

  return (
    <div>
      <p className="text-foreground mb-1 text-sm font-semibold">Model</p>
      <p className="text-foreground/55 mb-3 text-xs leading-relaxed">
        Pick the model that handles this conversation. Add more in Settings → Config.
      </p>

      {/* Model name search */}
      {hasAnyModels && (
        <div className="relative mb-3">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search models..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-8 text-xs"
            autoFocus
          />
        </div>
      )}

      {/* Default / built-in models */}
      {filteredModels.length > 0 && (
        <ul className="space-y-1 mb-4">
          {filteredModels.map((m) => {
            // "Default" is active only when there is NO provider/model
            // selection (the store's null/null state).
            const isActive =
              selectedProviderId == null &&
              (selectedModel == null || selectedModel === "") &&
              m.value === "";
            return (
              <li key={m.value || "default"}>
                <button
                  type="button"
                  onClick={() => onPickDefault(m)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-left text-xs transition-all",
                    isActive
                      ? "border-foreground/30 bg-accent text-foreground"
                      : "border-border text-foreground/75 hover:border-foreground/25 hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <span className="truncate font-medium">{m.label}</span>
                  {isActive && <Check className="text-foreground h-3.5 w-3.5 shrink-0" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* User-configured custom providers */}
      {filteredProviders.length > 0 && (
        <div className="space-y-3">
          <p className="text-foreground/55 font-mono text-[10px] tracking-wider uppercase">
            Your providers
          </p>
          {filteredProviders.map((p) => (
            <div key={p.id} className="space-y-1">
              <div className="flex items-center gap-1.5 px-1">
                <span className="text-foreground text-xs font-semibold truncate">{p.name}</span>
                {!p.has_api_key && (
                  <span className="text-amber-500 text-[10px]">no key</span>
                )}
                <span className="text-foreground/40 text-[10px] truncate ml-auto">{p.base_url}</span>
              </div>
              {p.models.length === 0 ? (
                <p className="px-3 text-[11px] text-foreground/45 italic">No models — add some in Config.</p>
              ) : (
                <ul className="space-y-1">
                  {p.models.map((modelId) => {
                    const isActive =
                      selectedProviderId === p.id && selectedModel === modelId;
                    return (
                      <li key={`${p.id}::${modelId}`}>
                        <button
                          type="button"
                          onClick={() => onPickProviderModel(p, modelId)}
                          className={cn(
                            "flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-left text-xs transition-all",
                            isActive
                              ? "border-foreground/30 bg-accent text-foreground"
                              : "border-border text-foreground/75 hover:border-foreground/25 hover:bg-accent/60 hover:text-foreground",
                          )}
                        >
                          <span className="truncate font-mono">{modelId}</span>
                          {isActive && <Check className="text-foreground h-3.5 w-3.5 shrink-0" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {noResults && (
        <p className="text-foreground/55 py-4 text-center text-xs">
          No models match &ldquo;{search}&rdquo;.
        </p>
      )}

      {models.length === 0 && providers.length === 0 && (
        <p className="text-foreground/55 text-xs">
          No models available. Add an AI provider in{" "}
          <Link href="/settings/config" className="underline">Settings → Config</Link>.
        </p>
      )}

      {/* Custom model ID input — type any model ID and pick a provider.
       * Hidden while searching to keep the panel focused on results. */}
      {providers.length > 0 && !q && (
        <div className="mt-4 pt-4 border-t border-border">
          <p className="text-foreground/55 font-mono text-[10px] tracking-wider uppercase mb-2">
            Custom model ID
          </p>
          <p className="text-foreground/55 mb-2 text-[11px]">
            Type any model ID and select a provider to use it.
          </p>
          <div className="flex gap-1.5">
            <Input
              placeholder="e.g., gpt-4o, claude-3-opus, srv_…"
              value={customModelId}
              onChange={(e) => setCustomModelId(e.target.value)}
              className="h-8 text-xs flex-1"
            />
            <select
              value={customProviderId}
              onChange={(e) => setCustomProviderId(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            >
              <option value="">Provider…</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2 text-xs"
              disabled={!customModelId.trim() || !customProviderId}
              onClick={() => {
                const p = providers.find((x) => x.id === customProviderId);
                if (p && customModelId.trim()) {
                  onPickProviderModel(p, customModelId.trim());
                }
              }}
            >
              Use
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Chat settings panel — temperature + thinking effort + tool display. */
function SettingsPanel({
  temperature,
  effort,
  onTemperatureChange,
  onEffortChange,
}: {
  temperature: number | null;
  effort: ThinkingEffort;
  onTemperatureChange: (v: number | null) => void;
  onEffortChange: (v: ThinkingEffort) => void;
}) {
  return (
    <div className="space-y-6">
      <ToolDisplayToggle />

      <BackgroundRunToggle />

      <div className="space-y-2.5">
        <div className="flex items-baseline justify-between">
          <label htmlFor="chat-temp" className="text-foreground text-sm font-semibold">
            Temperature
          </label>
          <span className="text-foreground font-mono text-xs tabular-nums">
            {temperature === null ? (
              <span className="text-foreground/55">default</span>
            ) : (
              temperature.toFixed(2)
            )}
          </span>
        </div>
        <input
          id="chat-temp"
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={temperature ?? 0.7}
          onChange={(e) => onTemperatureChange(parseFloat(e.target.value))}
          className="bg-foreground/15 h-1.5 w-full cursor-pointer appearance-none rounded-full accent-[var(--color-brand)]"
        />
        <div className="text-foreground/45 flex justify-between font-mono text-[10px] tracking-wider uppercase">
          <span>focused</span>
          <span>creative</span>
        </div>
        {temperature !== null && (
          <button
            type="button"
            onClick={() => onTemperatureChange(null)}
            className="text-foreground/55 hover:text-foreground text-[11px] underline-offset-2 hover:underline"
          >
            Reset to server default
          </button>
        )}
      </div>

      <div className="space-y-2.5">
        <div className="flex items-baseline justify-between">
          <span className="text-foreground text-sm font-semibold">Thinking effort</span>
          <span className="text-foreground/45 text-[10px]">model-dependent</span>
        </div>
        <div className="grid grid-cols-4 gap-1">
          {EFFORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onEffortChange(opt.value)}
              className={cn(
                "rounded-lg px-2 py-1.5 font-mono text-[11px] tracking-wider uppercase transition-colors",
                effort === opt.value
                  ? "bg-foreground text-background"
                  : "border-foreground/15 text-foreground/55 hover:text-foreground border",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-foreground/55 text-[11px]">
          {EFFORT_OPTIONS.find((o) => o.value === effort)?.hint}
        </p>
      </div>

      <p className="text-foreground/45 text-[10px] leading-relaxed">
        Settings persist for the current chat session. Some controls are no-ops on models that
        don&apos;t support them.
      </p>
    </div>
  );
}

const TOOL_DISPLAY_OPTIONS: {
  value: ToolDisplayMode;
  label: string;
  hint: string;
}[] = [
  {
    value: "simple",
    label: "Simple",
    hint: "Plain language — no code, no tool names, no raw output",
  },
  {
    value: "technical",
    label: "Technical",
    hint: "Full detail — tool names, code, diffs, and raw output",
  },
];

/** Background runs — when enabled (and an E2B key is configured), agent
 *  turns execute INSIDE the E2B sandbox as background commands: the work
 *  continues after the browser is closed, stopped, or minimized, and the
 *  chat catches up (replays the progress) when the user returns. Persisted
 *  per browser. */
function BackgroundRunToggle() {
  const enabled = useBackgroundRunStore((s) => s.enabled);
  const setEnabled = useBackgroundRunStore((s) => s.setEnabled);
  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-foreground text-sm font-semibold">Continue in background</span>
        <span className="text-foreground/45 text-[10px]">E2B sandbox</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => setEnabled(!enabled)}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg border p-2.5 text-left transition-colors",
          enabled
            ? "border-primary/40 bg-primary/[0.06]"
            : "border-foreground/12 hover:border-foreground/25",
        )}
      >
        <span
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
            enabled ? "bg-primary" : "bg-foreground/20",
          )}
        >
          <span
            className={cn(
              "absolute h-4 w-4 rounded-full bg-background shadow transition-transform",
              enabled ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </span>
        <span className="min-w-0">
          <span className="text-foreground/80 block text-[12px] leading-tight">
            Keep working when I close the browser
          </span>
          <span className="text-foreground/50 block text-[11px] leading-tight">
            Turns run inside the E2B sandbox and catch up when you return. Requires an E2B API key — falls back to in-browser turns otherwise.
          </span>
        </span>
      </button>
    </div>
  );
}

/** Tool activity display — how the agent's tool work is shown. "Simple"
 *  retells every tool call as a plain sentence (for people who don't read
 *  code); "Technical" shows the full cards. Persisted per browser. */
function ToolDisplayToggle() {
  const mode = useToolDisplayStore((s) => s.mode);
  const setMode = useToolDisplayStore((s) => s.setMode);
  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-foreground text-sm font-semibold">Tool activity</span>
        <span className="text-foreground/45 text-[10px]">applies everywhere</span>
      </div>
      <div className="grid grid-cols-2 gap-1">
        {TOOL_DISPLAY_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={mode === opt.value}
            onClick={() => setMode(opt.value)}
            className={cn(
              "rounded-lg px-2 py-1.5 font-mono text-[11px] tracking-wider uppercase transition-colors",
              mode === opt.value
                ? "bg-foreground text-background"
                : "border border-foreground/15 text-foreground/55 hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <p className="text-foreground/55 text-[11px]">
        {TOOL_DISPLAY_OPTIONS.find((o) => o.value === mode)?.hint}
      </p>
    </div>
  );
}
