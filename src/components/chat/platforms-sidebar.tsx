"use client";

// ============================================================================
// PlatformsSidebar — the Composio platform catalog docked beside the chat.
//
// Rendered inside the chat workspace's DockedPanel (desktop split layout) or
// its mobile drawer. The chat page only mounts this panel when a Composio
// API key is stored (Settings → Integrations), so the catalog is always
// reachable from chat — search (server-side), sort (popularity / A→Z / Z→A),
// category + connection filters, and a DIRECT OAuth connect flow:
//
//   Connect → /api/composio/connect-platform → OAuth tab opens → we poll
//   /api/composio/connections until the platform flips to active → toast.
//
// Security mirrors the settings section: the vault-encrypted API key is
// decrypted transiently per call (resolveComposioHeaders) and only ever
// travels as the `x-composio-key` header to our own proxy routes.
// ============================================================================

import * as React from "react";
import { toast } from "sonner";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  Blocks,
  CheckCircle2,
  ExternalLink,
  Flame,
  Loader2,
  Plug,
  RefreshCw,
  Search,
  SearchX,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks";
import {
  apiComposioConnectPlatform,
  apiComposioConnections,
  apiComposioToolkits,
  persistComposioSessionId,
  resolveComposioHeaders,
  type ComposioConnectionItem,
  type ComposioToolkitCard,
} from "@/lib/composio/browser";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types + helpers
// ---------------------------------------------------------------------------

/** Per-toolkit aggregated connection state shown on a row. */
type RowState = "disconnected" | "connecting" | "connected" | "reconnect";

type SortChoice = "popular" | "az" | "za";
type ConnFilter = "all" | "connected" | "disconnected";

interface CategoryChip {
  id: string;
  name: string;
}

const PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MS = 400;
const AUTH_POLL_INTERVAL_MS = 4_000;
const AUTH_POLL_MAX_TRIES = 45; // ~3 minutes

function rowStateBadgeClasses(state: RowState): string {
  switch (state) {
    case "connected":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    case "connecting":
      return "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
    case "reconnect":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    default:
      return "border-border bg-muted/50 text-muted-foreground";
  }
}

function rowStateLabel(state: RowState): string {
  switch (state) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "reconnect":
      return "Reconnect";
    default:
      return "Not connected";
  }
}

/** Best state across possibly-multiple accounts of one toolkit. */
function bestRowState(items: ComposioConnectionItem[]): RowState {
  const states = items.map((i) => i.state);
  if (states.includes("active")) return "connected";
  if (states.includes("initializing")) return "connecting";
  if (states.includes("expired") || states.includes("error")) return "reconnect";
  return "disconnected";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PlatformsSidebar() {
  const { user } = useAuth();
  const userId = user?.id;

  // ── catalog state ───────────────────────────────────────────────────────
  const [toolkits, setToolkits] = React.useState<ComposioToolkitCard[]>([]);
  const [categories, setCategories] = React.useState<CategoryChip[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [totalItems, setTotalItems] = React.useState<number | null>(null);
  const [catalogLoading, setCatalogLoading] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  /** Set when the catalog REQUEST failed (never render a failed load as
   *  "No platforms found" — the count-vs-grid mismatch bug). */
  const [catalogError, setCatalogError] = React.useState<string | null>(null);

  // ── controls ────────────────────────────────────────────────────────────
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [sort, setSort] = React.useState<SortChoice>("popular");
  const [connFilter, setConnFilter] = React.useState<ConnFilter>("all");
  const [activeCategory, setActiveCategory] = React.useState("");

  // ── connections + OAuth flow ────────────────────────────────────────────
  const [connections, setConnections] = React.useState<ComposioConnectionItem[]>([]);
  const [connectingSlug, setConnectingSlug] = React.useState<string | null>(null);
  const [awaitingAuth, setAwaitingAuth] = React.useState<Set<string>>(new Set());
  /** OAuth link surfaced inline when the browser blocked the new tab. */
  const [blockedLink, setBlockedLink] = React.useState<{ toolkit: string; url: string } | null>(null);

  // Debounce the search box → server-side catalog search.
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  /** Load one catalog page (server-side search + category + sort + cursor). */
  const loadCatalog = React.useCallback(
    async (opts: { cursor?: string; append?: boolean } = {}) => {
      if (!userId) return;
      // resolveComposioHeaders reads the vault DIRECTLY — the authoritative
      // check (never trust a stale `hasStoredKey` closure).
      const headers = await resolveComposioHeaders(userId);
      if (!headers) return;
      const setLoading = opts.append ? setLoadingMore : setCatalogLoading;
      setLoading(true);
      if (!opts.append) setCatalogError(null);
      try {
        const r = await apiComposioToolkits(headers, {
          cursor: opts.cursor,
          search: debouncedSearch || undefined,
          category: activeCategory || undefined,
          // popular → Composio usage order; az/za → alphabetical (za reverses
          // the page client-side below).
          sortBy: sort === "popular" ? "usage" : "alphabetically",
          limit: PAGE_SIZE,
          withCategories: !opts.append && !opts.cursor,
        });
        let items = r.items;
        if (sort === "za") items = [...items].reverse();
        setToolkits((prev) => (opts.append ? [...prev, ...items] : items));
        setNextCursor(r.nextCursor);
        setTotalItems(r.totalItems);
        setCatalogError(null);
        if (r.categories) setCategories(r.categories);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Composio request failed";
        if (!opts.append) {
          setToolkits([]);
          setCatalogError(message);
        }
        toast.error("Could not load the platform catalog", {
          description: message,
          icon: <XCircle className="size-4" />,
        });
      } finally {
        setLoading(false);
      }
    },
    [userId, debouncedSearch, activeCategory, sort],
  );

  /** Refresh the sanitized connected-account list. */
  const refreshConnections = React.useCallback(async () => {
    if (!userId) return;
    const headers = await resolveComposioHeaders(userId);
    if (!headers) return;
    try {
      const r = await apiComposioConnections(headers);
      setConnections(r.items);
    } catch {
      // Non-fatal — rows fall back to "Not connected".
    }
  }, [userId]);

  // Initial load (the panel mounts on first open): connections + catalog.
  React.useEffect(() => {
    if (!userId) return;
    void refreshConnections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // Re-query the catalog when search / category / sort changes. Exactly one
  // fetch per control change (no mount double-fetch: this effect IS the
  // initial catalog load too).
  React.useEffect(() => {
    void loadCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, activeCategory, sort, userId]);

  // OAuth completion poller — while platforms are awaiting authorization.
  React.useEffect(() => {
    if (awaitingAuth.size === 0) return;
    let tries = 0;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      tries++;
      if (!userId) return;
      const headers = await resolveComposioHeaders(userId);
      if (!headers) return;
      try {
        const r = await apiComposioConnections(headers);
        if (cancelled) return;
        setConnections(r.items);
        const done = [...awaitingAuth].filter((slug) => {
          const items = r.items.filter((i) => i.toolkit === slug);
          return items.length > 0 && bestRowState(items) === "connected";
        });
        if (done.length > 0) {
          setAwaitingAuth((prev) => {
            const next = new Set(prev);
            for (const slug of done) next.delete(slug);
            return next;
          });
          for (const slug of done) {
            const name = toolkits.find((t) => t.slug === slug)?.name ?? slug;
            toast.success(`${name} connected`, {
              description: "The platform authorized successfully — the agent can use it now.",
              icon: <CheckCircle2 className="size-4" />,
            });
          }
        } else if (tries >= AUTH_POLL_MAX_TRIES) {
          setAwaitingAuth(new Set());
          toast.info("Still waiting for authorization", {
            description: "Finish the authorization in the Composio tab, then hit Refresh.",
          });
        }
      } catch {
        // transient — keep polling
      }
    };
    void tick();
    const interval = setInterval(tick, AUTH_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingAuth]);

  // ── handlers ────────────────────────────────────────────────────────────

  /** Connect one platform from chat: OAuth link → new tab → poll to active. */
  async function handleConnectPlatform(slug: string) {
    if (!userId) return;
    const headers = await resolveComposioHeaders(userId);
    if (!headers) {
      toast.error("Connect Composio first", {
        description: "Add your Composio API key in Settings → Integrations.",
      });
      return;
    }
    setConnectingSlug(slug);
    setBlockedLink(null);
    try {
      const r = await apiComposioConnectPlatform(headers, slug);
      if (r.sessionId) await persistComposioSessionId(userId, r.sessionId);
      const url = r.redirectUrl;
      const opened = window.open(url, "_blank", "noopener,noreferrer");
      if (!opened) {
        // Popup blocked — surface the link on the row so the user can act.
        setBlockedLink({ toolkit: slug, url });
        toast.info("Open the authorization link", {
          description: "Your browser blocked the new tab — use the link shown on the row.",
          duration: 10_000,
        });
      }
      setAwaitingAuth((prev) => new Set(prev).add(slug));
    } catch (err) {
      toast.error("Could not start the connection", {
        description: err instanceof Error ? err.message : "Composio request failed",
        icon: <XCircle className="size-4" />,
      });
    } finally {
      setConnectingSlug(null);
    }
  }

  async function handleLoadMore() {
    if (!nextCursor) return;
    await loadCatalog({ cursor: nextCursor, append: true });
  }

  /** Manual refresh: connections + the current catalog query. */
  async function handleRefresh() {
    await Promise.all([refreshConnections(), loadCatalog()]);
  }

  // ── derived ─────────────────────────────────────────────────────────────

  const connectionsBySlug = React.useMemo(() => {
    const map = new Map<string, ComposioConnectionItem[]>();
    for (const c of connections) {
      const list = map.get(c.toolkit) ?? [];
      list.push(c);
      map.set(c.toolkit, list);
    }
    return map;
  }, [connections]);

  function rowStateFor(slug: string): RowState {
    if (awaitingAuth.has(slug)) return "connecting";
    const items = connectionsBySlug.get(slug);
    if (!items?.length) return "disconnected";
    return bestRowState(items);
  }

  const activeConnections = connections.filter((c) => c.state === "active").length;

  /** Client-side connection filter applied to the fetched page. */
  const visibleToolkits = React.useMemo(() => {
    if (connFilter === "all") return toolkits;
    return toolkits.filter((t) => {
      const state = rowStateFor(t.slug);
      const isConnected = state === "connected";
      return connFilter === "connected" ? isConnected : !isConnected;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolkits, connFilter, connectionsBySlug, awaitingAuth]);

  const hasActiveQuery = !!(debouncedSearch || activeCategory || connFilter !== "all");

  // ── render ──────────────────────────────────────────────────────────────

  return (
    <div className="bg-card flex h-full min-h-0 flex-col" aria-label="Composio platforms">
      {/* Header */}
      <div className="border-border space-y-2 border-b px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Blocks className="h-4 w-4" aria-hidden />
            Platforms
            {totalItems != null && (
              <span className="text-muted-foreground text-[11px] font-normal">
                · {activeConnections} connected
              </span>
            )}
          </h3>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void handleRefresh()}
            disabled={catalogLoading}
            className="h-8 w-8 p-0"
            title="Refresh platforms"
            aria-label="Refresh platforms"
          >
            <RefreshCw className={cn("h-4 w-4", catalogLoading && "animate-spin")} />
          </Button>
        </div>

        {/* Search (server-side) */}
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search platforms…"
            className="h-8 pl-8 text-xs"
            aria-label="Search platforms"
          />
        </div>

        {/* Sort + connection filter */}
        <div className="flex items-center gap-1.5">
          <Select value={sort} onValueChange={(v) => setSort(v as SortChoice)}>
            <SelectTrigger
              className="text-muted-foreground h-8 flex-1 gap-1 text-xs"
              aria-label="Sort platforms"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="popular">
                <span className="flex items-center gap-1.5">
                  <Flame className="size-3.5" aria-hidden /> Popular
                </span>
              </SelectItem>
              <SelectItem value="az">
                <span className="flex items-center gap-1.5">
                  <ArrowDownAZ className="size-3.5" aria-hidden /> A → Z
                </span>
              </SelectItem>
              <SelectItem value="za">
                <span className="flex items-center gap-1.5">
                  <ArrowUpAZ className="size-3.5" aria-hidden /> Z → A
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
          <div
            className="border-border bg-muted/30 flex shrink-0 items-center rounded-md border p-0.5"
            role="group"
            aria-label="Filter by connection"
          >
            {(
              [
                ["all", "All"],
                ["connected", "On"],
                ["disconnected", "Off"],
              ] as Array<[ConnFilter, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setConnFilter(value)}
                aria-pressed={connFilter === value}
                className={cn(
                  "rounded px-2 py-1 text-[11px] font-medium transition-colors",
                  connFilter === value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Category chips (real Composio metadata, server-side filter) */}
        {categories.length > 0 && (
          <div className="scrollbar-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
            <button
              type="button"
              onClick={() => setActiveCategory("")}
              className={cn(
                "shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                activeCategory === ""
                  ? "border-primary bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground border-border",
              )}
            >
              All
            </button>
            {categories.slice(0, 14).map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setActiveCategory(activeCategory === c.id ? "" : c.id)}
                className={cn(
                  "shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  activeCategory === c.id
                    ? "border-primary bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground border-border",
                )}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Platform list */}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {catalogLoading && toolkits.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="text-muted-foreground size-5 animate-spin" aria-label="Loading platforms" />
          </div>
        ) : catalogError ? (
          /* EXPLICIT ERROR STATE — a failed load is never "No platforms found". */
          <div className="border-destructive/30 bg-destructive/5 mx-2 rounded-lg border px-4 py-8 text-center">
            <XCircle className="text-destructive mx-auto size-5" aria-hidden />
            <p className="mt-2 text-sm font-medium">Could not load platforms</p>
            <p className="text-muted-foreground mx-auto mt-1 max-w-xs text-xs">{catalogError}</p>
            <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void loadCatalog()}>
              <RefreshCw className="size-3.5" />
              Retry
            </Button>
          </div>
        ) : visibleToolkits.length === 0 ? (
          <div className="text-muted-foreground mx-2 rounded-lg border border-dashed px-4 py-8 text-center">
            <SearchX className="mx-auto size-5" aria-hidden />
            <p className="mt-2 text-sm font-medium">
              {hasActiveQuery ? "No platforms match" : "No platforms found"}
            </p>
            <p className="mt-1 text-xs">
              {hasActiveQuery
                ? "Try a different search, category, or filter."
                : "Your Composio catalog returned no toolkits."}
            </p>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {visibleToolkits.map((t) => (
              <PlatformRow
                key={t.slug}
                toolkit={t}
                state={rowStateFor(t.slug)}
                busy={connectingSlug === t.slug}
                authLink={blockedLink?.toolkit === t.slug ? blockedLink.url : null}
                onConnect={() => void handleConnectPlatform(t.slug)}
              />
            ))}
            {nextCursor && (
              <li className="flex justify-center pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleLoadMore()}
                  disabled={loadingMore}
                >
                  {loadingMore ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Load more
                </Button>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Platform row
// ---------------------------------------------------------------------------

function PlatformRow({
  toolkit,
  state,
  busy,
  authLink,
  onConnect,
}: {
  toolkit: ComposioToolkitCard;
  state: RowState;
  busy: boolean;
  /** Inline authorization link (popup-blocked connect). */
  authLink: string | null;
  onConnect: () => void;
}) {
  const label =
    state === "connected"
      ? "Open"
      : state === "reconnect"
        ? "Reconnect"
        : state === "connecting"
          ? "Connecting…"
          : "Connect";

  return (
    <li
      className={cn(
        "rounded-lg border p-2.5 transition-colors",
        state === "connected"
          ? "border-emerald-500/30 bg-emerald-500/[0.03]"
          : "border-border bg-background hover:border-foreground/20",
      )}
    >
      <div className="flex items-center gap-2.5">
        {toolkit.logo ? (
          // Remote Composio CDN logos (many domains) — plain img by design.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={toolkit.logo}
            alt=""
            aria-hidden
            className="size-8 shrink-0 rounded-md bg-white object-contain p-0.5"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
            <Blocks className="size-4" aria-hidden />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium">{toolkit.name}</p>
          <p className="text-muted-foreground truncate text-[11px]">
            {toolkit.noAuth ? "no auth needed" : `${toolkit.toolsCount} tools`}
          </p>
        </div>
        {/* Right action: Open (connected + app url) / Connecting / Connect */}
        {state === "connected" ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant="outline" className={cn("gap-1 text-[10px]", rowStateBadgeClasses(state))}>
              <CheckCircle2 className="size-3" aria-hidden />
              {rowStateLabel(state)}
            </Badge>
            {toolkit.appUrl && (
              <a
                href={toolkit.appUrl}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label={`Open ${toolkit.name}`}
                title={`Open ${toolkit.name}`}
              >
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            )}
          </div>
        ) : state === "connecting" ? (
          <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1 px-2 text-[11px]" disabled>
            <Loader2 className="size-3 animate-spin" aria-hidden />
            {label}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 gap-1 px-2 text-[11px]"
            onClick={onConnect}
            disabled={busy}
            aria-label={`Connect ${toolkit.name}`}
          >
            {busy ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Plug className="size-3" aria-hidden />}
            {label}
          </Button>
        )}
      </div>

      {/* Popup-blocked fallback: inline authorization link on the row. */}
      {authLink && state !== "connected" && (
        <a
          href={authLink}
          target="_blank"
          rel="noreferrer"
          className="text-primary mt-2 block truncate text-[11px] font-medium underline underline-offset-2"
        >
          Open authorization link
        </a>
      )}
    </li>
  );
}

export default PlatformsSidebar;
