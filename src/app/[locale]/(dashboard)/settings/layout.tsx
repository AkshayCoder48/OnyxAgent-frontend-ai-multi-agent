"use client";

import type { ReactNode } from "react";
import { Blocks, Bot, KeyRound, Palette, Settings, Slash, Wrench } from "lucide-react";

import { ROUTES } from "@/lib/constants";
import { PageHeader } from "@/components/dashboard/page-header";
import { PageTabs, type PageTab } from "@/components/dashboard/page-tabs";

const SETTINGS_TABS: PageTab[] = [
  { label: "Config", href: ROUTES.SETTINGS_CONFIG, icon: Settings },
  { label: "Subagents", href: ROUTES.SETTINGS_SUBAGENTS, icon: Bot },
  { label: "Slash commands", href: ROUTES.SETTINGS_SLASH_COMMANDS, icon: Slash },
  { label: "Skills", href: ROUTES.SETTINGS_SKILLS, icon: Wrench },
  { label: "MCPs", href: ROUTES.SETTINGS_MCPS, icon: Blocks },
  { label: "Tools", href: ROUTES.SETTINGS_TOOLS, icon: Wrench },
  { label: "Env vars", href: ROUTES.SETTINGS_ENV, icon: KeyRound },
  { label: "Appearance", href: ROUTES.SETTINGS_APPEARANCE, icon: Palette },
];

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto px-3 py-4 sm:px-6 sm:py-8">
      <div className="mx-auto max-w-4xl space-y-6 pb-8">
        <PageHeader
          eyebrow="Settings"
          title="Settings"
          description="Manage your config, slash commands, skills, MCPs, tools, env vars, and appearance."
        />
        <PageTabs tabs={SETTINGS_TABS} />
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
