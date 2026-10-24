// ============================================================================
// useCloudOrchestrator — Trigger.dev Cloud connection state + mutations
// (Settings → Cloud Tasks; Background Task Execution Framework).
//
// Follows the use-background-tasks.ts conventions: qk.* keys, mutation +
// invalidate. All server round-trips go through /api/tasks/cloud.
//
// SERVERLESS SURVIVAL: on read-only deployments (Netlify etc.) the server
// cannot seal the key to SQLite — it holds the config in process memory
// (status.cloud.ephemeral) and forgets it on cold starts. The BROWSER is
// then the durable store: every successful connect is mirrored vault-sealed
// in Dexie (cloud-config-store.ts) and, whenever the server reports "not
// configured" while a mirror exists, the hook silently reconnects with the
// stored key. The API key itself is never persisted unencrypted and never
// rendered.
// ============================================================================
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/query-keys";
import { useAuth } from "@/hooks/use-auth";
import {
  clearClientCloudConfig,
  loadClientCloudConfig,
  saveClientCloudConfig,
} from "@/lib/tasks/cloud-config-store";

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

/** Worker bootstrap state (liveness of the deployed agent-run task +
 *  auto-deploy progress) — see trigger-cloud.ts. */
export interface WorkerBootstrap {
  liveness: "live" | "deploying" | "undeployed" | "unknown";
  probedAt: string | null;
  deploy: {
    state: "running" | "succeeded" | "failed" | "unavailable";
    startedAt: string | null;
    finishedAt: string | null;
    tail: string[];
  } | null;
}

export interface CloudOrchestratorStatus {
  ok: true;
  mode: "off" | "cloud";
  appUrl: string;
  cloud: {
    configured: boolean;
    keySource: "settings" | "env" | null;
    maskedKey: string | null;
    taskSlug: string;
    account: CloudAccountSnapshot | null;
    verifiedAt: string | null;
    dashboardBase: string | null;
    /** Serverless: the server holds the config in memory only; the browser
     *  mirror re-applies it after cold starts. */
    ephemeral: boolean;
    apiBase: string;
  };
  bootstrap?: WorkerBootstrap;
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
  const { user } = useAuth();
  const listKey = qk.tasks.cloudConfig();

  const query = useQuery({
    queryKey: listKey,
    queryFn: fetchCloudStatus,
    staleTime: 10_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: listKey });

  /** Verify + connect a key (optionally with a non-default task slug).
   *  On success the connection is mirrored vault-sealed in Dexie so
   *  serverless deployments can re-apply it after cold starts. */
  const connectM = useMutation({
    mutationFn: async (input: { apiKey: string; taskSlug?: string }) => {
      const res = await fetch("/api/tasks/cloud", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await jsonError(res, "Verification failed"));
      const status = (await res.json()) as CloudOrchestratorStatus;
      if (user?.id) {
        await saveClientCloudConfig(user.id, {
          apiKey: input.apiKey,
          taskSlug: status.cloud.taskSlug || input.taskSlug || "agent-run",
        });
      }
      return status;
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
      // Keep the mirror's slug in sync (serverless reconnects re-use it).
      if (user?.id) {
        const mirror = await loadClientCloudConfig(user.id);
        if (mirror) {
          await saveClientCloudConfig(user.id, {
            apiKey: mirror.apiKey,
            taskSlug,
          });
        }
      }
      return (await res.json()) as CloudOrchestratorStatus;
    },
    onSuccess: invalidate,
  });

  const disconnectM = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/tasks/cloud", { method: "DELETE" });
      if (!res.ok) throw new Error(await jsonError(res, "Failed to disconnect"));
      if (user?.id) await clearClientCloudConfig(user.id);
      return (await res.json()) as CloudOrchestratorStatus;
    },
    onSuccess: invalidate,
  });

  // ── Serverless auto-reconnect ─────────────────────────────────────────────
  // The server forgot the key (fresh lambda / read-only filesystem) but this
  // browser holds a vault-sealed mirror → re-submit it silently. Throttled
  // so a flapping deployment can't spam the verify endpoint; re-verified
  // live against api.trigger.dev on every reconnect.
  const reconnectingRef = React.useRef(false);
  const lastReconnectAtRef = React.useRef(0);

  const status = query.data ?? null;
  const needsReconnect =
    !!status &&
    !!user?.id &&
    !status.cloud.configured &&
    status.cloud.keySource === null; // env-sourced keys never need a mirror

  React.useEffect(() => {
    if (!needsReconnect || reconnectingRef.current) return;
    if (Date.now() - lastReconnectAtRef.current < 15_000) return;
    reconnectingRef.current = true;
    lastReconnectAtRef.current = Date.now();
    (async () => {
      try {
        const mirror = user?.id ? await loadClientCloudConfig(user.id) : null;
        if (!mirror?.apiKey) return;
        const res = await fetch("/api/tasks/cloud", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            apiKey: mirror.apiKey,
            taskSlug: mirror.taskSlug,
          }),
        });
        if (res.ok) invalidate();
      } catch {
        /* network hiccup — retried on the next status refetch */
      } finally {
        reconnectingRef.current = false;
      }
    })();
  }, [needsReconnect, user?.id, invalidate]);

  return {
    status,
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
    /** Disconnect. */
    disconnect: disconnectM.mutateAsync,
    isDisconnecting: disconnectM.isPending,
    /** (Re)deploy the bundled worker to the operator's cloud project. */
    deployWorker: async () => {
      await fetch("/api/tasks/cloud", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "deploy" }),
      });
      invalidate();
    },
  };
}
