"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/types";

/**
 * useAgentActivity — the companion's single source of truth (Realtime PRD
 * §30): what the agent is doing RIGHT NOW, derived from the chat store's
 * streaming state with zero extra wiring:
 *
 *   browsing  — a use_browser tool call is running/pending
 *   executing — any other tool call is running/pending
 *   writing   — the streaming assistant message has visible text
 *   thinking  — processing, but nothing visible yet
 *   success   — settle pulse (≈2.4s) after a turn completes
 *   error     — settle pulse when the turn ended with an error
 *   idle      — not processing (companion sleeps after a beat)
 */

export type AgentActivity =
  | "idle"
  | "thinking"
  | "browsing"
  | "executing"
  | "writing"
  | "success"
  | "error";

function isActive(c: { status?: string }): boolean {
  return c.status === "running" || c.status === "pending";
}

function deriveActivity(isProcessing: boolean, messages: readonly ChatMessage[]): Exclude<AgentActivity, "success" | "error"> {
  if (!isProcessing) return "idle";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    let anyToolActive = false;
    for (const c of m.toolCalls ?? []) {
      if (!isActive(c)) continue;
      anyToolActive = true;
      if (c.name === "use_browser") return "browsing";
    }
    if (anyToolActive) return "executing";
    if (m.isStreaming) {
      const hasText =
        Boolean(m.content) ||
        (m.parts ?? []).some((p) => p.type === "text" && p.content);
      return hasText ? "writing" : "thinking";
    }
    break; // only the NEWEST assistant message matters
  }
  return "thinking";
}

function lastTurnErrored(messages: readonly ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "assistant") {
      // A tool call that ended in error wins.
      for (const c of m.toolCalls ?? []) {
        if (c.status === "error") return true;
      }
      return false;
    }
    if (m.role === "user") return false;
  }
  return false;
}

/**
 * @param isProcessing true while an agent turn runs (the same flag that
 * drives the chat's Thinking bar).
 * @param messages the conversation's messages (the same array the thread
 * renders — memo-friendly: only array identity matters).
 */
export function useAgentActivity(
  isProcessing: boolean,
  messages: readonly ChatMessage[],
): AgentActivity {
  const live = deriveActivity(isProcessing, messages);
  const [pulse, setPulse] = useState<"success" | "error" | null>(null);
  const sawActive = useRef(false);

  useEffect(() => {
    if (isProcessing) {
      sawActive.current = true;
      return;
    }
    if (!sawActive.current) return;
    sawActive.current = false;
    // SETTLE PULSE: a beat of joy (or a wobbly recovery) right after the
    // turn ends, then back to idle. setState lives inside the timers —
    // never synchronously in the effect body (repo lint rule).
    const errored = lastTurnErrored(messages);
    const t1 = window.setTimeout(
      () => setPulse(errored ? "error" : "success"),
      300,
    );
    const t2 = window.setTimeout(() => setPulse(null), 2700);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
    // `messages` is read once at settle time; re-running the timers per
    // message change would restart the pulse mid-flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isProcessing]);

  return pulse ?? live;
}
