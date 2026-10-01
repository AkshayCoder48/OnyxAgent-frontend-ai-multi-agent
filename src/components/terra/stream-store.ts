"use client";

import { create } from "zustand";
import type { RouteInfo } from "./types";

/**
 * Live-stream overlay — the fast-changing half of an in-flight reply.
 *
 * ARCHITECTURE (the lag fix): the conversations store is only written at
 * MILESTONES (message added, tool card added/updated, route chosen, reply
 * finalized). Every-token state — reasoning, the growing answer, the
 * partially-generated tool call — lives HERE, and only the single streaming
 * assistant turn subscribes to it. So a token flush re-renders exactly one
 * component instead of the whole application (sidebar, header, panels,
 * thread, every message…), which is what made long generations janky.
 *
 * The module-level draft machinery in store.ts owns the authoritative copy;
 * this store is its reactive mirror for the UI.
 */

export interface PrepareTool {
  toolId: string;
  name: string;
  /** Full partial JSON text streamed so far (snapshot — set, not appended). */
  args: string;
}

export interface LiveStreamState {
  /** The streaming assistant message id (null when nothing is live). */
  msgId: string | null;
  convId: string | null;
  reasoning: string;
  answer: string;
  thinkStart: number | null;
  route: RouteInfo | null;
  /** Transient stream notice ("Resuming your reply…", "Reconnecting…"). */
  notice: string | null;
  /** The tool call the model is currently generating arguments for. */
  prepare: PrepareTool | null;
  /** Bumped on every live flush — cheap subscription for scroll-follow. */
  version: number;
}

export const useStream = create<LiveStreamState>(() => ({
  msgId: null,
  convId: null,
  reasoning: "",
  answer: "",
  thinkStart: null,
  route: null,
  notice: null,
  prepare: null,
  version: 0,
}));

type Mutable = Omit<LiveStreamState, "version">;

/** Push the live draft's current values (bumps version once). */
export function setLiveStream(patch: Partial<Mutable>): void {
  useStream.setState((s) => ({ ...patch, version: s.version + 1 }));
}

/**
 * Clear the overlay when a stream finishes. If a NEWER draft already took
 * over the overlay (msgId differs), leave it alone — never clobber live work.
 */
export function clearLiveStream(msgId: string | null): void {
  const current = useStream.getState().msgId;
  if (current !== null && msgId !== null && current !== msgId) return;
  useStream.setState({
    msgId: null,
    convId: null,
    reasoning: "",
    answer: "",
    thinkStart: null,
    route: null,
    notice: null,
    prepare: null,
    version: 0,
  });
}
