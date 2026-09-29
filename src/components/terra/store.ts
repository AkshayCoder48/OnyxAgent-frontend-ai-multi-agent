"use client";

import { create } from "zustand";
import { MODELS, seedConversations } from "./seed";
import type {
  ChatHistoryMessage,
  Conversation,
  Message,
  MessagePart,
  ModelPreferenceId,
  RouteInfo,
  RouteStats,
  SyncStatus,
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
      return `[used tool ${part.tool.name}: ${part.tool.subtitle}]`;
  }
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

function ensureActive(conversations: Conversation[], activeId: string): string {
  return conversations.some((c) => c.id === activeId) ? activeId : (conversations[0]?.id ?? "");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sentinel for errors the server already retried — never retried client-side. */
class FinalStreamError extends Error {}

interface StreamDraft {
  convId: string;
  msgId: string;
  reasoning: string;
  answer: string;
  route: RouteInfo | null;
  notice: string | null;
  warn: string | null;
  thinkStart: number | null;
  thinkMs: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

let draft: StreamDraft | null = null;
let streamAbort: AbortController | null = null;
let userStopped = false;

/* ------------------------------------------------------------------ */
/* SSE client — heartbeats ignored, transport failures surfaced        */
/* ------------------------------------------------------------------ */

type StreamEvent =
  | { type: "route"; route: RouteInfo["route"]; label: string; model?: string; reason: string }
  | { type: "reasoning"; text: string }
  | { type: "delta"; text: string }
  | { type: "replace"; reasoning: string; answer: string }
  | { type: "status"; text: string }
  | { type: "warning"; text: string }
  | { type: "done"; elapsedMs?: number; partial?: boolean }
  | { type: "error"; message: string };

async function consumeChatStream(
  history: ChatHistoryMessage[],
  model: ModelPreferenceId,
  resumeFrom: string | null,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: history.slice(-14),
      model,
      ...(resumeFrom ? { resumeFrom } : {}),
    }),
    signal,
  });

  if (!response.ok || !response.body) {
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

  const handleLine = (line: string) => {
    if (!line.startsWith("data:")) return; // heartbeats arrive as ": ping …"
    const payload = line.slice(5).trim();
    if (!payload) return;
    try {
      onEvent(JSON.parse(payload) as StreamEvent);
    } catch {
      // Ignore malformed fragments — the next event usually repairs.
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
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
            };
            const merged = normalizeConversation(incoming);
            if (existing) {
              conversations = conversations.map((c) => (c.id === update.id ? merged : c));
            } else {
              conversations.push(merged);
            }
          }
          conversations = sortConversations(conversations);
          return { conversations, activeId: ensureActive(conversations, s.activeId) };
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

  /** Write the current draft into the live assistant message (batched). */
  const flushDraft = () => {
    const current = draft;
    if (!current) return;
    if (current.timer) {
      clearTimeout(current.timer);
      current.timer = null;
    }
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
                      streaming: true,
                      // Live running timer for the thinking block.
                      thinkMs:
                        current.thinkStart !== null ? Date.now() - current.thinkStart : undefined,
                      text: current.answer,
                      parts:
                        current.answer.length > 0
                          ? [{ type: "text", text: current.answer }]
                          : [],
                    }
                  : m,
              ),
            }
          : c,
      ),
    }));
  };

  const queueFlush = () => {
    if (!draft || draft.timer) return;
    // setTimeout keeps working (throttled) in background tabs, unlike rAF —
    // so the reply keeps rendering even while the tab is hidden.
    draft.timer = setTimeout(flushDraft, 80);
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
                        (answer.length > 0
                          ? [{ type: "text", text: answer }]
                          : (m.parts ?? [])),
                    }
                  : m,
              ),
            }
          : c,
      ),
      sending: false,
    }));
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
  };

  const runStream = async (convId: string, history: ChatHistoryMessage[]) => {
    const model = get().modelId;
    let resumeFrom: string | null = null;
    let attempt = 0;
    let sawDone = false;

    while (true) {
      streamAbort = new AbortController();
      userStopped = false;
      sawDone = false;
      try {
        await consumeChatStream(history, model, resumeFrom, streamAbort.signal, (event) => {
          if (!draft) return;
          switch (event.type) {
            case "route": {
              draft.route = {
                route: event.route,
                label: event.label,
                reason: event.reason,
                model: event.model,
              };
              set((s) => ({
                routeStats: {
                  ...s.routeStats,
                  [event.route]: (s.routeStats[event.route] ?? 0) + 1,
                },
              }));
              queueFlush();
              break;
            }
            case "reasoning": {
              if (draft.thinkStart === null) draft.thinkStart = Date.now();
              draft.reasoning += event.text;
              queueFlush();
              break;
            }
            case "delta": {
              draft.answer += event.text;
              queueFlush();
              break;
            }
            case "replace": {
              draft.reasoning = event.reasoning;
              draft.answer = event.answer;
              queueFlush();
              break;
            }
            case "status": {
              draft.notice = event.text;
              queueFlush();
              break;
            }
            case "warning": {
              draft.warn = event.text;
              queueFlush();
              break;
            }
            case "done": {
              sawDone = true;
              finalizeDraft(event.partial ? {} : {});
              break;
            }
            case "error": {
              sawDone = true;
              throw new FinalStreamError(event.message);
            }
          }
        });
        if (draft && !sawDone) {
          // Server leg closed without a completion marker — treat exactly
          // like a client-leg drop and resume transparently.
          throw new Error("Stream closed before the completion marker.");
        }
        if (draft) finalizeDraft({});
        return;
      } catch (error) {
        // User pressed stop: keep whatever arrived, finish silently.
        if (userStopped) {
          if (draft && draft.answer.trim().length > 0) {
            finalizeDraft({});
          } else {
            removeDraftMessage();
          }
          return;
        }

        // Server already retried and gave up — surface honestly.
        if (error instanceof FinalStreamError) {
          const message = error.message;
          if (draft && draft.answer.trim().length > 0) {
            finalizeDraft({ warn: message });
          } else {
            finalizeDraft({
              isError: true,
              parts: [{ type: "text", text: message }],
            });
          }
          return;
        }

        // Client-leg transport failure (fetch aborted in a background tab,
        // network blip, socket reset, premature close). Auto-heal instead
        // of erroring — this is the "Stream read failed: operation aborted"
        // class of problem, and it now recovers on its own.
        const haveAnswer = (draft?.answer ?? "").trim().length > 0;
        if (haveAnswer && attempt < 2) {
          attempt += 1;
          resumeFrom = draft?.answer ?? null;
          if (draft) {
            draft.notice = "Connection dropped — resuming your reply…";
            queueFlush();
          }
          await sleep(600);
          continue;
        }
        if (!haveAnswer && attempt < 2) {
          attempt += 1;
          if (draft) {
            draft.notice = "Reconnecting…";
            queueFlush();
          }
          await sleep(800 * attempt);
          continue;
        }

        const message =
          "The connection dropped mid-reply and could not recover. Your message is safe — tap the refresh button to try again.";
        if (draft && draft.answer.trim().length > 0) {
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
    draft = {
      convId: conversationId,
      msgId: assistantId,
      reasoning: "",
      answer: "",
      route: null,
      notice: null,
      warn: null,
      thinkStart: null,
      thinkMs: null,
      timer: null,
    };
    const history: ChatHistoryMessage[] = historyMessages.map((m) => ({
      role: m.role,
      content: messageContent(m),
    }));
    await runStream(conversationId, history);
  };

  const sendMessage = async (text: string, mode: "send" | "regenerate") => {
    const trimmed = text.trim();
    const state = get();
    if (state.sending) return;
    const conversation = state.conversations.find((c) => c.id === state.activeId);
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
    };

    if (mode === "send") {
      if (!trimmed) return;
      const userMessage: Message = {
        id: makeId(),
        role: "user",
        text: trimmed,
        time: nowLabel(),
      };
      const title =
        conversation.title === "New conversation" ? titleFrom(trimmed) : conversation.title;
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
      set({
        conversations,
        activeId: conversations[0]?.id ?? "",
        modelId: prefs.modelId ?? "auto",
        autoSync: prefs.autoSync ?? true,
        routeStats: prefs.routeStats ?? { fast: 0, balanced: 0, deep: 0 },
        booted: true,
      });
      if (!snapshot) for (const c of conversations) dirtyIds.add(c.id);
      scheduleSnapshot();
      if (get().autoSync) {
        // Pull first (respects tombstones), then push anything pending.
        void enqueueSync(doPull).then(() => {
          if (dirtyIds.size > 0) enqueueSync(doPush);
        });
      }
      // Resync whenever the tab becomes visible again.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && get().booted && get().autoSync) {
          void enqueueSync(doPull);
        }
      });
    },

    setActive: (id) => set({ activeId: id }),

    newConversation: () => {
      set((state) => {
        const existingEmpty = state.conversations.find(
          (c) => c.title === "New conversation" && c.messages.length === 0,
        );
        if (existingEmpty) {
          return { activeId: existingEmpty.id, mobileNavOpen: false };
        }
        const conversation: Conversation = {
          id: makeId(),
          title: "New conversation",
          group: "today",
          separator: `Today · ${nowLabel()}`,
          messages: [],
          createdAt: Date.now(),
          version: 0,
        };
        return {
          conversations: [conversation, ...state.conversations],
          activeId: conversation.id,
          mobileNavOpen: false,
        };
      });
      markDirty(get().activeId);
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
      streamAbort?.abort();
    },

    deleteConversation: (id) => {
      const state = get();
      const target = state.conversations.find((c) => c.id === id);
      if (!target) return;
      // If this conversation is mid-stream, abort the stream first.
      if (draft?.convId === id) {
        userStopped = true;
        streamAbort?.abort();
      }
      const remaining = state.conversations.filter((c) => c.id !== id);
      tombstones.add(id);
      pendingTombstones.add(id);
      const nextActive = state.activeId === id ? (remaining[0]?.id ?? "") : state.activeId;
      set({
        conversations: remaining,
        activeId: nextActive,
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
      set((s) => ({
        conversations: sortConversations([last.conversation, ...s.conversations]),
        activeId: last.conversation.id,
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
  };
});
