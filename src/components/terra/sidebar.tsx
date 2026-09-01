"use client";

import { Feather, MessageSquare, Search, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTerra } from "./store";

interface SidebarContentProps {
  /** Close the mobile drawer after navigation actions. */
  onNavigate?: () => void;
}

export function SidebarContent({ onNavigate }: SidebarContentProps) {
  const conversations = useTerra((s) => s.conversations);
  const activeId = useTerra((s) => s.activeId);
  const search = useTerra((s) => s.search);
  const setSearch = useTerra((s) => s.setSearch);
  const setActive = useTerra((s) => s.setActive);
  const newConversation = useTerra((s) => s.newConversation);
  const setSettingsOpen = useTerra((s) => s.setSettingsOpen);

  const needle = search.trim().toLowerCase();
  const filtered = needle
    ? conversations.filter((c) => c.title.toLowerCase().includes(needle))
    : conversations;
  const groups = [
    { key: "today", label: "Today", items: filtered.filter((c) => c.group === "today") },
    {
      key: "yesterday",
      label: "Yesterday",
      items: filtered.filter((c) => c.group === "yesterday"),
    },
  ].filter((group) => group.items.length > 0);

  return (
    <div className="flex h-full flex-col bg-paper">
      {/* Brand row */}
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
        <Feather className="h-[18px] w-[18px] text-terra" aria-hidden />
        <span className="font-serif text-[18px] font-semibold text-ink">Terra</span>
      </div>

      {/* New conversation */}
      <div className="px-3">
        <button
          type="button"
          onClick={() => {
            newConversation();
            onNavigate?.();
          }}
          className="flex h-9 w-full items-center rounded-lg bg-terra px-3 text-white shadow-[0_1px_3px_rgba(166,63,26,0.35)] transition-colors hover:bg-terra-deep"
        >
          <span className="text-sm font-medium">New conversation</span>
          <kbd className="ml-auto rounded border border-white/25 bg-white/10 px-1.5 py-0.5 font-mono text-[11px] leading-none text-white/60">
            ⌘N
          </kbd>
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pt-3">
        <label htmlFor="terra-search" className="sr-only">
          Search chats
        </label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-muted"
            aria-hidden
          />
          <input
            id="terra-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search chats"
            autoComplete="off"
            className="h-9 w-full rounded-lg border border-hairline bg-background pr-3 pl-9 text-sm text-ink placeholder:text-ink-muted/70 transition-colors focus:border-terra/50 focus:ring-2 focus:ring-terra/25 focus:outline-none"
          />
        </div>
      </div>

      {/* Chat history */}
      <nav aria-label="Chat history" className="terra-scroll mt-4 flex-1 overflow-y-auto px-3 pb-4">
        {groups.length === 0 && (
          <p className="px-2 pt-2 text-[13px] leading-relaxed text-ink-muted">
            No chats match “{search.trim()}”.
          </p>
        )}
        {groups.map((group) => (
          <section key={group.key} className="mb-5 last:mb-0">
            <h3 className="mb-1.5 px-2 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">
              {group.label}
            </h3>
            <ul className="space-y-0.5">
              {group.items.map((conversation) => {
                const isActive = conversation.id === activeId;
                return (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setActive(conversation.id);
                        onNavigate?.();
                      }}
                      aria-current={isActive ? "true" : undefined}
                      className={cn(
                        "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors",
                        isActive
                          ? "bg-terra-soft font-medium text-ink"
                          : "text-ink-soft hover:bg-background",
                      )}
                    >
                      <MessageSquare
                        className={cn(
                          "h-4 w-4 shrink-0",
                          isActive ? "text-terra" : "text-ink-muted/70",
                        )}
                        aria-hidden
                      />
                      <span className="truncate">{conversation.title}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>

      {/* Account */}
      <div className="flex shrink-0 items-center gap-2.5 border-t border-hairline px-4 py-3">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-xs font-medium text-white"
          aria-hidden
        >
          TL
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">Terra Lopez</p>
          <p className="text-[11px] text-ink-muted">Pro · Editorial</p>
        </div>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          aria-label="Open settings"
          title="Settings"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-terra-soft hover:text-terra"
        >
          <Settings2 className="h-[18px] w-[18px]" aria-hidden />
        </button>
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden w-[264px] shrink-0 border-r border-hairline bg-paper md:flex md:flex-col">
      <SidebarContent />
    </aside>
  );
}
