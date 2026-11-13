/**
 * Brand persistence — RETIRED PRESET LAYER (Appearance PRD §1.1).
 *
 * The multi-colour brand presets and the 50-scheme "color combinations"
 * picker are GONE: the app now ships ONE default theme (Orange Glass —
 * warm-black canvas + orange accent). The only customization left is the
 * background colour picker + font size, both owned by @/lib/appearance.
 *
 * This module remains only as the import seam callers used to reach the
 * boot applier through; everything forwards to the appearance engine.
 */

export {
  applyPersistedAppearance as applyPersistedBrand,
  FONT_KEY,
} from "@/lib/appearance";
