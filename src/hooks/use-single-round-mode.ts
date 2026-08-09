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
  const [singleRoundMode, setSingleRoundModeState] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    settingsService
      .getSingleRoundMode(user.id)
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
  }, [user?.id]);

  const toggleSingleRoundMode = useCallback(async () => {
    if (!user?.id) return;
    const next = !singleRoundMode;
    setSingleRoundModeState(next); // optimistic update
    try {
      await settingsService.setSingleRoundMode(user.id, next);
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
  }, [user?.id, singleRoundMode]);

  return {
    singleRoundMode,
    toggleSingleRoundMode,
    loading,
  };
}
