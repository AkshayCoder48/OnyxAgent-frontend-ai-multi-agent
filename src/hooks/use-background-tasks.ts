// ============================================================================
// useBackgroundTasks, useBackgroundTask, useTaskSchedules,
// useTriggerBackgroundTask — Background Task Execution Framework hooks
// (Task 3-c). Follow the use-data.ts conventions: useAuthScope gating
// (authResolved), qk.* keys, mutation + invalidate.
// ============================================================================
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { qk } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth-store";
import {
  createTaskSchedule,
  deleteTaskSchedule,
  listTaskRuns,
  listTaskSchedules,
  pollTaskStatus,
  reconcileRunRows,
  triggerBackgroundTask,
  updateTaskSchedule,
  type TriggerBackgroundTaskInput,
} from "@/lib/tasks/client";
import type {
  TaskScheduleInput,
  TaskScheduleRecord,
  TaskStatusChunk,
  TaskStatusRun,
} from "@/lib/tasks/protocol";

// ── AUTH-RESOLVED GATING (same rationale as use-data.ts) ────────────────────
// The auth store synchronously boots with the transient "local-user" id;
// queries must fire exactly once against the FINAL id.
function useAuthScope() {
  const userId = useAuthStore((s) => s.user?.id);
  const authResolved = useAuthStore((s) => s.authResolved);
  return { userId: authResolved ? userId : null, authResolved };
}

// ---------------------------------------------------------------------------
// Run list — FR-3.1 polling + Dexie mirror reconciliation.
// ---------------------------------------------------------------------------

/**
 * All of the user's background task runs. Polls aggressively (4s) while any
 * run is queued/running, relaxes to 15s otherwise. Every successful fetch
 * also reconciles the durable Dexie mirror (fire-and-forget) so the v7
 * `background_tasks` rows stay fresh for offline sweeps + sync-back.
 */
export function useBackgroundTasks() {
  const { userId, authResolved } = useAuthScope();
  const query = useQuery({
    queryKey: qk.tasks.list(userId ?? undefined),
    queryFn: async () => {
      const runs = await listTaskRuns(userId!);
      // Fire-and-forget mirror reconciliation — never blocks the poll.
      void reconcileRunRows(runs, userId!).catch(() => {});
      return runs;
    },
    enabled: !!userId && authResolved,
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.status === "queued" || r.status === "running")
        ? 4000
        : 15000,
    staleTime: 2000,
  });
  return {
    runs: (query.data as TaskStatusRun[] | undefined) ?? [],
    isLoading: query.isLoading,
  };
}

// ---------------------------------------------------------------------------
// Single run — FR-3.2 cursor-based chunk accumulation.
// ---------------------------------------------------------------------------

export interface BackgroundTaskDetail {
  run: TaskStatusRun;
  /** Accumulated progress chunks (oldest → newest, deduped by seq). */
  chunks: TaskStatusChunk[];
}

/**
 * One run's status + accumulated chunk log. The query data carries the full
 * chunk history; each refetch polls with `cursor = last consumed seq` and
 * merges only the NEW chunks (survives unmount/remount — the cache keeps
 * accumulating within the gc window). Polls every 3s while the run is live,
 * stops on terminal statuses.
 */
export function useBackgroundTask(runId: string | null) {
  const qc = useQueryClient();
  const { userId } = useAuthScope();
  const query = useQuery({
    queryKey: runId ? qk.tasks.detail(runId) : qk.tasks.detail("none"),
    enabled: !!runId,
    queryFn: async (): Promise<BackgroundTaskDetail> => {
      const key = qk.tasks.detail(runId!);
      const prev = qc.getQueryData<BackgroundTaskDetail>(key);
      const lastSeq = prev?.chunks.reduce((max, c) => Math.max(max, c.seq), 0) ?? 0;
      const cursor = Math.max(prev?.run.cursor ?? 0, lastSeq);
      const run = await pollTaskStatus(runId!, cursor);
      if (!run) {
        throw new Error(
          "Background task not found — it may have been cleaned up on the server.",
        );
      }
      // Merge new chunks (dedupe by seq — the server may resend the boundary).
      const prevChunks = prev?.chunks ?? [];
      const seen = new Set(prevChunks.map((c) => c.seq));
      const merged = [
        ...prevChunks,
        ...(run.chunks ?? []).filter((c) => !seen.has(c.seq)),
      ].sort((a, b) => a.seq - b.seq);
      // Fire-and-forget mirror refresh (same poll — no second request).
      void reconcileRunRows([run], userId ?? undefined).catch(() => {});
      return { run, chunks: merged };
    },
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status === "queued" || status === "running" ? 3000 : false;
    },
    staleTime: 1000,
  });
  return {
    run: query.data?.run ?? null,
    chunks: query.data?.chunks ?? [],
    isLoading: query.isLoading,
  };
}

// ---------------------------------------------------------------------------
// Schedules — FR-2.1 list + CRUD mutations.
// ---------------------------------------------------------------------------

export function useTaskSchedules() {
  const qc = useQueryClient();
  const listKey = qk.tasks.schedules();
  const query = useQuery({
    queryKey: listKey,
    queryFn: () => listTaskSchedules(),
    staleTime: 30_000,
  });
  const createM = useMutation({
    mutationFn: (input: TaskScheduleInput) => createTaskSchedule(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
  const updateM = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<TaskScheduleInput> }) =>
      updateTaskSchedule(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
  const deleteM = useMutation({
    mutationFn: (id: string) => deleteTaskSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
  return {
    schedules: (query.data as TaskScheduleRecord[] | undefined) ?? [],
    isLoading: query.isLoading,
    create: createM.mutateAsync,
    update: updateM.mutateAsync,
    remove: deleteM.mutateAsync,
  };
}

// ---------------------------------------------------------------------------
// Trigger — mutation wrapper with toasts + list invalidation.
// ---------------------------------------------------------------------------

export type TriggerTaskInput = Omit<TriggerBackgroundTaskInput, "userId">;

/**
 * Start a background task (see triggerBackgroundTask). Resolves the user id
 * LIVE from the auth store inside the mutationFn (the use-data.ts resilient
 * pattern — a closure over an unresolved render would save/trigger under the
 * transient local-user id). Toasts on success/error and invalidates the
 * tasks cache so the strip picks the new run up immediately.
 */
export function useTriggerBackgroundTask() {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (input: TriggerTaskInput) => {
      const userId = useAuthStore.getState().user?.id;
      if (!userId) {
        throw new Error("No user resolved — cannot start a background task.");
      }
      return triggerBackgroundTask({ ...input, userId });
    },
    onSuccess: (res) => {
      toast.success("Background task started", {
        description: `Run ${res.runId.slice(0, 8)} — track it in the tasks strip.`,
      });
      void qc.invalidateQueries({ queryKey: qk.tasks.all() });
    },
    onError: (err) => {
      toast.error("Background task failed to start", {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });
  return {
    trigger: mutation.mutateAsync,
    isPending: mutation.isPending,
    error: mutation.error,
  };
}
