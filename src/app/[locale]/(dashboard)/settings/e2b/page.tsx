import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/constants";

/**
 * E2B sandbox settings route — REDIRECTED to API Keys (2026-11-14: the
 * Sandbox (E2B), Cloud and Schedules tabs were removed from Settings —
 * their key + connection surfaces live in the ONE API Keys tab). The
 * route stays as a redirect so old links and bookmarks keep working.
 */
export default function E2BSettingsPage() {
  redirect(ROUTES.SETTINGS_API_KEYS);
}
