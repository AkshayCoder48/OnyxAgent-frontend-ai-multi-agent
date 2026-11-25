"use client";

import { create } from "zustand";
import { nanoid } from "nanoid";

/**
 * Subagent store — the DATA layer for API-only subagents. There is NO
 * sub-agent chat UI: the AI orchestrator spawns/steers/queries subagents
 * purely through the subagent tools (spawn_subagent, query_subagent, …),
 * and every tool call + result renders in the MAIN workspace chat through
 * the ordinary tool-call UI. This store keeps what the tools still need:
 *
 *   - subagent configs (registry rows the tools create/lookup/dispose)
 *   - chat sessions (the subagent↔AI conversation state the runtime
 *     streams into and read_chat snapshots; persisted to localStorage so
 *     subagent state survives a page refresh)
 *
 * Changes from the UI era:
 *   - sidebarOpen/setSidebarOpen removed (no sidebar exists)
 *   - activeSessionId kept — the runtime falls back to it when a tool
 *     doesn't pin an explicit session
 */

export interface SubagentMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  /** Reasoning/thinking text streamed by the model (reasoning_content /
   *  reasoning deltas). Rendered by the shared ThinkingReasoning element —
   *  never merged into `content`. (Sub-Agent Chat PRD §3.) */
  reasoning?: string;
  /** True while this reasoning is still streaming (drives the live
   *  "Thinking…" header vs the settled "Thought for Ns" summary). */
  isReasoningStreaming?: boolean;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
    status: "pending" | "running" | "completed" | "error";
    /** Epoch ms when the call started — drives the live elapsed badge on
     *  the shared ToolCallCard. */
    startedAt?: number;
    /** Epoch ms when the call settled — drives the settled duration badge. */
    endedAt?: number;
  }>;
  fileIds?: string[];
  isStreaming?: boolean;
}

/** Lifecycle states for an agent (the orchestration pipeline). */
export type AgentLifecycleStatus =
  | "idle"
  | "planning"
  | "working"
  | "waiting"
  | "reviewing"
  | "completed"
  | "disposed";

export interface SubagentConfig {
  id: string;
  name: string;
  description: string;
  specialty: "research" | "code" | "analysis" | "writing" | "general";
  /** Override provider ID. If null, inherits the main agent's active provider. */
  providerId: string | null;
  /** Override model. If null, inherits. */
  model: string | null;
  /** Override base_url. If null, inherits. */
  baseUrl: string | null;
  /** Override API key. If null, inherits. */
  apiKey: string | null;
  /** System prompt for the subagent. */
  systemPrompt: string;
  /** Is the subagent enabled (can be called by orchestrator)? */
  enabled: boolean;
  /** Whether this agent auto-disposes after its task completes. Disposable
   *  agents are removed from the sidebar (enabled=false) once they finish. */
  disposable?: boolean;
  /** Specialization label (e.g. "Frontend Engineer", "Database Engineer").
   *  Surfaces in the UI + drives the orchestration pipeline's role assignment. */
  role?: string;
  /** Current lifecycle state — used by the orchestration pipeline + UI badges. */
  lifecycle_status?: AgentLifecycleStatus;
  /** The task ID that spawned this agent (for traceability). */
  parent_task?: string;
  /** ISO timestamp of the agent's last activity (tool call, message, etc.). */
  last_activity?: string;
  created_at: string;
}

/** A chat session with a subagent — persists across refresh. */
export interface SubagentChatSession {
  id: string;
  subagentId: string;
  title: string;
  messages: SubagentMessage[];
  created_at: string;
  updated_at: string;
  pinned?: boolean;
}

interface SubagentStore {
  subagents: SubagentConfig[];
  sessions: SubagentChatSession[];
  activeSessionId: string | null;

  // Subagent config actions
  createSubagent: (config: Partial<SubagentConfig>) => SubagentConfig;
  updateSubagent: (id: string, updates: Partial<SubagentConfig>) => void;
  deleteSubagent: (id: string) => void;
  getSubagent: (id: string) => SubagentConfig | undefined;

  // Lifecycle management — the orchestration pipeline drives these.
  updateLifecycleStatus: (id: string, status: AgentLifecycleStatus) => void;
  disposeAgent: (id: string) => void;

  // Session actions
  createSession: (subagentId: string, title?: string) => SubagentChatSession;
  deleteSession: (sessionId: string) => void;
  setActiveSession: (id: string | null) => void;
  getActiveSession: () => SubagentChatSession | null;
  updateSessionTitle: (sessionId: string, title: string) => void;
  pinSession: (sessionId: string, pinned: boolean) => void;
  addMessage: (sessionId: string, message: SubagentMessage) => void;
  updateMessage: (sessionId: string, messageId: string, updates: Partial<SubagentMessage>) => void;
  clearMessages: (sessionId: string) => void;

  loadFromStorage: () => void;
  saveToStorage: () => void;
}

const STORAGE_KEY = "onyxagent-subagents-v2";

// STREAMING PERSISTENCE THROTTLE state (see updateMessage): mid-stream
// deltas persist at most once per 400ms; settle events always persist.
let lastPersistAt = 0;
let pendingPersist = false;

export const useSubagentStore = create<SubagentStore>((set, get) => ({
  subagents: [],
  sessions: [],
  activeSessionId: null,

  createSubagent: (config) => {
    const subagent: SubagentConfig = {
      id: config.id || `subagent_${nanoid(10)}`,
      name: config.name || "Subagent",
      description: config.description || "",
      specialty: config.specialty || "general",
      providerId: config.providerId ?? null,
      model: config.model ?? null,
      baseUrl: config.baseUrl ?? null,
      apiKey: config.apiKey ?? null,
      systemPrompt: config.systemPrompt || "",
      enabled: config.enabled ?? true,
      disposable: config.disposable ?? false,
      role: config.role,
      lifecycle_status: config.lifecycle_status ?? "idle",
      parent_task: config.parent_task,
      last_activity: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };
    set((state) => ({
      subagents: [...state.subagents, subagent],
    }));
    get().saveToStorage();
    return subagent;
  },

  updateSubagent: (id, updates) => {
    set((state) => ({
      subagents: state.subagents.map((s) => (s.id === id ? { ...s, ...updates } : s)),
    }));
    get().saveToStorage();
  },

  deleteSubagent: (id) => {
    set((state) => ({
      subagents: state.subagents.filter((s) => s.id !== id),
      sessions: state.sessions.filter((s) => s.subagentId !== id),
      // Fix: was `activeSubagentId` (doesn't exist in the store interface).
      // Use `activeSessionId` — clear it if the active session belonged to
      // the deleted subagent.
      activeSessionId: state.activeSessionId && state.sessions.find((s) => s.id === state.activeSessionId)?.subagentId === id
        ? null
        : state.activeSessionId,
    }));
    get().saveToStorage();
  },

  getSubagent: (id) => get().subagents.find((s) => s.id === id),

  updateLifecycleStatus: (id, status) => {
    set((state) => ({
      subagents: state.subagents.map((s) =>
        s.id === id
          ? { ...s, lifecycle_status: status, last_activity: new Date().toISOString() }
          : s,
      ),
    }));
    get().saveToStorage();
  },

  disposeAgent: (id) => {
    set((state) => ({
      subagents: state.subagents.map((s) =>
        s.id === id
          ? {
              ...s,
              lifecycle_status: "disposed",
              enabled: false,
              last_activity: new Date().toISOString(),
            }
          : s,
      ),
    }));
    get().saveToStorage();
  },

  createSession: (subagentId, title) => {
    const session: SubagentChatSession = {
      id: nanoid(),
      subagentId,
      title: title || `Chat ${new Date().toLocaleString()}`,
      messages: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    set((state) => ({
      sessions: [session, ...state.sessions],
      activeSessionId: session.id,
    }));
    get().saveToStorage();
    return session;
  },

  deleteSession: (sessionId) => {
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== sessionId),
      activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId,
    }));
    get().saveToStorage();
  },

  setActiveSession: (id) => set({ activeSessionId: id }),

  getActiveSession: () => {
    const { sessions, activeSessionId } = get();
    return sessions.find((s) => s.id === activeSessionId) ?? null;
  },

  updateSessionTitle: (sessionId, title) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, title, updated_at: new Date().toISOString() } : s,
      ),
    }));
    get().saveToStorage();
  },

  pinSession: (sessionId, pinned) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, pinned, updated_at: new Date().toISOString() } : s,
      ),
    }));
    get().saveToStorage();
  },

  addMessage: (sessionId, message) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? { ...s, messages: [...s.messages, message], updated_at: new Date().toISOString() }
          : s,
      ),
    }));
    get().saveToStorage();
  },

  updateMessage: (sessionId, messageId, updates) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              messages: s.messages.map((m) => (m.id === messageId ? { ...m, ...updates } : m)),
              updated_at: new Date().toISOString(),
            }
          : s,
      ),
    }));
    // STREAMING PERSISTENCE THROTTLE (Sub-Agent Chat PRD §1/§6 + the
    // background-tab jank/network-error reports): the runtime calls this
    // on EVERY streamed delta — the old unconditional saveToStorage ran a
    // full JSON.stringify of every session on EVERY TOKEN, which stalled
    // the tab's main thread in background runs (timer throttling turns
    // that into multi-second freezes and the pending fetch looks dead).
    // Now: persist immediately only when streaming SETTLES (isStreaming /
    // isReasoningStreaming flipping to false) or when a tool call settles
    // — mid-stream deltas persist at most once every 400ms.
    const settling =
      updates.isStreaming === false ||
      updates.isReasoningStreaming === false ||
      (updates.toolCalls !== undefined);
    if (settling) {
      get().saveToStorage();
      pendingPersist = false;
      return;
    }
    const now = Date.now();
    if (!pendingPersist || now - lastPersistAt >= 400) {
      lastPersistAt = now;
      pendingPersist = true;
      get().saveToStorage();
    }
  },

  clearMessages: (sessionId) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, messages: [], updated_at: new Date().toISOString() } : s,
      ),
    }));
    get().saveToStorage();
  },

  loadFromStorage: () => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return; // No prebuilt agents — start empty, AI creates them.
      }
      const parsed = JSON.parse(raw);
      set({
        subagents: parsed.subagents ?? [],
        sessions: parsed.sessions ?? [],
      });
    } catch {
      // corrupted — start fresh
    }
  },

  saveToStorage: () => {
    if (typeof window === "undefined") return;
    try {
      const state = get();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        subagents: state.subagents,
        sessions: state.sessions,
      }));
    } catch {
      // quota / private mode — ignore
    }
  },
}));

// AUTO-HYDRATE: Load from localStorage on module import so the store is
// populated before any component or tool reads it. Previously the store
// only loaded when the sidebar or settings page mounted — meaning the
// AI's spawn_subagent tool saw an empty store and created duplicates,
// and query_subagent couldn't find subagents that existed in localStorage
// but hadn't been loaded yet.
if (typeof window !== "undefined") {
  useSubagentStore.getState().loadFromStorage();
}
