"use client";

/**
 * Skip-wait registry (OnyxCode PRD §4.4 — shared by normal Agent + Code
 * Mode). A tiny module-level bridge between the UI ("Continue while this
 * runs") and the agent runtime's tool-execution loop:
 *
 *   - The runtime calls `getSkipWaitRace(conversationId, toolCallId)` when a
 *     tool STARTS running and races the handler promise against it.
 *   - The UI's SkipWaitButton calls `requestSkipWait(...)` when the user
 *     clicks. The race resolves, the round continues with a placeholder
 *     result, and the real handler keeps running detached — its late
 *     result is injected as a tool_result event (and replaces the
 *     placeholder in the message history) when it settles.
 *
 * Keyed by conversation id + tool call id (both sides know both keys). The
 * runtime clears its entry once the late result lands.
 */

const pending = new Map<string, Promise<"skipped">>();
const resolvers = new Map<string, () => void>();
const skippedSet = new Set<string>();

/** Records self-expire so a stale skip never leaks across turns. */
const SKIP_TTL_MS = 10 * 60_000;

export function skipWaitKey(conversationId: string, toolCallId: string): string {
  return `${conversationId}::${toolCallId}`;
}

/** The promise the runtime races against. Created on first call. */
export function getSkipWaitRace(conversationId: string, toolCallId: string): Promise<"skipped"> {
  const key = skipWaitKey(conversationId, toolCallId);
  let p = pending.get(key);
  if (!p) {
    p = new Promise<"skipped">((resolve) => {
      resolvers.set(key, () => resolve("skipped"));
    });
    pending.set(key, p);
    // TTL: an unclaimed race (tool finished before the click, or the user
    // never clicked) must not hold memory forever.
    window.setTimeout(() => {
      if (pending.get(key) === p) {
        pending.delete(key);
        resolvers.delete(key);
      }
    }, SKIP_TTL_MS);
  }
  return p;
}

/** Fire the skip (UI action). Returns false when nothing was pending. */
export function requestSkipWait(conversationId: string, toolCallId: string): boolean {
  const key = skipWaitKey(conversationId, toolCallId);
  const resolve = resolvers.get(key);
  if (resolve) {
    resolve();
    resolvers.delete(key);
    pending.delete(key);
    skippedSet.add(key);
    window.setTimeout(() => skippedSet.delete(key), SKIP_TTL_MS);
    return true;
  }
  // The race already settled (tool completed) — still record the intent so
  // the button can render its final state honestly.
  skippedSet.add(key);
  window.setTimeout(() => skippedSet.delete(key), SKIP_TTL_MS);
  return false;
}

/** Was this tool call skipped (for button state after re-renders)? */
export function wasSkipped(conversationId: string, toolCallId: string): boolean {
  return skippedSet.has(skipWaitKey(conversationId, toolCallId));
}

/** Runtime cleanup once the late (real) result has been injected. */
export function clearSkipWait(conversationId: string, toolCallId: string): void {
  const key = skipWaitKey(conversationId, toolCallId);
  pending.delete(key);
  resolvers.delete(key);
  skippedSet.delete(key);
}
