"use client";

// ============================================================================
// OnyxAiBridgeRuntime — invisible, mounted ONCE in the dashboard layout.
//
// Keeps the OnyxAI Browser Runtime alive for the whole session: while an app
// tab is open (and the runtime is enabled / OnyxAI is the active provider),
// it heartbeats presence and serves remote model calls (Telegram, scheduled
// tasks) against the user's local QVAC server. Renders null — the status UI
// lives in Settings → OnyxAI.
// ============================================================================

import { useEffect } from "react";
import { useAuth } from "@/hooks";
import { bridgeRuntime } from "@/lib/onyxai/bridge-runtime";

export function OnyxAiBridgeRuntime() {
  // useAuth (not the raw store) — its mount effect rehydrates the real user
  // + vault before the runtime resolves its first provider/key (the same
  // cold-navigation race SchedulerHeartbeat documents).
  const { user } = useAuth();
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) return;
    return bridgeRuntime.ensure(userId);
  }, [userId]);

  return null;
}
