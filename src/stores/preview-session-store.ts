"use client";

/**
 * OnyxCode preview sessions (OnyxCode PRD §7 — "Preview sessions: stored as
 * lightweight records (sandbox id, port, public URL, status, created_at) so
 * they survive refresh").
 *
 * Zustand + localStorage persistence. The `manage_preview` / `start_preview`
 * agent tools and the Preview tab UI both read/write this single store, so
 * a preview the agent starts shows up in the Preview tab instantly, and the
 * Stop button in the UI acts on the same records the agent created.
 */

import { create } from "zustand";

export type PreviewSessionStatus = "running" | "stopped" | "error";

export interface PreviewSession {
  /** pv_* id (stable across refreshes). */
  id: string;
  /** App name (the scaffold's project name). */
  name: string;
  /** Scaffold key: nextjs | vite-react | fastapi | node | static | … */
  framework: string;
  frameworkLabel: string;
  /** Public E2B URL — https://{sandboxId}-{port}.e2b.dev */
  url: string;
  port: number;
  sandboxId: string;
  status: PreviewSessionStatus;
  /** The dev-server command (used by Stop). */
  command?: string;
  /** Error note when status === "error". */
  error?: string;
  createdAt: number;
  conversationId?: string;
}

const STORAGE_KEY = "onyx:code:preview-sessions";
const MAX_SESSIONS = 20;

/** Window event broadcast whenever sessions change (the Preview tab listens
 *  so a tool-driven change re-renders + re-selects even outside React). */
export const PREVIEW_SESSIONS_CHANGED_EVENT = "onyx:preview-sessions-changed";

function broadcast(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(PREVIEW_SESSIONS_CHANGED_EVENT));
  }
}

function loadSessions(): PreviewSession[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s) => s && typeof s.id === "string" && typeof s.url === "string",
    ) as PreviewSession[];
  } catch {
    return [];
  }
}

function persistSessions(sessions: PreviewSession[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
  } catch {
    /* storage unavailable — keep the in-memory state */
  }
}

interface PreviewSessionState {
  sessions: PreviewSession[];
  /** Insert or update a session (keyed by id), newest first. */
  upsert: (session: PreviewSession) => void;
  markStatus: (id: string, status: PreviewSessionStatus, error?: string) => void;
  remove: (id: string) => void;
}

export const usePreviewSessionStore = create<PreviewSessionState>((set) => ({
  sessions: loadSessions(),
  upsert: (session) =>
    set((s) => {
      const rest = s.sessions.filter((x) => x.id !== session.id);
      const sessions = [session, ...rest].slice(0, MAX_SESSIONS);
      persistSessions(sessions);
      broadcast();
      return { sessions };
    }),
  markStatus: (id, status, error) =>
    set((s) => {
      const sessions = s.sessions.map((x) =>
        x.id === id ? { ...x, status, error: error ?? x.error } : x,
      );
      persistSessions(sessions);
      broadcast();
      return { sessions };
    }),
  remove: (id) =>
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id);
      persistSessions(sessions);
      broadcast();
      return { sessions };
    }),
}));
