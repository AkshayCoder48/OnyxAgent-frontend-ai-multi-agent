"use client";

import * as React from "react";
import { SectionCard } from "@/components/settings/settings-section";
import { ThemeToggle } from "@/components/theme";
import { cn } from "@/lib/utils";

interface ColorScheme {
  name: string;
  primary: string;
  primaryForeground: string;
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  muted: string;
  mutedForeground: string;
  secondary: string;
  secondaryForeground: string;
  accent: string;
  accentForeground: string;
  border: string;
  input: string;
  ring: string;
  isDark: boolean;
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function deriveScheme(name: string, primary: string, bg: string, fg: string): ColorScheme {
  const isDark = parseInt(bg.slice(1, 3), 16) < 128;
  const muted = isDark
    ? hexToRgba(fg, 0.08)
    : hexToRgba(fg, 0.04);
  const card = isDark
    ? hexToRgba(fg, 0.06)
    : bg;
  const border = isDark
    ? hexToRgba(fg, 0.12)
    : hexToRgba(fg, 0.10);
  return {
    name,
    primary,
    primaryForeground: isDark ? "#ffffff" : "#ffffff",
    background: bg,
    foreground: fg,
    card,
    cardForeground: fg,
    popover: card,
    popoverForeground: fg,
    muted,
    mutedForeground: isDark ? hexToRgba(fg, 0.6) : hexToRgba(fg, 0.5),
    secondary: muted,
    secondaryForeground: fg,
    accent: hexToRgba(primary, 0.08),
    accentForeground: fg,
    border,
    input: border,
    ring: primary,
    isDark,
  };
}

const COLOR_SCHEMES: ColorScheme[] = [
  // Light schemes
  deriveScheme("Emerald (Default)", "#1ec677", "#ffffff", "#0d4029"),
  deriveScheme("Black & Orange", "#ff6b35", "#ffffff", "#1a1a1a"),
  deriveScheme("Ocean Blue", "#0ea5e9", "#f0f9ff", "#0c4a6e"),
  deriveScheme("Rose Pink", "#f43f5e", "#fff1f2", "#881337"),
  deriveScheme("Sunset Gold", "#f59e0b", "#fffbeb", "#78350f"),
  deriveScheme("Forest Green", "#16a34a", "#f0fdf4", "#14532d"),
  deriveScheme("Crimson Red", "#dc2626", "#fef2f2", "#7f1d1d"),
  deriveScheme("Teal Fresh", "#14b8a6", "#f0fdfa", "#134e4a"),
  deriveScheme("Amber Warm", "#d97706", "#fffbeb", "#451a03"),
  deriveScheme("Cyan Cool", "#06b6d4", "#ecfeff", "#164e63"),
  deriveScheme("Violet Deep", "#7c3aed", "#f5f3ff", "#3b0764"),
  deriveScheme("Pure Mono", "#000000", "#ffffff", "#000000"),
  deriveScheme("Lime Zest", "#84cc16", "#f7fee7", "#1a2e05"),
  deriveScheme("Magenta Pop", "#d946ef", "#fdf4ff", "#701a75"),
  deriveScheme("Sky Blue", "#3b82f6", "#eff6ff", "#1e3a5f"),
  deriveScheme("Coral Reef", "#fb7185", "#fff5f6", "#7f1d1d"),
  deriveScheme("Mint Ice", "#2dd4bf", "#f0fdfa", "#134e4a"),
  deriveScheme("Plum Royale", "#9333ea", "#faf5ff", "#581c87"),
  deriveScheme("Brick Earth", "#b45309", "#fef3c7", "#451a03"),
  deriveScheme("Sage Green", "#65a30d", "#f7fee7", "#1a2e05"),
  deriveScheme("Cherry Blossom", "#ec4899", "#fdf2f8", "#831843"),
  deriveScheme("Turquoise Sea", "#0891b2", "#ecfeff", "#083344"),
  deriveScheme("Goldenrod", "#ca8a04", "#fefce8", "#422006"),
  deriveScheme("Ruby Wine", "#be123c", "#fff1f2", "#4c0519"),
  deriveScheme("Electric Lime", "#a3e635", "#f7fee7", "#1a2e05"),
  deriveScheme("Hot Pink", "#e11d48", "#fff1f2", "#881337"),
  deriveScheme("Deep Ocean", "#0284c7", "#f0f9ff", "#0c4a6e"),
  deriveScheme("Bronze Metal", "#92400e", "#fef3c7", "#451a03"),
  deriveScheme("Jade Stone", "#059669", "#ecfdf5", "#064e3b"),
  deriveScheme("Berry Purple", "#a855f7", "#faf5ff", "#3b0764"),

  // Dark schemes
  deriveScheme("Midnight Purple", "#8b5cf6", "#0f0f1a", "#e2e8f0"),
  deriveScheme("Slate Dark", "#64748b", "#0f172a", "#f1f5f9"),
  deriveScheme("Indigo Night", "#6366f1", "#1e1b4b", "#e0e7ff"),
  deriveScheme("Carbon Black", "#ff6b35", "#0a0a0a", "#fafafa"),
  deriveScheme("Deep Space", "#3b82f6", "#030712", "#f3f4f6"),
  deriveScheme("Dark Emerald", "#1ec677", "#0d1b14", "#d1fae5"),
  deriveScheme("Obsidian Rose", "#f43f5e", "#0c0a09", "#fce7f3"),
  deriveScheme("Dark Teal", "#14b8a6", "#042f2e", "#ccfbf1"),
  deriveScheme("Charcoal Gold", "#f59e0b", "#18181b", "#fef3c7"),
  deriveScheme("Night Violet", "#a855f7", "#13111c", "#e9d5ff"),
  deriveScheme("Dark Crimson", "#ef4444", "#1c0a0a", "#fee2e2"),
  deriveScheme("Onyx Blue", "#3b82f6", "#0a0f1e", "#dbeafe"),
  deriveScheme("Dark Plum", "#c026d3", "#170b1e", "#f5d0fe"),
  deriveScheme("Espresso", "#d97706", "#1c1410", "#fef3c7"),
  deriveScheme("Dark Steel", "#0891b2", "#0f172a", "#cffafe"),
  deriveScheme("Forest Night", "#22c55e", "#0a1f0e", "#dcfce7"),
  deriveScheme("Deep Magenta", "#d946ef", "#1a0a1e", "#f5d0fe"),
  deriveScheme("Rust Iron", "#ea580c", "#1c100a", "#fed7aa"),
  deriveScheme("Abyss Blue", "#2563eb", "#0a0f1e", "#bfdbfe"),
  deriveScheme("Dark Orchid", "#9333ea", "#130b1e", "#e9d5ff"),
];

const STORAGE_KEY = "onyx-color-scheme";

function applyScheme(scheme: ColorScheme) {
  const root = document.documentElement;
  root.style.setProperty("--color-primary", scheme.primary);
  root.style.setProperty("--color-primary-foreground", scheme.primaryForeground);
  root.style.setProperty("--color-background", scheme.background);
  root.style.setProperty("--color-foreground", scheme.foreground);
  root.style.setProperty("--color-card", scheme.card);
  root.style.setProperty("--color-card-foreground", scheme.cardForeground);
  root.style.setProperty("--color-popover", scheme.popover);
  root.style.setProperty("--color-popover-foreground", scheme.popoverForeground);
  root.style.setProperty("--color-muted", scheme.muted);
  root.style.setProperty("--color-muted-foreground", scheme.mutedForeground);
  root.style.setProperty("--color-secondary", scheme.secondary);
  root.style.setProperty("--color-secondary-foreground", scheme.secondaryForeground);
  root.style.setProperty("--color-accent", scheme.accent);
  root.style.setProperty("--color-accent-foreground", scheme.accentForeground);
  root.style.setProperty("--color-border", scheme.border);
  root.style.setProperty("--color-input", scheme.input);
  root.style.setProperty("--color-ring", scheme.ring);
  root.style.setProperty("--color-brand", scheme.primary);
  root.style.setProperty("--color-brand-hover", scheme.primary);
  root.style.backgroundColor = scheme.background;
  root.style.color = scheme.foreground;
  // Add .custom-scheme class so the dark-theme @media queries DON'T override
  // the inline styles (they have :not(.custom-scheme) in their selectors).
  root.classList.add("custom-scheme");
}

export default function AppearanceSettingsPage() {
  const [activeScheme, setActiveScheme] = React.useState<string>("Emerald (Default)");

  React.useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const scheme = JSON.parse(saved);
        if (scheme.name) {
          setActiveScheme(scheme.name);
          applyScheme(scheme);
        }
      } catch {
        // ignore
      }
    }
  }, []);

  function selectScheme(scheme: ColorScheme) {
    setActiveScheme(scheme.name);
    applyScheme(scheme);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scheme));
  }

  function resetScheme() {
    localStorage.removeItem(STORAGE_KEY);
    const root = document.documentElement;
    [
      "--color-primary", "--color-primary-foreground", "--color-background",
      "--color-foreground", "--color-card", "--color-card-foreground",
      "--color-popover", "--color-popover-foreground", "--color-muted",
      "--color-muted-foreground", "--color-secondary", "--color-secondary-foreground",
      "--color-accent", "--color-accent-foreground", "--color-border",
      "--color-input", "--color-ring", "--color-brand", "--color-brand-hover",
    ].forEach((prop) => root.style.removeProperty(prop));
    root.style.removeProperty("background-color");
    root.style.removeProperty("color");
    root.classList.remove("custom-scheme");
    setActiveScheme("Emerald (Default)");
  }

  // Split into light + dark sections
  const lightSchemes = COLOR_SCHEMES.filter((s) => !s.isDark);
  const darkSchemes = COLOR_SCHEMES.filter((s) => s.isDark);

  return (
    <div className="space-y-6">
      <SectionCard title="Theme" description="Light, dark, or follow your system preference.">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-foreground text-sm font-medium">Color scheme</p>
            <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
              Affects the entire app. Choose light, dark, or follow your system preference.
            </p>
          </div>
          <div className="shrink-0">
            <ThemeToggle variant="dropdown" />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Color combinations" description="Pick a preset color palette. Overrides the default theme. Applies to all panels including sidebars.">
        <div className="space-y-4">
          {/* Light schemes */}
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Light Themes ({lightSchemes.length})</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {lightSchemes.map((scheme) => (
                <button
                  key={scheme.name}
                  type="button"
                  onClick={() => selectScheme(scheme)}
                  className={cn(
                    "rounded-xl border-2 p-2.5 text-left transition-all hover:scale-[1.02]",
                    activeScheme === scheme.name ? "border-primary ring-2 ring-primary/20" : "border-border",
                  )}
                  style={{ backgroundColor: scheme.card, borderColor: scheme.border }}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <div
                      className="h-5 w-5 rounded-full shrink-0 border"
                      style={{ backgroundColor: scheme.primary, borderColor: scheme.border }}
                    />
                    <div className="flex flex-col gap-0.5">
                      <div className="h-2.5 w-8 rounded-full" style={{ backgroundColor: scheme.foreground }} />
                      <div className="h-1.5 w-10 rounded-full" style={{ backgroundColor: scheme.muted }} />
                    </div>
                  </div>
                  <p className="text-[11px] font-medium truncate" style={{ color: scheme.foreground }}>{scheme.name}</p>
                  <div className="flex gap-1 mt-1">
                    <div className="h-3 flex-1 rounded" style={{ backgroundColor: scheme.primary }} />
                    <div className="h-3 w-3 rounded" style={{ backgroundColor: scheme.card, border: `1px solid ${scheme.border}` }} />
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Dark schemes */}
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Dark Themes ({darkSchemes.length})</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {darkSchemes.map((scheme) => (
                <button
                  key={scheme.name}
                  type="button"
                  onClick={() => selectScheme(scheme)}
                  className={cn(
                    "rounded-xl border-2 p-2.5 text-left transition-all hover:scale-[1.02]",
                    activeScheme === scheme.name ? "border-primary ring-2 ring-primary/20" : "border-border",
                  )}
                  style={{ backgroundColor: scheme.card, borderColor: scheme.border }}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <div
                      className="h-5 w-5 rounded-full shrink-0 border"
                      style={{ backgroundColor: scheme.primary, borderColor: scheme.border }}
                    />
                    <div className="flex flex-col gap-0.5">
                      <div className="h-2.5 w-8 rounded-full" style={{ backgroundColor: scheme.foreground }} />
                      <div className="h-1.5 w-10 rounded-full" style={{ backgroundColor: scheme.muted }} />
                    </div>
                  </div>
                  <p className="text-[11px] font-medium truncate" style={{ color: scheme.foreground }}>{scheme.name}</p>
                  <div className="flex gap-1 mt-1">
                    <div className="h-3 flex-1 rounded" style={{ backgroundColor: scheme.primary }} />
                    <div className="h-3 w-3 rounded" style={{ backgroundColor: scheme.card, border: `1px solid ${scheme.border}` }} />
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={resetScheme}
          className="mt-3 text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
        >
          Reset to default
        </button>
      </SectionCard>
    </div>
  );
}
