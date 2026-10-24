// ============================================================================
// useCloudOrchestrator — Trigger.dev Cloud connection state + mutations
// (Settings → Cloud Tasks; Background Task Execution Framework).
//
// Follows the use-background-tasks.ts conventions: qk.* keys, mutation +
// invalidate. All server round-trips go through /api/tasks/cloud; the API
// key itself is never persisted client-side — only the server's masked form
// ever comes back.
// ============================================================================
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/query-keys";

// ---------------------------------------------------------------------------
// Response shapes (mirrors /api/tasks/cloud).
// ---------------------------------------------------------------------------

export interface CloudAccountProject {
  id: string;
  name: string;
  externalRef: string;
  orgSlug: string | null;
  orgName: string | null;
  environments: Array<{ id: string; name: string; slug: string }>;
}

export interface CloudAccountSnapshot {
  partial: boolean;
  note?: string;
  projects: CloudAccountProject[];
}

export interface CloudOrchestratorStatus {
  ok: true;
  mode: "local" | "selfhosted" | "cloud";
  selfHosted: boolean;
  appUrl: string;
  cloud: {
    configured: boolean;
    keySource: "settings" | "env" | null;
    maskedKey: string | null;
    taskSlug: string;
    account: CloudAccountSnapshot | null;
    verifiedAt: string | null;
    dashboardBase: string | null;
    /** The operator's own worker token (setup checklist). Null when absent. */
    workerToken: string | null;
    workerTokenSource: "env" | "generated" | "none";
    apiBase: string;
  };
}

// ---------------------------------------------------------------------------
// Fetch helpers.
// ---------------------------------------------------------------------------

async function jsonError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    if (typeof data.error === "string" && data.error) return data.error;
  } catch {
    /* not JSON */
  }
  return `${fallback} (HTTP ${res.status})`;
}

async function fetchCloudStatus(): Promise<CloudOrchestratorStatus> {
  const res = await fetch("/api/tasks/cloud");
  if (!res.ok) throw new Error(await jsonError(res, "Failed to load the cloud connection"));
  return (await res.json()) as CloudOrchestratorStatus;
}

// ---------------------------------------------------------------------------
// Hook.
// ---------------------------------------------------------------------------

export function useCloudOrchestrator() {
  const qc = useQueryClient();
  const listKey = qk.tasks.cloudConfig();

  const query = useQuery({
    queryKey: listKey,
    queryFn: fetchCloudStatus,
    staleTime: 10_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: listKey });

  /** Verify + connect a key (optionally with a non-default task slug). */
  const connectM = useMutation({
    mutationFn: async (input: { apiKey: string; taskSlug?: string }) => {
      const res = await fetch("/api/tasks/cloud", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await jsonError(res, "Verification failed"));
      return (await res.json()) as CloudOrchestratorStatus;
    },
    onSuccess: invalidate,
  });

  /** Re-verify the STORED key against api.trigger.dev (server-side; the key
   *  never leaves the server) and refresh the account snapshot. */
  const retestM = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/tasks/cloud", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "retest" }),
      });
      if (!res.ok) throw new Error(await jsonError(res, "Verification failed"));
      return (await res.json()) as CloudOrchestratorStatus;
    },
    onSuccess: invalidate,
  });

  const setTaskSlugM = useMutation({
    mutationFn: async (taskSlug: string) => {
      const res = await fetch("/api/tasks/cloud", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskSlug }),
      });
      if (!res.ok) throw new Error(await jsonError(res, "Failed to save the task id"));
      return (await res.json()) as CloudOrchestratorStatus;
    },
    onSuccess: invalidate,
  });

  const disconnectM = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/tasks/cloud", { method: "DELETE" });
      if (!res.ok) throw new Error(await jsonError(res, "Failed to disconnect"));
      return (await res.json()) as CloudOrchestratorStatus;
    },
    onSuccess: invalidate,
  });

  return {
    status: query.data ?? null,
    isLoading: query.isLoading,
    /** Verify + connect { apiKey, taskSlug? }. */
    connect: connectM.mutateAsync,
    isConnecting: connectM.isPending,
    /** Refresh the connection status. */
    refresh: retestM.mutateAsync,
    isRetesting: retestM.isPending,
    /** Save the kicked task id. */
    setTaskSlug: setTaskSlugM.mutateAsync,
    isSavingSlug: setTaskSlugM.isPending,
    /** Disconnect (back to the local orchestrator). */
    disconnect: disconnectM.mutateAsync,
    isDisconnecting: disconnectM.isPending,
  };
}
