"use client";

import { SectionAppearance } from "@/components/settings/section-appearance";
import { SectionCard } from "@/components/settings/settings-section";

/**
 * Appearance settings — the canonical route for the app's appearance
 * (PRD §1). One surface, shared with the in-app settings tab: theme mode,
 * the contrast-safe background colour picker, reset, font size and orb
 * personalities. The legacy 50-scheme "color combinations" grid is gone —
 * the app ships exactly one default theme.
 */
export default function AppearanceSettingsPage() {
  return (
    <div className="space-y-6">
      <SectionCard
        title="Appearance"
        description="Theme mode, background colour and interface scaling — one unified default identity."
      >
        <SectionAppearance />
      </SectionCard>
    </div>
  );
}
