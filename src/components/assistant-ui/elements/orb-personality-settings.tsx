"use client";

import * as React from "react";
import { Sparkles, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { SectionCard, SettingsRow } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Orb, ORB_TASKS, type OrbVariant } from "./orb";
import { PersonalityOrb, usePrefersReducedMotion } from "./personality-orb";
import {
  ALL_ORB_VARIANTS,
  getActivePersonality,
  ORB_REACTION_STATES,
  PERSONALITY_PRESETS,
  REACTION_STATE_LABELS,
  type OrbIdleMotion,
  type OrbPersonality,
  type OrbPersonalityId,
  type OrbReactionState,
} from "@/lib/orb/personalities";
import { useOrbPersonalityStore } from "@/stores/orb-personality-store";
import { cn } from "@/lib/utils";

/**
 * OrbPersonalitySettings — the Appearance panel for PRD §10 (Feature Two):
 * preset picker with LIVE mini-orb previews, the Custom personality's tuning
 * controls (intensity / idle motion / celebration / chat visibility), and a
 * per-state variant editor with live previews. Everything is wired to the
 * persisted orb-personality store — every control performs its real
 * function immediately.
 *
 * Editing any control while a PRESET is active switches to a Custom
 * personality seeded from that preset (one toast explains the switch), so
 * no control is ever a dead knob.
 */

/** Short choreography notes for the variant dropdowns. */
const VARIANT_NOTES: Record<OrbVariant, string> = {
  S1: "centre-out swell", S2: "diagonal band", S3: "ring run, tailed",
  S4: "soft column sweep", S5: "scrambled pulses",
  G1: "collapse inward", G2: "diagonal, reversed", G3: "column, right→left",
  G4: "rows, bottom→top", G5: "corners→cross",
  C1: "comet, counterclockwise", C2: "fast clockwise comet", C3: "slow long-tail comet",
  C4: "two chasing heads", C5: "fastest patrol",
  B1: "checkerboard blink", B2: "scattered blinks", B3: "column blink, staggered",
  B4: "row blink, staggered", B5: "cross first, corners late",
  M1: "row scan", M2: "column scan", M3: "perimeter patrol",
  M4: "spiral scan", M5: "cross sweep, outward",
};

const FAMILY_NAMES: Record<string, string> = {
  S: "Swell", G: "Gather", C: "Comet", B: "Blink", M: "March",
};

function variantLabel(v: OrbVariant): string {
  // v[0] is the family letter (S/G/C/B/M); the ?? "" guards the noUnchecked
  // indexed-access case so the lookup always gets a string index.
  return `${v} · ${FAMILY_NAMES[v[0] ?? ""] ?? "Lattice"} — ${VARIANT_NOTES[v]}`;
}

function intensityWord(intensity: number): string {
  if (intensity <= 0.25) return "Calm";
  if (intensity <= 0.5) return "Measured";
  if (intensity <= 0.75) return "Lively";
  return "Expressive";
}

const IDLE_MOTIONS: { value: OrbIdleMotion; label: string; hint: string }[] = [
  { value: "none", label: "None", hint: "Resting lattice (also fully static under reduced motion)" },
  { value: "subtle", label: "Subtle", hint: "Quiet idle life" },
  { value: "warm", label: "Warm", hint: "Alive, welcoming idle" },
];

/** A preset/Custom card with two LIVE mini-orbs (idle + tool_running). */
function PersonalityCard({
  personality,
  active,
  onSelect,
}: {
  personality: Pick<OrbPersonality, "id" | "label" | "description" | "stateVariants" | "reactionIntensity">;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "flex min-h-[112px] flex-col gap-2 rounded-xl border-2 p-3 text-left transition-all hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-primary ring-2 ring-primary/20" : "border-border",
      )}
    >
      <div className="flex items-center gap-3">
        {/* LIVE previews of the actual variants: idle + working. */}
        <Orb variant={personality.stateVariants.idle} size={20} />
        <Orb variant={personality.stateVariants.tool_running} size={20} />
        <span className="ml-auto text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {intensityWord(personality.reactionIntensity)}
        </span>
      </div>
      <div>
        <p className="text-sm font-semibold leading-tight">{personality.label}</p>
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          {personality.description}
        </p>
      </div>
    </button>
  );
}

/** One per-state editor row: live orb preview + variant dropdown. */
function StateVariantRow({
  state,
  variant,
  onChange,
}: {
  state: OrbReactionState;
  variant: OrbVariant;
  onChange: (v: OrbVariant) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Orb variant={variant} size={18} className="shrink-0" />
      <Label
        htmlFor={`orb-state-${state}`}
        className="w-28 shrink-0 text-xs font-medium text-muted-foreground"
      >
        {REACTION_STATE_LABELS[state]}
      </Label>
      <Select
        value={variant}
        onValueChange={(v) => onChange(v as OrbVariant)}
      >
        <SelectTrigger
          id={`orb-state-${state}`}
          className="h-8 min-w-0 flex-1"
          aria-label={`${REACTION_STATE_LABELS[state]} variant`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          {ALL_ORB_VARIANTS.map((v) => (
            <SelectItem key={v} value={v} className="py-1.5 text-xs">
              {variantLabel(v)}
              <span className="ml-1 text-muted-foreground/70">({ORB_TASKS[v]})</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function OrbPersonalitySettings() {
  const personalityId = useOrbPersonalityStore((s) => s.personalityId);
  const custom = useOrbPersonalityStore((s) => s.custom);
  const setPersonality = useOrbPersonalityStore((s) => s.setPersonality);
  const patchCustom = useOrbPersonalityStore((s) => s.patchCustom);
  const resetCustom = useOrbPersonalityStore((s) => s.resetCustom);

  const active = getActivePersonality(personalityId, custom);
  const isCustom = personalityId === "custom";
  const reducedMotion = usePrefersReducedMotion();

  // Which state the live preview orb renders.
  const [previewState, setPreviewState] =
    React.useState<OrbReactionState>("thinking");

  /**
   * Editing while a preset is active → switch to Custom FIRST (the store
   * seeds the copy from the current preset), then apply the patch. The
   * controls therefore always work, wherever you start.
   */
  const editCustom = React.useCallback(
    (patch: Parameters<typeof patchCustom>[0], label: string) => {
      if (!isCustom) {
        setPersonality("custom");
        toast.success(`Custom personality created from ${active.label}`, {
          description: `${label} — adjust anything else freely.`,
        });
      }
      patchCustom(patch);
    },
    [isCustom, setPersonality, patchCustom, active.label],
  );

  return (
    <SectionCard
      title="Orb personality"
      description="How the status orb reacts to what the agent is doing — pick a preset or craft your own. The orb always complements (never replaces) the text status."
    >
      <div className="space-y-5">
        {/* ── Live preview ─────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-muted/30 p-4">
          <PersonalityOrb state={previewState} surface="preview" size={34} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Live preview</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {active.label} · {REACTION_STATE_LABELS[previewState]} ·{" "}
              {active.stateVariants[previewState]} · {intensityWord(active.reactionIntensity)} speed
            </p>
          </div>
          <div className="w-44">
            <Select
              value={previewState}
              onValueChange={(v) => setPreviewState(v as OrbReactionState)}
            >
              <SelectTrigger className="h-8 w-full" aria-label="Preview state">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ORB_REACTION_STATES.map((s) => (
                  <SelectItem key={s} value={s} className="py-1.5 text-xs">
                    {REACTION_STATE_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* ── Presets ───────────────────────────────────────────────── */}
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Presets
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {(Object.keys(PERSONALITY_PRESETS) as Exclude<OrbPersonalityId, "custom">[]).map(
              (id) => (
                <PersonalityCard
                  key={id}
                  personality={PERSONALITY_PRESETS[id]}
                  active={personalityId === id}
                  onSelect={() => setPersonality(id)}
                />
              ),
            )}
            <PersonalityCard
              personality={custom}
              active={isCustom}
              onSelect={() => setPersonality("custom")}
            />
          </div>
        </div>

        {/* ── Tuning ────────────────────────────────────────────────── */}
        <div className="space-y-1">
          <SettingsRow
            label="Reaction intensity"
            description={`How strongly the orb reacts — speed and one-shot reactions. Currently ${intensityWord(active.reactionIntensity)} (${Math.round(active.reactionIntensity * 100)}%).`}
            control={
              <div className="flex w-full items-center gap-3 sm:w-56">
                <Slider
                  value={[active.reactionIntensity]}
                  min={0}
                  max={1}
                  step={0.05}
                  onValueChange={([v]) =>
                    editCustom({ reactionIntensity: v }, "Intensity adjusted")
                  }
                  aria-label="Reaction intensity"
                />
                <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {Math.round(active.reactionIntensity * 100)}%
                </span>
              </div>
            }
          />

          <SettingsRow
            label="Idle motion"
            description="How lively the orb sits between turns."
            control={
              <Select
                value={active.idleMotion}
                onValueChange={(v) =>
                  editCustom({ idleMotion: v as OrbIdleMotion }, "Idle motion set")
                }
              >
                <SelectTrigger className="h-8 w-40" aria-label="Idle motion">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {IDLE_MOTIONS.map((m) => (
                    <SelectItem key={m.value} value={m.value} className="py-1.5 text-xs">
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />

          <SettingsRow
            label="Success celebration"
            description="A brief celebratory bloom when a run completes successfully (≤0.9s). Error reactions stay subtle for every personality."
            control={
              <div className="flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                <Switch
                  checked={active.celebrationEnabled}
                  onCheckedChange={(c) =>
                    editCustom({ celebrationEnabled: c }, "Celebration toggled")
                  }
                  aria-label="Success celebration"
                />
              </div>
            }
          />

          <SettingsRow
            label="Show orb in chat"
            description="When off, the chat status lines keep their pulsing dot and text — the orb personality still applies everywhere else (e.g. this panel)."
            control={
              <Switch
                checked={active.showInChat}
                onCheckedChange={(c) =>
                  editCustom({ showInChat: c }, "Chat visibility toggled")
                }
                aria-label="Show orb in chat"
              />
            }
          />
        </div>

        {/* ── Reduced-motion note ───────────────────────────────────── */}
        <p className="rounded-lg border border-dashed px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          {reducedMotion
            ? "Reduced motion is ON for this device: the orb renders a static lattice, keeping only a slow, subtle pulse while the agent works. One-shot celebrations and shakes are skipped entirely."
            : "Reduced motion is currently OFF. Whenever your system requests reduced motion, the orb automatically renders a static lattice — keeping only one slow, subtle pulse while the agent works — and skips all one-shot celebrations and shakes."}
        </p>

        {/* ── Per-state variant editor ──────────────────────────────── */}
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Variants per reaction state {isCustom ? "(Custom)" : "(edits create Custom)"}
            </p>
            {isCustom && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  resetCustom();
                  toast.success("Custom personality reset to defaults");
                }}
                className="h-7 gap-1.5 px-2 text-xs"
              >
                <RotateCcw className="h-3 w-3" aria-hidden />
                Reset custom
              </Button>
            )}
          </div>
          <div className="space-y-2 rounded-lg border p-3">
            {ORB_REACTION_STATES.map((state) => (
              <StateVariantRow
                key={state}
                state={state}
                variant={active.stateVariants[state]}
                onChange={(v) => {
                  if (v === active.stateVariants[state]) return;
                  editCustom(
                    { stateVariants: { ...active.stateVariants, [state]: v } },
                    `${REACTION_STATE_LABELS[state]} variant set to ${v}`,
                  );
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </SectionCard>
  );
}
