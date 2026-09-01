"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Feather, MessageSquare, type LucideIcon } from "lucide-react";
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

  return (
    <header className="glass-header w-full shrink-0 border-b">
      <div className="flex h-11 items-center justify-between gap-2 px-3 sm:px-6">
        <div className="flex items-center gap-1 sm:gap-3">
          <Link
            href={ROUTES.CHAT}
            className="flex items-center gap-2 pr-1"
          >
            {/* Terra editorial wordmark — terracotta feather + serif type */}
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-primary/10">
              <Feather className="h-3.5 w-3.5 text-primary" aria-hidden />
            </span>
            <span className="onyx-logo-text text-lg sm:text-xl">
              <span className="onyx-logo-o">O</span>nyx<span className="onyx-logo-agent">Agent</span>
            </span>
          </Link>

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
        </div>
      </div>
    </header>
  );
}
