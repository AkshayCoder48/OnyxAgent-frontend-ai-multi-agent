"use client";

import { create } from "zustand";
import { MODELS, seedConversations } from "./seed";
import { clearLiveStream, setLiveStream, useStream } from "./stream-store";
import type {
  AppMode,
  ChatHistoryMessage,
  CodeTab,
  Conversation,
  Message,
  MessagePart,
  ModelPreferenceId,
  RouteInfo,
  RouteStats,
  SyncStatus,
  ToolCallData,
  ToolIconKind,
  ToolResultData,
} from "./types";

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;

function nowLabel(): string {
  return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function makeId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 42 ? `${clean.slice(0, 42).trimEnd()}…` : clean;
}

function partContent(part: MessagePart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "code":
      return `\`\`\`${part.language}\n${part.code}\n\`\`\``;
    case "tool":
      return `[used tool ${part.tool.name}: ${part.tool.subtitle}]${
        part.tool.result ? `\n${part.tool.result.slice(0, 600)}` : ""
      }`;
  }
}

/** Icon chip for a tool name (code-mode tools included). */
export function toolIconFor(name: string): ToolIconKind {
  switch (name) {
    case "create_app":
    case "manage_files":
      return "folder";
    case "start_preview":
    case "manage_preview":
    case "start_web_session":
      return "monitor";
    case "manage_database":
      return "database";
    case "inspect_image":
      return "image";
    case "web_search":
      return "globe";
    default:
      return "wrench";
  }
}

/** The conversations that belong to a mode (OnyxCode keeps its own list). */
function conversationsForMode(conversations: Conversation[], mode: AppMode): Conversation[] {
  return conversations.filter((c) => (c.mode === "code") === (mode === "code"));
}

function ensureActiveInMode(conversations: Conversation[], activeId: string, mode: AppMode): string {
  const pool = conversationsForMode(conversations, mode);
  return pool.some((c) => c.id === activeId) ? activeId : (pool[0]?.id ?? "");
}

function messageContent(message: Message): string {
  if (message.role === "user") return message.text;
  return (message.parts ?? [{ type: "text", text: message.text }])
    .map(partContent)
    .join("\n\n");
}

function groupFor(createdAt: number): Conversation["group"] {
  const d = new Date(createdAt);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = startOfDay(now) - startOfDay(d);
  if (diff <= 0) return "today";
  if (diff <= DAY_MS) return "yesterday";
  return "earlier";
}

function normalizeConversation(conversation: Conversation): Conversation {
  return { ...conversation, group: groupFor(conversation.createdAt) };
}

function sortConversations(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((a, b) => b.createdAt - a.createdAt);
}

/* ------------------------------------------------------------------ */
/* Persistence (localStorage snapshot → instant boot)                  */
/* ------------------------------------------------------------------ */

const SNAPSHOT_KEY = "terra.v1.snapshot";
const PREFS_KEY = "terra.v1.prefs";

interface Snapshot {
  conversations: Conversation[];
  tombstones: string[];
  savedAt: number;
}

interface Prefs {
  modelId: ModelPreferenceId;
  autoSync: boolean;
  routeStats: RouteStats;
  appMode?: AppMode;
  activeCodeId?: string;
}

function loadSnapshot(): Snapshot | null {
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Snapshot>;
    if (!Array.isArray(parsed.conversations)) return null;
    return {
      conversations: parsed.conversations
        .filter((c): c is Conversation => Boolean(c?.id))
        .map(normalizeConversation),
      tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones : [],
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
    };
  } catch {
    return null;
  }
}

function loadPrefs(): Partial<Prefs> {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* Module-level sync + stream machinery (kept out of React state)      */
/* ------------------------------------------------------------------ */

const tombstones = new Set<string>();
/** Tombstones not yet acknowledged by the cloud. */
const pendingTombstones = new Set<string>();
const dirtyIds = new Set<string>();

let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let syncChain: Promise<void> = Promise.resolve();
let pullRetryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Sleep that a "tab became visible" event can cut short: while hidden,
 * browsers clamp timers hard (down to ~1/minute), so backoff waits must
 * never block a reconnect that could start immediately on return.
 */
const wakeWaiters = new Set<() => void>();
function sleepOrWake(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wakeWaiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    wakeWaiters.add(done);
  });
}
function wakeAll(): void {
  for (const wake of [...wakeWaiters]) {
    try {
      wake();
    } catch {
      // A broken waiter never blocks the others.
    }
  }
}

/** Sentinel for errors the server already retried — never retried client-side. */
class FinalStreamError extends Error {}
/** The server no longer knows this turn (restart / expiry) — caller rebuilds. */
class GoneError extends Error {}

interface StreamDraft {
  convId: string;
  msgId: string;
  /** Server job id — stable across every re-attach. */
  turnId: string;
  reasoning: string;
  answer: string;
  /** Finalized segments: complete text parts + tool cards, in order. */
  builtParts: MessagePart[];
  route: RouteInfo | null;
  notice: string | null;
  warn: string | null;
  thinkStart: number | null;
  thinkMs: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Route stats counted once per turn (replays never double-count). */
  statsCounted: boolean;
}

let draft: StreamDraft | null = null;
let streamAbort: AbortController | null = null;
let userStopped = false;

/** Mirror the whole draft into the live-stream overlay (draft creation). */
const syncOverlay = () => {
  const current = draft;
  if (!current) return;
  setLiveStream({
    msgId: current.msgId,
    convId: current.convId,
    reasoning: current.reasoning,
    answer: current.answer,
    thinkStart: current.thinkStart,
    route: current.route,
    notice: current.notice,
    prepare: null,
  });
};

/** Find a live tool card inside the draft by its server tool id. */
function draftTool(current: StreamDraft, toolId: string): ToolCallData | null {
  for (let i = current.builtParts.length - 1; i >= 0; i--) {
    const part = current.builtParts[i];
    if (part.type === "tool" && part.tool.toolId === toolId) return part.tool;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* SSE client — attach to a server-side background turn job.           */
/* The connection is a detachable viewer: if it dies (background tab,  */
/* network blip, proxy kill) the job keeps running server-side and we  */
/* re-attach with a `since` cursor to receive exactly what we missed.  */
/* ------------------------------------------------------------------ */

type StreamEvent =
  | { type: "route"; route: RouteInfo["route"]; label: string; model?: string; reason: string }
  | { type: "reasoning"; text: string }
  | { type: "delta"; text: string }
  | { type: "replace"; reasoning: string; answer: string }
  | { type: "status"; text: string }
  | { type: "warning"; text: string }
  | { type: "tool_prepare"; toolId: string; name: string; args: string }
  | { type: "tool_call"; toolId: string; name: string; subtitle: string; args: string }
  | { type: "tool_status"; toolId: string; backgrounded: boolean; subtitle: string }
  | {
      type: "tool_result";
      toolId: string;
      ok: boolean;
      result: string;
      subtitle: string;
      resultData?: { kind: string; payload: Record<string, unknown> };
    }
  | { type: "done"; elapsedMs?: number; partial?: boolean }
  | { type: "error"; message: string }
  | { type: "cancelled" };

interface AttachArgs {
  history: ChatHistoryMessage[];
  model: ModelPreferenceId;
  turnId: string;
  /** Cursor: index of the first event we have NOT applied yet. */
  since: number;
  /** Create the job if it does not exist (false = attach-only). */
  create: boolean;
  resumeFrom: string | null;
  /** OnyxCode turns run the tool-capable pipeline on a workspace. */
  mode: AppMode;
  workspaceId?: string;
}

async function consumeChatStream(
  args: AttachArgs,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
  onReset: () => void,
): Promise<number> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: args.history.slice(-14),
      model: args.model,
      turnId: args.turnId,
      since: args.since,
      create: args.create,
      ...(args.resumeFrom ? { resumeFrom: args.resumeFrom } : {}),
      ...(args.mode === "code"
        ? { mode: "code", workspaceId: args.workspaceId ?? args.turnId }
        : {}),
    }),
    signal,
  });

  if (!response.ok || !response.body) {
    if (response.status === 404) {
      // The server no longer has this job (restart / expiry). The caller
      // decides how to rebuild — never silently restart from scratch.
      throw new GoneError("Turn job is gone");
    }
    let message = "Terra could not be reached — please try again.";
    try {
      const data = (await response.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // Non-JSON error body; keep the friendly default.
    }
    throw new FinalStreamError(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let nextSince = args.since;

  const handleLine = (line: string) => {
    if (!line.startsWith("data:")) return; // heartbeats arrive as ": ping …"
    const payload = line.slice(5).trim();
    if (!payload) return;
    try {
      const parsed = JSON.parse(payload) as {
        type?: string;
        index?: number;
        reset?: boolean;
      };
      if (parsed.type === "hello") {
        if (parsed.reset) {
          // The job's log does not match our cursor (new job under the
          // same id) — rebuild the draft from the full replay that follows.
          nextSince = 0;
          onReset();
        }
        return;
      }
      if (typeof parsed.index === "number") {
        if (parsed.index < nextSince) return; // stale duplicate guard
        nextSince = parsed.index + 1;
      }
      onEvent(parsed as StreamEvent);
    } catch {
      // Ignore malformed fragments — the next event usually repairs.
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) return nextSince;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      handleLine(line);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

interface TerraState {
  conversations: Conversation[];
  activeId: string;
  /** OnyxCode — the code-mode experience state. */
  appMode: AppMode;
  codeTab: CodeTab;
  activeCodeId: string;
  modelId: ModelPreferenceId;
  search: string;
  sending: boolean;
  mobileNavOpen: boolean;
  settingsOpen: boolean;
  /** False until the localStorage snapshot has been restored */
  booted: boolean;
  syncStatus: SyncStatus;
  lastSyncedAt: number | null;
  syncError: string | null;
  autoSync: boolean;
  routeStats: RouteStats;
  lastDeleted: { conversation: Conversation; at: number } | null;

  hydrate: () => void;
  setActive: (id: string) => void;
  newConversation: () => void;
  setSearch: (query: string) => void;
  setModel: (modelId: ModelPreferenceId) => void;
  setMobileNav: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setFeedback: (messageId: string, value: "up" | "down") => void;
  send: (text: string) => Promise<void>;
  regenerate: () => Promise<void>;
  stop: () => void;
  deleteConversation: (id: string) => void;
  undoDelete: () => void;
  pullSync: () => Promise<void>;
  pushSync: () => Promise<void>;
  setAutoSync: (value: boolean) => void;
  /* OnyxCode */
  enterCodeMode: () => void;
  exitCodeMode: () => void;
  setCodeTab: (tab: CodeTab) => void;
  newCodeConversation: () => void;
  skipToolWait: (toolId: string) => void;
}

export const useTerra = create<TerraState>()((set, get) => {
  /* ---------------- persistence helpers ---------------------------- */

  const scheduleSnapshot = () => {
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      try {
        const snapshot = {
          conversations: get().conversations,
          tombstones: [...tombstones],
          pendingTombstones: [...pendingTombstones],
          savedAt: Date.now(),
        };
        window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
        const prefs: Prefs = {
          modelId: get().modelId,
          autoSync: get().autoSync,
          routeStats: get().routeStats,
          appMode: get().appMode,
          activeCodeId: get().activeCodeId,
        };
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch {
        // Storage full or unavailable — cloud sync still protects the data.
      }
    }, 350);
  };

  const schedulePush = () => {
    if (!get().autoSync || !get().booted) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      void get().pushSync();
    }, 1200);
  };

  const markDirty = (conversationId: string) => {
    dirtyIds.add(conversationId);
    scheduleSnapshot();
    schedulePush();
  };

  /* ---------------- cloud sync ------------------------------------- */

  const doPull = async (): Promise<void> => {
    const state = get();
    if (!state.booted) return;
    set({ syncStatus: "syncing", syncError: null });
    try {
      const versions: Record<string, number> = {};
      for (const c of state.conversations) versions[c.id] = c.version;
      const query = encodeURIComponent(JSON.stringify(versions));
      const response = await fetch(`/api/sync?versions=${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as {
        updates?: {
          id: string;
          title: string;
          group: string;
          separator: string;
          messages: string;
          mode?: string;
          version: number;
          deleted: boolean;
        }[];
      };

      if (Array.isArray(data.updates) && data.updates.length > 0) {
        set((s) => {
          let conversations = [...s.conversations];
          for (const update of data.updates ?? []) {
            if (update.deleted) {
              tombstones.add(update.id);
              conversations = conversations.filter((c) => c.id !== update.id);
              continue;
            }
            // Local unsynced edits win until they have been pushed.
            if (dirtyIds.has(update.id)) continue;
            let messages: Message[] = [];
            try {
              messages = (JSON.parse(update.messages) as Message[]).filter(
                (m) => m && typeof m.id === "string",
              );
            } catch {
              continue;
            }
            const existing = conversations.find((c) => c.id === update.id);
            if (existing && existing.version >= update.version) continue;
            const incoming: Conversation = {
              id: update.id,
              title: update.title,
              group: (update.group as Conversation["group"]) ?? "earlier",
              separator: update.separator,
              messages,
              // Keep local createdAt when we already know it — better grouping.
              createdAt: existing?.createdAt ?? Date.now(),
              version: update.version,
              mode: update.mode === "code" ? "code" : undefined,
            };
            const merged = normalizeConversation(incoming);
            if (existing) {
              conversations = conversations.map((c) => (c.id === update.id ? merged : c));
            } else {
              conversations.push(merged);
            }
          }
          conversations = sortConversations(conversations);
          return {
            conversations,
            activeId: ensureActiveInMode(conversations, s.activeId, "agent"),
            activeCodeId: ensureActiveInMode(conversations, s.activeCodeId, "code"),
          };
        });
      }
      set({ syncStatus: "synced", lastSyncedAt: Date.now() });
      scheduleSnapshot();
    } catch (error) {
      const offline = error instanceof TypeError;
      set({
        syncStatus: offline ? "offline" : "error",
        syncError: offline ? "No connection to the cloud" : "Cloud sync hit an error",
      });
      schedulePullRetry();
    }
  };

  const schedulePullRetry = () => {
    if (!get().autoSync) return;
    if (pullRetryTimer) clearTimeout(pullRetryTimer);
    pullRetryTimer = setTimeout(() => {
      pullRetryTimer = null;
      enqueueSync(doPull);
    }, 8000);
  };

  const doPush = async (): Promise<void> => {
    const state = get();
    if (!state.booted) return;
    // Prune dirty ids whose conversation no longer exists client-side
    // (e.g. tombstoned away by a pull while still unsynced) — they could
    // otherwise produce an empty payload and an error loop.
    const known = new Set(state.conversations.map((c) => c.id));
    for (const id of [...dirtyIds]) {
      if (!known.has(id)) dirtyIds.delete(id);
    }
    // Never push a conversation that is mid-stream — it is pushed on finish.
    const streamingConv = draft?.convId;
    const pendingConvIds = [...dirtyIds].filter((id) => id !== streamingConv);
    const pendingTombIds = [...pendingTombstones];
    if (pendingConvIds.length === 0 && pendingTombIds.length === 0) return;
    set({ syncStatus: "syncing", syncError: null });
    try {
      const payload = [
        ...state.conversations
          .filter((c) => pendingConvIds.includes(c.id))
          .map((c) => ({
            id: c.id,
            title: c.title,
            group: c.group,
            separator: c.separator,
            messages: JSON.stringify(c.messages),
            mode: c.mode === "code" ? "code" : "agent",
          })),
        ...pendingTombIds.map((id) => ({
          id,
          title: "Deleted",
          deleted: true,
        })),
      ];
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversations: payload }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { acks?: { id: string; version: number }[] };
      const acks = new Map((data.acks ?? []).map((a) => [a.id, a.version]));
      set((s) => ({
        conversations: s.conversations.map((c) =>
          acks.has(c.id) ? { ...c, version: acks.get(c.id) ?? c.version } : c,
        ),
      }));
      for (const id of acks.keys()) {
        dirtyIds.delete(id);
        pendingTombstones.delete(id);
      }
      set({ syncStatus: "synced", lastSyncedAt: Date.now() });
      scheduleSnapshot();
      if (dirtyIds.size > 0) schedulePush(); // edits made while pushing
    } catch (error) {
      const offline = error instanceof TypeError;
      set({
        syncStatus: offline ? "offline" : "error",
        syncError: offline ? "No connection to the cloud" : "Cloud sync hit an error",
      });
      schedulePullRetry();
    }
  };

  /** Serialize sync operations so pull/push never interleave. */
  const enqueueSync = (operation: () => Promise<void>): Promise<void> => {
    syncChain = syncChain.then(operation).catch(() => undefined);
    return syncChain;
  };

  /* ---------------- streaming core --------------------------------- */

  /**
   * LIVE flush (fast path, ~12×/s): pushes reasoning/answer into the overlay
   * store ONLY. No conversation state is touched — so nothing except the one
   * streaming assistant turn re-renders while tokens arrive. This split is
   * what keeps long generations from janking the whole app.
   */
  const flushLive = () => {
    const current = draft;
    if (!current) return;
    if (current.timer) {
      clearTimeout(current.timer);
      current.timer = null;
    }
    setLiveStream({
      msgId: current.msgId,
      convId: current.convId,
      reasoning: current.reasoning,
      answer: current.answer,
      thinkStart: current.thinkStart,
      route: current.route,
    });
  };

  const queueLive = () => {
    if (!draft || draft.timer) return;
    // setTimeout keeps working (throttled) in background tabs, unlike rAF —
    // so the reply keeps rendering even while the tab is hidden.
    draft.timer = setTimeout(flushLive, 80);
  };

  /**
   * MILESTONE flush (slow path, rare): persists the structural snapshot —
   * completed text segments + tool cards, route, notices — into the actual
   * conversation message. Called on tool lifecycle events, route decisions
   * and status notes; never per token.
   */
  const pushMilestone = () => {
    const current = draft;
    if (!current) return;
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === current.convId
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.id === current.msgId
                  ? {
                      ...m,
                      reasoning: current.reasoning || undefined,
                      route: current.route ?? undefined,
                      notice: current.notice ?? undefined,
                      warn: current.warn ?? undefined,
                      streaming: true,
                      // Live running timer for the thinking block.
                      thinkMs:
                        current.thinkStart !== null ? Date.now() - current.thinkStart : undefined,
                      parts: current.builtParts,
                    }
                  : m,
              ),
            }
          : c,
      ),
    }));
  };

  const finalizeDraft = (patch: Partial<Message>) => {
    const current = draft;
    if (!current) return;
    draft = null;
    if (current.timer) clearTimeout(current.timer);
    if (current.thinkStart !== null && current.reasoning.trim().length > 0) {
      current.thinkMs = Math.max(0, Date.now() - current.thinkStart);
    }
    const warn = patch.warn ?? current.warn ?? undefined;
    const isError = patch.isError ?? false;
    const answer = current.answer;
    const finalParts: MessagePart[] = [
      ...current.builtParts,
      ...(answer.length > 0 ? [{ type: "text" as const, text: answer }] : []),
    ];
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === current.convId
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.id === current.msgId
                  ? {
                      ...m,
                      ...patch,
                      reasoning: current.reasoning || undefined,
                      route: current.route ?? undefined,
                      notice: undefined,
                      warn,
                      isError: isError || undefined,
                      streaming: false,
                      thinkMs: current.thinkMs ?? undefined,
                      text: patch.text ?? answer,
                      parts:
                        patch.parts ??
                        (finalParts.length > 0 ? finalParts : (m.parts ?? [])),
                    }
                  : m,
              ),
            }
          : c,
      ),
      sending: false,
    }));
    clearLiveStream(current.msgId);
    markDirty(current.convId);
  };

  const removeDraftMessage = () => {
    const current = draft;
    if (!current) return;
    draft = null;
    if (current.timer) clearTimeout(current.timer);
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === current.convId
          ? { ...c, messages: c.messages.filter((m) => m.id !== current.msgId) }
          : c,
      ),
      sending: false,
    }));
    clearLiveStream(current.msgId);
  };

  const runStream = async (
    convId: string,
    history: ChatHistoryMessage[],
    turnId: string,
    options?: { allowRestart?: boolean; codeWorkspaceId?: string | null },
  ) => {
    const model = get().modelId;
    const allowRestart = options?.allowRestart ?? true;
    const mode: AppMode = options?.codeWorkspaceId ? "code" : "agent";
    const workspaceId = options?.codeWorkspaceId ?? undefined;
    let since = 0;
    let create = true;
    let resumeFrom: string | null = null;
    let attempts = 0;
    let sawDone = false;
    // ~2 minutes of reconnecting (longer with hidden-tab timer throttling);
    // the server job keeps running the whole time regardless.
    const MAX_ATTACH_ATTEMPTS = 30;

    /** Draft has content — OR the live message already does (a recovered
     *  turn resumes with an empty draft but a partially-filled message,
     *  and that partial must never be thrown away). Tool cards already
     *  pinned onto the timeline count too — a tool-only turn is real work. */
    const draftHasContent = (): boolean => {
      const current = draft;
      if (!current) return false;
      if (current.answer.trim().length > 0) return true;
      if (current.builtParts.some((p) => p.type === "tool")) return true;
      const live = get()
        .conversations.find((c) => c.id === current.convId)
        ?.messages.find((m) => m.id === current.msgId);
      if (!live) return false;
      return (
        live.text.trim().length > 0 ||
        (live.parts ?? []).some((p) => p.type === "text" && p.text.trim().length > 0) ||
        (live.parts ?? []).some((p) => p.type === "tool")
      );
    };

    const applyEvent = (event: StreamEvent) => {
      if (!draft) return;
      // A live event arrived — the re-attach succeeded; clear any transient
      // "reattaching…" overlay notice so it never outstays the blip.
      if (event.type !== "status" && useStream.getState().notice !== null) {
        setLiveStream({ notice: null });
      }
      switch (event.type) {
        case "route": {
          draft.route = {
            route: event.route,
            label: event.label,
            reason: event.reason,
            model: event.model,
          };
          if (!draft.statsCounted) {
            draft.statsCounted = true;
            set((s) => ({
              routeStats: {
                ...s.routeStats,
                [event.route]: (s.routeStats[event.route] ?? 0) + 1,
              },
            }));
            scheduleSnapshot();
          }
          pushMilestone();
          break;
        }
        case "reasoning": {
          if (draft.thinkStart === null) draft.thinkStart = Date.now();
          draft.reasoning += event.text;
          queueLive();
          break;
        }
        case "delta": {
          draft.answer += event.text;
          queueLive();
          break;
        }
        case "replace": {
          draft.reasoning = event.reasoning;
          draft.answer = event.answer;
          queueLive();
          break;
        }
        case "status": {
          draft.notice = event.text;
          pushMilestone();
          break;
        }
        case "warning": {
          draft.warn = event.text;
          pushMilestone();
          break;
        }
        case "tool_prepare": {
          // The model is still WRITING the tool call — surface the real name
          // + partial arguments live (fast overlay only; zero conversation
          // writes so token-frequency never re-renders the app shell).
          setLiveStream({
            msgId: draft.msgId,
            convId: draft.convId,
            prepare: { toolId: event.toolId, name: event.name, args: event.args },
          });
          break;
        }
        case "tool_call": {
          // A tool started server-side: close the current text segment and
          // pin a live tool card onto the timeline at this exact position.
          if (draft.answer.length > 0) {
            draft.builtParts.push({ type: "text", text: draft.answer });
            draft.answer = "";
          }
          draft.builtParts.push({
            type: "tool",
            tool: {
              name: event.name,
              icon: toolIconFor(event.name),
              subtitle: event.subtitle,
              status: "running",
              args: event.args,
              result: "",
              toolId: event.toolId,
            },
          });
          pushMilestone();
          setLiveStream({ answer: "", prepare: null });
          break;
        }
        case "tool_status": {
          const tool = draftTool(draft, event.toolId);
          if (tool) {
            tool.backgrounded = event.backgrounded;
            if (event.subtitle) tool.subtitle = event.subtitle;
            pushMilestone();
          }
          break;
        }
        case "tool_result": {
          const tool = draftTool(draft, event.toolId);
          if (tool) {
            tool.status = "completed";
            tool.result = event.result;
            if (event.subtitle) tool.subtitle = event.subtitle;
            tool.error = event.ok ? undefined : true;
            if (event.resultData) {
              const data: ToolResultData = {
                kind: event.resultData.kind as ToolResultData["kind"],
                payload: event.resultData.payload,
              };
              tool.resultData = data;
            }
            pushMilestone();
          }
          break;
        }
        case "done": {
          sawDone = true;
          finalizeDraft({});
          break;
        }
        case "cancelled": {
          // Stop pressed (possibly in another tab): keep what arrived.
          sawDone = true;
          if (draftHasContent()) {
            finalizeDraft({});
          } else {
            removeDraftMessage();
          }
          break;
        }
        case "error": {
          sawDone = true;
          throw new FinalStreamError(event.message);
        }
      }
    };

    while (true) {
      streamAbort = new AbortController();
      userStopped = false;
      sawDone = false;
      try {
        since = await consumeChatStream(
          { history, model, turnId, since, create, resumeFrom, mode, workspaceId },
          streamAbort.signal,
          applyEvent,
          () => {
            // hello.reset — the incoming replay rebuilds the whole draft.
            if (draft) {
              draft.reasoning = "";
              draft.answer = "";
              draft.builtParts = [];
              draft.route = null;
              draft.notice = null;
              setLiveStream({ reasoning: "", answer: "", prepare: null });
            }
          },
        );
        if (draft && !sawDone) {
          // Viewer leg closed without a completion marker — treat exactly
          // like a drop and re-attach; the job may still be running.
          throw new Error("Stream closed before the completion marker.");
        }
        if (draft) finalizeDraft({});
        return;
      } catch (error) {
        // User pressed stop: keep whatever arrived, finish silently.
        if (userStopped) {
          if (draft && draftHasContent()) {
            finalizeDraft({});
          } else {
            removeDraftMessage();
          }
          return;
        }

        // Server already retried and gave up — surface honestly.
        if (error instanceof FinalStreamError) {
          const message = error.message;
          if (draft && draftHasContent()) {
            finalizeDraft({ warn: message });
          } else {
            finalizeDraft({
              isError: true,
              parts: [{ type: "text", text: message }],
            });
          }
          return;
        }

        attempts += 1;

        // The server lost the job (restart / expiry). Rebuild it once with
        // the partial answer as the resume base — never silently restart a
        // turn the user may have forgotten about.
        if (error instanceof GoneError) {
          if (allowRestart && attempts <= 3) {
            resumeFrom = (draft?.answer ?? "").trim().length > 0 ? draft?.answer ?? null : null;
            since = 0;
            create = true;
            continue;
          }
          if (draft && draftHasContent()) {
            finalizeDraft({
              warn: "This reply was interrupted and could not be recovered — it may be incomplete.",
            });
          } else {
            removeDraftMessage();
          }
          return;
        }

        // Transport failure on the viewer leg (background-tab eviction,
        // network blip, socket reset, premature close). The job keeps
        // running server-side — re-attach and replay what we missed.
        //
        // A hidden tab is NOT a lost job: the first re-attach is usually a
        // sub-second blip the user never sees, so it stays SILENT. Only a
        // reconnect that actually takes multiple attempts is worth surfacing
        // (honest lifecycle, no false "reconnecting" noise on tab switches).
        if (attempts <= MAX_ATTACH_ATTEMPTS) {
          create = false; // attach-only; a missing job surfaces as GoneError
          if (draft && attempts >= 2) {
            setLiveStream({
              notice:
                attempts === 2
                  ? "Stream connection dropped — reattaching…"
                  : `Reattaching (attempt ${attempts - 1})…`,
            });
          }
          await sleepOrWake(Math.min(400 * 2 ** Math.min(attempts, 4), 5000));
          continue;
        }

        const message =
          "The connection dropped mid-reply and could not recover. Your message is safe — tap the refresh button to try again.";
        if (draft && draftHasContent()) {
          finalizeDraft({ warn: message });
        } else {
          finalizeDraft({ isError: true, parts: [{ type: "text", text: message }] });
        }
        return;
      } finally {
        streamAbort = null;
      }
    }
  };

  /* ---------------- send / regenerate ------------------------------ */

  const runTurn = async (
    conversationId: string,
    historyMessages: Message[],
    assistantId: string,
  ) => {
    const isCode =
      get().conversations.find((c) => c.id === conversationId)?.mode === "code";
    draft = {
      convId: conversationId,
      msgId: assistantId,
      turnId: assistantId,
      reasoning: "",
      answer: "",
      builtParts: [],
      route: null,
      notice: null,
      warn: null,
      thinkStart: null,
      thinkMs: null,
      timer: null,
      statsCounted: false,
    };
    syncOverlay();
    const history: ChatHistoryMessage[] = historyMessages.map((m) => ({
      role: m.role,
      content: messageContent(m),
    }));
    await runStream(conversationId, history, assistantId, {
      codeWorkspaceId: isCode ? conversationId : null,
    });
  };

  /**
   * Turns that were still streaming when the page went away (background
   * tab frozen/discarded, crash, reload) are re-attached to their
   * server-side job: a finished job replays its full reply near-instantly,
   * a live one keeps streaming. Stuck messages we cannot recover are
   * finalized as partials instead of spinning forever.
   */
  const recoverInterruptedTurns = () => {
    const state = get();
    const hasContent = (m: Message) =>
      m.text.trim().length > 0 ||
      (m.parts ?? []).some((p) => p.type === "text" && p.text.trim().length > 0);

    // Newest conversation with a stuck turn that carries a server job id
    // (conversations are sorted newest-first); its last such message wins.
    let targetConvId: string | null = null;
    let targetIndex = -1;
    let targetMsg: Message | null = null;
    for (const conversation of state.conversations) {
      for (let i = 0; i < conversation.messages.length; i++) {
        const message = conversation.messages[i];
        if (message.role === "assistant" && message.streaming && message.turnId) {
          targetConvId = conversation.id;
          targetIndex = i;
          targetMsg = message;
        }
      }
      if (targetMsg) break;
    }
    if (targetMsg && targetIndex === 0) {
      // Nothing to replay from — cannot recover meaningfully.
      targetMsg = null;
      targetConvId = null;
    }

    const recoverId = targetMsg?.id ?? null;
    const conversations = state.conversations.map((conversation) => {
      let changed = false;
      const messages: Message[] = [];
      for (const message of conversation.messages) {
        if (message.role === "assistant" && message.streaming && message.id !== recoverId) {
          changed = true;
          if (hasContent(message)) {
            messages.push({
              ...message,
              streaming: false,
              warn: "Recovered after the page reloaded — this reply may be incomplete.",
            });
          }
          continue; // empty + unrecoverable → drop
        }
        messages.push(message);
      }
      return changed ? { ...conversation, messages } : conversation;
    });
    set({ conversations });
    for (const c of conversations) {
      if (c !== state.conversations.find((o) => o.id === c.id)) markDirty(c.id);
    }

    if (!targetMsg || !targetConvId || !targetMsg.turnId) return;
    const conversation = get().conversations.find((c) => c.id === targetConvId);
    if (!conversation) return;
    const historyMessages = conversation.messages.slice(0, targetIndex);
    if (historyMessages.length === 0) return;

    draft = {
      convId: targetConvId,
      msgId: targetMsg.id,
      turnId: targetMsg.turnId,
      reasoning: "",
      answer: "",
      builtParts: [],
      route: null,
      notice: "Resuming your reply…",
      warn: null,
      thinkStart: null,
      thinkMs: null,
      timer: null,
      statsCounted: true, // replays never double-count
    };
    syncOverlay();
    set({ sending: true });
    const history: ChatHistoryMessage[] = historyMessages.map((m) => ({
      role: m.role,
      content: messageContent(m),
    }));
    const isCode =
      get().conversations.find((c) => c.id === targetConvId)?.mode === "code";
    void runStream(targetConvId, history, targetMsg.turnId, {
      allowRestart: false,
      codeWorkspaceId: isCode ? targetConvId : null,
    });
  };

  const sendMessage = async (text: string, mode: "send" | "regenerate") => {
    const trimmed = text.trim();
    const state = get();
    if (state.sending) return;
    const activeConvId = state.appMode === "code" ? state.activeCodeId : state.activeId;
    const conversation = state.conversations.find((c) => c.id === activeConvId);
    if (!conversation) return;

    let historyMessages: Message[];
    const assistantId = makeId();
    const assistant: Message = {
      id: assistantId,
      role: "assistant",
      text: "",
      time: nowLabel(),
      feedback: null,
      streaming: true,
      parts: [],
      turnId: assistantId,
    };

    if (mode === "send") {
      if (!trimmed) return;
      const userMessage: Message = {
        id: makeId(),
        role: "user",
        text: trimmed,
        time: nowLabel(),
      };
      const isUntitled =
        conversation.title === "New conversation" ||
        conversation.title === "New app" ||
        conversation.title.trim().length === 0;
      const title = isUntitled ? titleFrom(trimmed) : conversation.title;
      historyMessages = [...conversation.messages, userMessage];
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === conversation.id
            ? {
                ...c,
                title,
                messages: [...c.messages, userMessage, { ...assistant }],
              }
            : c,
        ),
        sending: true,
      }));
    } else {
      const messages = [...conversation.messages];
      while (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
        messages.pop();
      }
      if (messages.length === 0) return;
      historyMessages = messages;
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === conversation.id ? { ...c, messages: [...messages, { ...assistant }] } : c,
        ),
        sending: true,
      }));
    }

    markDirty(conversation.id);
    await runTurn(conversation.id, historyMessages, assistantId);
  };

  /* ---------------- store object ----------------------------------- */

  return {
    conversations: seedConversations,
    activeId: seedConversations[0].id,
    appMode: "agent",
    codeTab: "chat",
    activeCodeId: "",
    modelId: "auto",
    search: "",
    sending: false,
    mobileNavOpen: false,
    settingsOpen: false,
    booted: false,
    syncStatus: "booting",
    lastSyncedAt: null,
    syncError: null,
    autoSync: true,
    routeStats: { fast: 0, balanced: 0, deep: 0 },
    lastDeleted: null,

    hydrate: () => {
      if (get().booted) return;
      const prefs = loadPrefs();
      const snapshot = loadSnapshot();
      const conversations = snapshot
        ? sortConversations(snapshot.conversations)
        : sortConversations(seedConversations);
      for (const t of snapshot?.tombstones ?? []) tombstones.add(t);
      for (const t of (snapshot as { pendingTombstones?: string[] } | null)?.pendingTombstones ?? []) {
        pendingTombstones.add(t);
      }
      const codeConversations = conversations.filter((c) => c.mode === "code");
      const restoredMode: AppMode =
        prefs.appMode === "code" && codeConversations.length > 0 ? "code" : "agent";
      set({
        conversations,
        activeId: ensureActiveInMode(conversations, conversations[0]?.id ?? "", "agent"),
        activeCodeId: restoredMode === "code"
          ? ensureActiveInMode(conversations, prefs.activeCodeId ?? "", "code")
          : "",
        appMode: restoredMode,
        modelId: prefs.modelId ?? "auto",
        autoSync: prefs.autoSync ?? true,
        routeStats: prefs.routeStats ?? { fast: 0, balanced: 0, deep: 0 },
        booted: true,
      });
      // First boot on this device (no local snapshot): the cloud wins where
      // it already knows the conversation — only rows the server does NOT
      // have (still version 0 after the initial pull) are pushed as fresh.
      const markUnsyncedSeeds = () => {
        for (const c of get().conversations) {
          if (c.version === 0 && !tombstones.has(c.id)) dirtyIds.add(c.id);
        }
      };
      if (!snapshot && !get().autoSync) markUnsyncedSeeds();
      scheduleSnapshot();
      // Turns that were still streaming when the page died (backgrounded
      // tab frozen/discarded, crash, reload) resume from the server-side
      // job — a finished job replays instantly, a live one keeps streaming.
      recoverInterruptedTurns();
      if (get().autoSync) {
        // Pull first (respects tombstones), then push anything pending.
        void enqueueSync(doPull).then(() => {
          if (!snapshot) markUnsyncedSeeds();
          if (dirtyIds.size > 0 || pendingTombstones.size > 0) enqueueSync(doPush);
        });
      }
      // Resync + shortcut reconnect backoff whenever the tab becomes
      // visible again (hidden tabs throttle timers to ~1/minute).
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        wakeAll();
        if (get().booted && get().autoSync) {
          void enqueueSync(doPull);
        }
      });
    },

    setActive: (id) =>
      set((s) => {
        const conversation = s.conversations.find((c) => c.id === id);
        if (!conversation) return {};
        return conversation.mode === "code"
          ? { activeCodeId: id }
          : { activeId: id, appMode: s.appMode === "code" ? "agent" : s.appMode };
      }),

    newConversation: () => {
      set((state) => {
        const inCode = state.appMode === "code";
        const existingEmpty = state.conversations.find(
          (c) =>
            (c.mode === "code") === inCode &&
            c.title === (inCode ? "New app" : "New conversation") &&
            c.messages.length === 0,
        );
        if (existingEmpty) {
          return inCode
            ? { activeCodeId: existingEmpty.id, mobileNavOpen: false }
            : { activeId: existingEmpty.id, mobileNavOpen: false };
        }
        const conversation: Conversation = {
          id: makeId(),
          title: inCode ? "New app" : "New conversation",
          group: "today",
          separator: `Today · ${nowLabel()}`,
          messages: [],
          createdAt: Date.now(),
          version: 0,
          ...(inCode ? { mode: "code" as const } : {}),
        };
        return {
          conversations: [conversation, ...state.conversations],
          ...(inCode
            ? { activeCodeId: conversation.id }
            : { activeId: conversation.id }),
          mobileNavOpen: false,
        };
      });
      markDirty(get().appMode === "code" ? get().activeCodeId : get().activeId);
    },

    setSearch: (search) => set({ search }),

    setModel: (modelId) => {
      set({ modelId });
      scheduleSnapshot();
    },

    setMobileNav: (mobileNavOpen) => set({ mobileNavOpen }),

    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

    setFeedback: (messageId, value) => {
      set((state) => ({
        conversations: state.conversations.map((c) => ({
          ...c,
          messages: c.messages.map((m) =>
            m.id === messageId ? { ...m, feedback: m.feedback === value ? null : value } : m,
          ),
        })),
      }));
      const conv = get().conversations.find((c) => c.messages.some((m) => m.id === messageId));
      if (conv) markDirty(conv.id);
    },

    send: async (text) => {
      await sendMessage(text, "send");
    },

    regenerate: async () => {
      await sendMessage("", "regenerate");
    },

    stop: () => {
      userStopped = true;
      const turnId = draft?.turnId ?? null;
      streamAbort?.abort();
      // The turn now runs as a server-side job — aborting the viewer is
      // not enough, tell the job to stop spending tokens too.
      if (turnId) {
        void fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "cancel", turnId }),
        }).catch(() => undefined);
      }
    },

    deleteConversation: (id) => {
      const state = get();
      const target = state.conversations.find((c) => c.id === id);
      if (!target) return;
      // If this conversation is mid-stream, abort the stream first.
      if (draft?.convId === id) {
        userStopped = true;
        const turnId = draft.turnId;
        streamAbort?.abort();
        if (turnId) {
          void fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "cancel", turnId }),
          }).catch(() => undefined);
        }
      }
      const remaining = state.conversations.filter((c) => c.id !== id);
      tombstones.add(id);
      pendingTombstones.add(id);
      const wasCode = target.mode === "code";
      const pool = remaining.filter((c) => (c.mode === "code") === wasCode);
      const nextActive = wasCode
        ? state.activeCodeId === id
          ? (pool[0]?.id ?? "")
          : state.activeCodeId
        : state.activeId === id
          ? (pool[0]?.id ?? "")
          : state.activeId;
      set({
        conversations: remaining,
        ...(wasCode ? { activeCodeId: nextActive } : { activeId: nextActive }),
        lastDeleted: { conversation: target, at: Date.now() },
      });
      scheduleSnapshot();
      // Push the tombstone promptly (skip the debounce).
      if (get().autoSync) void enqueueSync(doPush);
    },

    undoDelete: () => {
      const last = get().lastDeleted;
      if (!last || Date.now() - last.at > 15_000) return;
      tombstones.delete(last.conversation.id);
      pendingTombstones.delete(last.conversation.id);
      const wasCode = last.conversation.mode === "code";
      set((s) => ({
        conversations: sortConversations([last.conversation, ...s.conversations]),
        // MODE-AWARE RESTORE: a code chat must never become the active
        // agent chat (and vice versa) — that is how code conversations
        // leaked into the normal agent view.
        ...(wasCode
          ? { activeCodeId: s.appMode === "code" ? last.conversation.id : s.activeCodeId }
          : { activeId: s.appMode === "agent" ? last.conversation.id : s.activeId }),
        lastDeleted: null,
      }));
      markDirty(last.conversation.id);
    },

    pullSync: async () => {
      await enqueueSync(doPull);
    },

    pushSync: async () => {
      await enqueueSync(doPush);
    },

    setAutoSync: (value) => {
      set({ autoSync: value });
      if (value) {
        void enqueueSync(doPull);
      } else {
        if (pushTimer) clearTimeout(pushTimer);
        if (pullRetryTimer) clearTimeout(pullRetryTimer);
        set({ syncStatus: "synced" });
      }
      scheduleSnapshot();
    },

    /* ---------------- OnyxCode -------------------------------------- */

    enterCodeMode: () => {
      const state = get();
      const codeConversations = conversationsForMode(state.conversations, "code");
      if (codeConversations.length === 0) {
        const conversation: Conversation = {
          id: makeId(),
          title: "New app",
          group: "today",
          separator: `Today · ${nowLabel()}`,
          messages: [],
          createdAt: Date.now(),
          version: 0,
          mode: "code",
        };
        set({
          appMode: "code",
          codeTab: "chat",
          activeCodeId: conversation.id,
          conversations: [conversation, ...state.conversations],
          mobileNavOpen: false,
        });
        markDirty(conversation.id);
      } else {
        set({
          appMode: "code",
          codeTab: "chat",
          activeCodeId: state.activeCodeId || codeConversations[0].id,
          mobileNavOpen: false,
        });
      }
      scheduleSnapshot();
    },

    exitCodeMode: () => {
      const state = get();
      // Leaving Code Mode destroys the workspace RUNTIME (the preview
      // session) — source files stay. CodeShell's unmount also covers this;
      // both are idempotent.
      if (state.activeCodeId) {
        void fetch("/api/code/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId: state.activeCodeId, action: "stop_workspace" }),
        }).catch(() => undefined);
      }
      set({ appMode: "agent", mobileNavOpen: false });
      scheduleSnapshot();
    },

    setCodeTab: (codeTab) => set({ codeTab }),

    newCodeConversation: () => {
      set((state) => {
        const existingEmpty = state.conversations.find(
          (c) => c.mode === "code" && c.title === "New app" && c.messages.length === 0,
        );
        if (existingEmpty) {
          return { activeCodeId: existingEmpty.id, appMode: "code", mobileNavOpen: false };
        }
        const conversation: Conversation = {
          id: makeId(),
          title: "New app",
          group: "today",
          separator: `Today · ${nowLabel()}`,
          messages: [],
          createdAt: Date.now(),
          version: 0,
          mode: "code",
        };
        return {
          conversations: [conversation, ...state.conversations],
          activeCodeId: conversation.id,
          appMode: "code",
          mobileNavOpen: false,
        };
      });
      markDirty(get().activeCodeId);
    },

    skipToolWait: (toolId) => {
      const current = draft;
      if (!current) return;
      // Optimistic: the card flips to "running in background" immediately;
      // the server confirms via a tool_status event right after.
      const tool = draftTool(current, toolId);
      if (tool) {
        tool.backgrounded = true;
        tool.subtitle = "Running in background";
        pushMilestone();
      }
      void fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "skip_wait", turnId: current.turnId, toolId }),
      }).catch(() => undefined);
    },
  };
});
