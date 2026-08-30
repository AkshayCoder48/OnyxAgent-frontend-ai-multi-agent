"use client";

import { useState, useEffect, useCallback } from "react";
import { settingsService } from "@/lib/services";
import { useAuthStore } from "@/stores";
import { toast } from "sonner";

/**
 * useSingleRoundMode — reads and writes the user's single-round mode setting.
 *
 * Single-round mode caps the agent loop at 2 rounds (round 1 = all tool calls,
 * round 2 = final text response), producing ONE message bubble instead of
 * multiple bubbles split by tool calls. This reduces API requests, token
 * usage, and latency.
 *
 * The setting is persisted per-user via the settings service (Dexie).
 */
export function useSingleRoundMode() {
  const { user } = useAuthStore();
  const userId = user?.id;
  const [singleRoundMode, setSingleRoundModeState] = useState(false);
  // Loading until the persisted value resolves; when there's no user there's
  // nothing to load, so start idle.
  const [loading, setLoading] = useState(() => !userId);

  // User transitions: when the user signs out (or is absent), stop loading
  // immediately. Render-time adjustment — no setState-in-effect (flagged by
  // the React Compiler lint). Sign-in re-arms `loading` and the fetch effect
  // below resolves it.
  const [prevUserId, setPrevUserId] = useState(userId);
  if (userId !== prevUserId) {
    setPrevUserId(userId);
    setLoading(Boolean(userId));
  }

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    settingsService
      .getSingleRoundMode(userId)
      .then((enabled) => {
        if (!cancelled) setSingleRoundModeState(enabled);
      })
      .catch(() => {
        // Ignore — defaults to false
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const toggleSingleRoundMode = useCallback(async () => {
    if (!userId) return;
    const next = !singleRoundMode;
    setSingleRoundModeState(next); // optimistic update
    try {
      await settingsService.setSingleRoundMode(userId, next);
      toast.success(
        next
          ? "Single-round mode enabled — fewer API requests, one message bubble"
          : "Multi-round mode restored — separate bubbles for each round",
        { duration: 2500 },
      );
    } catch {
      // Revert on failure
      setSingleRoundModeState(!next);
      toast.error("Failed to update single-round mode");
    }
  }, [userId, singleRoundMode]);

  return {
    singleRoundMode,
    toggleSingleRoundMode,
    loading,
  };
}
