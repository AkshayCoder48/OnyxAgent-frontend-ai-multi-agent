// @vitest-environment jsdom
// Appearance engine (PRD §1–§2) — WCAG contrast math, canvas-token
// derivation, persistence and reset, all pinned.
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DEFAULT_BACKGROUND,
  BACKGROUND_KEY,
  FONT_KEY,
  relativeLuminance,
  contrastRatio,
  deriveCanvasTokens,
  applyBackground,
  clearBackground,
  selectBackground,
  readPersistedBackground,
  resetAppearance,
  applyPersistedAppearance,
} from "@/lib/appearance";

describe("appearance · WCAG colour math", () => {
  it("computes relative luminance (black 0, white 1)", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
  });

  it("computes contrast ratios (WCAG reference pairs)", () => {
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    // #767676 on white is the classic 4.54:1 body-text floor.
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThan(4.5);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#f07e12", "#0b0200")).toBeCloseTo(
      contrastRatio("#0b0200", "#f07e12"),
      8,
    );
  });
});

describe("appearance · deriveCanvasTokens", () => {
  it("dark canvas → light ink ≥ 4.5:1 everywhere in the text ladder", () => {
    const t = deriveCanvasTokens("#0b0200");
    expect(t.isDark).toBe(true);
    expect(contrastRatio(t.vars["--text-primary"]!, "#0b0200")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.vars["--text-secondary"]!, "#0b0200")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.vars["--text-muted"]!, "#0b0200")).toBeGreaterThanOrEqual(4.5);
  });

  it("light canvas → dark ink ≥ 4.5:1 everywhere in the text ladder", () => {
    const t = deriveCanvasTokens("#f7f2ec");
    expect(t.isDark).toBe(false);
    expect(contrastRatio(t.vars["--text-primary"]!, "#f7f2ec")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.vars["--text-secondary"]!, "#f7f2ec")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.vars["--text-muted"]!, "#f7f2ec")).toBeGreaterThanOrEqual(4.5);
  });

  it("mid-tone canvas still clears the body floor (one side always does)", () => {
    for (const bg of ["#777777", "#7a6a55", "#607d8b", "#c0a080"]) {
      const t = deriveCanvasTokens(bg);
      expect(contrastRatio(t.vars["--text-primary"]!, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.vars["--text-secondary"]!, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("never repaints the accent — the orange identity survives every canvas", () => {
    for (const bg of ["#0b0200", "#f7f2ec", "#777777", "#ff8800"]) {
      const t = deriveCanvasTokens(bg);
      expect(t.vars["--accent-primary"]).toBe("#f07e12");
      expect(t.vars["--button-background"]).toBe("#f07e12");
    }
  });

  it("invisible accent on the canvas swaps the focus ring to the ink", () => {
    // A near-accent canvas: orange ring would vanish; ink ring takes over.
    const t = deriveCanvasTokens("#f07e12");
    expect(t.vars["--focus-ring"]).not.toBe("#f07e12");
    // A dark canvas keeps the orange ring (it reads fine there).
    expect(deriveCanvasTokens("#0b0200").vars["--focus-ring"]).toBe("#f07e12");
  });

  it("surfaces are close cousins of the canvas (distinct, not repainted)", () => {
    const t = deriveCanvasTokens("#101418");
    expect(t.vars["--surface-primary"]).not.toBe("#101418");
    expect(t.vars["--app-background"]).toBe("#101418");
  });

  it("bridges onto the Tailwind tokens the components already consume", () => {
    const t = deriveCanvasTokens("#04121c");
    expect(t.vars["--color-background"]).toBe("#04121c");
    expect(t.vars["--color-foreground"]).toBe(t.vars["--text-primary"]);
    expect(t.vars["--color-muted-foreground"]).toBe(t.vars["--text-muted"]);
    expect(t.vars["--color-border"]).toBe(t.vars["--border-default"]);
  });
});

describe("appearance · adaptive glass materials (glassmorphism overhaul)", () => {
  const GLASS_KEYS = [
    "--glass-ink",
    "--glass-soft-fill", "--glass-soft-fill-hover",
    "--glass-frost-fill", "--glass-frost-fill-hover",
    "--glass-dock-fill", "--glass-dock-fill-hover",
    "--glass-float-fill", "--glass-float-fill-hover",
    "--glass-solid-fill",
    "--glass-well-fill", "--glass-well-fill-hover",
    "--glass-code-fill", "--glass-composer-fill",
    "--glass-border", "--glass-border-hover", "--glass-border-strong",
    "--glass-edge-highlight",
    "--glass-shadow-1", "--glass-shadow-2", "--glass-shadow-3",
    "--glass-scrim",
  ] as const;

  // The canvases from the testing matrix (white, black, cream, dark gray,
  // orange, blue, purple, green, pink).
  const CANVASES = [
    "#ffffff", "#000000", "#f5f2ed", "#2b2b2b",
    "#f97316", "#2563eb", "#7c3aed", "#22c55e", "#ec4899",
  ];

  it("emits the full glass token contract on every canvas", () => {
    for (const bg of CANVASES) {
      const { vars } = deriveCanvasTokens(bg);
      for (const key of GLASS_KEYS) {
        expect(vars[key], `${key} missing for ${bg}`).toBeTruthy();
      }
    }
  });

  it("no shadow, border or scrim is EVER built from pure black", () => {
    // #000000 itself is excluded: a pure-black canvas can only deepen
    // toward itself (its ink IS the canvas, and shadows on black are
    // imperceptible). Every OTHER canvas must derive non-black ink.
    for (const bg of CANVASES.filter((c) => c !== "#000000")) {
      const { vars } = deriveCanvasTokens(bg);
      const surfaces = [
        vars["--glass-shadow-1"]!, vars["--glass-shadow-2"]!,
        vars["--glass-shadow-3"]!, vars["--glass-scrim"]!,
        vars["--glass-border"]!, vars["--glass-well-fill"]!,
      ];
      for (const value of surfaces) {
        expect(value, `${bg}: ${value}`).not.toMatch(/rgba?\(\s*0\s*,?\s*0\s*,?\s*0\s*[,/]/);
        expect(value, `${bg}: ${value}`).not.toMatch(/rgb\(\s*0 0 0\s*\//);
      }
    }
  });

  it("light canvas (cream) → warm umbra ink, not flat black", () => {
    const t = deriveCanvasTokens("#f5f2ed");
    expect(t.isDark).toBe(false);
    // The ink triplet parses to three channels in the soft-umbra band
    // (like rgb(60,45,30) over cream — visible, never a black stamp).
    const [r, g, b] = t.vars["--glass-ink"]!.split(" ").map(Number);
    expect(r).toBeGreaterThan(30);
    expect(r).toBeLessThan(120);
    expect(g).toBeGreaterThan(25);
    expect(b).toBeGreaterThan(10);
    // Frost lifts toward white — the "warm translucent cream glass" case.
    expect(t.vars["--glass-frost-fill"]!).toMatch(/^rgb\(2[0-9]{2} /);
    // Lighter scrim than the dark family (no blackened overlays).
    expect(t.vars["--glass-scrim"]!).toMatch(/\/ 0\.4\)$/);
  });

  it("dark canvas keeps the white-alpha translucent identity", () => {
    const t = deriveCanvasTokens("#0b0200");
    expect(t.isDark).toBe(true);
    expect(t.vars["--glass-frost-fill"]!).toBe("rgb(255 255 255 / 0.09)");
    expect(t.vars["--glass-border"]!).toBe("rgb(255 255 255 / 0.15)");
  });

  it("hue travels with the canvas (warm orange ink vs cool blue ink)", () => {
    const inkOf = (bg: string) =>
      deriveCanvasTokens(bg).vars["--glass-ink"]!.split(" ").map(Number);
    // LIGHT warm canvas → warm brown umbra (R leads B).
    const warm = inkOf("#f97316");
    expect(warm[0]).toBeGreaterThan(warm[2]);
    // DARK cool canvas → deep blue umbra (B leads R).
    const cool = inkOf("#1e3a8a");
    expect(cool[2]).toBeGreaterThan(cool[0]);
  });

  it("code wells stay deep on EVERY canvas (syntax colours need dark wells)", () => {
    const tripletOf = (v: string) =>
      (v.match(/^rgb\((\d+) (\d+) (\d+) \//) ?? []).slice(1).map(Number);
    for (const bg of CANVASES) {
      const t = deriveCanvasTokens(bg);
      const channels = tripletOf(t.vars["--glass-code-fill"]!);
      expect(channels.length).toBe(3);
      if (!t.isDark) {
        // Light canvases: a fixed deep well (each channel < 60).
        for (const c of channels) expect(c).toBeLessThan(60);
      } else {
        // Dark canvases: the well deepens the canvas hue channel-wise.
        const bgc = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
        // (<= : a pure-black channel is already at the floor)
        expect(channels[0]).toBeLessThanOrEqual(bgc[0]);
        expect(channels[1]).toBeLessThanOrEqual(bgc[1]);
        expect(channels[2]).toBeLessThanOrEqual(bgc[2]);
      }
    }
  });

  it("solid material is near-opaque on both families", () => {
    for (const bg of ["#0b0200", "#f5f2ed"]) {
      const { vars } = deriveCanvasTokens(bg);
      expect(vars["--glass-solid-fill"]!).toMatch(/\/ 0\.97\)$/);
    }
  });

  it("clearBackground strips every glass token (no stale materials)", () => {
    applyBackground("#1a0a02");
    clearBackground();
    const root = document.documentElement;
    for (const key of GLASS_KEYS) {
      expect(root.style.getPropertyValue(key)).toBe("");
    }
  });
});

describe("appearance · apply / persist / reset", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
    // jsdom stub
    if (!("matchMedia" in window)) {
      window.matchMedia = vi.fn().mockReturnValue({ matches: false });
    }
  });

  it("applyBackground writes tokens + flags the canvas", () => {
    applyBackground("#1a0a02");
    const root = document.documentElement;
    expect(root.classList.contains("custom-canvas")).toBe(true);
    expect(root.style.getPropertyValue("--app-background")).toBe("#1a0a02");
    expect(root.style.getPropertyValue("--color-background")).toBe("#1a0a02");
  });

  it("selectBackground persists; readPersistedBackground round-trips", () => {
    selectBackground("#04121c");
    expect(localStorage.getItem(BACKGROUND_KEY)).toBe("#04121c");
    expect(readPersistedBackground()).toBe("#04121c");
  });

  it("clearBackground strips every canvas var + the flag", () => {
    selectBackground("#170a1c");
    clearBackground();
    const root = document.documentElement;
    expect(root.classList.contains("custom-canvas")).toBe(false);
    expect(root.style.getPropertyValue("--app-background")).toBe("");
    expect(root.style.getPropertyValue("--color-background")).toBe("");
  });

  it("invalid hexes are ignored, never half-applied", () => {
    applyBackground("not-a-color");
    expect(document.documentElement.classList.contains("custom-canvas")).toBe(false);
    expect(readPersistedBackground()).toBe(null);
  });

  it("resetAppearance wipes background + font + legacy preset keys", () => {
    localStorage.setItem(BACKGROUND_KEY, "#1a0a02");
    localStorage.setItem(FONT_KEY, "lg");
    localStorage.setItem("settings.brand", "terracotta");
    localStorage.setItem("onyx-color-scheme", JSON.stringify({ name: "Slate Dark" }));
    applyBackground("#1a0a02");
    document.documentElement.style.fontSize = "18px";

    resetAppearance();

    expect(localStorage.getItem(BACKGROUND_KEY)).toBe(null);
    expect(localStorage.getItem(FONT_KEY)).toBe(null);
    expect(localStorage.getItem("settings.brand")).toBe(null);
    expect(localStorage.getItem("onyx-color-scheme")).toBe(null);
    expect(document.documentElement.classList.contains("custom-canvas")).toBe(false);
    expect(document.documentElement.style.fontSize).toBe("");
  });

  it("boot applier wipes legacy presets, restores a persisted background", () => {
    localStorage.setItem("settings.brand", "rose");
    localStorage.setItem(BACKGROUND_KEY, "#0a1508");
    localStorage.setItem(FONT_KEY, "sm");

    applyPersistedAppearance();

    // Legacy preset keys are gone (one default theme — §1.1).
    expect(localStorage.getItem("settings.brand")).toBe(null);
    // The background + font survive (§1.2 persist).
    expect(document.documentElement.classList.contains("custom-canvas")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--app-background")).toBe("#0a1508");
    expect(document.documentElement.style.fontSize).toBe("14px");
  });

  it("boot with defaults leaves a clean default paint", () => {
    applyPersistedAppearance();
    expect(document.documentElement.classList.contains("custom-canvas")).toBe(false);
    expect(readPersistedBackground()).toBe(null);
    expect(DEFAULT_BACKGROUND).toBe("#0b0200");
  });
});
