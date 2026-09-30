"use client";

import {
  ArrowLeft,
  CloudOff,
  Code2,
  Feather,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Settings2,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTerra } from "./store";

interface SidebarContentProps {
  /** Close the mobile drawer after navigation actions. */
  onNavigate?: () => void;
}

function relativeTime(at: number | null): string {
  if (at === null) return "never";
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function SyncPill() {
  const status = useTerra((s) => s.syncStatus);
  const lastSyncedAt = useTerra((s) => s.lastSyncedAt);
  const autoSync = useTerra((s) => s.autoSync);
  const pullSync = useTerra((s) => s.pullSync);
  const pushSync = useTerra((s) => s.pushSync);
  const syncError = useTerra((s) => s.syncError);

  const busy = status === "syncing" || status === "booting";
  const offline = status === "offline" || status === "error";
  const label = !autoSync
    ? "Cloud sync off"
    : busy
      ? "Syncing…"
      : offline
        ? (syncError ?? "Offline")
        : `Synced · ${relativeTime(lastSyncedAt)}`;

  const onSyncNow = () => {
    if (busy) return;
    void pullSync().then(() => pushSync());
  };

  return (
    <button
      type="button"
      onClick={onSyncNow}
      title={busy ? "Cloud sync in progress" : "Sync with the cloud now"}
      aria-label={`Cloud sync status: ${label}. Sync now.`}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-lg border px-2.5 text-left text-[12px] transition-colors",
        offline && autoSync
          ? "border-terra-soft-border bg-terra-soft/60 text-terra-deep hover:bg-terra-soft"
          : "border-hairline bg-background text-ink-muted hover:border-terra-soft-border hover:bg-terra-soft/50",
      )}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-terra" aria-hidden />
      ) : offline && autoSync ? (
        <CloudOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
      ) : (
        <span
          className={cn(
            "h-[7px] w-[7px] shrink-0 rounded-full",
            autoSync && status === "synced" ? "bg-[#5F7A45]" : "bg-ink-muted/50",
          )}
          aria-hidden
        />
      )}
      <span className="truncate">{label}</span>
      <RefreshCw
        className="ml-auto h-3 w-3 shrink-0 text-ink-muted/70 transition-transform hover:rotate-180"
        aria-hidden
      />
    </button>
  );
}

export function SidebarContent({ onNavigate }: SidebarContentProps) {
  const conversations = useTerra((s) => s.conversations);
  const appMode = useTerra((s) => s.appMode);
  const activeId = useTerra((s) => (s.appMode === "code" ? s.activeCodeId : s.activeId));
  const search = useTerra((s) => s.search);
  const booted = useTerra((s) => s.booted);
  const setSearch = useTerra((s) => s.setSearch);
  const setActive = useTerra((s) => s.setActive);
  const newConversation = useTerra((s) => s.newConversation);
  const enterCodeMode = useTerra((s) => s.enterCodeMode);
  const exitCodeMode = useTerra((s) => s.exitCodeMode);
  const setSettingsOpen = useTerra((s) => s.setSettingsOpen);
  const deleteConversation = useTerra((s) => s.deleteConversation);
  const undoDelete = useTerra((s) => s.undoDelete);

  const inCode = appMode === "code";
  const needle = search.trim().toLowerCase();
  const modeConversations = conversations.filter((c) => (c.mode === "code") === inCode);
  const filtered = needle
    ? modeConversations.filter((c) => c.title.toLowerCase().includes(needle))
    : modeConversations;
  const groups = [
    { key: "today", label: "Today", items: filtered.filter((c) => c.group === "today") },
    {
      key: "yesterday",
      label: "Yesterday",
      items: filtered.filter((c) => c.group === "yesterday"),
    },
    {
      key: "earlier",
      label: "Earlier",
      items: filtered.filter((c) => c.group === "earlier"),
    },
  ].filter((group) => group.items.length > 0);

  const onDelete = (id: string, title: string) => {
    deleteConversation(id);
    toast(`${title} deleted`, {
      action: { label: "Undo", onClick: () => undoDelete() },
      duration: 8000,
    });
  };

  return (
    <div className="flex h-full flex-col bg-paper">
      {/* Brand row — OnyxCode branding while in Code Mode */}
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
        {inCode ? (
          <>
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-terra-soft-border bg-terra-soft"
              aria-hidden
            >
              <Feather className="h-3.5 w-3.5 text-terra" />
            </span>
            <span className="font-serif text-[18px] font-semibold text-ink">OnyxCode</span>
            <span className="rounded bg-black px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">
              Beta
            </span>
            <Code2 className="ml-auto h-4 w-4 text-ink-muted" aria-hidden />
          </>
        ) : (
          <>
            <Feather className="h-[18px] w-[18px] text-terra" aria-hidden />
            <span className="font-serif text-[18px] font-semibold text-ink">Terra</span>
          </>
        )}
      </div>

      {/* New conversation (mode-aware) */}
      <div className="px-3">
        <button
          type="button"
          onClick={() => {
            newConversation();
            onNavigate?.();
          }}
          className="flex h-9 w-full items-center rounded-lg bg-terra px-3 text-white shadow-[0_1px_3px_rgba(166,63,26,0.35)] transition-colors hover:bg-terra-deep"
        >
          <span className="text-sm font-medium">{inCode ? "New app" : "New conversation"}</span>
          <kbd className="ml-auto rounded border border-white/25 bg-white/10 px-1.5 py-0.5 font-mono text-[11px] leading-none text-white/60">
            ⌘N
          </kbd>
        </button>
      </div>

      {/* Code Mode toggle — enter from the agent, exit from Code Mode */}
      <div className="px-3 pt-2">
        {inCode ? (
          <button
            type="button"
            onClick={() => {
              exitCodeMode();
              onNavigate?.();
            }}
            className="flex h-9 w-full items-center gap-2.5 rounded-lg border border-hairline bg-background px-3 text-sm text-ink-soft transition-colors hover:border-terra-soft-border hover:bg-terra-soft hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden />
            <span className="font-medium">Back to Terra agent</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              enterCodeMode();
              onNavigate?.();
            }}
            aria-label="Open OnyxCode (Beta) — the code mode experience"
            title="OnyxCode — build apps with the agent"
            className="group flex h-10 w-full items-center gap-2.5 rounded-lg border border-hairline bg-background px-3 transition-colors hover:border-terra-soft-border hover:bg-terra-soft"
          >
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-terra-soft-border bg-terra-soft"
              aria-hidden
            >
              <SquareTerminal className="h-3.5 w-3.5 text-terra" />
            </span>
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="text-sm font-medium text-ink">Code Mode</span>
              <span className="rounded bg-black px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white">
                Beta
              </span>
            </span>
            <span className="ml-auto text-[11px] text-ink-muted transition-colors group-hover:text-terra-deep">
              OnyxCode
            </span>
          </button>
        )}
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

      {/* Cloud sync status */}
      <div className="px-3 pt-3">
        <SyncPill />
      </div>

      {/* Chat history */}
      <nav aria-label="Chat history" className="terra-scroll mt-4 flex-1 overflow-y-auto px-3 pb-4">
        {!booted && (
          <div className="space-y-2 px-2 pt-1" aria-hidden>
            <div className="h-8 rounded-lg bg-background/70" />
            <div className="h-8 rounded-lg bg-background/70" />
            <div className="h-8 rounded-lg bg-background/70" />
          </div>
        )}
        {booted && groups.length === 0 && (
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
                  <li key={conversation.id} className="group/item relative">
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
                      <span className="truncate pr-6">{conversation.title}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(conversation.id, conversation.title)}
                      aria-label={`Delete conversation ${conversation.title}`}
                      title="Delete"
                      className="absolute top-1/2 right-1.5 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-ink-muted opacity-0 transition-opacity hover:bg-terra-soft hover:text-terra-deep focus-visible:opacity-100 group-hover/item:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
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
