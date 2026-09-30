"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Feather, MessageSquare, TerminalSquare, type LucideIcon } from "lucide-react";
import { useActiveRoute } from "@/lib/active-route";
import { ROUTES } from "@/lib/constants";
import { cn } from "@/lib/utils";

type NavEntry = { labelKey: string; href: string; icon: LucideIcon };

const NAV: NavEntry[] = [
  { labelKey: "chat", href: ROUTES.CHAT, icon: MessageSquare },
];

export function Header() {
  const isActive = useActiveRoute();
  const t = useTranslations("nav");
  // OnyxCode Code Mode — any /code* route swaps the wordmark + adds the
  // permanent black Beta badge (OnyxCode PRD §4.1). Database and the live
  // web Preview are docked panels opened from the workspace's glass
  // sub-header (no tab bar anymore — panels never remount the chat).
  const codeMode = isActive(ROUTES.CODE);

  return (
    <header className="glass-header w-full shrink-0 border-b">
      <div className="flex h-11 items-center justify-between gap-2 px-3 sm:px-6">
        <div className="flex items-center gap-1 sm:gap-3">
          <Link
            href={codeMode ? ROUTES.CODE : ROUTES.CHAT}
            className="flex items-center gap-2 pr-1"
          >
            {/* Terra editorial wordmark — terracotta feather + serif type */}
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-primary/10">
              {codeMode ? (
                <TerminalSquare className="h-3.5 w-3.5 text-primary" aria-hidden />
              ) : (
                <Feather className="h-3.5 w-3.5 text-primary" aria-hidden />
              )}
            </span>
            <span className="onyx-logo-text text-lg sm:text-xl">
              <span className="onyx-logo-o">O</span>nyx
              <span className="onyx-logo-agent">{codeMode ? "Code" : "Agent"}</span>
            </span>
            {codeMode && (
              <span className="ml-2 rounded bg-black px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white dark:bg-white dark:text-black">
                Beta
              </span>
            )}
          </Link>

          {!codeMode && (
            <nav className="hidden items-center gap-0.5 lg:flex">
              {NAV.map((entry) => (
                <Link
                  key={entry.href}
                  href={entry.href}
                  aria-current={isActive(entry.href) ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    isActive(entry.href)
                      ? "bg-foreground/5 text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
                  )}
                >
                  <entry.icon className="h-3.5 w-3.5" />
                  {t(entry.labelKey)}
                </Link>
              ))}
            </nav>
          )}
        </div>

        {codeMode && (
          <Link
            href={ROUTES.CHAT}
            className="text-muted-foreground hover:text-foreground hover:bg-foreground/5 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
            title="Back to OnyxAgent"
          >
            <MessageSquare className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">Back to OnyxAgent</span>
            <span className="sm:hidden">Agent</span>
          </Link>
        )}
      </div>
    </header>
  );
}
