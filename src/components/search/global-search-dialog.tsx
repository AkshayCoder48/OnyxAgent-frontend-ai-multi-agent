"use client";

/**
 * GLOBAL SEARCH DIALOG (Task 2-b, PRD §11) — the semantic-search UI.
 *
 * Mounted ONCE at the chat-workspace level; reachable from anywhere in the
 * chat UI via:
 *   - the sidebar's "Search all messages" affordance (conversation-sidebar),
 *   - the Ctrl/Cmd+Shift+F binding (the command palette owns Ctrl/Cmd+K —
 *     deliberately NOT taken here),
 *   - `useGlobalSearchStore.getState().openDialog(scope)` from any surface.
 *
 * Search runs the hybrid engine (src/lib/search/search.ts): lexical always,
 * semantic only when the query embedding via the user's connected
 * Pollinations account actually worked — the header badge labels the mode
 * honestly ("Semantic + keyword" vs "Keyword search"). Results are grouped
 * by conversation; Enter/click opens the conversation AT the message (scroll
 * + brief highlight via the `msg-<id>` DOM anchor).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import {
  Bot,
  CalendarDays,
  CornerDownLeft,
  KeyRound,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Search,
  Sparkles,
  User,
  X,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Button,
  Skeleton,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { useAuthStore, useConversationStore } from "@/stores";
import { useConversations } from "@/hooks";
import { useActiveProject } from "@/lib/projects/store";
import {
  searchChats,
  type SearchHit,
  type SearchResults,
  type SearchScope,
} from "@/lib/search/search";
import {
  ensureIndexPopulated,
  rebuildSearchIndex,
  type BackfillProgress,
} from "@/lib/search/indexer";
import { logWarn } from "@/lib/client-logger";

// ---------------------------------------------------------------------------
// Dialog store — open/close with the scope the caller wants preselected.
// ---------------------------------------------------------------------------

interface GlobalSearchDialogState {
  open: boolean;
  /** Scope preset applied when the dialog opens (default "all"). */
  initialScope: SearchScope;
  openDialog: (scope?: SearchScope) => void;
  closeDialog: () => void;
}

export const useGlobalSearchStore = create<GlobalSearchDialogState>((set) => ({
  open: false,
  initialScope: "all",
  openDialog: (scope) => set({ open: true, initialScope: scope ?? "all" }),
  closeDialog: () => set({ open: false }),
}));

// ---------------------------------------------------------------------------
// Open-at-message anchor — shared with the project-history drawer
// ---------------------------------------------------------------------------

/**
 * Scroll the chat thread to a message and briefly highlight it. Polls for
 * the `msg-<id>` element (the thread mounts progressively — older rows are
 * admitted in idle chunks), so it works right after a conversation switch.
 * Reduced-motion users get an instant scroll, no flash. Exported for the
 * project drawer's message hits.
 */
export async function revealMessageAnchor(
  messageId: string,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  if (typeof document === "undefined") return false;
  const timeout = opts.timeoutMs ?? 8000;
  const startedAt = Date.now();
  const el = await new Promise<HTMLElement | null>((resolve) => {
    const tick = () => {
      const found = document.getElementById(`msg-${messageId}`);
      if (found) resolve(found);
      else if (Date.now() - startedAt > timeout) resolve(null);
      else window.setTimeout(tick, 120);
    };
    tick();
  });
  if (!el) return false;
  const reduced =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
  if (!reduced && typeof el.animate === "function") {
    el.animate(
      [
        { backgroundColor: "rgba(34, 211, 238, 0.18)", boxShadow: "inset 0 0 0 1px rgba(8, 145, 178, 0.35)" },
        { backgroundColor: "transparent", boxShadow: "inset 0 0 0 1px transparent" },
      ],
      { duration: 1600, easing: "ease-out" },
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Conversation groups in hit order (the engine's ranking is authoritative). */
function groupByConversation(hits: SearchHit[]): Array<{ conversationId: string; hits: SearchHit[] }> {
  const groups: Array<{ conversationId: string; hits: SearchHit[] }> = [];
  const byId = new Map<string, { conversationId: string; hits: SearchHit[] }>();
  for (const hit of hits) {
    let group = byId.get(hit.conversationId);
    if (!group) {
      group = { conversationId: hit.conversationId, hits: [] };
      byId.set(hit.conversationId, group);
      groups.push(group);
    }
    group.hits.push(hit);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

type ScopeChip = "all" | "project" | "general";

const SEARCH_DEBOUNCE_MS = 250;

export function GlobalSearchDialog() {
  const open = useGlobalSearchStore((s) => s.open);
  const initialScope = useGlobalSearchStore((s) => s.initialScope);
  const closeDialog = useGlobalSearchStore((s) => s.closeDialog);
  const openDialog = useGlobalSearchStore((s) => s.openDialog);

  const userId = useAuthStore((s) => s.user?.id);
  const activeProject = useActiveProject();
  const { selectConversation } = useConversations();

  // ── search state ────────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ScopeChip>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dateOpen, setDateOpen] = useState(false);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searching, setSearching] = useState(false);
  const [flatIndex, setFlatIndex] = useState(0);
  const [indexStatus, setIndexStatus] = useState<"idle" | "building" | "done">("idle");
  const [indexProgress, setIndexProgress] = useState<BackfillProgress | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** Monotonic search sequence — a stale debounce result can never win. */
  const searchSeqRef = useRef(0);
  /** One ensureIndexPopulated per dialog open. */
  const populateTickRef = useRef(0);

  // Apply the caller's scope preset on open + reset transient state —
  // render-time "adjust state on prop change" pattern (setState during
  // render, NEVER inside an effect body, which cascades renders).
  const openKey = `${open ? 1 : 0}:${initialScope}:${userId ?? ""}`;
  const [prevOpenKey, setPrevOpenKey] = useState(openKey);
  if (openKey !== prevOpenKey) {
    setPrevOpenKey(openKey);
    if (open) {
      setScope(initialScope === "all" || initialScope === "general" ? initialScope : "project");
      setQuery("");
      setResults(null);
      setFlatIndex(0);
      setIndexStatus(userId ? "building" : "idle");
      setIndexProgress(null);
      setSearching(false);
    }
  }

  // Async side effects only (on open): opportunistic index population
  // (bounded auto-backfill when empty) — honest progress is surfaced in the
  // footer while it runs — plus the focus nudge.
  useEffect(() => {
    if (!open || !userId) return;
    const myTick = ++populateTickRef.current;
    void ensureIndexPopulated(userId)
      .then((p) => {
        if (populateTickRef.current !== myTick) return;
        setIndexProgress(p);
        setIndexStatus("done");
      })
      .catch(() => {
        if (populateTickRef.current !== myTick) return;
        setIndexStatus("done");
      });
    window.setTimeout(() => inputRef.current?.focus(), 50);
  }, [open, userId]);

  // Global keyboard binding: Ctrl/Cmd+Shift+F (Ctrl/Cmd+K belongs to the
  // command palette — do not break it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        if (useGlobalSearchStore.getState().open) closeDialog();
        else openDialog();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeDialog, openDialog]);

  // ── the search effect (debounced live search) ──────────────────────────
  // An EMPTY query clears at RENDER time (derived visibleResults/
  // visibleSearching below) — the effect only bumps the sequence ref; the
  // busy flag flips inside the debounce callback (async, lint-clean).
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      searchSeqRef.current++;
      return;
    }
    const seq = ++searchSeqRef.current;
    const timer = window.setTimeout(() => {
      setSearching(true);
      const scopeResolved: SearchScope =
        scope === "project"
          ? activeProject
            ? { projectId: activeProject.id }
            : "all"
          : scope;
      void searchChats(trimmed, {
        scope: scopeResolved,
        userId: userId ?? "",
        limit: 30,
        ...(dateFrom || dateTo
          ? { dateFilter: { from: dateFrom || undefined, to: dateTo || undefined } }
          : {}),
      })
        .then((res) => {
          if (searchSeqRef.current !== seq) return; // superseded
          setResults(res);
          setFlatIndex(0);
        })
        .catch((err) => {
          if (searchSeqRef.current !== seq) return;
          logWarn("search", "global search failed", {
            context: { error: err instanceof Error ? err.message : String(err) },
          });
          setResults({ hits: [], semanticAvailable: false, scannedMessages: 0 });
        })
        .finally(() => {
          if (searchSeqRef.current === seq) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, query, scope, dateFrom, dateTo, activeProject, userId]);

  // Derived (render-time): an empty query shows NO results and never a
  // spinner — clearing is instant, without any effect-driven setState.
  const visibleResults = query.trim() ? results : null;
  const visibleSearching = query.trim() ? searching : false;

  const groups = useMemo(
    () => (visibleResults ? groupByConversation(visibleResults.hits) : []),
    [visibleResults],
  );
  const flatHits = useMemo(() => groups.flatMap((g) => g.hits), [groups]);

  // Keep the keyboard-active row in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-hit-index="${flatIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [flatIndex]);

  const openHit = useCallback(
    (hit: SearchHit) => {
      closeDialog();
      void (async () => {
        try {
          if (useConversationStore.getState().currentConversationId !== hit.conversationId) {
            await selectConversation(hit.conversationId);
          }
          await revealMessageAnchor(hit.messageId);
        } catch {
          // The conversation still opens via the store on failure — the
          // anchor scroll is a best-effort nicety, never a blocker.
        }
      })();
    },
    [closeDialog, selectConversation],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flatHits.length === 0) return;
      setFlatIndex((i) => {
        const next = e.key === "ArrowDown" ? i + 1 : i - 1;
        return (next + flatHits.length) % flatHits.length;
      });
      return;
    }
    if (e.key === "Enter") {
      if (flatHits.length === 0) return;
      e.preventDefault();
      const hit = flatHits[Math.min(flatIndex, flatHits.length - 1)];
      if (hit) openHit(hit);
    }
  };

  const handleRebuild = () => {
    if (!userId || rebuilding) return;
    setRebuilding(true);
    setIndexStatus("building");
    void rebuildSearchIndex(userId, { onProgress: (p) => setIndexProgress(p) })
      .catch(() => {})
      .finally(() => {
        setRebuilding(false);
        setIndexStatus("done");
      });
  };

  const semanticAvailable = visibleResults?.semanticAvailable === true;
  const hasDateFilter = !!dateFrom || !!dateTo;
  const trimmedQuery = query.trim();
  const indexEmpty = indexStatus === "done" && (indexProgress?.messagesIndexed ?? 0) === 0;

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : closeDialog())}>
      <DialogContent
        className="top-[8vh] flex max-h-[84vh] w-[calc(100vw-1.5rem)] translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onKeyDown={onKeyDown}
        aria-describedby={undefined}
      >
        <DialogHeader className="border-b border-border px-4 pt-4 pb-3">
          <DialogTitle className="flex items-center gap-2 text-sm font-medium">
            <Search className="h-4 w-4 text-muted-foreground" aria-hidden />
            Search messages
          </DialogTitle>
          {/* Big input — the PRD's global-search entry point. */}
          <div className="relative mt-2">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground/60"
              aria-hidden
            />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search conversations, decisions, files, and project knowledge…"
              aria-label="Search conversations, decisions, files, and project knowledge"
              className="h-11 w-full rounded-xl border border-border bg-background pr-20 pl-9 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/40"
            />
            <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1">
              {visibleSearching && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden />
              )}
              {trimmedQuery && !visibleSearching && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="rounded-md p-1 text-muted-foreground/60 transition-colors hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
              <kbd className="hidden rounded-md border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-block">
                ESC
              </kbd>
            </div>
          </div>

          {/* Scope chips + date filter + honest mode indicator. */}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <ScopeChipButton label="All chats" active={scope === "all"} onClick={() => setScope("all")} />
            {activeProject && (
              <ScopeChipButton
                label={`This project · ${activeProject.name}`}
                active={scope === "project"}
                onClick={() => setScope("project")}
                accent={activeProject.accent_color ?? undefined}
              />
            )}
            <ScopeChipButton
              label="General chats"
              active={scope === "general"}
              onClick={() => setScope("general")}
            />

            <Popover open={dateOpen} onOpenChange={setDateOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors",
                    hasDateFilter
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                  aria-label="Filter by date"
                  aria-expanded={dateOpen}
                >
                  <CalendarDays className="h-3.5 w-3.5" aria-hidden />
                  {hasDateFilter ? `${dateFrom || "…"} → ${dateTo || "…"}` : "Dates"}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-64 p-3">
                <p className="mb-2 text-xs font-medium text-foreground">Filter by message date</p>
                <div className="space-y-2">
                  <label className="block text-[11px] text-muted-foreground">
                    From
                    <input
                      type="date"
                      value={dateFrom}
                      max={dateTo || undefined}
                      onChange={(e) => setDateFrom(e.target.value)}
                      className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary/40"
                    />
                  </label>
                  <label className="block text-[11px] text-muted-foreground">
                    To
                    <input
                      type="date"
                      value={dateTo}
                      min={dateFrom || undefined}
                      onChange={(e) => setDateTo(e.target.value)}
                      className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary/40"
                    />
                  </label>
                  {hasDateFilter && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-full text-xs"
                      onClick={() => {
                        setDateFrom("");
                        setDateTo("");
                      }}
                    >
                      Clear dates
                    </Button>
                  )}
                </div>
              </PopoverContent>
            </Popover>

            <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {semanticAvailable ? (
                <>
                  <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
                  Semantic + keyword
                </>
              ) : (
                <>
                  <KeyRound className="h-3.5 w-3.5" aria-hidden />
                  Keyword search
                </>
              )}
            </span>
          </div>
        </DialogHeader>

        {/* Results — grouped by conversation. */}
        <div
          ref={listRef}
          role="listbox"
          aria-label="Search results"
          className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2"
        >
          {visibleSearching && !visibleResults ? (
            <div className="space-y-3 p-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                </div>
              ))}
            </div>
          ) : !trimmedQuery ? (
            <div className="flex flex-col items-center justify-center gap-1.5 px-6 py-10 text-center">
              <MessageSquareText className="mb-1 h-5 w-5 text-muted-foreground/60" aria-hidden />
              <p className="text-sm font-medium text-foreground">Search across every message</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                Finds message contents, decisions and file mentions — not just chat titles. Press{" "}
                <kbd className="rounded border border-border px-1 font-mono text-[10px]">↵</kbd> to open a result
                at the exact message.
              </p>
            </div>
          ) : flatHits.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1.5 px-6 py-10 text-center">
              <Search className="mb-1 h-5 w-5 text-muted-foreground/60" aria-hidden />
              <p className="text-sm font-medium text-foreground">No messages matched</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                Try different wording, fewer words, or a wider scope.
              </p>
              {!semanticAvailable && (
                <p className="max-w-sm text-xs text-muted-foreground/80">
                  Tip: connect Pollinations (Settings → Pollinations AI) to also search by meaning.
                </p>
              )}
            </div>
          ) : (
            groups.map((group) => {
              const first = group.hits[0]!;
              return (
                <section
                  key={group.conversationId}
                  aria-label={first.conversationTitle || "Conversation"}
                  className="mb-1"
                >
                  {/* Conversation header: title + project/general badge + time. */}
                  <div className="flex items-center gap-2 px-3 pt-2 pb-1">
                    <MessageSquareText className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                      {first.conversationTitle || "Untitled conversation"}
                    </span>
                    {first.projectName ? (
                      <span
                        className="flex max-w-[40%] items-center gap-1 truncate rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                        title={first.projectName}
                      >
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: first.projectAccent ?? "var(--color-primary)" }}
                          aria-hidden
                        />
                        {first.projectName}
                      </span>
                    ) : (
                      <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        General
                      </span>
                    )}
                  </div>
                  {/* Message rows. */}
                  <div className="space-y-0.5">
                    {group.hits.map((hit) => {
                      const flatIdx = flatHits.indexOf(hit);
                      const active = flatIdx === flatIndex;
                      return (
                        <button
                          key={hit.messageId}
                          type="button"
                          role="option"
                          aria-selected={active}
                          data-hit-index={flatIdx}
                          onClick={() => openHit(hit)}
                          onMouseEnter={() => setFlatIndex(flatIdx)}
                          className={cn(
                            "flex w-full items-start gap-2.5 rounded-xl px-3 py-2 text-left transition-colors",
                            active ? "bg-foreground/8" : "hover:bg-foreground/5",
                          )}
                        >
                          <span
                            className={cn(
                              "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md",
                              hit.role === "user"
                                ? "bg-foreground/8 text-foreground/70"
                                : "bg-primary/10 text-primary",
                            )}
                            title={hit.role === "user" ? "USER" : "ASSISTANT"}
                          >
                            {hit.role === "user" ? (
                              <User className="h-3 w-3" aria-hidden />
                            ) : (
                              <Bot className="h-3 w-3" aria-hidden />
                            )}
                          </span>
                          <span className="min-w-0 flex-1">
                            {/* Highlighted excerpt — the <mark> spans come from
                                the engine (HTML-escaped text; the only markup
                                present is the engine-authored marks). */}
                            <span
                              className="block text-[13px] leading-snug text-foreground/85 [&_mark]:rounded [&_mark]:bg-primary/20 [&_mark]:px-0.5 [&_mark]:font-medium [&_mark]:text-foreground"
                              dangerouslySetInnerHTML={{
                                __html: hit.excerpt || "<em>(no text)</em>",
                              }}
                            />
                            <span className="mt-0.5 flex flex-wrap items-center gap-2 text-[10.5px] text-muted-foreground">
                              <span className="font-mono tracking-wider uppercase">
                                {hit.role === "user" ? "USER" : "ASSISTANT"}
                              </span>
                              <span>{relativeTime(hit.createdAt)}</span>
                              <span>{formatDay(hit.createdAt)}</span>
                              {hit.matchedBy === "both" && (
                                <span className="flex items-center gap-0.5 text-primary/80">
                                  <Sparkles className="h-2.5 w-2.5" aria-hidden /> lexical + semantic
                                </span>
                              )}
                              {hit.matchedBy === "semantic" && (
                                <span className="flex items-center gap-0.5 text-primary/80">
                                  <Sparkles className="h-2.5 w-2.5" aria-hidden /> semantic
                                </span>
                              )}
                            </span>
                          </span>
                          {active && (
                            <CornerDownLeft
                              className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/70"
                              aria-hidden
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })
          )}
        </div>

        {/* Footer: scan stats + index maintenance + shortcuts. */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <kbd className="rounded border border-border px-1 py-0.5 font-mono">↑↓</kbd> Navigate
            <kbd className="ml-1 rounded border border-border px-1 py-0.5 font-mono">↵</kbd> Open at message
          </span>
          <span className="inline-flex items-center gap-2">
            {visibleResults && trimmedQuery && (
              <span>
                {flatHits.length} result{flatHits.length === 1 ? "" : "s"} · {visibleResults.scannedMessages} scanned
              </span>
            )}
            {indexStatus === "building" && (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                {rebuilding ? "Rebuilding index" : "Building index"}
                {indexProgress ? ` · ${indexProgress.messagesIndexed} messages` : "…"}
              </span>
            )}
            {indexEmpty && (
              <span>Index ready · no messages yet</span>
            )}
            <button
              type="button"
              onClick={handleRebuild}
              disabled={!userId || rebuilding}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-50"
              title="Wipe and rebuild the message search index from stored conversations"
            >
              <RefreshCw className={cn("h-3 w-3", rebuilding && "animate-spin")} aria-hidden />
              Rebuild index
            </button>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ScopeChipButton({
  label,
  active,
  onClick,
  accent,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  accent?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex h-7 max-w-[45%] items-center gap-1.5 truncate rounded-full border px-2.5 text-xs font-medium transition-colors",
        active
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
      style={active && accent ? { borderColor: `${accent}66` } : undefined}
    >
      {accent && (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: accent }} aria-hidden />
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}
