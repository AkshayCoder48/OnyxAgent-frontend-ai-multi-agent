"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type ThemeChoice = "light" | "dark" | "system";
type FontSize = "sm" | "base" | "lg";

interface BrandPreset {
  id: string;
  label: string;
  // CSS color value for --primary (oklch string)
  primary: string;
  // CSS color value for --primary-foreground
  primaryForeground: string;
  // visible swatch color (uses primary)
  swatch: string;
}

// Carefully chosen to avoid indigo/blue (hue 200–280 excluded).
const BRAND_PRESETS: BrandPreset[] = [
  {
    id: "neutral",
    label: "Neutral",
    primary: "oklch(0.205 0 0)",
    primaryForeground: "oklch(0.985 0 0)",
    swatch: "oklch(0.4 0 0)",
  },
  {
    id: "emerald",
    label: "Emerald",
    primary: "oklch(0.62 0.17 162)",
    primaryForeground: "oklch(0.985 0 0)",
    swatch: "oklch(0.62 0.17 162)",
  },
  {
    id: "amber",
    label: "Amber",
    primary: "oklch(0.7 0.16 70)",
    primaryForeground: "oklch(0.145 0 0)",
    swatch: "oklch(0.7 0.16 70)",
  },
  {
    id: "orange",
    label: "Orange",
    primary: "oklch(0.66 0.2 50)",
    primaryForeground: "oklch(0.985 0 0)",
    swatch: "oklch(0.66 0.2 50)",
  },
  {
    id: "rose",
    label: "Rose",
    primary: "oklch(0.62 0.24 16)",
    primaryForeground: "oklch(0.985 0 0)",
    swatch: "oklch(0.62 0.24 16)",
  },
  {
    id: "fuchsia",
    label: "Fuchsia",
    primary: "oklch(0.62 0.27 312)",
    primaryForeground: "oklch(0.985 0 0)",
    swatch: "oklch(0.62 0.27 312)",
  },
];

const FONT_SIZE_MAP: Record<FontSize, string> = {
  sm: "14px",
  base: "16px",
  lg: "18px",
};

const BRAND_KEY = "settings.brand";
const FONT_KEY = "settings.font-size";

function applyBrand(preset: BrandPreset) {
  const root = document.documentElement;
  if (preset.id === "neutral") {
    // Restore theme defaults by removing inline overrides.
    root.style.removeProperty("--primary");
    root.style.removeProperty("--primary-foreground");
    root.style.removeProperty("--sidebar-primary");
    root.style.removeProperty("--sidebar-primary-foreground");
    return;
  }
  root.style.setProperty("--primary", preset.primary);
  root.style.setProperty("--primary-foreground", preset.primaryForeground);
  // Also propagate to sidebar primary so the sidebar follows brand.
  root.style.setProperty("--sidebar-primary", preset.primary);
  root.style.setProperty("--sidebar-primary-foreground", preset.primaryForeground);
}

function applyFont(size: FontSize) {
  document.documentElement.style.fontSize = FONT_SIZE_MAP[size];
}

export function SectionAppearance() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  const [brand, setBrand] = React.useState<string>("neutral");
  const [fontSize, setFontSize] = React.useState<FontSize>("base");

  React.useEffect(() => {
    setMounted(true);
    const savedBrand = localStorage.getItem(BRAND_KEY) ?? "neutral";
    const savedFont = (localStorage.getItem(FONT_KEY) as FontSize | null) ?? "base";
    setBrand(savedBrand);
    setFontSize(savedFont);
    const preset = BRAND_PRESETS.find((p) => p.id === savedBrand) ?? BRAND_PRESETS[0]!;
    applyBrand(preset);
    applyFont(savedFont);
  }, []);

  function handleTheme(value: string) {
    setTheme(value as ThemeChoice);
    toast.success(`Theme set to ${value}`);
  }

  function handleBrand(preset: BrandPreset) {
    setBrand(preset.id);
    applyBrand(preset);
    localStorage.setItem(BRAND_KEY, preset.id);
    toast.success(`Brand color: ${preset.label}`);
  }

  function handleFont(value: string) {
    const size = value as FontSize;
    setFontSize(size);
    applyFont(size);
    localStorage.setItem(FONT_KEY, size);
    toast.success(`Font size: ${size}`);
  }

  return (
    <div className="space-y-8">
      {/* Theme */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Theme</h3>
          <p className="text-muted-foreground text-xs">Choose how the app looks.</p>
        </div>
        <div className="grid grid-cols-3 gap-2 sm:max-w-md">
          <ThemeOption
            label="Light"
            icon={Sun}
            active={mounted && theme === "light"}
            onClick={() => handleTheme("light")}
          />
          <ThemeOption
            label="Dark"
            icon={Moon}
            active={mounted && theme === "dark"}
            onClick={() => handleTheme("dark")}
          />
          <ThemeOption
            label="System"
            icon={Monitor}
            active={mounted && (theme === "system" || !theme)}
            onClick={() => handleTheme("system")}
          />
        </div>
      </section>

      {/* Brand */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Brand color</h3>
          <p className="text-muted-foreground text-xs">
            Applied to primary buttons, badges, and the active accent.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {BRAND_PRESETS.map((preset) => {
            const selected = brand === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleBrand(preset)}
                aria-label={preset.label}
                aria-pressed={selected}
                className={cn(
                  "relative flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                  selected
                    ? "border-foreground/30 bg-accent text-accent-foreground"
                    : "border-border hover:bg-accent/50",
                )}
              >
                <span
                  className="size-4 rounded-full border border-black/10 dark:border-white/20"
                  style={{ background: preset.swatch }}
                />
                {preset.label}
                {selected && <Check className="size-3.5" />}
              </button>
            );
          })}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleBrand(BRAND_PRESETS[0]!)}
          disabled={brand === "neutral"}
        >
          Reset to default
        </Button>
      </section>

      {/* Font size */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Font size</h3>
          <p className="text-muted-foreground text-xs">
            Scales the entire interface. Defaults to <code>base</code> (16&nbsp;px).
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="font-size">Size</Label>
          <Select value={fontSize} onValueChange={handleFont}>
            <SelectTrigger id="font-size" className="w-full sm:w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sm">Small (14 px)</SelectItem>
              <SelectItem value="base">Base (16 px)</SelectItem>
              <SelectItem value="lg">Large (18 px)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>
    </div>
  );
}

interface ThemeOptionProps {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  onClick: () => void;
}

function ThemeOption({ label, icon: Icon, active, onClick }: ThemeOptionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 rounded-md border p-3 text-xs font-medium transition-colors",
        active
          ? "bg-accent text-accent-foreground border-foreground/30"
          : "border-border hover:bg-accent/50",
      )}
    >
      <Icon className="size-4" />
      {label}
    </button>
  );
}

export default SectionAppearance;
