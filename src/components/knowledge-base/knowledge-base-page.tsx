"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowRight,
  Cloud,
  Copy,
  Database,
  Eye,
  LibraryBig,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SearchX,
  Trash2,
} from "lucide-react";

import { PageHeader } from "@/components/dashboard/page-header";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks";
import { useAuthStore } from "@/stores";
import { ROUTES } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { formatBytes, type OnyxBaseUsage } from "@/lib/onyxbase/files-client";
import {
  kbDelete,
  kbGet,
  kbList,
  kbSearch,
  resolveKBClients,
  type KBItemSummary,
  type KBItemType,
  type KBClients,
  type KBSearchResult,
} from "@/lib/onyxbase/kb-store";
import { KBAddDialog } from "./kb-add-dialog";
import { KBItemDialog } from "./kb-item-dialog";
import { KBFilesView } from "./kb-files-view";
import {
  AISavedBadge,
  KB_TYPE_FILTERS,
  KB_TYPE_META,
  TagChips,
  TypeBadge,
  kbErrorMessage,
  timeAgo,
} from "./kb-shared";

/**
 * Knowledge Base tab — the user-facing manager for the workspace's persistent
 * OnyxBase-backed knowledge (AI-saved knowledge items + hosted files). This
 * is a workspace tool, NOT a chat: clean cards, filters, and detail/edit
 * dialogs over the kb-store API.
 */
export function KnowledgeBasePage() {
  // useAuth (not the raw store) — its mount effect runs authStore.init(),
  // avoiding the cold-navigation hydration race (same pattern as the Cloud
  // settings section). authResolved gates client resolution: until init()
  // settles, the transient "local-user" id is NOT authoritative.
  const { user } = useAuth();
  const authResolved = useAuthStore((s) => s.authResolved);
  const userId = user?.id ?? null;

  const [clients, setClients] = React.useState<KBClients | null>(null);
  const [resolving, setResolving] = React.useState(true);

  const [query, setQuery] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState<KBItemType | "all">("all");

  const [allItems, setAllItems] = React.useState<KBItemSummary[]>([]);
  const [listLoading, setListLoading] = React.useState(true);
  const [listError, setListError] = React.useState<string | null>(null);
  const [searchResults, setSearchResults] = React.useState<KBSearchResult[] | null>(null);
  const [searchLoading, setSearchLoading] = React.useState(false);

  const [usage, setUsage] = React.useState<OnyxBaseUsage | null>(null);
  const [account, setAccount] = React.useState<string | null>(null);

  const [view, setView] = React.useState<"knowledge" | "files">("knowledge");
  const [addOpen, setAddOpen] = React.useState(false);
  const [dialog, setDialog] = React.useState<{ itemId: string; edit: boolean } | null>(null);
  const [copyingId, setCopyingId] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);

  const configured = clients !== null;
  const resolvingView = resolving || !authResolved || !userId;
  const searching = debounced.trim().length > 0;
  const busy = resolvingView || listLoading || searchLoading;

  const refresh = React.useCallback(() => setRefreshKey((k) => k + 1), []);

  // Debounce the search input (~300ms).
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Resolve the OnyxBase clients once auth has settled (null = not configured).
  React.useEffect(() => {
    if (!authResolved || !userId) return;
    let cancelled = false;
    setResolving(true);
    (async () => {
      const resolved = await resolveKBClients(userId);
      if (!cancelled) {
        setClients(resolved);
        setResolving(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authResolved, userId]);

  // Full knowledge list (newest first) — powers the browse list, the type
  // filter (client-side) and the storage strip's item count.
  React.useEffect(() => {
    if (!clients || !userId) return;
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    (async () => {
      try {
        const list = await kbList(clients.kv, userId);
        if (!cancelled) setAllItems(list);
      } catch (e) {
        const msg = kbErrorMessage(e);
        if (!cancelled) {
          setListError(msg);
          toast.error("Could not load the Knowledge Base", { description: msg });
        }
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clients, userId, refreshKey]);

  // Search (debounced query + active type filter). Empty query clears results.
  React.useEffect(() => {
    if (!clients || !userId) return;
    const q = debounced.trim();
    if (!q) {
      setSearchResults(null);
      setSearchLoading(false);
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    (async () => {
      try {
        const results = await kbSearch(clients.kv, userId, {
          query: q,
          type: typeFilter === "all" ? undefined : typeFilter,
          limit: 50,
        });
        if (!cancelled) setSearchResults(results);
      } catch (e) {
        if (!cancelled) {
          setSearchResults([]);
          toast.error("Search failed", { description: kbErrorMessage(e) });
        }
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clients, userId, debounced, typeFilter, refreshKey]);

  // Storage strip — account usage (files + bytes) and the key's account name.
  React.useEffect(() => {
    if (!clients) {
      setUsage(null);
      setAccount(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const [statsRes, whoRes] = await Promise.allSettled([
        clients.files.stats(),
        clients.kv.whoami(),
      ]);
      if (cancelled) return;
      if (statsRes.status === "fulfilled") setUsage(statsRes.value);
      if (whoRes.status === "fulfilled") {
        setAccount(whoRes.value.apiKey?.name ?? whoRes.value.user ?? null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clients, refreshKey]);

  const filteredItems = React.useMemo(
    () => (typeFilter === "all" ? allItems : allItems.filter((i) => i.type === typeFilter)),
    [allItems, typeFilter],
  );

  const searchMap = React.useMemo(
    () => new Map((searchResults ?? []).map((r) => [r.id, r] as const)),
    [searchResults],
  );

  /** What the list shows: search hits when searching, else the filtered list. */
  const displayed: KBItemSummary[] = searching ? (searchResults ?? []) : filteredItems;

  const dialogSummary = React.useMemo(
    () => (dialog ? (allItems.find((i) => i.id === dialog.itemId) ?? null) : null),
    [dialog, allItems],
  );

  const copyItem = React.useCallback(
    async (item: KBItemSummary) => {
      if (!clients || !userId) return;
      setCopyingId(item.id);
      try {
        const full = await kbGet(clients.kv, userId, item.id);
        if (!full) throw new Error("The item content could not be read.");
        await navigator.clipboard.writeText(full.content);
        toast.success("Copied to clipboard", { description: item.title });
      } catch (e) {
        toast.error("Copy failed", { description: kbErrorMessage(e) });
      } finally {
        setCopyingId(null);
      }
    },
    [clients, userId],
  );

  const deleteItem = React.useCallback(
    async (item: KBItemSummary) => {
      if (!clients || !userId) return;
      try {
        await kbDelete(clients.kv, userId, item.id);
        toast.success("Knowledge deleted", { description: item.title });
        refresh();
      } catch (e) {
        toast.error("Could not delete knowledge", { description: kbErrorMessage(e) });
      }
    },
    [clients, userId, refresh],
  );

  return (
    <div className="h-full overflow-y-auto px-3 py-4 sm:px-6 sm:py-8">
      <div className="mx-auto max-w-5xl space-y-6 pb-8">
        <PageHeader
          eyebrow="Workspace"
          title="Knowledge Base"
          description="Persistent knowledge and resources for this workspace."
          actions={
            configured ? (
              <>
                <Button
                  variant="outline"
                  onClick={refresh}
                  disabled={busy}
                  aria-label="Refresh the Knowledge Base"
                >
                  <RefreshCw aria-hidden className={cn(busy && "animate-spin")} />
                  Refresh
                </Button>
                <Button onClick={() => setAddOpen(true)}>
                  <Plus aria-hidden />
                  Add knowledge
                </Button>
              </>
            ) : undefined
          }
        />

        {resolvingView ? (
          <KBSkeleton />
        ) : !configured ? (
          <NotConfiguredCard />
        ) : (
          <>
            <StorageStrip itemCount={allItems.length} usage={usage} account={account} />

            <Tabs value={view} onValueChange={(v) => setView(v as typeof view)}>
              <TabsList>
                <TabsTrigger value="knowledge" className="gap-1.5">
                  <LibraryBig aria-hidden className="h-4 w-4" />
                  Knowledge
                  <span className="tabular-nums text-muted-foreground">{allItems.length}</span>
                </TabsTrigger>
                <TabsTrigger value="files" className="gap-1.5">
                  <Paperclip aria-hidden className="h-4 w-4" />
                  Files
                  <span className="tabular-nums text-muted-foreground">
                    {usage?.files ?? "—"}
                  </span>
                </TabsTrigger>
              </TabsList>

              {/* forceMount keeps both views (and their state) alive across switches. */}
              <TabsContent
                value="knowledge"
                forceMount
                className="data-[state=inactive]:hidden mt-4 space-y-4"
              >
                {/* Search + type filter pills. */}
                <div className="space-y-3">
                  <div className="relative">
                    <Search
                      aria-hidden
                      className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search titles, tags, categories and content…"
                      aria-label="Search knowledge"
                      className="pr-9 pl-9"
                    />
                    {searchLoading && (
                      <Loader2
                        aria-hidden
                        className="absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
                      />
                    )}
                  </div>
                  <div
                    className="flex flex-wrap items-center gap-1.5"
                    role="group"
                    aria-label="Filter knowledge by type"
                  >
                    {KB_TYPE_FILTERS.map((f) => {
                      const active = typeFilter === f.value;
                      return (
                        <button
                          key={f.value}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setTypeFilter(f.value)}
                          className={cn(
                            "inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors",
                            active
                              ? "border-primary/30 bg-primary/10 text-primary"
                              : "border-border text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                          )}
                        >
                          {f.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {listError ? (
                  <Alert variant="destructive">
                    <AlertTitle>Could not load the Knowledge Base</AlertTitle>
                    <AlertDescription>{listError}</AlertDescription>
                  </Alert>
                ) : listLoading && allItems.length === 0 ? (
                  <div className="space-y-3">
                    {[0, 1, 2, 3].map((i) => (
                      <Skeleton key={i} className="h-28 w-full rounded-xl" />
                    ))}
                  </div>
                ) : searching && searchResults === null ? (
                  // First search in flight (results not in yet) — skeletons,
                  // never a premature "no matches". Re-searches keep the
                  // previous results visible until the new ones land.
                  <div className="space-y-3" aria-busy="true" aria-label="Searching">
                    {[0, 1, 2].map((i) => (
                      <Skeleton key={i} className="h-28 w-full rounded-xl" />
                    ))}
                  </div>
                ) : displayed.length === 0 ? (
                  <KnowledgeEmptyState
                    searching={searching}
                    query={debounced.trim()}
                    typeFilter={typeFilter}
                    onClearSearch={() => setQuery("")}
                    onAdd={() => setAddOpen(true)}
                  />
                ) : (
                  <div className="scrollbar-thin max-h-[65dvh] space-y-3 overflow-y-auto pr-1">
                    {displayed.map((item) => {
                      const result = searching ? searchMap.get(item.id) : undefined;
                      return (
                        <KnowledgeItemCard
                          key={item.id}
                          item={item}
                          excerpt={result?.excerpt}
                          matchedOn={result?.matchedOn}
                          copying={copyingId === item.id}
                          onOpen={(i) => setDialog({ itemId: i.id, edit: false })}
                          onEdit={(i) => setDialog({ itemId: i.id, edit: true })}
                          onCopy={copyItem}
                          onDelete={deleteItem}
                        />
                      );
                    })}
                  </div>
                )}
              </TabsContent>

              <TabsContent
                value="files"
                forceMount
                className="data-[state=inactive]:hidden mt-4"
              >
                <KBFilesView clients={clients} refreshKey={refreshKey} onChanged={refresh} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>

      {/* Dialogs (portalled) */}
      {clients && userId && (
        <>
          <KBAddDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            kv={clients.kv}
            userId={userId}
            onSaved={refresh}
          />
          <KBItemDialog
            open={dialog !== null}
            onOpenChange={(o) => {
              if (!o) setDialog(null);
            }}
            kv={clients.kv}
            userId={userId}
            itemId={dialog?.itemId ?? null}
            summary={dialogSummary}
            initialEdit={dialog?.edit ?? false}
            onSaved={refresh}
            onDeleted={refresh}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Knowledge card.
// ---------------------------------------------------------------------------

interface KnowledgeItemCardProps {
  item: KBItemSummary;
  excerpt?: string;
  matchedOn?: string[];
  copying: boolean;
  onOpen: (item: KBItemSummary) => void;
  onEdit: (item: KBItemSummary) => void;
  onCopy: (item: KBItemSummary) => void | Promise<void>;
  onDelete: (item: KBItemSummary) => void | Promise<void>;
}

function KnowledgeItemCard({
  item,
  excerpt,
  matchedOn,
  copying,
  onOpen,
  onEdit,
  onCopy,
  onDelete,
}: KnowledgeItemCardProps) {
  return (
    <article className="group rounded-xl border border-border bg-card p-4 transition-colors hover:border-foreground/20 sm:p-5">
      <div className="flex items-start justify-between gap-2">
        {/* The whole title block opens the detail dialog (large touch target). */}
        <button
          type="button"
          onClick={() => onOpen(item)}
          aria-label={`Open “${item.title}”`}
          className="min-w-0 flex-1 cursor-pointer rounded-md text-left focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
        >
          <div className="flex flex-wrap items-center gap-2">
            <TypeBadge type={item.type} />
            {item.source === "ai" ? <AISavedBadge /> : null}
            {item.category ? (
              <span className="max-w-48 truncate text-xs text-muted-foreground">
                {item.category}
              </span>
            ) : null}
          </div>
          <h3 className="mt-2 truncate text-[15px] font-medium text-foreground">{item.title}</h3>
        </button>
        {/* min-h/w-11 = 44px touch targets (spec); visually calm ghost buttons. */}
        <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <IconButton
            size="icon"
            className="min-h-11 min-w-11"
            aria-label={`Open “${item.title}”`}
            onClick={() => onOpen(item)}
          >
            <Eye aria-hidden />
          </IconButton>
          <IconButton
            size="icon"
            className="min-h-11 min-w-11"
            aria-label={`Edit “${item.title}”`}
            onClick={() => onEdit(item)}
          >
            <Pencil aria-hidden />
          </IconButton>
          <IconButton
            size="icon"
            className="min-h-11 min-w-11"
            aria-label={`Copy content of “${item.title}”`}
            disabled={copying}
            onClick={() => void onCopy(item)}
          >
            {copying ? (
              <Loader2 aria-hidden className="animate-spin" />
            ) : (
              <Copy aria-hidden />
            )}
          </IconButton>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <IconButton
                size="icon"
                className="min-h-11 min-w-11 text-muted-foreground hover:text-destructive"
                aria-label={`Delete “${item.title}”`}
              >
                <Trash2 aria-hidden />
              </IconButton>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this knowledge?</AlertDialogTitle>
                <AlertDialogDescription>
                  “{item.title}” will be permanently removed from the workspace Knowledge Base.
                  This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => void onDelete(item)}
                >
                  <Trash2 aria-hidden />
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {excerpt ? (
        <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
          {excerpt}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <TagChips tags={item.tags} />
        <p className="text-xs text-muted-foreground">
          {matchedOn && matchedOn.length > 0 ? (
            <span className="mr-2 text-primary/80">matched in {matchedOn.join(" · ")}</span>
          ) : null}
          Updated {timeAgo(item.updatedAt)}
        </p>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Storage strip.
// ---------------------------------------------------------------------------

function StorageStrip({
  itemCount,
  usage,
  account,
}: {
  itemCount: number;
  usage: OnyxBaseUsage | null;
  account: string | null;
}) {
  return (
    <section
      aria-label="Knowledge Base storage"
      className="flex flex-wrap items-center gap-x-6 gap-y-2.5 rounded-xl border border-border bg-card px-4 py-3"
    >
      <div className="flex items-center gap-2 text-sm">
        <LibraryBig aria-hidden className="h-4 w-4 text-primary" />
        <span className="font-semibold tabular-nums text-foreground">{itemCount}</span>
        <span className="text-muted-foreground">
          {itemCount === 1 ? "knowledge item" : "knowledge items"}
        </span>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <Paperclip aria-hidden className="h-4 w-4 text-muted-foreground" />
        <span className="font-semibold tabular-nums text-foreground">{usage?.files ?? "—"}</span>
        <span className="text-muted-foreground">hosted files</span>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <Database aria-hidden className="h-4 w-4 text-muted-foreground" />
        <span className="font-semibold tabular-nums text-foreground">
          {formatBytes(usage?.fileBytes)}
        </span>
        <span className="text-muted-foreground">file storage</span>
      </div>
      <span className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
        <Cloud aria-hidden className="h-3 w-3 shrink-0" />
        OnyxBase{account ? ` · ${account}` : ""}
      </span>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Empty states.
// ---------------------------------------------------------------------------

function KnowledgeEmptyState({
  searching,
  query,
  typeFilter,
  onClearSearch,
  onAdd,
}: {
  searching: boolean;
  query: string;
  typeFilter: KBItemType | "all";
  onClearSearch: () => void;
  onAdd: () => void;
}) {
  if (searching) {
    return (
      <EmptyState
        icon={<SearchX aria-hidden className="h-5 w-5 text-muted-foreground" />}
        title={`No matches for “${query}”`}
        hint="Try different keywords, or clear the search to browse everything."
        action={
          <Button variant="outline" size="sm" onClick={onClearSearch}>
            Clear search
          </Button>
        }
      />
    );
  }
  if (typeFilter !== "all") {
    const label = KB_TYPE_META[typeFilter].toLowerCase();
    return (
      <EmptyState
        icon={<LibraryBig aria-hidden className="h-5 w-5 text-muted-foreground" />}
        title={`No ${label} items yet`}
        hint="Items the AI saves with this type will appear here — or add one yourself."
        action={
          <Button variant="outline" size="sm" onClick={onAdd}>
            <Plus aria-hidden />
            Add knowledge
          </Button>
        }
      />
    );
  }
  return (
    <EmptyState
      icon={<LibraryBig aria-hidden className="h-5 w-5 text-muted-foreground" />}
      title="No knowledge yet"
      hint="The AI saves important workspace knowledge here automatically — decisions, conventions, research and memories that outlive the chat. You can add your own too."
      action={
        <Button size="sm" onClick={onAdd}>
          <Plus aria-hidden />
          Add knowledge
        </Button>
      }
    />
  );
}

function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-14 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-foreground/[0.04]">
        {icon}
      </div>
      <h3 className="mt-4 font-display text-base font-semibold text-foreground">{title}</h3>
      {hint ? (
        <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Not-configured setup card + loading skeleton.
// ---------------------------------------------------------------------------

function NotConfiguredCard() {
  return (
    <section className="rounded-2xl border border-foreground/10 bg-card px-6 py-14 text-center sm:py-16">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
        <LibraryBig aria-hidden className="h-6 w-6 text-primary" />
      </div>
      <h2 className="mt-5 font-display text-lg font-semibold tracking-tight text-foreground">
        Connect OnyxBase to enable the Knowledge Base
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        The Knowledge Base persists workspace knowledge in your own OnyxBase account — it survives
        chats, sessions and restarts.
      </p>
      <Button asChild className="mt-6">
        <Link href={ROUTES.SETTINGS_CLOUD}>
          Connect OnyxBase
          <ArrowRight aria-hidden />
        </Link>
      </Button>
    </section>
  );
}

function KBSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading the Knowledge Base">
      <div className="space-y-2">
        <Skeleton className="h-3.5 w-20" />
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-14 w-full rounded-xl" />
      <Skeleton className="h-9 w-72 rounded-lg" />
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
