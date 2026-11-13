"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check, Monitor, Moon, RotateCcw, Sun } from "lucide-react";

import { cn } from "@/lib/utils";
import { useThemeStore, type Theme as ThemeChoice } from "@/stores/theme-store";
import {
  DEFAULT_BACKGROUND,
  DEFAULT_GLOW,
  FONT_KEY,
  readPersistedBackground,
  readPersistedGlow,
  resetAppearance,
  selectBackground,
  selectGlow,
  clearBackground,
  clearGlow,
  relativeLuminance,
} from "@/lib/appearance";
import { Label } from "@/components/ui/label";
import { MoreOptions } from "@/components/settings/more-options";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Appearance — the ONE appearance surface (Appearance PRD §1).
 *
 *  · Theme: light / dark / system (mode only — the palette is the single
 *    default Orange Glass identity on both).
 *  · Background: the canvas colour picker (§1.2) — default keeps the
 *    black + orange identity; every pick is contrast-validated by
 *    @/lib/appearance so text/icons/borders always read (§2).
 *  · Reset appearance (§1.3): restores the default background, component
 *    colours and font size in place.
 *
 * The old brand-preset grid and the 50-scheme "color combinations" picker
 * are gone (§1.1 — one default theme, no competing accent presets).
 */

type FontSize = "sm" | "base" | "lg";

const FONT_SIZE_MAP: Record<FontSize, string> = {
  sm: "14px",
  base: "16px",
  lg: "18px",
};

/** Curated canvas swatches — the default identity first, then a few
 *  sensible warm/cool/neutral canvases (these are BACKGROUNDS, not accent
 *  themes; the accent stays orange regardless). */
const CANVAS_SWATCHES: { label: string; hex: string }[] = [
  { label: "Onyx (default)", hex: DEFAULT_BACKGROUND },
  { label: "Ember", hex: "#1a0a02" },
  { label: "Charcoal", hex: "#16161a" },
  { label: "Deep Sea", hex: "#04121c" },
  { label: "Forest", hex: "#0a1508" },
  { label: "Plum", hex: "#170a1c" },
  { label: "Wine", hex: "#1c070d" },
  { label: "Slate", hex: "#101418" },
  { label: "Paper", hex: "#f7f2ec" },
  { label: "Cloud", hex: "#eef1f4" },
];

/** Curated glow-source swatches — the brand orange first, then a few
 *  hues that read well as washes (these tint the GLOW only; the canvas
 *  and every component stay untouched). */
const GLOW_SWATCHES: { label: string; hex: string }[] = [
  { label: "Onyx orange (default)", hex: DEFAULT_GLOW },
  { label: "Ember", hex: "#e5484d" },
  { label: "Magenta", hex: "#d6409f" },
  { label: "Violet", hex: "#8e4ec6" },
  { label: "Cyan", hex: "#0091ff" },
  { label: "Mint", hex: "#30a46c" },
];

function isValidHex(v: string): boolean {
  return /^#?[0-9a-f]{6}$/i.test(v.trim());
}

function normalizeHex(v: string): string {
  const t = v.trim();
  return t.startsWith("#") ? t.toLowerCase() : `#${t.toLowerCase()}`;
}

export function SectionAppearance() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const [mounted, setMounted] = React.useState(false);
  const [background, setBackground] = React.useState<string | null>(null);
  const [hexDraft, setHexDraft] = React.useState("");
  const [glow, setGlow] = React.useState<string | null>(null);
  const [glowDraft, setGlowDraft] = React.useState("");
  const [fontSize, setFontSize] = React.useState<FontSize>("base");
  const [confirmReset, setConfirmReset] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
    const savedBg = readPersistedBackground();
    setBackground(savedBg);
    setHexDraft(savedBg ?? DEFAULT_BACKGROUND);
    const savedGlow = readPersistedGlow();
    setGlow(savedGlow);
    setGlowDraft(savedGlow ?? DEFAULT_GLOW);
    const savedFont = (localStorage.getItem(FONT_KEY) as FontSize | null) ?? "base";
    setFontSize(savedFont);
    if (savedFont !== "base") {
      document.documentElement.style.fontSize = FONT_SIZE_MAP[savedFont];
    }
  }, []);

  function handleTheme(value: string) {
    setTheme(value as ThemeChoice);
    toast.success(`Theme set to ${value}`);
  }

  function handleBackground(hex: string) {
    const normalized = normalizeHex(hex);
    setBackground(normalized);
    setHexDraft(normalized);
    selectBackground(normalized);
  }

  function handleDefaultBackground() {
    setBackground(null);
    setHexDraft(DEFAULT_BACKGROUND);
    clearBackground();
    toast.success("Default background restored");
  }

  function handleGlow(hex: string) {
    const normalized = normalizeHex(hex);
    setGlow(normalized);
    setGlowDraft(normalized);
    selectGlow(normalized);
  }

  function handleDefaultGlow() {
    setGlow(null);
    setGlowDraft(DEFAULT_GLOW);
    clearGlow();
    toast.success("Default glow restored");
  }

  function handleGlowDraftCommit() {
    if (!isValidHex(glowDraft)) {
      setGlowDraft(glow ?? DEFAULT_GLOW);
      return;
    }
    handleGlow(glowDraft);
  }

  function handleHexDraftCommit() {
    if (!isValidHex(hexDraft)) {
      setHexDraft(background ?? DEFAULT_BACKGROUND);
      return;
    }
    handleBackground(hexDraft);
  }

  function handleFont(value: string) {
    const size = value as FontSize;
    setFontSize(size);
    if (size === "base") {
      document.documentElement.style.removeProperty("font-size");
    } else {
      document.documentElement.style.fontSize = FONT_SIZE_MAP[size];
    }
    localStorage.setItem(FONT_KEY, size);
  }

  function handleReset() {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    resetAppearance();
    setBackground(null);
    setHexDraft(DEFAULT_BACKGROUND);
    setGlow(null);
    setGlowDraft(DEFAULT_GLOW);
    setFontSize("base");
    setConfirmReset(false);
    toast.success("Appearance reset to defaults");
  }

  const isDefaultBg = background === null;
  const previewLuminance = relativeLuminance(isDefaultBg ? DEFAULT_BACKGROUND : background ?? DEFAULT_BACKGROUND);
  const previewInk = previewLuminance < 0.35 ? "#ffffff" : "#0b0200";

  return (
    <div className="space-y-8">
      {/* ── Theme (mode only — the palette is the single default identity) ── */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Theme</h3>
          <p className="text-muted-foreground text-xs">
            Light, dark, or follow your system. The palette stays Onyx — warm black with orange accents.
          </p>
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

      {/* ── Background customization (PRD §1.2) ── */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Background</h3>
          <p className="text-muted-foreground text-xs">
            The app canvas colour. Text, icons and borders adapt automatically to stay readable.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {/* Live preview chip — the canvas with its derived ink. */}
          <div
            aria-hidden
            className="flex h-11 w-full max-w-[220px] items-center gap-2.5 rounded-xl border px-3"
            style={{
              background: isDefaultBg ? DEFAULT_BACKGROUND : (background ?? DEFAULT_BACKGROUND),
              borderColor: "color-mix(in srgb, currentColor 14%, transparent)",
              color: previewInk,
            }}
          >
            <span className="text-xs font-semibold">Aa</span>
            <span className="h-1.5 w-1.5 rounded-full bg-[#f07e12]" />
            <span className="text-[11px] opacity-70">
              {isDefaultBg ? "Default · Onyx" : background}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Native colour picker — proper picker, immediate apply. */}
            <label
              className="relative inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-xs font-medium transition-colors hover:bg-accent/50"
              title="Pick a background colour"
            >
              <span
                aria-hidden
                className="h-4 w-4 rounded-full border border-black/10"
                style={{
                  background: isDefaultBg ? DEFAULT_BACKGROUND : (background ?? DEFAULT_BACKGROUND),
                }}
              />
              Pick colour
              <input
                type="color"
                value={isDefaultBg ? DEFAULT_BACKGROUND : (background ?? DEFAULT_BACKGROUND)}
                onChange={(e) => handleBackground(e.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="Background colour picker"
              />
            </label>

            {/* Hex entry for exact colours. */}
            <input
              type="text"
              value={hexDraft}
              onChange={(e) => setHexDraft(e.target.value)}
              onBlur={handleHexDraftCommit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleHexDraftCommit();
                }
              }}
              spellCheck={false}
              maxLength={7}
              aria-label="Background hex colour"
              className="border-input bg-background/40 h-9 w-[92px] rounded-lg border px-2.5 font-mono text-xs lowercase"
            />
          </div>
        </div>

        {/* Curated canvas swatches. */}
        <div className="flex flex-wrap gap-2">
          {CANVAS_SWATCHES.map((sw) => {
            const selected = !isDefaultBg && background === sw.hex;
            const isDefaultSwatch = sw.hex === DEFAULT_BACKGROUND && isDefaultBg;
            return (
              <button
                key={sw.hex}
                type="button"
                onClick={() =>
                  sw.hex === DEFAULT_BACKGROUND && isDefaultBg
                    ? handleDefaultBackground()
                    : handleBackground(sw.hex)
                }
                aria-label={sw.label}
                aria-pressed={selected || isDefaultSwatch}
                title={sw.label}
                className={cn(
                  "relative flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors",
                  selected || isDefaultSwatch
                    ? "border-primary text-foreground"
                    : "border-border hover:bg-accent/50",
                )}
              >
                <span
                  aria-hidden
                  className="size-4 rounded-full border border-black/10"
                  style={{ background: sw.hex }}
                />
                {sw.label}
                {(selected || isDefaultSwatch) && <Check className="size-3.5" />}
              </button>
            );
          })}
        </div>

        <p className="text-muted-foreground/70 text-[11px] leading-relaxed">
          Applies instantly and persists across sessions. Components keep their own
          contrast-aware surfaces — your colour never repaints buttons or icons.
        </p>
      </section>

      {/* ── Background glow (the glow-source colour picker, 2026-11-14) ── */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Background glow</h3>
          <p className="text-muted-foreground text-xs">
            The colour of the soft glow that washes over the canvas. Works with the default
            and custom backgrounds — only the glow tints, nothing else.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {/* Live preview — the glow wash over the current canvas. */}
          <div
            aria-hidden
            className="relative flex h-11 w-full max-w-[220px] items-center gap-2.5 overflow-hidden rounded-xl border px-3"
            style={{
              background: `radial-gradient(120% 80% at 80% 0%, ${(glow ?? DEFAULT_GLOW) + "55"}, transparent 70%), ${isDefaultBg ? DEFAULT_BACKGROUND : background ?? DEFAULT_BACKGROUND}`,
              borderColor: "color-mix(in srgb, currentColor 14%, transparent)",
              color: previewInk,
            }}
          >
            <span className="text-xs font-semibold">Aa</span>
            <span className="text-[11px] opacity-70">
              {glow === null ? `Default · ${DEFAULT_GLOW}` : glow}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <label
              className="relative inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-xs font-medium transition-colors hover:bg-accent/50"
              title="Pick a glow colour"
            >
              <span
                aria-hidden
                className="h-4 w-4 rounded-full border border-black/10"
                style={{ background: `radial-gradient(circle, #fff2 20%, transparent), ${glow ?? DEFAULT_GLOW}` }}
              />
              Pick colour
              <input
                type="color"
                value={glow ?? DEFAULT_GLOW}
                onChange={(e) => handleGlow(e.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="Glow colour picker"
              />
            </label>

            <input
              type="text"
              value={glowDraft}
              onChange={(e) => setGlowDraft(e.target.value)}
              onBlur={handleGlowDraftCommit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleGlowDraftCommit();
                }
              }}
              spellCheck={false}
              maxLength={7}
              aria-label="Glow hex colour"
              className="border-input bg-background/40 h-9 w-[92px] rounded-lg border px-2.5 font-mono text-xs lowercase"
            />
          </div>
        </div>

        {/* Curated glow swatches. */}
        <div className="flex flex-wrap gap-2">
          {GLOW_SWATCHES.map((sw) => {
            const selected = glow === sw.hex;
            const isDefaultSwatch = sw.hex === DEFAULT_GLOW && glow === null;
            return (
              <button
                key={sw.hex}
                type="button"
                onClick={() =>
                  isDefaultSwatch ? handleDefaultGlow() : handleGlow(sw.hex)
                }
                aria-label={sw.label}
                aria-pressed={selected || isDefaultSwatch}
                title={sw.label}
                className={cn(
                  "relative flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors",
                  selected || isDefaultSwatch
                    ? "border-primary text-foreground"
                    : "border-border hover:bg-accent/50",
                )}
              >
                <span
                  aria-hidden
                  className="size-4 rounded-full border border-black/10"
                  style={{ background: `radial-gradient(circle, #fff3 25%, transparent), ${sw.hex}` }}
                />
                {sw.label.replace(" (default)", "")}
                {(selected || isDefaultSwatch) && <Check className="size-3.5" />}
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Reset appearance (PRD §1.3) ── */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Reset appearance</h3>
          <p className="text-muted-foreground text-xs">
            Restore the default background, component colours and text size.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleReset}
            onBlur={() => setConfirmReset(false)}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
              confirmReset
                ? "border-destructive/50 bg-destructive/10 text-destructive"
                : "border-border hover:bg-accent/50",
            )}
            aria-live="polite"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            {confirmReset ? "Tap again to confirm" : "Reset appearance"}
          </button>
        </div>
      </section>

      {/* ── Advanced: interface scaling ── */}
      <MoreOptions defaultOpen={fontSize !== "base"}>
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
      </MoreOptions>

      {/* Orb customization removed (user directive 2026-11-14) — the orb
          keeps its default reactions everywhere; the settings block and its
          persisted key (onyx-orb-personality, wiped at boot) are gone. */}
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
