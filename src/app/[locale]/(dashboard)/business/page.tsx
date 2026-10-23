"use client";

import { BusinessDashboard } from "@/components/business/business-dashboard";

/**
 * Business Mode tab — the dashboard listing every business (active +
 * archived) with per-business live stats, template quick-starts and the
 * create-business entry point.
 *
 * Client-only by design (mirrors the knowledge-base / settings page-loading
 * pattern): all data lives in Dexie/IndexedDB behind the business services,
 * which only exist in the browser. The lazy Dexie proxy in `@/lib/db` keeps
 * module evaluation SSR-safe; the component itself defers every read to
 * effects that run after auth resolves.
 */
export default function BusinessTabPage() {
  return <BusinessDashboard />;
}
