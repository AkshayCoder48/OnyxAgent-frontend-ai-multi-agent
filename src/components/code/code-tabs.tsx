"use client";

import { Database, MessageSquare, MonitorPlay } from "lucide-react";

import { PageTabs, type PageTab } from "@/components/dashboard/page-tabs";
import { ROUTES } from "@/lib/constants";

/**
 * OnyxCode Code Mode tab bar — Chat | Database | Preview (extension PRD §3.3).
 * A thin wrapper around the existing PageTabs pattern: sits directly under
 * the dashboard header inside the /code layout, active state = bottom border.
 * The Chat tab is `exact` so /code/database and /code/preview don't light it.
 */
const CODE_TABS: PageTab[] = [
  { label: "Chat", href: ROUTES.CODE, icon: MessageSquare, exact: true },
  { label: "Database", href: ROUTES.CODE_DATABASE, icon: Database },
  { label: "Preview", href: ROUTES.CODE_PREVIEW, icon: MonitorPlay },
];

export function CodeTabs({ className }: { className?: string }) {
  return <PageTabs tabs={CODE_TABS} className={className} />;
}
