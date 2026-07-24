"use client";

import { create } from "zustand";
import { nanoid } from "nanoid";

/**
 * Subagent store — manages subagent configurations + chat sessions.
 *
 * Changes from previous version:
 *   - NO prebuilt agents — the AI orchestrator creates subagents dynamically
 *   - NO user-facing "create subagent" button — AI-only
 *   - Chat sessions persist to localStorage and survive page refresh
 *   - Multiple chat sessions per subagent, with a session selector
 *
 * Subagents are created by the AI (via spawn_subagent tool) or by the user
 * in settings (but only editing, not creating from scratch — the AI spawns
 * them based on task needs).
 */

export interface SubagentMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
    status: "pending" | "running" | "completed" | "error";
  }>;
  fileIds?: string[];
  isStreaming?: boolean;
}

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
      activeSubagentId: state.activeSessionId && state.sessions.find((s) => s.id === state.activeSessionId)?.subagentId === id
        ? null
        : state.activeSessionId,
    }));
    get().saveToStorage();
  },

  getSubagent: (id) => get().subagents.find((s) => s.id === id),

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
    get().saveToStorage();
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
