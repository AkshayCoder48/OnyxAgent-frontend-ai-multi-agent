"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import {
  ArrowLeft,
  Bot,
  CalendarClock,
  Cloud,
  CloudCog,
  Flower2,
  KeyRound,
  Moon,
  Palette,
  Plug,
  Settings as SettingsIcon,
  Sliders,
  Sparkles,
  Sun,
  Terminal,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { motion } from "@/components/motion";
import { getResolvedTheme, useThemeStore } from "@/stores/theme-store";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

/**
 * Settings sections are heavy (Pollinations ~1.4k lines, several others
 * 500-800+). Statically importing all of them pulls ~6k lines of settings UI
 * into the main bundle even though only one section is ever mounted at a
 * time. Each section is therefore code-split via `next/dynamic` with
 * `ssr: false` (the settings overlay is a client-only UI) and a compact
 * skeleton fallback. The nav metadata below stays static so the shell
 * renders instantly. Follows the same pattern as chart-message.tsx.
 */
const SectionSkeleton = () => (
  <div className="h-64 w-full animate-pulse rounded-lg bg-muted/40" aria-hidden />
);

const SectionApiKeys = dynamic(
  () => import("./section-api-keys").then((m) => m.SectionApiKeys),
  { ssr: false, loading: SectionSkeleton },
);
const SectionProviders = dynamic(
  () => import("./section-providers").then((m) => m.SectionProviders),
  { ssr: false, loading: SectionSkeleton },
);
const SectionPollinations = dynamic(
  () => import("./section-pollinations").then((m) => m.SectionPollinations),
  { ssr: false, loading: SectionSkeleton },
);
const SectionAgentSettings = dynamic(
  () => import("./section-agent-settings").then((m) => m.SectionAgentSettings),
  { ssr: false, loading: SectionSkeleton },
);
const SectionSlashCommands = dynamic(
  () => import("./section-slash-commands").then((m) => m.SectionSlashCommands),
  { ssr: false, loading: SectionSkeleton },
);
const SectionE2B = dynamic(
  () => import("./section-e2b").then((m) => m.SectionE2B),
  { ssr: false, loading: SectionSkeleton },
);
const SectionCloudWorkspace = dynamic(
  () => import("./section-cloud-workspace").then((m) => m.SectionCloudWorkspace),
  { ssr: false, loading: SectionSkeleton },
);
const SectionCustomTools = dynamic(
  () => import("./section-custom-tools").then((m) => m.SectionCustomTools),
  { ssr: false, loading: SectionSkeleton },
);
const SectionSkills = dynamic(
  () => import("./section-skills").then((m) => m.SectionSkills),
  { ssr: false, loading: SectionSkeleton },
);
const SectionAppearance = dynamic(
  () => import("./section-appearance").then((m) => m.SectionAppearance),
  { ssr: false, loading: SectionSkeleton },
);
const SectionSchedules = dynamic(
  () => import("./section-schedules").then((m) => m.SectionSchedules),
  { ssr: false, loading: SectionSkeleton },
);

export type SettingsSectionId =
  | "apikeys"
  | "providers"
  | "pollinations"
  | "agent"
  | "slash"
  | "e2b"
  | "cloud"
  | "tools"
  | "skills"
  | "schedules"
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
 * Settings consolidated into tidy groups (task requirement: "sort all
 * similar settings into one and make it less messy"). NAV_ITEMS stays flat
 * for lookups; NAV_GROUPS drives the grouped nav rendering.
 *
 * API Keys is its own FIRST group (task 2026-11-14): every key input in the
 * app lives in that one tab — the other sections keep their non-key
 * settings and point there for credentials.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    id: "credentials",
    label: "Credentials",
    items: [
      {
        id: "apikeys",
        label: "API Keys",
        description: "Every key in one place, with platform logos",
        icon: KeyRound,
      },
    ],
  },
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
        id: "pollinations",
        label: "Pollinations AI",
        description: "Media generation, Pollen & models",
        icon: Flower2,
      },
      {
        id: "agent",
        label: "Agent Settings",
        description: "Default model, temperature, env vars",
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
        id: "cloud",
        label: "Cloud Workspace",
        description: "OnyxBase persistent workspace sync",
        icon: CloudCog,
      },
      {
        id: "schedules",
        label: "Schedules",
        description: "Cron background tasks",
        icon: CalendarClock,
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
  // Zustand theme store (the app's real theme system). next-themes' useTheme
  // no-ops here — its provider is not mounted anywhere in the app.
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const isDark = mounted && getResolvedTheme(theme) === "dark";
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

export function SettingsPage({ onClose, initialSection = "apikeys" }: SettingsPageProps) {
  const [active, setActive] = React.useState<SettingsSectionId>(initialSection);

  // REDUCED MOTION for the JS-driven (framer) layout animations — the CSS
  // kill switch in motion.css cannot reach them, so the glide durations
  // collapse to 0 here (Motion spec §17 accessibility).
  const [reduceMotion, setReduceMotion] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const glide = { duration: reduceMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] as const };

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
                            aria-current={isActive ? "page" : undefined}
                            className={cn(
                              "group relative flex w-full items-start gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors",
                              isActive
                                ? "text-accent-foreground"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            {/*
                              GLIDING ACTIVE INDICATOR (Motion spec §3.2,
                              2026-11-14): the selected nav pill no longer
                              pops per button — ONE shared-layout layer
                              (layoutId) travels smoothly to whichever item is
                              active. framer-motion handles the position
                              interpolation; reduced-motion users get an
                              instant swap (the `glide` durations collapse
                              to 0 — see reduceMotion above).
                            */}
                            {isActive && (
                              <motion.span
                                layoutId="settings-nav-active-pill"
                                transition={glide}
                                className="bg-accent absolute inset-0 rounded-md border border-primary/50 dark:border-primary/40"
                                aria-hidden
                              />
                            )}
                            <Icon
                              className={cn(
                                "relative mt-0.5 size-4 shrink-0",
                                isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                              )}
                            />
                            <span className="relative flex min-w-0 flex-col">
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
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "relative inline-flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                      isActive
                        ? "text-accent-foreground border-transparent"
                        : "bg-transparent text-muted-foreground border-border hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    {/* Same glide, own layoutId (both navs stay mounted —
                        CSS-hidden per breakpoint — so the ids must not mix). */}
                    {isActive && (
                      <motion.span
                        layoutId="settings-nav-active-pill-mobile"
                        transition={{ duration: reduceMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
                        className="bg-accent absolute inset-0 rounded-md"
                        aria-hidden
                      />
                    )}
                    <Icon className="relative size-3.5" />
                    <span className="relative">{item.label}</span>
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
            {active === "apikeys" && <SectionApiKeys />}
            {active === "providers" && <SectionProviders />}
            {active === "pollinations" && <SectionPollinations />}
            {active === "agent" && <SectionAgentSettings />}
            {active === "slash" && <SectionSlashCommands />}
            {active === "e2b" && <SectionE2B />}
            {active === "cloud" && <SectionCloudWorkspace />}
            {active === "tools" && <SectionCustomTools />}
            {active === "skills" && <SectionSkills />}
            {active === "schedules" && <SectionSchedules />}
            {active === "appearance" && <SectionAppearance />}
          </div>
        </main>
      </div>
    </div>
  );
}

export default SettingsPage;
