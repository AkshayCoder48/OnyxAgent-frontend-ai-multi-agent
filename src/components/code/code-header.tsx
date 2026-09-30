"use client";

import { Code2, Feather, Menu, MessageSquare, MonitorPlay, Settings2, Database } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTerra } from "@/components/terra/store";
import type { CodeTab } from "@/components/terra/types";

const TABS: { id: CodeTab; label: string; icon: typeof MessageSquare }[] = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "database", label: "Database", icon: Database },
  { id: "preview", label: "Preview", icon: MonitorPlay },
];

/**
 * OnyxCode header — wordmark + black Beta badge + the three primary tabs
 * (Chat / Database / Preview). Glass style matching the Terra top bar.
 */
export function CodeHeader() {
  const codeTab = useTerra((s) => s.codeTab);
  const setCodeTab = useTerra((s) => s.setCodeTab);
  const setMobileNav = useTerra((s) => s.setMobileNav);
  const setSettingsOpen = useTerra((s) => s.setSettingsOpen);
  const exitCodeMode = useTerra((s) => s.exitCodeMode);

  return (
    <header className="terra-glass sticky top-0 z-10 flex h-auto shrink-0 flex-col border-b border-hairline">
      <div className="flex h-14 items-center gap-1 px-3 sm:px-4">
        <button
          type="button"
          onClick={() => setMobileNav(true)}
          aria-label="Open navigation"
          title="Navigation"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-terra-soft hover:text-ink md:hidden"
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>

        {/* Brand + Beta badge — tapping the wordmark returns to Terra */}
        <button
          type="button"
          onClick={exitCodeMode}
          aria-label="OnyxCode (Beta). Return to Terra agent."
          title="Back to Terra"
          className="flex min-w-0 items-center rounded-lg px-1 py-1 transition-colors hover:bg-terra-soft/60"
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-terra-soft-border bg-terra-soft"
            aria-hidden
          >
            <Feather className="h-3.5 w-3.5 text-terra" />
          </span>
          <span className="ml-2 truncate font-serif text-[18px] font-semibold text-ink">
            OnyxCode
          </span>
          <span className="ml-2 rounded bg-black px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">
            Beta
          </span>
          <Code2 className="ml-1.5 h-3.5 w-3.5 text-ink-muted" aria-hidden />
        </button>

        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open settings"
            title="Settings"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-terra-soft hover:text-ink"
          >
            <Settings2 className="h-[18px] w-[18px]" aria-hidden />
          </button>
        </div>
      </div>

      {/* Primary tabs */}
      <nav aria-label="OnyxCode sections" className="flex h-10 items-center gap-1 px-3 sm:px-4">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = codeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setCodeTab(tab.id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex h-10 items-center gap-1.5 px-3 text-[13px] font-medium transition-colors",
                active ? "text-terra-deep" : "text-ink-muted hover:text-ink",
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {tab.label}
              <span
                className={cn(
                  "absolute inset-x-2 bottom-0 h-0.5 rounded-full transition-opacity",
                  active ? "bg-terra opacity-100" : "opacity-0",
                )}
                aria-hidden
              />
            </button>
          );
        })}
      </nav>
    </header>
  );
}
