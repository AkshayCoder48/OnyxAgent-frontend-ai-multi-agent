"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import {
  ArrowLeft,
  Bot,
  Cloud,
  Moon,
  Palette,
  Plug,
  Server,
  Settings as SettingsIcon,
  Sliders,
  Sparkles,
  Sun,
  Terminal,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

import { SectionProviders } from "./section-providers";
import { SectionAgentSettings } from "./section-agent-settings";
import { SectionSlashCommands } from "./section-slash-commands";
import { SectionE2B } from "./section-e2b";
import { SectionMcp } from "./section-mcp";
import { SectionCustomTools } from "./section-custom-tools";
import { SectionSkills } from "./section-skills";
import { SectionAppearance } from "./section-appearance";

export type SettingsSectionId =
  | "providers"
  | "agent"
  | "slash"
  | "e2b"
  | "mcp"
  | "tools"
  | "skills"
  | "appearance";

interface SettingsPageProps {
  onClose: () => void;
  initialSection?: SettingsSectionId;
}

interface NavItem {
  id: SettingsSectionId;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

/**
 * Settings consolidated into three tidy groups (task requirement: "sort all
 * similar settings into one and make it less messy"). NAV_ITEMS stays flat
 * for lookups; NAV_GROUPS drives the grouped nav rendering.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    id: "ai",
    label: "AI & Models",
    items: [
      {
        id: "providers",
        label: "AI Providers",
        description: "BYO-key model providers",
        icon: Bot,
      },
      {
        id: "agent",
        label: "Agent Settings",
        description: "Default model, temperature, system prompt",
        icon: Sliders,
      },
    ],
  },
  {
    id: "extensions",
    label: "Extensions",
    items: [
      {
        id: "slash",
        label: "Slash Commands",
        description: "Built-in & custom prompts",
        icon: Terminal,
      },
      {
        id: "mcp",
        label: "MCP Servers",
        description: "Model Context Protocol over HTTP/SSE",
        icon: Server,
      },
      {
        id: "tools",
        label: "Custom Tools",
        description: "Webhook & Python tool integrations",
        icon: Plug,
      },
      {
        id: "skills",
        label: "Skills",
        description: "Reusable prompt + tool bundles",
        icon: Sparkles,
      },
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    items: [
      {
        id: "e2b",
        label: "Sandbox (E2B)",
        description: "Remote code execution sandbox",
        icon: Cloud,
      },
      {
        id: "appearance",
        label: "Appearance",
        description: "Theme, brand color, font size",
        icon: Palette,
      },
    ],
  },
];

const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const isDark = mounted && resolvedTheme === "dark";
  return (
    <Button
      variant="outline"
      size="icon"
      aria-label="Toggle theme"
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

export function SettingsPage({ onClose, initialSection = "providers" }: SettingsPageProps) {
  const [active, setActive] = React.useState<SettingsSectionId>(initialSection);

  const activeItem = NAV_ITEMS.find((n) => n.id === active)!;

  return (
    <div className="bg-background text-foreground flex h-dvh flex-col">
      {/* Sticky header */}
      <header className="bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b px-4 backdrop-blur">
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex items-center gap-2">
          <SettingsIcon className="text-muted-foreground size-4" />
          <h1 className="text-base font-semibold">Settings</h1>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
        </div>
      </header>

      {/* Body: sidebar nav + content */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Desktop vertical nav — grouped with tracked-caps headers so
            similar settings live together (less messy). */}
        <nav className="bg-secondary/50 hidden w-64 shrink-0 border-r md:block">
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-4 p-3">
              {NAV_GROUPS.map((group) => (
                <div key={group.id}>
                  <p className="px-3 pb-1.5 font-mono text-[10px] font-medium tracking-[0.16em] text-muted-foreground/70 uppercase">
                    {group.label}
                  </p>
                  <ul className="flex flex-col gap-0.5">
                    {group.items.map((item) => {
                      const Icon = item.icon;
                      const isActive = item.id === active;
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            onClick={() => setActive(item.id)}
                            className={cn(
                              "group flex w-full items-start gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors",
                              isActive
                                ? "bg-accent text-accent-foreground border border-[#ead6c4] dark:border-[#4c3d2a]"
                                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground border border-transparent",
                            )}
                          >
                            <Icon
                              className={cn(
                                "mt-0.5 size-4 shrink-0",
                                isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                              )}
                            />
                            <span className="flex min-w-0 flex-col">
                              <span className="font-medium leading-tight">{item.label}</span>
                              <span className="text-muted-foreground truncate text-xs leading-tight">
                                {item.description}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </ScrollArea>
        </nav>

        {/* Mobile horizontal scroll tabs */}
        <div className="md:hidden">
          <ScrollArea className="w-full">
            <div className="flex gap-1 overflow-x-auto p-2">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = item.id === active;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActive(item.id)}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                      isActive
                        ? "bg-accent text-accent-foreground border-transparent"
                        : "bg-transparent text-muted-foreground border-border hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    <Icon className="size-3.5" />
                    {item.label}
                  </button>
                );
              })}
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
          <Separator />
        </div>

        {/* Right content */}
        <main className="bg-background min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-8">
            <div className="mb-6 flex items-center gap-2.5">
              <activeItem.icon className="text-primary size-5" />
              <div>
                <h2 className="font-display text-xl font-semibold leading-tight tracking-tight">{activeItem.label}</h2>
                <p className="text-muted-foreground text-xs">{activeItem.description}</p>
              </div>
            </div>
            <Separator className="mb-6" />
            {active === "providers" && <SectionProviders />}
            {active === "agent" && <SectionAgentSettings />}
            {active === "slash" && <SectionSlashCommands />}
            {active === "e2b" && <SectionE2B />}
            {active === "mcp" && <SectionMcp />}
            {active === "tools" && <SectionCustomTools />}
            {active === "skills" && <SectionSkills />}
            {active === "appearance" && <SectionAppearance />}
          </div>
        </main>
      </div>
    </div>
  );
}

export default SettingsPage;
