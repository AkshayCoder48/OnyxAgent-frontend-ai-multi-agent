/**
 * Appearance engine — the ONE source of truth for the app's canvas
 * customization (PRD "Appearance System Redesign" §1–§2).
 *
 * DESIGN CONTRACT
 * ───────────────
 * 1. ONE default theme (the Orange Glass identity: warm-black canvas +
 *    orange accent). No competing accent presets — the brand/scheme
 *    pickers are gone; their legacy localStorage keys are cleaned at boot.
 * 2. The ONLY customization is the BACKGROUND colour. The user's colour is
 *    never painted onto every component: it becomes `--app-background`,
 *    and every readable surface derives from it through semantic tokens
 *    (§2.2) computed with WCAG contrast math (§2.3).
 * 3. Components keep their OWN contrast-aware surfaces (cards, muted
 *    wells, borders are mixes of canvas + ink — never the raw user colour),
 *    and the accent stays the app orange unless contrast demands a nudge
 *    (e.g. a bright orange canvas needs a darker ring).
 *
 * WCAG SAFETY (§2.3 — automatic validation)
 * ─────────────────────────────────────────
 *   luminance(bg) → ink = white|black (whichever contrasts more) →
 *   text ≥ 4.5:1 · muted text pushed until ≥ 4.5:1 · borders ≥ ~1.15:1 →
 *   ring: the orange accent unless it vanishes on this canvas (< 1.6:1),
 *   then a contrast-corrected variant.
 */

/** Persistence keys. */
export const BACKGROUND_KEY = "onyx.app-background";
export const GLOW_KEY = "onyx.app-glow";
export const FONT_KEY = "settings.font-size";
/** Legacy keys from the removed preset pickers — cleared at boot + reset. */
const LEGACY_KEYS = [
  "settings.brand",
  "onyx-color-scheme",
  // The removed orb-customization picker (2026-11-14) — its persisted
  // personality is wiped so the orb returns to its default reactions.
  "onyx-orb-personality",
] as const;

/** The default canvas — the Orange Glass warm black (DESIGN.md §1). */
export const DEFAULT_BACKGROUND = "#0b0200";
/** The default glow-source colour — the brand orange. The two radial glow
 *  washes painted on the page (top + bottom) use this hue; the picker in
 *  Settings → Appearance can retint it (2026-11-14). */
export const DEFAULT_GLOW = "#f07e12";

/** Font-size map (Settings → Appearance → Advanced). */
const FONT_SIZE_MAP: Record<string, string> = {
  sm: "14px",
  base: "16px",
  lg: "18px",
};

// ── colour math ─────────────────────────────────────────────────────────────

/** sRGB channel → linear-light (WCAG 2.x definition). */
function channelToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** WCAG relative luminance of a hex colour (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb;
  return (
    0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b)
  );
}

/** WCAG contrast ratio between two hex colours (1 … 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mix two hex colours (t = 0 → all `from`, 1 → all `to`). */
function mix(from: string, to: string, t: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  if (!a || !b) return from;
  return toHex([
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]);
}

/**
 * The readable INK for a canvas: pure white or pure black — whichever
 * contrasts more. For any colour one side always clears 4.58:1, so WCAG
 * 4.5:1 body text is guaranteed before any further derivation.
 */
function inkFor(bg: string): "#ffffff" | "#000000" {
  return contrastRatio("#ffffff", bg) >= contrastRatio("#000000", bg)
    ? "#ffffff"
    : "#000000";
}

/** Soften pure ink toward the canvas while keeping ≥ `min` contrast. */
function readableInk(bg: string, ink: string, startAlpha: number, min = 4.5): string {
  // Binary-search the largest ink blend that still passes `min` — the
  // secondary text reads as quiet but never drops below the body floor.
  let lo = startAlpha;
  let hi = 1;
  const ratioAt = (alpha: number) => contrastRatio(mix(bg, ink, alpha), bg);
  if (ratioAt(startAlpha) >= min) return mix(bg, ink, startAlpha);
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (ratioAt(mid) >= min) hi = mid;
    else lo = mid;
  }
  return mix(bg, ink, hi);
}

/** The app's orange identity accent (DESIGN.md §1). */
const ACCENT = "#f07e12";

export interface CanvasTokens {
  /** Raw + derived CSS custom properties for :root. */
  vars: Record<string, string>;
  /** True when the canvas is dark (drives a few luminance-keyed tweaks). */
  isDark: boolean;
}

/**
 * Derive the full semantic token set (PRD §2.2) for a custom background.
 * Every value is a CONTRAST-AWARE derivation — never the raw canvas colour
 * on component surfaces that must hold readable text.
 */
export function deriveCanvasTokens(bg: string): CanvasTokens {
  const ink = inkFor(bg);
  const isDark = ink === "#ffffff";

  // Text ladder — primary always ≥ 4.5:1 (pure ink clears ~4.6+ on any
  // canvas), secondary pushed until it also clears the body floor.
  const textPrimary = ink;
  const textSecondary = readableInk(bg, ink, 0.78);
  const textMuted = readableInk(bg, ink, 0.6);

  // Surfaces — the canvas lifted (dark) or sunk (light) a few percent:
  // cards/muted wells stay CLOSE to the canvas (the user's colour is still
  // recognizable) while reading as distinct layers.
  const surfaceLift = isDark ? mix(bg, "#ffffff", 0.055) : mix(bg, "#000000", 0.035);
  const surfaceSecondary = isDark ? mix(bg, "#ffffff", 0.03) : mix(bg, "#000000", 0.018);

  // Borders — visible hairlines (≥ ~1.15:1 against the canvas).
  const borderTint = isDark ? "#ffffff" : "#000000";
  let borderDefault = mix(bg, borderTint, 0.14);
  if (contrastRatio(borderDefault, bg) < 1.15) {
    borderDefault = mix(bg, borderTint, 0.22);
  }
  const borderSubtle = mix(bg, borderTint, isDark ? 0.08 : 0.07);

  // Accent + ring — the orange identity, but if it VANISHES on this canvas
  // (a bright orange background, say) the focus ring switches to the ink
  // so keyboard focus is always visible (§2.1 "invisible icons corrected").
  const accentPrimary = ACCENT;
  const accentOnBg = contrastRatio(ACCENT, bg);
  const focusRing = accentOnBg >= 1.6 ? ACCENT : ink;
  // Button foreground: white ink on orange clears 2.9:1 for large/UI, but
  // for small button labels prefer black when it reads better.
  const buttonForeground =
    contrastRatio("#000000", ACCENT) > contrastRatio("#ffffff", ACCENT)
      ? "#1a0d02"
      : "#ffffff";
  // Icons follow the primary ink so glyphs never disappear.
  const iconPrimary = textSecondary;

  return {
    isDark,
    vars: {
      // ── PRD §2.2 semantic tokens ────────────────────────────────────
      "--app-background": bg,
      "--surface-primary": surfaceLift,
      "--surface-secondary": surfaceSecondary,
      "--text-primary": textPrimary,
      "--text-secondary": textSecondary,
      "--text-muted": textMuted,
      "--border-default": borderDefault,
      "--border-subtle": borderSubtle,
      "--accent-primary": accentPrimary,
      "--icon-primary": iconPrimary,
      "--button-background": accentPrimary,
      "--button-foreground": buttonForeground,
      "--input-background": surfaceSecondary,
      "--input-foreground": textPrimary,
      "--focus-ring": focusRing,
      // ── bridge onto the Tailwind v4 tokens the components already use ─
      "--color-background": bg,
      "--color-foreground": textPrimary,
      "--color-card": surfaceLift,
      "--color-card-foreground": textPrimary,
      "--color-popover": surfaceLift,
      "--color-popover-foreground": textPrimary,
      "--color-muted": surfaceSecondary,
      "--color-muted-foreground": textMuted,
      "--color-secondary": surfaceSecondary,
      "--color-secondary-foreground": textPrimary,
      "--color-accent": mix(bg, borderTint, 0.08),
      "--color-accent-foreground": textPrimary,
      "--color-border": borderDefault,
      "--color-input": borderDefault,
      "--color-ring": focusRing,
    },
  };
}

/** Every inline var the canvas system may set (for clean removal). */
const CANVAS_VARS = [
  ...Object.keys(deriveCanvasTokens(DEFAULT_BACKGROUND).vars),
  "--color-primary",
  "--color-primary-foreground",
  "--color-brand",
  "--color-brand-hover",
  "--color-chart",
];

// ── application ─────────────────────────────────────────────────────────────

/** Apply a custom background: derive + write tokens, flag the canvas. */
export function applyBackground(hex: string): void {
  if (typeof document === "undefined") return;
  const rgb = parseHex(hex);
  if (!rgb) return;
  const bg = toHex(rgb);
  const root = document.documentElement;
  const { vars } = deriveCanvasTokens(bg);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.classList.add("custom-canvas");
}

/** Remove the custom background (back to the default Orange Glass paint). */
export function clearBackground(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const prop of CANVAS_VARS) root.style.removeProperty(prop);
  root.style.removeProperty("background-color");
  root.style.removeProperty("color");
  root.classList.remove("custom-canvas");
}

/** Apply a custom glow-source colour: retints the page's radial glow
 *  washes (top + bottom) without touching the canvas or any component.
 *  Unset → the CSS falls back to the brand orange (--acc). */
export function applyGlow(hex: string): void {
  if (typeof document === "undefined") return;
  const rgb = parseHex(hex);
  if (!rgb) return;
  document.documentElement.style.setProperty("--glow-color", toHex(rgb));
}

/** Remove the custom glow colour (back to the brand-orange glow). */
export function clearGlow(): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.removeProperty("--glow-color");
}

/** Persist + apply a glow-colour choice. */
export function selectGlow(hex: string): void {
  applyGlow(hex);
  try {
    localStorage.setItem(GLOW_KEY, hex);
  } catch {
    /* storage unavailable — session-only */
  }
}

/** The persisted glow colour, or null when the default orange is active. */
export function readPersistedGlow(): string | null {
  try {
    const raw = localStorage.getItem(GLOW_KEY);
    if (raw && parseHex(raw)) return raw;
  } catch {
    /* ignore */
  }
  return null;
}

/** Persist + apply a background choice. */
export function selectBackground(hex: string): void {
  applyBackground(hex);
  try {
    localStorage.setItem(BACKGROUND_KEY, hex);
  } catch {
    /* storage unavailable — session-only */
  }
}

/** The persisted background, or null when the default paint is active. */
export function readPersistedBackground(): string | null {
  try {
    const raw = localStorage.getItem(BACKGROUND_KEY);
    if (raw && parseHex(raw)) return raw;
  } catch {
    /* ignore */
  }
  return null;
}

/** Remove legacy preset keys so old picks can't haunt the new system. */
function clearLegacyKeys(): void {
  try {
    for (const k of LEGACY_KEYS) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
  // Inline vars a legacy scheme/brand may have written at boot.
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const prop of CANVAS_VARS) root.style.removeProperty(prop);
  root.style.removeProperty("background-color");
  root.style.removeProperty("color");
  root.classList.remove("custom-scheme");
}

/** Apply the persisted font-size override (no-op at default). */
function applyPersistedFont(): void {
  if (typeof document === "undefined") return;
  try {
    const size = localStorage.getItem(FONT_KEY);
    if (size && FONT_SIZE_MAP[size]) {
      document.documentElement.style.fontSize = FONT_SIZE_MAP[size]!;
    }
  } catch {
    /* ignore */
  }
}

/**
 * APP-BOOT application: wipe legacy preset state, then apply the persisted
 * background + font size. Called from Providers before first paint of the
 * shell (same slot the old brand applier used).
 */
export function applyPersistedAppearance(): void {
  clearLegacyKeys();
  const bg = readPersistedBackground();
  if (bg) applyBackground(bg);
  const glow = readPersistedGlow();
  if (glow) applyGlow(glow);
  applyPersistedFont();
}

/**
 * Reset Appearance (PRD §1.3): restore the default background + component
 * colours, wipe every customization (background, font size, legacy keys)
 * and update the live DOM immediately.
 */
export function resetAppearance(): void {
  clearLegacyKeys();
  try {
    localStorage.removeItem(BACKGROUND_KEY);
    localStorage.removeItem(GLOW_KEY);
    localStorage.removeItem(FONT_KEY);
  } catch {
    /* ignore */
  }
  clearBackground();
  clearGlow();
  if (typeof document !== "undefined") {
    document.documentElement.style.removeProperty("font-size");
  }
}
