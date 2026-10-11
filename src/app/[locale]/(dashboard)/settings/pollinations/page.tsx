"use client";

/**
 * Settings → Pollinations AI — the dedicated hub for the media_generation
 * integration: account connection (official OAuth BYOP flow or a pasted
 * key), Pollen balance + tiers, per-modality model defaults (live catalogue,
 * FREE-first), generation preferences, activity logs, and the provider's
 * actual usage history.
 *
 * All logic lives in SectionPollinations (shared with the settings overlay);
 * this page wires it into the legacy tabbed settings tree — the route the
 * chat sidebar's gear icon leads to.
 */
import { SectionPollinations } from "@/components/settings/section-pollinations";

export default function PollinationsSettingsPage() {
  return <SectionPollinations />;
}
