"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useCompanionStore, COMPANION_SIZES } from "@/stores/companion-store";

/**
 * CompanionSettings (Realtime PRD §31–§37) — the dots-swarm companion's
 * customization card, shared by BOTH appearance surfaces (the /settings hub
 * section and the standalone /settings/appearance page): master switch,
 * face style (solid vs particles), size, and color (follows the live brand
 * color by default).
 */

function CompanionToggle() {
  const enabled = useCompanionStore((s) => s.enabled);
  const setEnabled = useCompanionStore((s) => s.setEnabled);
  return (
    <Switch
      checked={enabled}
      onCheckedChange={setEnabled}
      aria-label="Show the AI companion"
      className="shrink-0"
    />
  );
}

/** Companion color presets — hex values that read on both canvases. null =
 *  follow the live brand color (default). No blue/indigo, per design rules. */
const COMPANION_COLORS: Array<{ id: string; label: string; value: string | null }> = [
  { id: "brand", label: "Brand", value: null },
  { id: "emerald", label: "Emerald", value: "#10b981" },
  { id: "amber", label: "Amber", value: "#f59e0b" },
  { id: "rose", label: "Rose", value: "#f43f5e" },
  { id: "graphite", label: "Graphite", value: "#9aa3ad" },
];

function CompanionCustomization() {
  const enabled = useCompanionStore((s) => s.enabled);
  const appearance = useCompanionStore((s) => s.appearance);
  const size = useCompanionStore((s) => s.size);
  const color = useCompanionStore((s) => s.color);
  const setAppearance = useCompanionStore((s) => s.setAppearance);
  const setSize = useCompanionStore((s) => s.setSize);
  const setColor = useCompanionStore((s) => s.setColor);

  if (!enabled) return null;

  const pickBtn = (active: boolean) =>
    cn(
      "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
      active
        ? "border-foreground/30 bg-accent text-accent-foreground"
        : "border-border hover:bg-accent/50",
    );

  return (
    <div className="space-y-4 rounded-lg border border-border bg-foreground/[0.02] p-4">
      {/* Face style */}
      <div className="space-y-1.5">
        <Label>Face style</Label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setAppearance("solid")}
            aria-pressed={appearance === "solid"}
            className={pickBtn(appearance === "solid")}
          >
            Solid face
          </button>
          <button
            type="button"
            onClick={() => setAppearance("dots")}
            aria-pressed={appearance === "dots"}
            className={pickBtn(appearance === "dots")}
          >
            Particle dots
          </button>
        </div>
      </div>

      {/* Size */}
      <div className="space-y-1.5">
        <Label>Size</Label>
        <div className="flex flex-wrap gap-2">
          {COMPANION_SIZES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSize(s.px)}
              aria-pressed={size === s.px}
              className={pickBtn(size === s.px)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Color */}
      <div className="space-y-1.5">
        <Label>Color</Label>
        <div className="flex flex-wrap gap-2">
          {COMPANION_COLORS.map((c) => {
            const active = (color ?? null) === c.value;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setColor(c.value)}
                aria-label={c.label}
                aria-pressed={active}
                className={cn(
                  "relative flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                  active
                    ? "border-foreground/30 bg-accent text-accent-foreground"
                    : "border-border hover:bg-accent/50",
                )}
              >
                <span
                  className="size-3.5 rounded-full border border-black/10 dark:border-white/20"
                  style={
                    c.value
                      ? { background: c.value }
                      : {
                          background:
                            "linear-gradient(135deg, var(--color-primary), var(--color-brand-muted, var(--color-primary)))",
                        }
                  }
                />
                {c.label}
                {active && <Check className="size-3.5" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function CompanionSettings() {
  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold">AI companion</h3>
          <p className="text-muted-foreground text-xs">
            The dot companion that lives beside the chat — it reacts to what the
            agent is doing and dozes off when idle. Click it in the chat to
            scatter the dots.
          </p>
        </div>
        <CompanionToggle />
      </div>
      <CompanionCustomization />
    </section>
  );
}
