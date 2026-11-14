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

/** Desaturate a hex colour toward its own luminance (t = 0 none, 1 gray). */
function desaturate(hex: string, t: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return toHex([
    c[0] + (l - c[0]) * t,
    c[1] + (l - c[1]) * t,
    c[2] + (l - c[2]) * t,
  ]);
}

/** Hex → "R G B" space-separated triplet (for `rgb(var(--x) / a)` tokens). */
function triplet(hex: string): string {
  const c = parseHex(hex);
  return c ? `${c[0]} ${c[1]} ${c[2]}` : "0 0 0";
}

/** `rgb(R G B / A)` literal from a hex colour. */
function rgba(hex: string, alpha: number): string {
  return `rgb(${triplet(hex)} / ${alpha})`;
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

// (The accent constant now lives as DEFAULT_GLOW — the glow-source colour
// IS the brand colour; every accent element follows it.)

export interface CanvasTokens {
  /** Raw + derived CSS custom properties for :root. */
  vars: Record<string, string>;
  /** True when the canvas is dark (drives a few luminance-keyed tweaks). */
  isDark: boolean;
}

/** The ink that reads on top of an accent (buttons, bubbles, switches). */
function accentForeground(accent: string): string {
  return contrastRatio("#000000", accent) > contrastRatio("#ffffff", accent)
    ? "#1a0d02"
    : "#ffffff";
}

/**
 * Derive the full semantic token set (PRD §2.2) for a custom background.
 * Every value is a CONTRAST-AWARE derivation — never the raw canvas colour
 * on component surfaces that must hold readable text.
 *
 * `glow` is the GLOW-SOURCE colour (Settings → Appearance). It drives the
 * whole accent chain — buttons, CTAs, chat bubbles, switches, focus rings,
 * charts — so retinting the glow retints every accent-driven element while
 * surfaces/borders stay derived from the canvas (2026-11-14 directive:
 * "changing glow source colour changes everything with orange in it").
 */
export function deriveCanvasTokens(bg: string, glow: string = DEFAULT_GLOW): CanvasTokens {
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

  // Accent + ring — the glow-source colour is the accent: if it VANISHES
  // on this canvas (a glow close to the background colour) the focus ring
  // switches to the ink so keyboard focus is always visible (§2.1
  // "invisible icons corrected"). The accent itself is still applied
  // verbatim — the user picked it.
  const accentPrimary = glow;
  const accentOnBg = contrastRatio(glow, bg);
  const focusRing = accentOnBg >= 1.6 ? glow : ink;
  // Button foreground: white ink on the accent clears 2.9:1 for large/UI,
  // but for light accents (yellow, cream) black reads better.
  const buttonForeground = accentForeground(glow);
  // Icons follow the primary ink so glyphs never disappear.
  const iconPrimary = textSecondary;

  // ── GLASS MATERIAL SYSTEM (adaptive glassmorphism overhaul) ─────────
  // Glass inherits the canvas character instead of importing black:
  // every fill, border, shadow and scrim below is derived from the
  // background's luminance + hue, so NO component can introduce an
  // unwanted dark patch on cream/white/coloured canvases.

  // Shadow ink — the ONLY colour shadows are built from. On a dark canvas
  // it is the canvas hue deepened; on a light canvas it is a warm/cool
  // mid-dark neutral (over cream this lands near rgb(60,45,30) — soft
  // umbra, never pure black).
  const shadowInk = isDark
    ? mix(bg, "#000000", 0.55)
    : desaturate(mix(bg, "#141210", 0.82), 0.35);
  // Hairline ink — borders on light canvases (dark canvases use white).
  const lineInk = isDark ? "#ffffff" : desaturate(mix(bg, "#141210", 0.72), 0.3);

  // Elevation ladder (spec §7): 1 subtle · 2 floating · 3 modal. Two-layer
  // ambient shadows from the ink — no pure black, no hard edges.
  const a1 = isDark ? 0.2 : 0.08;
  const a2 = isDark ? 0.3 : 0.12;
  const a3 = isDark ? 0.42 : 0.17;
  const shadow1 = `0 1px 2px rgb(${triplet(shadowInk)} / ${(a1 * 0.55).toFixed(3)}), 0 4px 14px rgb(${triplet(shadowInk)} / ${a1})`;
  const shadow2 = `0 2px 6px rgb(${triplet(shadowInk)} / ${(a2 * 0.5).toFixed(3)}), 0 10px 28px rgb(${triplet(shadowInk)} / ${a2})`;
  const shadow3 = `0 4px 12px rgb(${triplet(shadowInk)} / ${(a3 * 0.45).toFixed(3)}), 0 18px 48px rgb(${triplet(shadowInk)} / ${a3})`;

  // Fills. Dark canvases keep the identity's white-alpha translucency
  // (frosted lift); light canvases lift toward white so glass reads as a
  // clean warm/cool pane of the canvas hue (cream → warm cream glass,
  // orange → soft warm glass, blue → cool glass — automatically).
  const liftTint = (t: number) => mix(bg, "#ffffff", t);
  const softFill = isDark ? "rgb(255 255 255 / 0.05)" : rgba(liftTint(0.42), 0.5);
  const softFillHover = isDark ? "rgb(255 255 255 / 0.08)" : rgba(liftTint(0.46), 0.58);
  const frostFill = isDark ? "rgb(255 255 255 / 0.09)" : rgba(liftTint(0.6), 0.8);
  const frostFillHover = isDark ? "rgb(255 255 255 / 0.13)" : rgba(liftTint(0.64), 0.86);
  const dockFill = isDark
    ? rgba(mix(bg, "#000000", 0.28), 0.5)
    : rgba(liftTint(0.52), 0.88);
  const dockFillHover = isDark
    ? rgba(mix(bg, "#000000", 0.22), 0.56)
    : rgba(liftTint(0.56), 0.92);
  const floatFill = isDark ? "rgb(255 255 255 / 0.12)" : rgba(liftTint(0.66), 0.86);
  const floatFillHover = isDark ? "rgb(255 255 255 / 0.16)" : rgba(liftTint(0.7), 0.9);
  const solidFill = isDark
    ? rgba(mix(bg, "#ffffff", 0.05), 0.97)
    : rgba(liftTint(0.55), 0.97);
  // Recessed wells (inputs, code) — sink with the ink, never with flat black.
  const wellFill = isDark ? rgba(shadowInk, 0.34) : rgba(shadowInk, 0.05);
  const wellFillHover = isDark ? rgba(shadowInk, 0.4) : rgba(shadowInk, 0.08);
  // Code surfaces keep a deep well on EVERY canvas (syntax colours are
  // tuned for dark wells — a dark code block on a cream canvas is
  // intentional, like every mainstream editor).
  const codeFill = isDark ? rgba(shadowInk, 0.52) : "rgb(24 20 16 / 0.92)";

  // Borders — hairlines from the line ink, visible but never loud.
  const glassBorder = isDark ? "rgb(255 255 255 / 0.15)" : rgba(lineInk, 0.2);
  const glassBorderHover = isDark ? "rgb(255 255 255 / 0.24)" : rgba(lineInk, 0.3);
  const glassBorderStrong = isDark ? "rgb(255 255 255 / 0.3)" : rgba(lineInk, 0.38);
  // Top edge highlight — the "light from above" glass sheen.
  const edgeHighlight = isDark ? "rgb(255 255 255 / 0.22)" : "rgb(255 255 255 / 0.55)";
  // Modal scrim — dims the page behind dialogs without blackening light UIs.
  const scrim = isDark ? rgba(shadowInk, 0.66) : rgba(shadowInk, 0.4);
  // The composer pane sits over LIVE streaming text — it gets its own
  // deeper mix so typed text stays readable over any content.
  const composerFill = isDark
    ? rgba(mix(bg, "#000000", 0.35), 0.62)
    : rgba(liftTint(0.58), 0.9);

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
      // ── adaptive glass materials (the overhaul's token contract) ────
      "--glass-ink": triplet(shadowInk),
      "--glass-soft-fill": softFill,
      "--glass-soft-fill-hover": softFillHover,
      "--glass-frost-fill": frostFill,
      "--glass-frost-fill-hover": frostFillHover,
      "--glass-dock-fill": dockFill,
      "--glass-dock-fill-hover": dockFillHover,
      "--glass-float-fill": floatFill,
      "--glass-float-fill-hover": floatFillHover,
      "--glass-solid-fill": solidFill,
      "--glass-well-fill": wellFill,
      "--glass-well-fill-hover": wellFillHover,
      "--glass-code-fill": codeFill,
      "--glass-composer-fill": composerFill,
      "--glass-border": glassBorder,
      "--glass-border-hover": glassBorderHover,
      "--glass-border-strong": glassBorderStrong,
      "--glass-edge-highlight": edgeHighlight,
      "--glass-shadow-1": shadow1,
      "--glass-shadow-2": shadow2,
      "--glass-shadow-3": shadow3,
      "--glass-scrim": scrim,
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
      // ── accent bridge: the glow colour IS the brand colour ───────────
      "--color-primary": accentPrimary,
      "--color-primary-foreground": buttonForeground,
      "--color-brand": accentPrimary,
      "--color-brand-hover": mix(glow, "#000000", 0.15),
      "--color-brand-foreground": buttonForeground,
      "--color-brand-muted": mix(glow, "#000000", 0.45),
      "--color-chart": accentPrimary,
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
  "--color-brand-foreground",
  "--color-chart",
];

/** The inline vars applyGlow writes (for clean removal). */
const GLOW_VARS = ["--glow-color", "--color-primary-foreground", "--button-foreground"];

// ── application ─────────────────────────────────────────────────────────────

/** Apply a custom background: derive + write tokens, flag the canvas. The
 *  persisted glow (if any) rides along so the accent chain follows it. */
export function applyBackground(hex: string): void {
  if (typeof document === "undefined") return;
  const rgb = parseHex(hex);
  if (!rgb) return;
  const bg = toHex(rgb);
  const root = document.documentElement;
  const glow = readPersistedGlow() ?? DEFAULT_GLOW;
  const { vars } = deriveCanvasTokens(bg, glow);
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

/** Apply a custom glow-source colour: retints the page's radial glow washes
 *  AND the whole accent chain — buttons, CTAs, chat bubbles, switches,
 *  checkboxes, focus rings, charts — every element that carries the brand
 *  colour (2026-11-14 directive). Unset → the CSS falls back to the brand
 *  orange. When a custom background is active, its accent-derived tokens
 *  are re-derived against the new glow so contrast guarantees survive. */
export function applyGlow(hex: string): void {
  if (typeof document === "undefined") return;
  const rgb = parseHex(hex);
  if (!rgb) return;
  const glow = toHex(rgb);
  const root = document.documentElement;
  root.style.setProperty("--glow-color", glow);
  root.style.setProperty("--color-primary-foreground", accentForeground(glow));
  root.style.setProperty("--button-foreground", accentForeground(glow));
  // Re-derive the canvas tokens (focus ring, accent bridge) against the
  // new glow when a custom canvas is live.
  const bg = readPersistedBackground();
  if (bg && parseHex(bg)) {
    const { vars } = deriveCanvasTokens(toHex(parseHex(bg)!), glow);
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  }
}

/** Remove the custom glow colour (back to the brand-orange glow). */
export function clearGlow(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const prop of GLOW_VARS) root.style.removeProperty(prop);
  // Restore the canvas tokens' accent to the default orange when a custom
  // background is active.
  const bg = readPersistedBackground();
  if (bg && parseHex(bg)) {
    const { vars } = deriveCanvasTokens(toHex(parseHex(bg)!), DEFAULT_GLOW);
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  }
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
