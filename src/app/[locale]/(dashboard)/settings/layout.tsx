"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  Blocks,
  Bot,
  Braces,
  KeyRound,
  Palette,
  Settings,
  Slash,
  Wrench,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useActiveRoute } from "@/lib/active-route";
import { ROUTES } from "@/lib/constants";
import { PageHeader } from "@/components/dashboard/page-header";
import type { PageTab } from "@/components/dashboard/page-tabs";

/**
 * Settings consolidated into three groups ("sort all similar settings into
 * one and make it less messy" — Terra redesign). Routes are unchanged so
 * existing links keep working; the nav just presents them grouped with
 * tracked-caps section labels.
 */
const SETTINGS_GROUPS: { id: string; label: string; tabs: PageTab[] }[] = [
  {
    id: "agent",
    label: "Agent",
    tabs: [
      { label: "Config", href: ROUTES.SETTINGS_CONFIG, icon: Settings },
      { label: "Subagents", href: ROUTES.SETTINGS_SUBAGENTS, icon: Bot },
      { label: "Slash commands", href: ROUTES.SETTINGS_SLASH_COMMANDS, icon: Slash },
    ],
  },
  {
    id: "extensions",
    label: "Extensions",
    tabs: [
      { label: "Skills", href: ROUTES.SETTINGS_SKILLS, icon: Wrench },
      { label: "MCPs", href: ROUTES.SETTINGS_MCPS, icon: Blocks },
      { label: "Tools", href: ROUTES.SETTINGS_TOOLS, icon: Wrench },
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    tabs: [
      // Env vars gets `Braces` (its ${VAR} syntax) so the adjacent API Keys
      // tab can own the KeyRound glyph without the two reading as one.
      { label: "Env vars", href: ROUTES.SETTINGS_ENV, icon: Braces },
      { label: "API Keys", href: ROUTES.SETTINGS_API_KEYS, icon: KeyRound },
      { label: "Appearance", href: ROUTES.SETTINGS_APPEARANCE, icon: Palette },
    ],
  },
];

/** Grouped tab bar — PageTabs look with tracked-caps group separators. */
function GroupedSettingsTabs() {
  const isActive = useActiveRoute();
  return (
    <div className="border-border border-b">
      <nav className="-mb-px flex flex-wrap items-end gap-x-5 [scrollbar-width:none] overflow-x-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {SETTINGS_GROUPS.map((group) => (
          <div key={group.id} className="flex items-end">
            <span className="text-muted-foreground/60 mr-1 mb-2.5 hidden select-none font-mono text-[9px] font-medium tracking-[0.16em] uppercase sm:inline-block">
              {group.label}
              <span className="text-border mx-1.5">·</span>
            </span>
            {group.tabs.map((tab) => {
              const active = isActive(tab.href, tab.exact);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors",
                    active
                      ? "border-primary text-foreground"
                      : "text-muted-foreground hover:text-foreground border-transparent",
                  )}
                >
                  {tab.icon && (
                    <tab.icon className={cn("h-4 w-4", active && "text-primary")} />
                  )}
                  {tab.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </div>
  );
}

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto px-3 py-4 sm:px-6 sm:py-8">
      <div className="mx-auto max-w-4xl space-y-6 pb-8">
        <PageHeader
          eyebrow="Settings"
          title="Settings"
          description="Manage your agent, extensions, and workspace — grouped so similar settings live together."
        />
        <GroupedSettingsTabs />
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
