"use client";

import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { ChatContainer, ConversationSidebar } from "@/components/chat";
import { FileSidebar } from "@/components/chat/file-sidebar";
import { SubAgentSidebar } from "@/components/chat/subagent-sidebar";
import { PlatformsSidebar } from "@/components/chat/platforms-sidebar";
import { DockedPanel } from "@/components/chat/docked-panel";
import { Button } from "@/components/ui/button";
import { useChatSidebarStore, useChatStore, useConversationStore } from "@/stores";
import { useSubagentStore } from "@/stores/subagent-store";
import { useConversations } from "@/hooks";
import { useSettings } from "@/hooks/use-data";
import { useLogStore } from "@/stores/log-store";
import { TimelineSidebar } from "@/components/chat/timeline-sidebar";
import { LogsViewer } from "@/components/dev/logs-viewer";
import { KnowledgeBasePanel } from "@/components/knowledge-base/kb-panel";
import { setUrlParam } from "@/lib/utils";
import { FolderOpen, Menu, Bot, ListTree, ScrollText, Blocks, LibraryBig } from "lucide-react";

type SidePanel = "platforms" | "files" | "timeline" | "logs" | "knowledge" | null;

/* ------------------------------------------------------------------
 * SPLIT WORKSPACE GEOMETRY (PRD §7/§8/§20)
 *
 * From md (768px) up, the right-hand panels dock BESIDE the chat as real
 * layout columns. Two rules keep that split usable on every width:
 *
 *   1. PANEL FIT CLAMP — the DockedPanel renders at
 *      `min(userWidth, 100vw - 448px)` (CSS, live), so the chat column
 *      never drops below ~400px.
 *   2. AUTO RAIL — when the viewport cannot fit
 *      [conversation sidebar + 400px chat + the fitted panel], the
 *      conversation sidebar collapses to its 48px icon rail. Only a
 *      collapse THIS layout performed is reverted (on panel close or
 *      viewport growth); the user's own collapse/expand choice is never
 *      overridden.
 *
 * The prefs below must stay in sync with the DockedPanel props further
 * down (storage keys + default widths) and with the conversation
 * sidebar's own resizable-width key.
 * ------------------------------------------------------------------ */

/** Chat column floor (px) — panels may never starve the chat below this. */
const MIN_CHAT_WIDTH = 400;
/** Conversation sidebar width when collapsed to its icon rail (w-12). */
const COLLAPSED_RAIL_WIDTH = 48;
/** Conversation sidebar default width (matches its useResizableSidebar). */
const CONV_SIDEBAR_DEFAULT_WIDTH = 256;

/** Persisted width prefs of the docked panels — mirrors the DockedPanel
 * props below (storageKey/defaultWidth), used by the auto-rail math. */
const PANEL_WIDTH_PREFS = {
  platforms: { storageKey: "platforms-sidebar-width", defaultWidth: 360 },
  subagents: { storageKey: "subagent-sidebar-width", defaultWidth: 360 },
  files: { storageKey: "file-sidebar-width", defaultWidth: 320 },
  timeline: { storageKey: "timeline-sidebar-width", defaultWidth: 340 },
  logs: { storageKey: "logs-sidebar-width", defaultWidth: 420 },
  knowledge: { storageKey: "kb-sidebar-width", defaultWidth: 380 },
} as const;

type DockedPanelId = keyof typeof PANEL_WIDTH_PREFS;

/** Live viewport width (re-renders on resize only). */
function useViewportWidth() {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/** Read a persisted resizable width (localStorage, same keys
 * useResizableSidebar writes) with its default as fallback. */
function readPersistedWidth(storageKey: string, fallback: number) {
  if (typeof window === "undefined") return fallback;
  const stored = parseInt(window.localStorage.getItem(storageKey) ?? "", 10);
  return Number.isFinite(stored) && stored > 0 ? stored : fallback;
}

/** No-op subscription for `useSyncExternalStore` hydration gates. */
const emptySubscribe = () => () => {};

/**
 * The full chat workspace — conversation sidebar + glass top bar + chat
 * column + right-hand docked panels (the OnyxAgent /chat experience).
 */
export function ChatWorkspace() {

  // Files / timeline panels — the user's last right-panel choice, closed by
  // default. The DockedPanel container renders each as a docked column on
  // md+ and a full-height drawer below, so this single state drives both.
  const [sidePanel, setSidePanel] = useState<SidePanel>(null);
  // Selector-only: `open` is a stable store ACTION — this subscription never
  // re-renders the workspace (the old no-selector call subscribed it to the
  // entire chat-sidebar store).
  const openChatSidebar = useChatSidebarStore((s) => s.open);
  const currentConversationId = useConversationStore((s) => s.currentConversationId);
  const { conversations, isLoading: conversationsLoading, selectConversation } =
    useConversations();
  const conversationTitle =
    conversations.find((c) => c.id === currentConversationId)?.title ?? null;

  // ── LEGACY GUARD ────────────────────────────────────────────────────────
  // OnyxCode (Code Mode) is gone. If the store still points at a legacy
  // "code" conversation (a stale pointer from before the removal), fall
  // back to the latest agent conversation (or a fresh new-chat state).
  useEffect(() => {
    const store = useConversationStore.getState();
    const curId = store.currentConversationId;
    const curConv = curId ? conversations.find((c) => c.id === curId) : undefined;
    if (curConv?.mode !== "code") return;
    if (conversationsLoading && conversations.length === 0) return; // wait for the list
    const latestAgent = [...conversations]
      .filter((c) => (!c.mode || c.mode === "agent") && !c.is_archived)
      .sort((a, b) => (b.updated_at || b.created_at).localeCompare(a.updated_at || a.created_at))[0];
    if (latestAgent) {
      void selectConversation(latestAgent.id);
    } else {
      useChatStore.getState().clearMessages();
      store.selectConversation(null, { loading: false });
      setUrlParam("id", null);
    }
  }, [conversations, conversationsLoading, selectConversation]);

  // HYDRATION-SAFE TITLE (fixes the "Hydration failed" mismatch on ?id=
  // reloads): the conversation store rehydrates SYNCHRONOUSLY from
  // sessionStorage on the client, so the first client render knows the
  // active conversation id while the SSR pass could not — the server frame
  // rendered the plain "New conversation" heading, the client frame the
  // shimmer/title → mismatch. `useSyncExternalStore` with a false SERVER
  // snapshot gives a lint-clean mounted gate: false during SSR AND the
  // hydration render (matching the server frame exactly), true afterwards.
  const titleHydrated = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

  // Composio gate — the Platforms chat sidebar exists ONLY while a Composio
  // API key is stored (Settings → Integrations). `composio_api_key_present`
  // is a non-secret flag on the settings row (the key itself is encrypted in
  // the vault and never leaves it except as the transient proxy header).
  const { settings } = useSettings();
  const composioConnected = !!settings?.composio_api_key_present;

  // Subagent panel — the store is the single source of truth: the event
  // processor flips `sidebarOpen` the moment a sub-agent tool call starts
  // (PRD §15), and the docked panel reads it directly (no mirroring into
  // local panel state).
  const subagentOpen = useSubagentStore((s) => s.sidebarOpen);
  const setSubagentOpen = useSubagentStore((s) => s.setSidebarOpen);
  // Error-log badge: unseen error count on the Logs toggle (resets when any
  // logs surface is opened).
  const unseenErrors = useLogStore((s) => s.unseenErrors);
  const markLogsSeen = useLogStore((s) => s.markSeen);

  // Only one right-hand panel VISIBLE at a time — fully DERIVED during
  // render (no state syncing, so it is React-Compiler-safe): while the
  // subagent panel is open (manually or auto-opened by the agent) it takes
  // over the dock; closing it restores the panel that was open before.
  // The Platforms panel is additionally gated on the Composio key being
  // present — removing the key in Settings closes it here (derived), and
  // re-adding the key restores it if it was the user's last choice.
  const platformsOpen = sidePanel === "platforms" && !subagentOpen && composioConnected;
  const filesOpen = sidePanel === "files" && !subagentOpen;
  const timelineOpen = sidePanel === "timeline" && !subagentOpen;
  const logsOpen = sidePanel === "logs" && !subagentOpen;
  const knowledgeOpen = sidePanel === "knowledge" && !subagentOpen;
  // The panel currently occupying the right-hand dock (drives the auto-rail
  // math below) — a "platforms" choice with the key absent closes the dock.
  const activeDockedPanel: DockedPanelId | null =
    subagentOpen
      ? "subagents"
      : platformsOpen
        ? "platforms"
        : sidePanel === "platforms"
          ? null
          : sidePanel;

  // Opening the docked logs panel counts as "seeing" the errors.
  useEffect(() => {
    if (logsOpen) markLogsSeen();
  }, [logsOpen, markLogsSeen]);

  // ── AUTO RAIL (split workspace, PRD §7/§20) ──
  // With a panel docked at md+, collapse the conversation sidebar to its
  // icon rail when the viewport cannot fit sidebar + chat floor + the
  // fitted panel. Revert when the last panel closes or the viewport grows
  // — but ONLY the collapse this layout performed; if the user collapses
  // or expands the sidebar themselves, their choice wins from then on.
  const viewportWidth = useViewportWidth();
  const convCollapsed = useChatSidebarStore((s) => s.collapsed);
  const collapseConv = useChatSidebarStore((s) => s.collapse);
  const expandConv = useChatSidebarStore((s) => s.expand);
  const autoCollapsedByPanelRef = useRef(false);

  useEffect(() => {
    if (!activeDockedPanel) {
      // Last panel closed — restore the sidebar if (and only if) the split
      // layout is what collapsed it.
      if (autoCollapsedByPanelRef.current) {
        autoCollapsedByPanelRef.current = false;
        expandConv();
      }
      return;
    }
    // The user manually expanded while a panel is docked — respect it and
    // stop managing the collapse state for this panel session.
    if (autoCollapsedByPanelRef.current && !convCollapsed) {
      autoCollapsedByPanelRef.current = false;
      return;
    }
    // Below md the panels are mobile drawers — the rail math is moot.
    if (viewportWidth < 768) return;

    const convWidth = readPersistedWidth(
      "conversation-sidebar-width",
      CONV_SIDEBAR_DEFAULT_WIDTH,
    );
    const pref = PANEL_WIDTH_PREFS[activeDockedPanel];
    const panelWidth = readPersistedWidth(pref.storageKey, pref.defaultWidth);
    // Same fit clamp the DockedPanel applies via CSS (100vw - 448px).
    const fitCap = viewportWidth - COLLAPSED_RAIL_WIDTH - MIN_CHAT_WIDTH;
    const effectivePanelWidth = Math.min(panelWidth, Math.max(fitCap, 0));
    const fitsExpanded =
      viewportWidth >= convWidth + MIN_CHAT_WIDTH + effectivePanelWidth;

    if (!fitsExpanded && !convCollapsed) {
      autoCollapsedByPanelRef.current = true;
      collapseConv();
    } else if (fitsExpanded && autoCollapsedByPanelRef.current && convCollapsed) {
      // Viewport grew (window maximized, panel switched to a narrower one) —
      // the rail is no longer needed.
      autoCollapsedByPanelRef.current = false;
      expandConv();
    }
  }, [activeDockedPanel, viewportWidth, convCollapsed, collapseConv, expandConv]);

  const closeSubagent = useCallback(() => {
    setSubagentOpen(false);
  }, [setSubagentOpen]);

  const toggleSubagents = () => {
    setSubagentOpen(!subagentOpen);
  };
  const toggleSidePanel = (panel: Exclude<SidePanel, null>) => {
    // Opening a side panel takes over the dock from the subagent panel.
    setSubagentOpen(false);
    const wasVisible =
      panel === "platforms"
        ? platformsOpen
        : panel === "files"
          ? filesOpen
          : panel === "timeline"
            ? timelineOpen
            : panel === "knowledge"
              ? knowledgeOpen
              : logsOpen;
    setSidePanel(wasVisible ? null : panel);
  };

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <ConversationSidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Glass top bar (Terra spec): serif conversation title on the left,
            panel toggles on the right, over a hairline. Chat history lives
            in the conversation sidebar (left rail + its mobile sheet), not
            here (PRD §11). */}
        <div className="glass-header flex h-12 shrink-0 items-center justify-between border-b px-2 sm:px-4">
          <div className="flex min-w-0 items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={openChatSidebar}
              className="animate-press fluid-chip h-8 w-8 p-0 md:hidden"
              title="Open conversations"
              aria-label="Open conversations"
            >
              <Menu className="h-4 w-4" />
            </Button>
            {!titleHydrated ? (
              /* Pre-hydration frame: the deterministic server shape. */
              <h1 className="title-reveal font-display truncate text-[17px] font-medium tracking-tight sm:text-lg">
                {"New conversation"}
              </h1>
            ) : currentConversationId && !conversationTitle ? (
              /* PRD §12 — the naming call is in flight: a shimmer skeleton
                 holds the empty title space (no layout jump when the title
                 lands). */
              <span
                aria-hidden
                className="shimmer mt-0.5 h-4 w-28 rounded-sm sm:h-5 sm:w-36"
              />
            ) : (
              /* The title reveals with a fade/slide/blur-to-sharp settle
                 (keyed on the text so the generated title, renames, and
                 chat switches all animate in seamlessly). */
              <h1
                key={conversationTitle ?? "new"}
                className="title-reveal font-display truncate text-[17px] font-medium tracking-tight sm:text-lg"
              >
                {conversationTitle || "New conversation"}
              </h1>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {/* Knowledge Base — the workspace's persistent knowledge (AI-saved
                items + hosted files) as a docked sidebar; the compact sibling
                of the full /knowledge-base page. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => toggleSidePanel("knowledge")}
              className="animate-press fluid-chip text-muted-foreground hover:text-foreground h-8 w-8 p-0"
              title="Knowledge Base"
              aria-label="Toggle knowledge panel"
              aria-expanded={knowledgeOpen}
              aria-controls="kb-panel"
            >
              <LibraryBig className="h-4 w-4" />
            </Button>
            {/* Composio Platforms — a docked catalog sidebar that exists ONLY
                while a Composio key is stored (direct platform connections
                from chat: search, sort, filter, OAuth connect). */}
            {composioConnected && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => toggleSidePanel("platforms")}
                className="animate-press fluid-chip text-muted-foreground hover:text-foreground h-8 w-8 p-0"
                title="Platforms (Composio)"
                aria-label="Toggle platforms panel"
                aria-expanded={platformsOpen}
                aria-controls="platforms-panel"
              >
                <Blocks className="h-4 w-4" />
              </Button>
            )}
            {/* Tool timeline — a DOCKED SIDEBAR (not a popup): the whole
                working session as a fixed, scrollable, real-time panel on
                the right. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => toggleSidePanel("timeline")}
              className="animate-press fluid-chip text-muted-foreground hover:text-foreground h-8 w-8 p-0"
              title="Tool timeline"
              aria-label="Show tool timeline"
              aria-expanded={timelineOpen}
              aria-controls="timeline-panel"
            >
              <ListTree className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleSubagents}
              className="animate-press fluid-chip text-muted-foreground hover:text-foreground h-8 w-8 p-0"
              title="Subagent chat"
              aria-label="Toggle subagent panel"
              aria-expanded={subagentOpen}
              aria-controls="subagent-panel"
            >
              <Bot className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => toggleSidePanel("logs")}
              className="animate-press fluid-chip hover:text-foreground relative h-8 w-8 p-0 text-muted-foreground"
              title="Error logs"
              aria-label="Toggle error logs panel"
              aria-expanded={logsOpen}
              aria-controls="logs-panel"
            >
              <ScrollText className="h-4 w-4" />
              {unseenErrors > 0 && (
                <span className="bg-destructive absolute top-1 right-1 h-2 w-2 rounded-full" aria-hidden />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => toggleSidePanel("files")}
              className="animate-press fluid-chip text-muted-foreground hover:text-foreground h-8 w-8 p-0"
              title="Show files"
              aria-label="Toggle files panel"
              aria-expanded={filesOpen}
              aria-controls="files-panel"
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <ChatContainer />
        </div>
      </div>

      {/* Right-hand docked panels (PRD §16/§17): in-flow columns on md+
          whose open/close is an animated width change (the main chat
          column shrinks seamlessly — no overlay, no backdrop, no blur),
          and full-height drawers below md. One at a time; each is
          resizable with the width persisted and CSS-fitted so the chat
          column never drops below ~400px. */}
      <DockedPanel
        id="kb-panel"
        label="Knowledge Base"
        open={knowledgeOpen}
        onClose={() => setSidePanel(null)}
        storageKey="kb-sidebar-width"
        defaultWidth={380}
        minWidth={300}
        maxWidth={640}
        sheetCloseButton
        sheetClassName="w-[88vw] max-w-sm"
      >
        <KnowledgeBasePanel />
      </DockedPanel>

      <DockedPanel
        id="platforms-panel"
        label="Platforms"
        open={platformsOpen}
        onClose={() => setSidePanel(null)}
        storageKey="platforms-sidebar-width"
        defaultWidth={360}
        minWidth={280}
        maxWidth={640}
        sheetCloseButton
        sheetClassName="w-[90vw] max-w-sm"
      >
        <PlatformsSidebar />
      </DockedPanel>

      <DockedPanel
        id="subagent-panel"
        label="Subagent chat"
        open={subagentOpen}
        onClose={closeSubagent}
        storageKey="subagent-sidebar-width"
        defaultWidth={360}
        minWidth={280}
        maxWidth={600}
        sheetClassName="w-[90vw] max-w-md"
      >
        <SubAgentSidebar onClose={closeSubagent} />
      </DockedPanel>

      <DockedPanel
        id="files-panel"
        label="Files"
        open={filesOpen}
        onClose={() => setSidePanel(null)}
        storageKey="file-sidebar-width"
        defaultWidth={320}
        minWidth={240}
        maxWidth={600}
        sheetCloseButton
        sheetClassName="w-[85vw] max-w-sm"
      >
        <FileSidebar />
      </DockedPanel>

      <DockedPanel
        id="logs-panel"
        label="Error logs"
        open={logsOpen}
        onClose={() => setSidePanel(null)}
        storageKey="logs-sidebar-width"
        defaultWidth={420}
        minWidth={320}
        maxWidth={720}
        sheetClassName="w-[92vw] sm:max-w-md"
      >
        <LogsViewer />
      </DockedPanel>

      <DockedPanel
        id="timeline-panel"
        label="Tool timeline"
        open={timelineOpen}
        onClose={() => setSidePanel(null)}
        storageKey="timeline-sidebar-width"
        defaultWidth={340}
        minWidth={280}
        maxWidth={600}
        sheetClassName="w-[85vw] max-w-sm"
      >
        <TimelineSidebar onClose={() => setSidePanel(null)} />
      </DockedPanel>

    </div>
  );
}
