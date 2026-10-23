// ============================================================================
// useProviders, useSettings, useSlashCommands, useCustomTools, useSkills
// ============================================================================
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  aiProviderService,
  settingsService,
  slashCommandService,
  customToolService,
  skillService,
} from "@/lib/services";
import { qk } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth-store";
import type { ID } from "@/types";

// ── AUTH-RESOLVED GATING (stale "OnyxAI" ghost fix) ─────────────────────────
// The auth store SYNCHRONOUSLY starts with the transient "local-user" id;
// init() swaps in the real (nanoid) id shortly after. Queries keyed on the
// transient id would read rows belonging to no real account — deleted
// legacy seed rows ("OnyxAI") resurfaced in pickers while the user's own
// rows stayed hidden until a remount. Every per-user list query is gated
// on `authResolved` so it fires exactly once, against the FINAL id.
function useAuthScope() {
  const userId = useAuthStore((s) => s.user?.id);
  const authResolved = useAuthStore((s) => s.authResolved);
  return { userId: authResolved ? userId : null, authResolved };
}

export function useProviders() {
  const { userId } = useAuthScope();
  const qc = useQueryClient();
  // Single shared key (qk factory) — every provider consumer (Settings, chat
  // pickers, route pages) dedupes onto one cache entry and one fetch.
  const listKey = qk.aiProviders.list(userId ?? undefined);
  const query = useQuery({
    queryKey: listKey,
    queryFn: () => (userId ? aiProviderService.list(userId) : []),
    enabled: !!userId,
  });
  const createM = useMutation({
    mutationFn: async (input: Parameters<typeof aiProviderService.create>[1]) =>
      aiProviderService.create(userId!, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
  const updateM = useMutation({
    mutationFn: async ({ id, patch }: { id: ID; patch: Record<string, unknown> }) =>
      aiProviderService.update(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
  const deleteM = useMutation({
    mutationFn: async (id: ID) => aiProviderService.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
  const testM = useMutation({
    mutationFn: async ({ id, model }: { id: ID; model?: string }) =>
      aiProviderService.test(id, model),
  });
  return {
    providers: query.data ?? [],
    loading: query.isLoading,
    create: createM.mutateAsync,
    update: updateM.mutateAsync,
    remove: deleteM.mutateAsync,
    test: testM.mutateAsync,
  };
}

export function useSettings() {
  const { userId } = useAuthScope();
  const qc = useQueryClient();
  const detailKey = qk.userSettings.detail(userId ?? undefined);
  const query = useQuery({
    queryKey: detailKey,
    queryFn: () => (userId ? settingsService.get(userId) : null),
    enabled: !!userId,
  });
  const updateM = useMutation({
    mutationFn: async (patch: Parameters<typeof settingsService.update>[1]) =>
      settingsService.update(userId!, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: detailKey }),
  });
  const setE2BKeyM = useMutation({
    mutationFn: async (key: string | null) => {
      // RESILIENT USER RESOLUTION (the "E2B key never saves" fix): the
      // closure userId can be stale (auth unresolved at the last render) —
      // read the live store as a fallback before giving up.
      const effectiveUserId =
        userId ?? useAuthStore.getState().user?.id ?? undefined;
      if (!effectiveUserId) throw new Error("No user resolved — cannot save the key");
      return settingsService.setSandboxKey(effectiveUserId, key);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: detailKey }),
  });
  const setOnyxBaseKeyM = useMutation({
    mutationFn: async (key: string | null) => settingsService.setOnyxBaseApiKey(userId!, key),
    onSuccess: () => qc.invalidateQueries({ queryKey: detailKey }),
  });
  const setComposioKeyM = useMutation({
    mutationFn: async (key: string | null) => settingsService.setComposioApiKey(userId!, key),
    onSuccess: () => qc.invalidateQueries({ queryKey: detailKey }),
  });
  return {
    settings: query.data ?? null,
    loading: query.isLoading,
    update: updateM.mutateAsync,
    // `setE2BKey` is the legacy name — both names write the same DB column.
    setE2BKey: setE2BKeyM.mutateAsync,
    setSandboxKey: setE2BKeyM.mutateAsync,
    setOnyxBaseApiKey: setOnyxBaseKeyM.mutateAsync,
    setComposioApiKey: setComposioKeyM.mutateAsync,
  };
}

export function useSlashCommands() {
  const { userId } = useAuthScope();
  const qc = useQueryClient();
  // SAME KEY as hooks/use-slash-commands.ts (qk.slashCommands.list) — the
  // two hooks previously used different keys (["slash-commands", userId] vs
  // ["slash-commands", "list", userId]), so each mounted its own fetch and
  // mutations from one hook never invalidated the other's cache.
  const listKey = qk.slashCommands.list(userId ?? undefined);
  const query = useQuery({
    queryKey: listKey,
    queryFn: () => (userId ? slashCommandService.list(userId) : []),
    enabled: !!userId,
  });
  const createM = useMutation({
    mutationFn: async (input: { name: string; prompt: string; isEnabled?: boolean }) =>
      slashCommandService.createCustom(userId!, {
        name: input.name,
        prompt: input.prompt,
        is_enabled: input.isEnabled ?? true,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
  const updateM = useMutation({
    mutationFn: async ({ id, patch }: { id: ID; patch: Record<string, unknown> }) =>
      slashCommandService.update(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
  const toggleBuiltinM = useMutation({
    mutationFn: async ({ name, isEnabled }: { name: string; isEnabled: boolean }) =>
      slashCommandService.toggleBuiltin(userId!, name, isEnabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
  const deleteM = useMutation({
    mutationFn: async (id: ID) => slashCommandService.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
  return {
    commands: query.data ?? [],
    loading: query.isLoading,
    create: createM.mutateAsync,
    update: updateM.mutateAsync,
    toggleBuiltin: toggleBuiltinM.mutateAsync,
    remove: deleteM.mutateAsync,
  };
}

export function useCustomTools() {
  const { userId } = useAuthScope();
  const qc = useQueryClient();
  const listKey = qk.customTools.list(userId ?? undefined);
  const query = useQuery({
    queryKey: listKey,
    queryFn: () => (userId ? customToolService.list(userId) : []),
    enabled: !!userId,
  });
  const createM = useMutation({
    mutationFn: async (input: Parameters<typeof customToolService.create>[1]) =>
      customToolService.create(userId!, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
  const updateM = useMutation({
    mutationFn: async ({ id, patch }: { id: ID; patch: Record<string, unknown> }) =>
      customToolService.update(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
  const deleteM = useMutation({
    mutationFn: async (id: ID) => customToolService.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
  return {
    tools: query.data ?? [],
    loading: query.isLoading,
    create: createM.mutateAsync,
    update: updateM.mutateAsync,
    remove: deleteM.mutateAsync,
  };
}

export function useSkills() {
  const { userId } = useAuthScope();
  const qc = useQueryClient();
  const listKey = qk.skills.list(userId ?? undefined);
  const query = useQuery({
    queryKey: listKey,
    queryFn: () => (userId ? skillService.list(userId) : []),
    enabled: !!userId,
  });
  const deleteM = useMutation({
    mutationFn: async (id: ID) => skillService.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
  return {
    skills: query.data ?? [],
    loading: query.isLoading,
    remove: deleteM.mutateAsync,
  };
}
