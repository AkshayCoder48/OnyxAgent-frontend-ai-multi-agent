"use client";

/**
 * Settings → Integrations — Composio (external app platform).
 *
 * User workflow (per spec): Connect with a Composio API key (masked input +
 * reveal toggle) → key validated + session created via /api/composio/connect
 * (REAL verification — no fake "Connected ✓") → the platform catalog loads
 * from Composio metadata (first 100, "Load more" via cursor, server-side
 * search, category chips from Composio's real category list) → Connect on a
 * platform opens Composio's OAuth redirect URL in a NEW TAB (app state kept)
 * → the connection state polls until the platform flips to Connected ✓.
 *
 * Security: the API key is stored AES-GCM-encrypted in the browser vault and
 * only ever decrypted transiently to build the `x-composio-key` request
 * header for our own /api/composio/* proxy routes. It is never displayed
 * again after save, never logged, and never sent to the model.
 */

import * as React from "react";
import { toast } from "sonner";
import {
  Blocks,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  Loader2,
  Plug,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SectionCard } from "@/components/settings/settings-section";
import { MoreOptions } from "@/components/settings/more-options";
import { useSettings } from "@/hooks/use-data";
import { useAuth } from "@/hooks";
import {
  apiComposioConnect,
  apiComposioConnectPlatform,
  apiComposioConnections,
  apiComposioSessionAction,
  apiComposioStatus,
  apiComposioToolkits,
  looksLikeComposioKey,
  persistComposioSessionId,
  resolveComposioHeaders,
  type ComposioConnectionItem,
  type ComposioStatus,
  type ComposioToolkitCard,
} from "@/lib/composio/browser";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types + helpers
// ---------------------------------------------------------------------------

/** Per-toolkit aggregated connection state shown on a card. */
type CardState = "disconnected" | "connecting" | "connected" | "reconnect";

interface CategoryChip {
  id: string;
  name: string;
}

const PAGE_SIZE = 100;
const AUTH_POLL_INTERVAL_MS = 4_000;
const AUTH_POLL_MAX_TRIES = 45; // ~3 minutes

function stateBadgeClasses(state: CardState): string {
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

function stateLabel(state: CardState): string {
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
function bestCardState(items: ComposioConnectionItem[]): CardState {
  const states = items.map((i) => i.state);
  if (states.includes("active")) return "connected";
  if (states.includes("initializing")) return "connecting";
  if (states.includes("expired")) return "reconnect";
  if (states.includes("error")) return "reconnect";
  return "disconnected";
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function SectionIntegrationsComposio() {
  const { settings, loading: settingsLoading, setComposioApiKey, update } = useSettings();
  // useAuth (not the raw store) so a cold direct navigation rehydrates the
  // user + vault before we touch the encrypted key (same reason as the
  // Cloud Workspace section).
  const { user } = useAuth();
  const userId = user?.id;

  const hasStoredKey = !!settings?.composio_api_key_present;

  // ── connection lifecycle state ──────────────────────────────────────────
  const [keyInput, setKeyInput] = React.useState("");
  const [showKey, setShowKey] = React.useState(false);
  const [connecting, setConnecting] = React.useState(false);
  const [status, setStatus] = React.useState<ComposioStatus | null>(null);
  const [statusError, setStatusError] = React.useState<string | null>(null);

  // ── catalog state ───────────────────────────────────────────────────────
  const [toolkits, setToolkits] = React.useState<ComposioToolkitCard[]>([]);
  const [categories, setCategories] = React.useState<CategoryChip[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [totalItems, setTotalItems] = React.useState<number | null>(null);
  const [catalogLoading, setCatalogLoading] = React.useState(false);
  /** Set when the catalog REQUEST failed (vs a genuinely empty result).
   *  Drives the explicit error card + Retry — a failed load must NEVER look
   *  like "No platforms found" while the status card still shows a count
   *  (the 1463-vs-empty mismatch bug). */
  const [catalogError, setCatalogError] = React.useState<string | null>(null);
  /** True once a catalog page has loaded successfully (the count card only
   *  shows a number from THIS dataset — the same one the grid renders). */
  const [catalogLoaded, setCatalogLoaded] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [activeCategory, setActiveCategory] = React.useState("");

  // ── connections + OAuth polling ─────────────────────────────────────────
  const [connections, setConnections] = React.useState<ComposioConnectionItem[]>([]);
  const [connectingSlug, setConnectingSlug] = React.useState<string | null>(null);
  const [awaitingAuth, setAwaitingAuth] = React.useState<Set<string>>(new Set());
  /** OAuth link surfaced inline when the browser blocked the new tab. */
  const [blockedLink, setBlockedLink] = React.useState<{ toolkit: string; url: string } | null>(null);

  // ── advanced ("More options") ───────────────────────────────────────────
  const [reconnectLinks, setReconnectLinks] = React.useState<Array<{ toolkit: string; redirectUrl: string | null }>>([]);
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = React.useState<"disconnect_key" | "disconnect_all" | null>(null);

  const connected = hasStoredKey;

  // Debounce the search box → server-side catalog search.
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);

  /** Load the masked live status (+ connections) via the proxy. */
  const refreshStatus = React.useCallback(async () => {
    if (!userId) return;
    // NOTE: no hasStoredKey guard — the vault-backed header resolution is the
    // authoritative check (a stale hasStoredKey closure after a fresh
    // Connect would silently skip the refresh).
    const headers = await resolveComposioHeaders(userId);
    if (!headers) return;
    try {
      const s = await apiComposioStatus(headers);
      setStatus(s);
      setStatusError(null);
      if (s.session?.sessionId) await persistComposioSessionId(userId, s.session.sessionId);
    } catch (e) {
      setStatus(null);
      setStatusError(e instanceof Error ? e.message : "Could not reach Composio.");
    }
  }, [userId]);

  const refreshConnections = React.useCallback(async () => {
    if (!userId) return;
    const headers = await resolveComposioHeaders(userId);
    if (!headers) return;
    try {
      const r = await apiComposioConnections(headers);
      setConnections(r.items);
    } catch {
      // Non-fatal — cards fall back to "Not connected".
    }
  }, [userId]);

  /** Load one catalog page (server-side search + category + cursor). */
  const loadCatalog = React.useCallback(
    async (opts: { cursor?: string; search?: string; category?: string; append?: boolean } = {}) => {
      // NOTE: no hasStoredKey guard — resolveComposioHeaders reads the vault
      // DIRECTLY (the authoritative check). The old `!hasStoredKey` early
      // return silently skipped the load when called from handleConnect:
      // the closure still saw the PRE-connect value, so after a fresh
      // Connect the platform grid stayed "No platforms found" while the
      // connect toast/status card showed the real count (the
      // 1463-vs-empty-dropdown mismatch bug).
      if (!userId) return;
      const headers = await resolveComposioHeaders(userId);
      if (!headers) return;
      const setLoading = opts.append ? setLoadingMore : setCatalogLoading;
      setLoading(true);
      if (!opts.append) setCatalogError(null);
      try {
        const r = await apiComposioToolkits(headers, {
          cursor: opts.cursor,
          search: opts.search,
          category: opts.category,
          limit: PAGE_SIZE,
          withCategories: !opts.append && !opts.cursor,
        });
        setToolkits((prev) => (opts.append ? [...prev, ...r.items] : r.items));
        setNextCursor(r.nextCursor);
        setTotalItems(r.totalItems);
        setCatalogLoaded(true);
        setCatalogError(null);
        if (r.categories) setCategories(r.categories);
      } catch (e) {
        // HONEST FAILURE STATE: keep a previously loaded page visible for
        // appends, but a FIRST-page failure surfaces as an explicit error
        // card with a Retry — never as "No platforms found".
        const message = e instanceof Error ? e.message : "Composio request failed";
        if (!opts.append) {
          setToolkits([]);
          setCatalogLoaded(false);
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
    [userId],
  );

  // Initial load: status + connections. The catalog is loaded by the
  // search/category effect below (which also runs on mount) so exactly ONE
  // catalog fetch happens.
  React.useEffect(() => {
    if (!userId || !hasStoredKey) return;
    void refreshStatus();
    void refreshConnections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, hasStoredKey]);

  // Re-query the catalog when the debounced search / category changes — OR
  // when the key PRESENCE flips (fresh Connect on this page: hasStoredKey
  // false→true must trigger the first catalog load, not just a remount).
  React.useEffect(() => {
    if (!userId || !hasStoredKey) return;
    void loadCatalog({ search: debouncedSearch || undefined, category: activeCategory || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, activeCategory, userId, hasStoredKey]);

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
          return items.length > 0 && bestCardState(items) === "connected";
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
              description: "The platform authorized successfully.",
              icon: <CheckCircle2 className="size-4" />,
            });
          }
          void refreshStatus();
        } else if (tries >= AUTH_POLL_MAX_TRIES) {
          setAwaitingAuth(new Set());
          toast.info("Still waiting for authorization", {
            description: "Finish the authorization in the Composio tab, then refresh the connection state.",
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

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = keyInput.trim();
    if (!trimmed) {
      toast.error("Enter your Composio API key first");
      return;
    }
    if (!looksLikeComposioKey(trimmed)) {
      toast.error("Key format looks invalid", {
        description: "Composio keys are 10+ alphanumeric characters from your dashboard.",
        icon: <XCircle className="size-4" />,
      });
      return;
    }
    if (!userId) {
      toast.error("Sign in first");
      return;
    }
    setConnecting(true);
    try {
      // REAL verification — Composio answers 401 for bad keys; we only store
      // the key + session after a successful validation (PRD §38: no fake
      // success states).
      const r = await apiComposioConnect({ apiKey: trimmed, userId });
      await setComposioApiKey(trimmed);
      await update({ composio_session_id: r.session.sessionId });
      setKeyInput("");
      toast.success("Composio connected", {
        description: `Verified against ${r.totalToolkits}+ available platforms. Session created.`,
        icon: <CheckCircle2 className="size-4" />,
      });
      setStatus({
        connected: true,
        totalToolkits: r.totalToolkits,
        session: { sessionId: r.session.sessionId, mcpUrl: r.session.mcpUrl },
        connections: { total: 0, active: 0, items: [] },
      });
      await refreshConnections();
      await loadCatalog();
    } catch (err) {
      toast.error("Could not connect to Composio", {
        description: err instanceof Error ? err.message : "Connection failed",
        icon: <XCircle className="size-4" />,
      });
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnectKey() {
    if (!userId) return;
    setConfirmDialog(null);
    setBusyAction("disconnect_key");
    try {
      await setComposioApiKey(null);
      await update({ composio_session_id: null });
      setStatus(null);
      setStatusError(null);
      setToolkits([]);
      setCategories([]);
      setConnections([]);
      setAwaitingAuth(new Set());
      setReconnectLinks([]);
      setBlockedLink(null);
      setNextCursor(null);
      setTotalItems(null);
      setCatalogError(null);
      setCatalogLoaded(false);
      setSearch("");
      setActiveCategory("");
      toast.success("Composio disconnected", {
        description: "The API key + session were removed from this browser. Connected accounts stay on Composio.",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setBusyAction(null);
    }
  }

  /** Connect one platform: OAuth link → new tab → poll until authorized. */
  async function handleConnectPlatform(slug: string) {
    if (!userId) return;
    const headers = await resolveComposioHeaders(userId);
    if (!headers) {
      toast.error("Connect Composio first");
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
        // Popup blocked — surface the link on the card so the user can act.
        setBlockedLink({ toolkit: slug, url });
        toast.info("Open the authorization link", {
          description: "Your browser blocked the new tab — use the link shown on the card.",
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
    await loadCatalog({
      cursor: nextCursor,
      search: debouncedSearch || undefined,
      category: activeCategory || undefined,
      append: true,
    });
  }

  async function handleResetSession() {
    if (!userId) return;
    setBusyAction("reset_session");
    try {
      const headers = await resolveComposioHeaders(userId);
      if (!headers) throw new Error("Connect Composio first");
      const r = await apiComposioSessionAction(headers, "reset");
      if (r.sessionId) {
        await persistComposioSessionId(userId, r.sessionId);
        await refreshStatus();
        toast.success("Session reset", { description: `New session ${r.sessionId.slice(0, 12)}… created.` });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Session reset failed");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleReconnectAll() {
    if (!userId) return;
    setBusyAction("reconnect_all");
    setReconnectLinks([]);
    try {
      const headers = await resolveComposioHeaders(userId);
      if (!headers) throw new Error("Connect Composio first");
      const r = await apiComposioSessionAction(headers, "reconnect_all");
      if (r.sessionId) await persistComposioSessionId(userId, r.sessionId);
      const links = r.links ?? [];
      setReconnectLinks(links);
      if (!links.length) {
        toast.info("Nothing to reconnect", { description: "No connected platforms found." });
      } else {
        toast.success(`Fresh links ready for ${links.length} platform${links.length === 1 ? "" : "s"}`, {
          description: "Open each link below and re-authorize.",
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reconnect failed");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDisconnectAll() {
    if (!userId) return;
    setConfirmDialog(null);
    setBusyAction("disconnect_all");
    try {
      const headers = await resolveComposioHeaders(userId);
      if (!headers) throw new Error("Connect Composio first");
      const r = await apiComposioSessionAction(headers, "disconnect_all");
      await refreshConnections();
      await refreshStatus();
      toast.success(`Disconnected ${r.removed ?? 0} platform connection${r.removed === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Disconnect failed");
    } finally {
      setBusyAction(null);
    }
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

  function cardStateFor(slug: string): CardState {
    if (awaitingAuth.has(slug)) return "connecting";
    const items = connectionsBySlug.get(slug);
    if (!items?.length) return "disconnected";
    return bestCardState(items);
  }

  const activeConnections = connections.filter((c) => c.state === "active").length;

  // ── render ──────────────────────────────────────────────────────────────

  if (settingsLoading && !settings) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Connect / status card (always visible) ─────────────────────── */}
      <SectionCard
        title="Composio"
        description="Connect 250+ external apps (Slack, GitHub, Gmail, Notion…) the agent can search, connect and use at runtime."
        action={
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
              connected
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-border bg-muted/50 text-muted-foreground",
            )}
          >
            {connected ? <CheckCircle2 className="size-3.5" /> : <Plug className="size-3.5" />}
            {connected ? "Connected" : "Not connected"}
          </span>
        }
      >
        <div className="space-y-5">
          <Alert>
            <Blocks className="size-4" />
            <AlertTitle>What is Composio?</AlertTitle>
            <AlertDescription>
              Composio gives Onyx access to external apps through OAuth: the agent can search available tools,
              hand you a connect link when a platform needs authorization, and run actions with your connected
              account. Get an API key at{" "}
              <a
                href="https://composio.dev"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 font-medium underline underline-offset-2"
              >
                composio.dev
                <ExternalLink className="size-3" />
              </a>{" "}
              (Settings → Project Settings → API Keys). Your key is encrypted with AES-GCM and stored in your
              browser only.
            </AlertDescription>
          </Alert>

          {/* API key form — stays visible; entering a new key replaces the stored one */}
          <form onSubmit={handleConnect} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="composio-key">Composio API key</Label>
              <div className="relative">
                <KeyRound className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="composio-key"
                  type={showKey ? "text" : "password"}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder={hasStoredKey ? "•••••••• (a key is stored) — enter new to replace" : "Your Composio project API key"}
                  autoComplete="off"
                  spellCheck={false}
                  className="pl-9 pr-10 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={showKey ? "Hide key" : "Show key"}
                >
                  {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                {hasStoredKey
                  ? "A key is stored, encrypted. Type a new one to replace it — the key is never shown again after saving."
                  : "Stored encrypted (AES-GCM) in your browser. Never sent to the AI model."}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" disabled={connecting || !keyInput.trim()}>
                {connecting ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
                {hasStoredKey ? "Replace key" : "Connect"}
              </Button>
              {connected && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void refreshStatus()}
                    disabled={busyAction === "refresh"}
                  >
                    <RefreshCw className="size-4" />
                    Refresh status
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmDialog("disconnect_key")}
                    className="text-destructive hover:text-destructive"
                    disabled={busyAction === "disconnect_key"}
                  >
                    <Trash2 className="size-4" />
                    Disconnect
                  </Button>
                </>
              )}
            </div>
          </form>

          {/* Live status (only after real verification) */}
          {connected && status && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-lg border bg-muted/30 p-3">
                <span className="text-xs font-medium text-muted-foreground">Platforms available</span>
                {/* SINGLE DATASET (1463-vs-empty mismatch fix): the count is
                    the CATALOG's own total — the exact dataset the grid
                    renders from. Loading → "…"; failed → "—" (never a stale
                    validation count next to an empty/failed grid). */}
                <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold">
                  {catalogError ? (
                    <span title="The platform catalog failed to load — see below">—</span>
                  ) : catalogLoaded ? (
                    (totalItems ?? 0).toLocaleString()
                  ) : catalogLoading ? (
                    <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading platform catalog" />
                  ) : (
                    "—"
                  )}
                </p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3">
                <span className="text-xs font-medium text-muted-foreground">Connected apps</span>
                <p className="mt-1 text-sm font-semibold">
                  {activeConnections}
                  {status.connections.total !== activeConnections && (
                    <span className="text-muted-foreground"> / {status.connections.total}</span>
                  )}
                </p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3">
                <span className="text-xs font-medium text-muted-foreground">Session</span>
                <p className="mt-1 truncate font-mono text-xs" title={status.session?.sessionId ?? "—"}>
                  {status.session ? `${status.session.sessionId.slice(0, 14)}…` : "will be re-created"}
                </p>
              </div>
            </div>
          )}
          {connected && !status && !statusError && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Checking your Composio connection…
            </p>
          )}
          {statusError && (
            <Alert variant="destructive">
              <XCircle className="size-4" />
              <AlertTitle>Composio connection problem</AlertTitle>
              <AlertDescription>
                {statusError} — re-enter your API key above to fix it.
              </AlertDescription>
            </Alert>
          )}
        </div>
      </SectionCard>

      {/* ── Platform catalog (after connect) ────────────────────────────── */}
      {connected && (
        <SectionCard
          title="Popular platforms"
          description={
            totalItems
              ? `${toolkits.length}${nextCursor ? "+" : ""} of ${totalItems.toLocaleString()} platforms · from your Composio catalog`
              : "From your Composio catalog"
          }
          action={
            awaitingAuth.size > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                <Loader2 className="size-3.5 animate-spin" />
                Waiting for authorization…
              </span>
            ) : undefined
          }
        >
          <div className="space-y-4">
            {/* Search (server-side) + category chips (real Composio metadata) */}
            <div className="space-y-3">
              <div className="relative max-w-sm">
                <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search platforms (server-side)…"
                  className="pl-9"
                  aria-label="Search platforms"
                />
              </div>
              {categories.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setActiveCategory("")}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                      activeCategory === ""
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    All
                  </button>
                  {categories.slice(0, 12).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setActiveCategory(activeCategory === c.id ? "" : c.id)}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                        activeCategory === c.id
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Grid */}
            {catalogLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : catalogError ? (
              /* EXPLICIT ERROR STATE — a failed catalog load is NEVER shown
                 as "No platforms found" (the count-vs-dropdown mismatch
                 bug): the real upstream reason + a Retry affordance. */
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-10 text-center">
                <XCircle className="mx-auto size-5 text-destructive" aria-hidden />
                <p className="mt-2 text-sm font-medium text-foreground">Could not load the platform catalog</p>
                <p className="mx-auto mt-1 max-w-md text-[13px] text-muted-foreground">{catalogError}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={() =>
                    void loadCatalog({ search: debouncedSearch || undefined, category: activeCategory || undefined })
                  }
                >
                  <RefreshCw className="size-4" />
                  Retry
                </Button>
              </div>
            ) : toolkits.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
                <p className="text-sm font-medium text-foreground">No platforms found</p>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  {debouncedSearch || activeCategory
                    ? "Try a different search or category."
                    : "Your Composio catalog returned no toolkits."}
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {toolkits.map((t) => (
                    <PlatformCard
                      key={t.slug}
                      toolkit={t}
                      state={cardStateFor(t.slug)}
                      busy={connectingSlug === t.slug}
                      authLink={
                        (blockedLink?.toolkit === t.slug ? blockedLink.url : null) ??
                        reconnectLinks.find((l) => l.toolkit === t.slug)?.redirectUrl ??
                        null
                      }
                      onConnect={() => void handleConnectPlatform(t.slug)}
                    />
                  ))}
                </div>
                {nextCursor && (
                  <div className="flex justify-center pt-1">
                    <Button type="button" variant="outline" size="sm" onClick={handleLoadMore} disabled={loadingMore}>
                      {loadingMore ? <Loader2 className="size-4 animate-spin" /> : <ChevronDown className="size-4" />}
                      Load more
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </SectionCard>
      )}

      {/* ── More options (advanced) ──────────────────────────────────────── */}
      {connected && (
        <MoreOptions>
          <SectionCard title="Session & connection management" description="Advanced Composio controls.">
              <div className="space-y-4">
                {/* Session details */}
                <div className="rounded-lg border bg-muted/30 p-3">
                  <span className="text-xs font-medium text-muted-foreground">Tool-router session</span>
                  {status?.session ? (
                    <>
                      <p className="mt-1 font-mono text-xs" title={status.session.sessionId}>
                        {status.session.sessionId}
                      </p>
                      {status.session.mcpUrl && (
                        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={status.session.mcpUrl}>
                          MCP: {status.session.mcpUrl}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">
                      No active session — the next agent call creates one automatically.
                    </p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    The session is reused across chats so platform connections stay attached to you.
                  </p>
                </div>

                {/* Reconnect-all links */}
                {reconnectLinks.length > 0 && (
                  <div className="rounded-lg border p-3">
                    <span className="text-xs font-medium text-muted-foreground">Fresh authorization links</span>
                    <ul className="mt-2 space-y-1.5">
                      {reconnectLinks.map((l) => (
                        <li key={l.toolkit} className="flex items-center justify-between gap-2">
                          <span className="text-sm">{l.toolkit}</span>
                          {l.redirectUrl ? (
                            <Button asChild variant="outline" size="sm">
                              <a href={l.redirectUrl} target="_blank" rel="noreferrer">
                                <Link2 className="size-3.5" /> Open
                              </a>
                            </Button>
                          ) : (
                            <span className="text-xs text-destructive">link failed</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Actions */}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleResetSession}
                    disabled={busyAction !== null}
                  >
                    {busyAction === "reset_session" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RotateCcw className="size-4" />
                    )}
                    Reset session
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleReconnectAll}
                    disabled={busyAction !== null}
                  >
                    {busyAction === "reconnect_all" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RefreshCw className="size-4" />
                    )}
                    Reconnect all
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmDialog("disconnect_all")}
                    className="text-destructive hover:text-destructive"
                    disabled={busyAction !== null}
                  >
                    {busyAction === "disconnect_all" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                    Disconnect all platforms
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  “Disconnect all platforms” removes every connected account on Composio for this user — the API
                  key itself stays stored until you disconnect Composio above.
                </p>
              </div>
          </SectionCard>
        </MoreOptions>
      )}

      {/* ── Confirmations ────────────────────────────────────────────────── */}
      <AlertDialog open={confirmDialog !== null} onOpenChange={(open) => !open && setConfirmDialog(null)}>
        <AlertDialogContent>
          {confirmDialog === "disconnect_key" ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Disconnect Composio?</AlertDialogTitle>
                <AlertDialogDescription>
                  The encrypted API key and the stored session are removed from this browser. Your connected
                  platform accounts remain on Composio — remove them via “Disconnect all platforms” first if
                  that’s what you want.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={handleDisconnectKey}
                >
                  Disconnect
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Disconnect all platforms?</AlertDialogTitle>
                <AlertDialogDescription>
                  Every connected account (Slack, GitHub, Gmail…) is removed on Composio. The agent will need a
                  fresh authorization for each platform you use again.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={handleDisconnectAll}
                >
                  Disconnect all
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Platform card
// ---------------------------------------------------------------------------

function PlatformCard({
  toolkit,
  state,
  busy,
  authLink,
  onConnect,
}: {
  toolkit: ComposioToolkitCard;
  state: CardState;
  busy: boolean;
  /** Inline authorization link (popup-blocked connect / reconnect-all). */
  authLink: string | null;
  onConnect: () => void;
}) {
  const label =
    state === "connected" ? "Open" : state === "reconnect" ? "Reconnect" : state === "connecting" ? "Connecting…" : "Connect";

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-card p-4 transition-colors",
        state === "connected" ? "border-emerald-500/30" : "border-border hover:border-foreground/20",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
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
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
              <Blocks className="size-4 text-muted-foreground" />
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{toolkit.name}</p>
            <p className="truncate text-[11px] text-muted-foreground">
              {toolkit.noAuth ? "no auth needed" : `${toolkit.toolsCount} tools`}
            </p>
          </div>
        </div>
        <Badge variant="outline" className={cn("shrink-0 gap-1 text-[10px]", stateBadgeClasses(state))}>
          {state === "connected" && <CheckCircle2 className="size-3" />}
          {stateLabel(state)}
        </Badge>
      </div>

      {toolkit.description && (
        <p className="line-clamp-2 min-h-[2.4em] text-xs leading-relaxed text-muted-foreground">
          {toolkit.description}
        </p>
      )}

      <div className="mt-auto flex items-center gap-2">
        {state === "connected" && toolkit.appUrl ? (
          <Button asChild size="sm" variant="outline" className="h-8">
            <a href={toolkit.appUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="size-3.5" /> {label}
            </a>
          </Button>
        ) : state === "connecting" ? (
          <Button size="sm" variant="outline" className="h-8" disabled>
            <Loader2 className="size-3.5 animate-spin" /> {label}
          </Button>
        ) : (
          <Button size="sm" variant="outline" className="h-8" onClick={onConnect} disabled={busy} aria-label={`Connect ${toolkit.name}`}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
            {label}
          </Button>
        )}
        {authLink && state !== "connected" && (
          <a
            href={authLink}
            target="_blank"
            rel="noreferrer"
            className="truncate text-xs font-medium text-primary underline underline-offset-2"
          >
            Open authorization link
          </a>
        )}
      </div>
    </div>
  );
}

export default SectionIntegrationsComposio;
