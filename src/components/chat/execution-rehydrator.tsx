"use client";

// ============================================================================
// ExecutionRehydrator — invisible client component mounted once in the
// dashboard layout. On app start (and on auth hydration) it resumes EVERY
// persisted E2B background job (spec §14: a browser refresh must not
// terminate backend execution). Each job becomes an ExecutionHub execution
// whose consumer keeps replaying sandbox events into the conversation's
// Dexie records — regardless of which page the user lands on. Never throws;
// renders null.
// ============================================================================

import { useEffect } from "react";
import { useAuth } from "@/hooks";
import { useBackgroundRunStore } from "@/stores/background-run-store";
import { getEffectiveE2BKey } from "@/lib/e2b/env-key";
import { executionHub } from "@/lib/agent/execution-hub";

export function ExecutionRehydrator() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) return;
    if (!useBackgroundRunStore.getState().enabled) return;
    let cancelled = false;
    void (async () => {
      let e2bKey: string | null = null;
      try {
        e2bKey = await getEffectiveE2BKey(userId);
      } catch {
        return;
      }
      if (!e2bKey || cancelled) return;
      try {
        await executionHub.rehydrateAll(userId, e2bKey);
      } catch {
        // best-effort — the per-conversation resume effect retries on view
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return null;
}
