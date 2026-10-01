"use client";

import { Code2, Database, Feather, Menu, MessageSquare, MonitorPlay, Settings2 } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useTerra } from "@/components/terra/store";
import type { CodeTab } from "@/components/terra/types";

const TABS: { id: CodeTab; label: string; shortLabel: string; icon: typeof MessageSquare }[] = [
  { id: "chat", label: "Chat", shortLabel: "Chat", icon: MessageSquare },
  { id: "database", label: "Database", shortLabel: "Data", icon: Database },
  { id: "preview", label: "Preview", shortLabel: "View", icon: MonitorPlay },
];

/**
 * OnyxCode header — brand row plus the workspace sub-header: the chat name on
 * the left and the Chat / Database / Preview pills on the right, styled like
 * the other sub-header buttons (Files, Connectors…). Database and Preview
 * toggle their panel; tapping the active one returns to the chat.
 */
export function CodeHeader() {
  const codeTab = useTerra((s) => s.codeTab);
  const setCodeTab = useTerra((s) => s.setCodeTab);
  const setMobileNav = useTerra((s) => s.setMobileNav);
  const setSettingsOpen = useTerra((s) => s.setSettingsOpen);
  const exitCodeMode = useTerra((s) => s.exitCodeMode);
  const active = useTerra((s) =>
    s.conversations.find((c) => c.id === s.activeCodeId && c.mode === "code"),
  );
  const sending = useTerra((s) => s.sending);

  const openTab = (tab: CodeTab) => {
    // Sub-header toggle behaviour: tapping the open panel closes it back
    // to the chat (same feel as the Files / Connectors buttons).
    setCodeTab(codeTab === tab && tab !== "chat" ? "chat" : tab);
  };

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

      {/* Workspace sub-header — chat name + section pills */}
      <nav
        aria-label="OnyxCode sections"
        className="flex h-11 items-center gap-2 border-t border-hairline/60 px-3 sm:px-4"
      >
        <span className="flex min-w-0 items-center gap-2" title={active?.title ?? "New app"}>
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-terra-soft-border bg-terra-soft"
            aria-hidden
          >
            <Code2 className="h-3 w-3 text-terra" />
          </span>
          <span className="truncate text-[13px] font-medium text-ink-soft">
            {active?.title ?? "New app"}
          </span>
          {sending && codeTab !== "chat" && (
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-terra" aria-hidden />
          )}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const activeTab = codeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => openTab(tab.id)}
                aria-current={activeTab ? "page" : undefined}
                aria-pressed={activeTab}
                className={cn(
                  "relative flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium transition-colors duration-150",
                  activeTab ? "text-terra-deep" : "text-ink-muted hover:bg-terra-soft/60 hover:text-ink",
                )}
              >
                {activeTab && (
                  <motion.span
                    layoutId="code-tab-pill"
                    className="absolute inset-0 rounded-lg bg-terra-soft"
                    transition={{ type: "spring", bounce: 0.25, duration: 0.45 }}
                    aria-hidden
                  />
                )}
                <Icon className="relative z-10 h-4 w-4 shrink-0" aria-hidden />
                <span className="relative z-10 hidden sm:inline">{tab.label}</span>
                <span className="relative z-10 sm:hidden">{tab.shortLabel}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </header>
  );
}
