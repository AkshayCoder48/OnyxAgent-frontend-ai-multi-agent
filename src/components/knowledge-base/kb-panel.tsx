"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowRight,
  ExternalLink,
  FileText,
  LibraryBig,
  Link2,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SearchX,
  Trash2,
} from "lucide-react";

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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks";
import { useAuthStore } from "@/stores";
import { ROUTES } from "@/lib/constants";
import { cn } from "@/lib/utils";
import {
  formatBytes,
  type OnyxBaseFile,
  type OnyxBaseFileLink,
} from "@/lib/onyxbase/files-client";
import {
  kbDelete,
  kbList,
  kbSearch,
  resolveKBClients,
  type KBClients,
  type KBItemSummary,
  type KBItemType,
  type KBSearchResult,
} from "@/lib/onyxbase/kb-store";
import { KBAddDialog } from "./kb-add-dialog";
import { KBItemDialog } from "./kb-item-dialog";
import {
  AISavedBadge,
  KB_TYPE_FILTERS,
  KB_TYPE_META,
  TagChips,
  TypeBadge,
  kbErrorMessage,
  timeAgo,
} from "./kb-shared";

type KBView = "knowledge" | "files";

/**
 * KnowledgeBasePanel — the compact, panel-adapted sibling of the Knowledge
 * Base page (knowledge-base-page.tsx), built for the ~300–640px docked
 * right-hand column of the chat workspace. Same data contract (resolveKBClients
 * + kbList/kbSearch + the OnyxBase files API) and the same dialogs
 * (KBItemDialog / KBAddDialog), condensed to a fixed header, a segmented
 * Knowledge/Files switcher, search + type pills and compact rows with 44px
 * touch targets. Not the page: no PageHeader, no max-w-5xl, no page-scale
 * empty states.
 */
export function KnowledgeBasePanel() {
  // useAuth (not the raw store) — its mount effect runs authStore.init(),
  // avoiding the cold-navigation hydration race (same pattern as the KB page
  // and the Cloud settings section). authResolved gates client resolution.
  const { user } = useAuth();
  const authResolved = useAuthStore((s) => s.authResolved);
  const userId = user?.id ?? null;

  const [clients, setClients] = React.useState<KBClients | null>(null);
  const [resolving, setResolving] = React.useState(true);

  const [view, setView] = React.useState<KBView>("knowledge");
  const [query, setQuery] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState<KBItemType | "all">("all");

  const [allItems, setAllItems] = React.useState<KBItemSummary[]>([]);
  const [listLoading, setListLoading] = React.useState(true);
  const [listError, setListError] = React.useState<string | null>(null);
  const [searchResults, setSearchResults] = React.useState<KBSearchResult[] | null>(null);
  const [searchLoading, setSearchLoading] = React.useState(false);

  /** Hosted-file count for the Files tab badge (fed by the files view). */
  const [fileCount, setFileCount] = React.useState<number | null>(null);

  const [addOpen, setAddOpen] = React.useState(false);
  const [dialog, setDialog] = React.useState<{ itemId: string; edit: boolean } | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);

  const configured = clients !== null;
  const resolvingView = resolving || !authResolved || !userId;
  const searching = debounced.trim().length > 0;
  const busy = resolvingView || listLoading || searchLoading;

  const refresh = React.useCallback(() => setRefreshKey((k) => k + 1), []);

  // Debounce the search input (~300ms), same cadence as the page.
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

  // Full knowledge list (newest first) — powers the browse list and the
  // Knowledge tab badge. The panel mounts with each open, so this doubles as
  // the "refresh on open" behaviour.
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

  const filteredItems = React.useMemo(
    () => (typeFilter === "all" ? allItems : allItems.filter((i) => i.type === typeFilter)),
    [allItems, typeFilter],
  );

  /** What the list shows: search hits when searching, else the filtered list. */
  const displayed: KBItemSummary[] = searching ? (searchResults ?? []) : filteredItems;

  const dialogSummary = React.useMemo(
    () => (dialog ? (allItems.find((i) => i.id === dialog.itemId) ?? null) : null),
    [dialog, allItems],
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
    <div className="bg-card flex h-full min-h-0 flex-col">
      {/* Header — fixed (never scrolls away), matching the sibling panels. */}
      <div className="fluid-bar border-border flex h-12 shrink-0 items-center justify-between gap-1.5 border-b px-3">
        <div className="flex min-w-0 items-center gap-2">
          <LibraryBig aria-hidden className="text-muted-foreground h-4 w-4 shrink-0" />
          <h3 className="truncate text-sm font-semibold leading-tight text-foreground">
            Knowledge Base
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="animate-press fluid-chip text-muted-foreground hover:text-foreground h-8 w-8 p-0"
          >
            <Link
              href={ROUTES.KNOWLEDGE_BASE}
              title="Open the full Knowledge Base page"
              aria-label="Open the full Knowledge Base page"
            >
              <ExternalLink aria-hidden className="h-4 w-4" />
            </Link>
          </Button>
          {configured && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={refresh}
                disabled={busy}
                className="animate-press fluid-chip text-muted-foreground hover:text-foreground h-8 w-8 p-0"
                title="Refresh"
                aria-label="Refresh the Knowledge Base"
              >
                <RefreshCw aria-hidden className={cn("h-4 w-4", busy && "animate-spin")} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAddOpen(true)}
                className="animate-press fluid-chip text-muted-foreground hover:text-foreground h-8 w-8 p-0"
                title="Add knowledge"
                aria-label="Add knowledge"
              >
                <Plus aria-hidden className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Controls — segmented Knowledge/Files switcher (+ search + type pills
          on the Knowledge view), fixed above the scrolling list. */}
      {configured && (
        <div className="space-y-2.5 border-border border-b px-3 py-2.5">
          <Tabs value={view} onValueChange={(v) => setView(v as KBView)}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="knowledge" className="gap-1.5 text-xs">
                <LibraryBig aria-hidden className="h-3.5 w-3.5" />
                Knowledge
                <span className="tabular-nums text-muted-foreground">{allItems.length}</span>
              </TabsTrigger>
              <TabsTrigger value="files" className="gap-1.5 text-xs">
                <Paperclip aria-hidden className="h-3.5 w-3.5" />
                Files
                <span className="tabular-nums text-muted-foreground">{fileCount ?? "—"}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {view === "knowledge" && (
            <>
              <div className="relative">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search knowledge…"
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
                        "inline-flex h-7 items-center rounded-full border px-2.5 text-[11px] font-medium transition-colors",
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
            </>
          )}
        </div>
      )}

      {/* The fixed scroll area — rows scroll inside this bounded container
          (the panel never grows unboundedly), styled scrollbar. */}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {resolvingView ? (
          <PanelSkeleton />
        ) : !configured ? (
          <NotConfiguredCard />
        ) : (
          <>
            {/* Knowledge view — kept mounted (hidden) while Files is shown,
                so switches are instant and the search state survives. */}
            <div className={cn(view !== "knowledge" && "hidden")}>
              {listError ? (
                <Alert variant="destructive">
                  <AlertTitle>Could not load the Knowledge Base</AlertTitle>
                  <AlertDescription>{listError}</AlertDescription>
                </Alert>
              ) : listLoading && allItems.length === 0 ? (
                <ListSkeleton />
              ) : searching && searchResults === null ? (
                // First search in flight — skeletons, never a premature
                // "no matches" (re-searches keep the stale results visible).
                <div aria-busy="true" aria-label="Searching">
                  <ListSkeleton />
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
                <div className="space-y-2.5">
                  {displayed.map((item) => {
                    const result = searching
                      ? searchResults?.find((r) => r.id === item.id)
                      : undefined;
                    return (
                      <KnowledgeRow
                        key={item.id}
                        item={item}
                        excerpt={result?.excerpt}
                        matchedOn={result?.matchedOn}
                        onOpen={(i) => setDialog({ itemId: i.id, edit: false })}
                        onEdit={(i) => setDialog({ itemId: i.id, edit: true })}
                        onDelete={deleteItem}
                      />
                    );
                  })}
                </div>
              )}
            </div>

            {/* Files view — loads its own list, reports the count up for the
                tab badge, stays mounted (hidden) while Knowledge is shown. */}
            <div className={cn(view !== "files" && "hidden")}>
              <KBFilesCompact
                clients={clients}
                refreshKey={refreshKey}
                onChanged={refresh}
                onCount={setFileCount}
              />
            </div>
          </>
        )}
      </div>

      {/* Dialogs (portalled) — the same ones the full page uses. */}
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
// Compact knowledge row.
// ---------------------------------------------------------------------------

interface KnowledgeRowProps {
  item: KBItemSummary;
  excerpt?: string;
  matchedOn?: string[];
  onOpen: (item: KBItemSummary) => void;
  onEdit: (item: KBItemSummary) => void;
  onDelete: (item: KBItemSummary) => void | Promise<void>;
}

function KnowledgeRow({ item, excerpt, matchedOn, onOpen, onEdit, onDelete }: KnowledgeRowProps) {
  return (
    <article className="group rounded-lg border border-border bg-card p-2.5 transition-colors hover:border-foreground/20">
      <div className="flex items-start justify-between gap-1">
        {/* The whole text block opens the detail dialog (large touch target). */}
        <button
          type="button"
          onClick={() => onOpen(item)}
          aria-label={`Open “${item.title}”`}
          className="min-w-0 flex-1 cursor-pointer rounded-md py-1 text-left focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <TypeBadge type={item.type} />
            {item.source === "ai" ? <AISavedBadge /> : null}
          </div>
          <h4 className="mt-1.5 truncate text-sm font-medium text-foreground">{item.title}</h4>
        </button>
        {/* min-h/w-11 = 44px touch targets (spec); visually calm ghost buttons. */}
        <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <IconButton
            size="icon"
            className="min-h-11 min-w-11"
            aria-label={`Edit “${item.title}”`}
            onClick={() => onEdit(item)}
          >
            <Pencil aria-hidden />
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
        <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {excerpt}
        </p>
      ) : null}

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1.5">
        <TagChips tags={item.tags} max={3} />
        <p className="text-[11px] text-muted-foreground">
          {matchedOn && matchedOn.length > 0 ? (
            <span className="mr-1.5 text-primary/80">matched in {matchedOn.join(" · ")}</span>
          ) : null}
          Updated {timeAgo(item.updatedAt)}
        </p>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Compact hosted-files view.
// ---------------------------------------------------------------------------

/** The file's human-facing name (label first, then original name). */
function fileLabel(f: OnyxBaseFile): string {
  return f.label || f.name || f.fileId || f.id;
}

/** Hosted-file share URL — proxyUrl preferred, made absolute when relative. */
function shareUrl(link: OnyxBaseFileLink, baseUrl: string): string {
  const url = link.proxyUrl || link.url;
  if (/^https?:\/\//i.test(url)) return url;
  return `${baseUrl.replace(/\/+$/, "")}${url.startsWith("/") ? "" : "/"}${url}`;
}

interface KBFilesCompactProps {
  clients: KBClients;
  /** Bumped by the parent's refresh / after mutations. */
  refreshKey: number;
  /** Notify the parent so the knowledge list / badges re-sync. */
  onChanged: () => void;
  /** Reports the hosted-file count up (Files tab badge). */
  onCount: (count: number) => void;
}

/** Compact Files tab — name + size rows, "Get link" (mint + copy) and a
 *  confirmed delete, per the kb-files-view logic in panel proportions. */
function KBFilesCompact({ clients, refreshKey, onChanged, onCount }: KBFilesCompactProps) {
  const [files, setFiles] = React.useState<OnyxBaseFile[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [mintingFor, setMintingFor] = React.useState<string | null>(null);
  const [deleteFile, setDeleteFile] = React.useState<OnyxBaseFile | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const reload = React.useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError(null);
      try {
        const listing = await clients.files.list();
        setFiles(listing.files);
        onCount(listing.files.length);
      } catch (e) {
        setError(kbErrorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [clients, onCount],
  );

  React.useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  async function copyLink(file: OnyxBaseFile) {
    setMintingFor(file.id);
    try {
      const fresh = await clients.files.mintLink(file.id);
      await navigator.clipboard.writeText(shareUrl(fresh, clients.baseUrl));
      toast.success("Link copied", {
        description: "Fresh signed link — expires in about 55 minutes.",
      });
    } catch (e) {
      toast.error("Could not copy the link", { description: kbErrorMessage(e) });
    } finally {
      setMintingFor(null);
    }
  }

  async function handleDelete() {
    if (!deleteFile) return;
    setDeleting(true);
    try {
      await clients.files.deleteFile(deleteFile.id);
      toast.success("File deleted", { description: fileLabel(deleteFile) });
      setDeleteFile(null);
      await reload(true);
      onChanged();
    } catch (e) {
      toast.error("Could not delete the file", { description: kbErrorMessage(e) });
    } finally {
      setDeleting(false);
    }
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not list hosted files</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (loading && files.length === 0) {
    return <ListSkeleton rowHeight="h-20" />;
  }

  if (files.length === 0) {
    return (
      <PanelEmptyState
        icon={<FileText aria-hidden className="h-5 w-5 text-muted-foreground" />}
        title="No files hosted yet"
        hint="The AI can host important files here via the Knowledge Base tool — they outlive the sandbox."
      />
    );
  }

  return (
    <div className="space-y-2.5">
      {files.map((f) => (
        <div
          key={f.id}
          className="rounded-lg border border-border bg-card p-2.5 transition-colors hover:border-foreground/20"
        >
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.04]">
              <FileText aria-hidden className="text-muted-foreground h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{fileLabel(f)}</p>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {formatBytes(f.size)}
                {" · "}
                uploaded {timeAgo(f.uploadedAt ?? f.createdAt)}
              </p>
            </div>
          </div>
          {/* 44px touch targets (spec): the primary "Get link" action is a
              full-width outline button, delete a square icon button. */}
          <div className="mt-2 flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-11 min-w-11 flex-1"
              disabled={mintingFor === f.id}
              onClick={() => void copyLink(f)}
            >
              {mintingFor === f.id ? (
                <Loader2 aria-hidden className="animate-spin" />
              ) : (
                <Link2 aria-hidden />
              )}
              Get link
            </Button>
            <IconButton
              size="icon"
              className="min-h-11 min-w-11 text-muted-foreground hover:text-destructive"
              aria-label={`Delete ${fileLabel(f)}`}
              onClick={() => setDeleteFile(f)}
            >
              <Trash2 aria-hidden />
            </IconButton>
          </div>
        </div>
      ))}

      <AlertDialog open={deleteFile !== null} onOpenChange={(o) => !o && setDeleteFile(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this file?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleteFile ? fileLabel(deleteFile) : "This file"}” will be permanently removed from
              OnyxBase storage. Existing links will stop working. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Keep the dialog open while the delete runs (no auto-close flash).
                e.preventDefault();
                void handleDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? <Loader2 aria-hidden className="animate-spin" /> : <Trash2 aria-hidden />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty states, setup card, skeletons.
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
      <PanelEmptyState
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
      <PanelEmptyState
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
    <PanelEmptyState
      icon={<LibraryBig aria-hidden className="h-5 w-5 text-muted-foreground" />}
      title="No knowledge yet"
      hint="The AI saves important workspace knowledge here automatically — you can add your own too."
      action={
        <Button size="sm" onClick={onAdd}>
          <Plus aria-hidden />
          Add knowledge
        </Button>
      }
    />
  );
}

function PanelEmptyState({
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
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed px-4 py-10 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-foreground/[0.04]">
        {icon}
      </div>
      <h4 className="mt-3 font-display text-sm font-semibold text-foreground">{title}</h4>
      {hint ? (
        <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

function NotConfiguredCard() {
  return (
    <section className="flex flex-col items-center justify-center rounded-xl border border-dashed px-5 py-10 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10">
        <LibraryBig aria-hidden className="text-primary h-6 w-6" />
      </div>
      <h3 className="mt-3.5 font-display text-sm font-semibold tracking-tight text-foreground">
        Connect OnyxBase to use the Knowledge Base
      </h3>
      <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-muted-foreground">
        Knowledge is persisted in your own OnyxBase account — it survives chats, sessions and
        restarts.
      </p>
      <Button asChild size="sm" className="mt-4">
        <Link href={ROUTES.SETTINGS_CLOUD}>
          Connect OnyxBase
          <ArrowRight aria-hidden />
        </Link>
      </Button>
    </section>
  );
}

function ListSkeleton({ rowHeight = "h-24" }: { rowHeight?: string }) {
  return (
    <div className="space-y-2.5" aria-busy="true" aria-label="Loading">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className={cn("w-full rounded-lg", rowHeight)} />
      ))}
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="space-y-2.5" aria-busy="true" aria-label="Loading the Knowledge Base">
      <Skeleton className="h-9 w-full rounded-lg" />
      <Skeleton className="h-9 w-2/3 rounded-lg" />
      <Skeleton className="h-7 w-1/2 rounded-full" />
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-24 w-full rounded-lg" />
      ))}
    </div>
  );
}
