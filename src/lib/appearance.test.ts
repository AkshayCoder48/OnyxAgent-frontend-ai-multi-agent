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
