"use client";

import { useEffect, useState } from "react";

/**
 * AI-GENERATED STATUS PHRASES (user directive 2026-10-02).
 *
 * While an agent turn streams, the live status line ("Working…/Thinking…")
 * cycles follow-up phrases. Those used to be a hard-coded list — a
 * simulation. This hook fetches ONE batch of phrases per turn from
 * /api/status-caption, where an actual LLM writes them from the user's
 * request + the current activity — so the working text reads like the
 * agent narrating its own steps, different every conversation.
 *
 * Design notes:
 *  - ONE request per (activity, tool, task) per session: results are cached
 *    in a module-level Map with in-flight dedup, so remounts (the status
 *    line remounts on every Thinking ⇄ Working phase swap) never re-fetch.
 *  - The resolved batch rides state (keyed — a stale batch never flashes on
 *    a key change); the CACHE is read during render so a remount with a hot
 *    cache shows phrases on the very first paint.
 *  - The ThinkingIndicator keeps its canned defaults until the AI phrases
 *    land (typically <2s) — never a blank or blocked status line.
 *  - Failures resolve to null silently; the canned fallback stays.
 */

/** activity vocabulary understood by /api/status-caption. */
export type StatusActivity = "thinking" | "working" | "reasoning";

export interface AiStatusPhrasesInput {
  /** What the agent is doing right now. "reasoning" is folded into the
   *  thinking bucket server-side; the key stays distinct so phrase sets
   *  differ between the two panels. */
  activity: StatusActivity;
  /** The user's request (last user message) — context for the LLM. */
  task?: string;
  /** Tool the agent just used, when known (optional specificity). */
  tool?: string;
  /** Only fetch while a turn is actually streaming. */
  enabled: boolean;
}

/** Module cache: one phrase batch per (activity, tool, task) key. */
const CACHE = new Map<string, string[]>();
/** In-flight request dedup — remounting callers share one fetch. */
const INFLIGHT = new Map<string, Promise<string[] | null>>();

function cacheKey(activity: StatusActivity, tool: string, task: string): string {
  return `${activity}|${tool}|${task.slice(0, 200)}`;
}

function fetchPhrases(
  key: string,
  activity: StatusActivity,
  tool: string,
  task: string,
): Promise<string[] | null> {
  const cached = CACHE.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = INFLIGHT.get(key);
  if (existing) return existing;
  const p = fetch("/api/status-caption", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      activity: activity === "reasoning" ? "thinking" : activity,
      tool: tool || undefined,
      task: task || undefined,
    }),
  })
    .then(async (res) => {
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as {
        phrases?: unknown;
      } | null;
      if (!data || !Array.isArray(data.phrases)) return null;
      const list = data.phrases.filter(
        (p): p is string => typeof p === "string" && p.trim().length > 1,
      );
      if (list.length === 0) return null;
      CACHE.set(key, list);
      return list;
    })
    .catch(() => null)
    .finally(() => {
      if (INFLIGHT.get(key) === p) INFLIGHT.delete(key);
    });
  INFLIGHT.set(key, p);
  return p;
}

/** AI-written follow-up phrases for the live status line, or null while
 *  loading/unavailable (the caller falls back to its canned set). */
export function useAiStatusPhrases({
  activity,
  task,
  tool,
  enabled,
}: AiStatusPhrasesInput): string[] | null {
  const toolKey = (tool ?? "").slice(0, 80);
  const taskKey = (task ?? "").slice(0, 200);
  const key = cacheKey(activity, toolKey, taskKey);

  // The last RESOLVED batch, keyed so a key change (new activity/tool/task)
  // never flashes the previous batch — it falls back to cache/null until
  // its own batch lands.
  const [resolved, setResolved] = useState<{
    key: string;
    list: string[];
  } | null>(null);

  // Render-visible value: the resolved batch for THIS key, else a hot
  // cache hit (instant on remount), else null (canned defaults).
  const phrases =
    resolved?.key === key ? resolved.list : (CACHE.get(key) ?? null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // Share one request across remounts via the module cache + in-flight
    // map; resolves from cache (already-loaded turns) without a network
    // hop. setState rides the async callback, never the effect body.
    fetchPhrases(key, activity, toolKey, taskKey).then((list) => {
      if (!cancelled && list) setResolved({ key, list });
    });
    return () => {
      cancelled = true;
    };
  }, [key, enabled, activity, toolKey, taskKey]);

  return phrases;
}
