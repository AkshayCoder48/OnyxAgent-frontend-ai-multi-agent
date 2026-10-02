"use client";

/**
 * OnyxCode preview sessions (OnyxCode PRD §7 — "Preview sessions: stored as
 * lightweight records (sandbox id, port, public URL, status, created_at) so
 * they survive refresh").
 *
 * ONE CODE CHAT = ONE APP (Runtime PRD §2-8/§73-76): every record is scoped
 * to its `conversationId` and keyed by the DETERMINISTIC id
 * `pv-<conversationId>`, so a chat owns at most ONE preview record — created
 * by the first start_preview, re-used/upgraded in place by every later
 * start, kept (status "stopped", url cleared) after Stop so re-entering the
 * chat can auto-start it again. The `start_preview` / `manage_preview` agent
 * tools AND the Preview panel both read/write this single store, so a
 * preview the agent starts shows up in the panel instantly and everything
 * survives refreshes.
 */

import { create } from "zustand";

export type PreviewSessionStatus = "running" | "stopped" | "error";

export interface PreviewSession {
  /** Deterministic pv-<conversationId> id (stable across refreshes). */
  id: string;
  /** App name (the scaffold's project name). */
  name: string;
  /** Scaffold key: nextjs | vite-react | fastapi | node | static | … */
  framework: string;
  frameworkLabel: string;
  /** Public E2B URL — https://{sandboxId}-{port}.e2b.dev. null once the
   *  preview is stopped (stale URLs are dropped so the UI can never embed a
   *  dead page — PRD §7/§122); re-populated by the next start. */
  url: string | null;
  port: number;
  sandboxId: string;
  status: PreviewSessionStatus;
  /** The dev-server command (used by Stop). */
  command?: string;
  /** Error note when status === "error". */
  error?: string;
  createdAt: number;
  /** Monotonic-ish boot stamp — bumped by EVERY completed start (a fresh
   *  dev-server boot AND a healthy-server reuse). The preview panel's
   *  iframe key includes it, so each new boot remounts the iframe and the
   *  panel can never keep rendering a page from a PREVIOUS build (the
   *  stale-scaffold-page / "__webpack_modules__[moduleId] is not a
   *  function" fix). */
  bootEpoch?: number;
  conversationId?: string;
}

const STORAGE_KEY = "onyx:code:preview-sessions";
const MAX_SESSIONS = 20;

/**
 * The deterministic session id for a conversation's ONE preview record.
 * (Runtime PRD §2 — "One Code Chat = One App Preview Project": the chat's
 * record is always this id, so re-entering the chat finds and upgrades it
 * in place instead of piling up a new record per start.)
 */
export function previewSessionIdFor(conversationId: string): string {
  return `pv-${conversationId}`;
}

/**
 * The conversation's single preview record (null when the chat has no app
 * project yet). Callers pass the ACTIVE conversation id — never show or
 * touch another chat's session.
 */
export function findPreviewSession(
  sessions: PreviewSession[],
  conversationId: string | null | undefined,
): PreviewSession | null {
  if (!conversationId) return null;
  return (
    sessions.find((s) => s.conversationId === conversationId) ??
    // Legacy safety net: a record that was loaded before the deterministic
    // id migration but never re-saved still matches by its pv-<id> key.
    sessions.find((s) => s.id === previewSessionIdFor(conversationId)) ??
    null
  );
}

/** Window event broadcast whenever sessions change (kept for cross-tab
 *  listeners — the in-app consumers subscribe via zustand directly). */
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
    const valid = parsed.filter(
      (s): s is PreviewSession =>
        !!s &&
        typeof s.id === "string" &&
        (typeof s.url === "string" || s.url === null) &&
        typeof s.createdAt === "number",
    );
    return adoptLegacySessions(valid);
  } catch {
    return [];
  }
}

/**
 * ONE-APP-PER-CHAT MIGRATION: legacy stores could hold MANY sessions for the
 * same conversation under random pv_<ts>_<rand> ids. On load, each
 * conversation keeps exactly ONE record — the NEWEST by createdAt — re-keyed
 * to the deterministic pv-<conversationId> id (older duplicates for that
 * conversation are dropped/merged into it). Sessions without a conversationId
 * (pre-scoping leftovers) survive as orphans, invisible to the scoped UI,
 * until the cap prunes them.
 */
function adoptLegacySessions(list: PreviewSession[]): PreviewSession[] {
  const sorted = [...list].sort((a, b) => b.createdAt - a.createdAt);
  const byConversation = new Map<string, PreviewSession>();
  const orphans: PreviewSession[] = [];
  for (const s of sorted) {
    if (!s.conversationId) {
      orphans.push(s);
      continue;
    }
    if (!byConversation.has(s.conversationId)) {
      byConversation.set(s.conversationId, {
        ...s,
        id: previewSessionIdFor(s.conversationId),
      });
    }
  }
  return [...byConversation.values(), ...orphans].slice(0, MAX_SESSIONS);
}

function persistSessions(sessions: PreviewSession[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
  } catch {
    /* storage unavailable — keep the in-memory state */
  }
}

/**
 * Cap the store at MAX_SESSIONS *conversations* (records are lightweight and
 * survive refresh): exactly one record per conversation (the newest), and
 * beyond the cap the OLDEST conversations' records are dropped first.
 */
function pruneByConversation(sessions: PreviewSession[]): PreviewSession[] {
  // Sessions arrive newest-first; the first record seen per conversation is
  // that conversation's newest (and, thanks to the upsert invariant, only).
  const newestPerConversation = new Map<string, PreviewSession>();
  for (const s of sessions) {
    const key = s.conversationId ?? `orphan:${s.id}`;
    if (!newestPerConversation.has(key)) newestPerConversation.set(key, s);
  }
  return [...newestPerConversation.values()].slice(0, MAX_SESSIONS);
}

interface PreviewSessionState {
  sessions: PreviewSession[];
  /** Insert or update a session (keyed by id), newest first. Upserting a
   *  conversation-scoped session REPLACES any other record for the same
   *  conversation — the one-app-per-chat invariant lives here. */
  upsert: (session: PreviewSession) => void;
  markStatus: (id: string, status: PreviewSessionStatus, error?: string) => void;
  remove: (id: string) => void;
}

export const usePreviewSessionStore = create<PreviewSessionState>((set) => ({
  sessions: loadSessions(),
  upsert: (session) =>
    set((s) => {
      // ONE APP PER CHAT: drop every record for this conversation (a legacy
      // id is adopted/merged into the incoming one) and the old copy of this
      // record, then prepend — so a conversation can never hold two records.
      const others = s.sessions.filter((x) => {
        if (x.id === session.id) return false;
        if (session.conversationId && x.conversationId === session.conversationId) return false;
        return true;
      });
      const sessions = pruneByConversation([session, ...others]);
      persistSessions(sessions);
      broadcast();
      return { sessions };
    }),
  markStatus: (id, status, error) =>
    set((s) => {
      const sessions = s.sessions.map((x) =>
        x.id === id
          ? {
              ...x,
              status,
              // Stopped previews drop their (now stale) public URL — the
              // record survives for auto-start, but the UI can never embed
              // a dead page (PRD §7/§122). The error note also resets.
              url: status === "stopped" ? null : x.url,
              error: status === "stopped" ? undefined : (error ?? x.error),
            }
          : x,
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
