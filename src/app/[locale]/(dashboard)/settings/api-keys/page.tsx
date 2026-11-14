"use strict";

// ============================================================================
// /settings/api-keys — the consolidated API Keys tab (task 2026-11-14).
//
// This route used to hold its own E2B/LangSearch/SkillsMP key inputs. Every
// key input in the app now lives in ONE component — SectionApiKeys — shared
// by this route and the in-app Settings overlay (Settings → API Keys), so
// there is exactly one implementation, one look, one set of platform logos.
// ============================================================================

import { SectionApiKeys } from "@/components/settings/section-api-keys";

export default function ApiKeysSettingsPage() {
  return <SectionApiKeys />;
}
