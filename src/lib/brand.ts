/**
 * Brand + interface-scale persistence — the ONE source of truth for the
 * Settings → Appearance brand presets and the font-size override.
 *
 * THE PERSISTENCE BUG this module fixes: `applyBrand`/`applyFont` used to
 * live INSIDE the SectionAppearance component — the inline CSS variables
 * were set only while the settings page was MOUNTED. On every app reload
 * the document came back with the DEFAULT cyan tokens, so the user's
 * chosen appearance color (Terracotta / Emerald / …) silently reverted and
 * everything brand-tinted — including the AI's highlighted inline code —
 * was "always cyan" no matter what they picked.
 *
 * `applyPersistedBrand()` runs at APP BOOT (Providers → ColorSchemeInitializer,
 * BEFORE the custom color-scheme initializer so a full scheme still wins)
 * and re-applies whatever the user last chose. Pickers also clear the
 * competing system so the LAST choice is the one that survives a reload.
 */

export interface BrandPreset {
  id: string;
  label: string;
  /** CSS color value for --color-primary. */
  primary: string;
  /** CSS color value for --color-primary-foreground. */
  primaryForeground: string;
  /** Visible swatch color (uses primary). */
  swatch: string;
}

// Cyan-first preset list. Cyan is the app default (white canvas, black
// ink, cyan buttons); no purple/violet/indigo presets, per the design
// spec. Picking Cyan clears the overrides so the design tokens from
// globals.css take over again.
export const BRAND_PRESETS: BrandPreset[] = [
  {
    id: "cyan",
    label: "Cyan",
    primary: "#0891b2",
    primaryForeground: "#ffffff",
    swatch: "#0891b2",
  },
  {
    id: "terracotta",
    label: "Terracotta",
    primary: "#c4552f",
    primaryForeground: "#faf6f0",
    swatch: "#c4552f",
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
];

export const BRAND_KEY = "settings.brand";
export const FONT_KEY = "settings.font-size";
export const CUSTOM_SCHEME_KEY = "onyx-color-scheme";

/** CSS vars the brand picker overrides (Tailwind v4 token names). */
const BRAND_OVERRIDES = [
  "--color-primary",
  "--color-primary-foreground",
  "--color-brand",
  "--color-brand-hover",
  "--color-ring",
  "--color-chart",
] as const;

/** Font-size map (Settings → Appearance → Advanced). */
const FONT_SIZE_MAP: Record<string, string> = {
  sm: "14px",
  base: "16px",
  lg: "18px",
};

/** Apply one brand preset's CSS variables (cyan restores theme defaults). */
export function applyBrandPreset(preset: BrandPreset): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (preset.id === "cyan") {
    // Restore theme defaults by removing inline overrides.
    for (const prop of BRAND_OVERRIDES) root.style.removeProperty(prop);
    return;
  }
  root.style.setProperty("--color-primary", preset.primary);
  root.style.setProperty("--color-primary-foreground", preset.primaryForeground);
  root.style.setProperty("--color-brand", preset.primary);
  root.style.setProperty("--color-brand-hover", preset.primary);
  root.style.setProperty("--color-ring", preset.primary);
  root.style.setProperty("--color-chart", preset.primary);
}

/** Remove the custom color-scheme override (the appearance PAGE's "Color
 * combinations" picker) so a brand pick is the last word on color. */
export function clearCustomScheme(): void {
  if (typeof document === "undefined") return;
  try {
    localStorage.removeItem(CUSTOM_SCHEME_KEY);
  } catch {
    /* ignore */
  }
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
}

/** Select a brand preset: apply it, clear the competing scheme, persist. */
export function selectBrandPreset(preset: BrandPreset): void {
  clearCustomScheme();
  applyBrandPreset(preset);
  try {
    localStorage.setItem(BRAND_KEY, preset.id);
  } catch {
    /* ignore */
  }
}

/** The persisted preset id, normalized to a valid preset ("cyan" default —
 * unknown/legacy ids like "neutral" map onto cyan). */
export function readPersistedBrandId(): string {
  try {
    const raw = localStorage.getItem(BRAND_KEY) ?? "cyan";
    return raw === "neutral" || !BRAND_PRESETS.some((p) => p.id === raw)
      ? "cyan"
      : raw;
  } catch {
    return "cyan";
  }
}

/** Apply the user's persisted font-size override (no-op at default). */
function applyPersistedFont(): void {
  if (typeof document === "undefined") return;
  try {
    const size = localStorage.getItem(FONT_KEY);
    if (size && FONT_SIZE_MAP[size]) {
      document.documentElement.style.fontSize = FONT_SIZE_MAP[size];
    }
  } catch {
    /* ignore */
  }
}

/**
 * APP-BOOT application of the persisted appearance choices (brand preset +
 * interface font size). Runs on every load — the pick survive reloads now.
 * Called BEFORE the custom color-scheme initializer, so when BOTH exist a
 * full custom scheme still takes precedence (pickers clear each other, so
 * in practice only the LAST choice is stored at all).
 */
export function applyPersistedBrand(): void {
  const id = readPersistedBrandId();
  const preset = BRAND_PRESETS.find((p) => p.id === id) ?? BRAND_PRESETS[0];
  if (preset) applyBrandPreset(preset);
  applyPersistedFont();
}
