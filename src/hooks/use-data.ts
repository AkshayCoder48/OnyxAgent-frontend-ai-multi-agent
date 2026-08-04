// ============================================================================
// useProviders, useSettings, useSlashCommands, useMCP, useCustomTools, useSkills
// ============================================================================
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  aiProviderService,
  settingsService,
  slashCommandService,
  mcpService,
  customToolService,
  skillService,
} from "@/lib/services";
import { useAuthStore } from "@/stores/auth-store";
import type { ID } from "@/types";

export function useProviders() {
  const { user } = useAuthStore();
  const userId = user?.id;
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["ai-providers", userId],
    queryFn: () => (userId ? aiProviderService.list(userId) : []),
    enabled: !!userId,
  });
  const createM = useMutation({
    mutationFn: async (input: Parameters<typeof aiProviderService.create>[1]) =>
      aiProviderService.create(userId!, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai-providers", userId] }),
  });
  const updateM = useMutation({
    mutationFn: async ({ id, patch }: { id: ID; patch: Record<string, unknown> }) =>
      aiProviderService.update(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai-providers", userId] }),
  });
  const deleteM = useMutation({
    mutationFn: async (id: ID) => aiProviderService.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai-providers", userId] }),
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
  const { user } = useAuthStore();
  const userId = user?.id;
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["user-settings", userId],
    queryFn: () => (userId ? settingsService.get(userId) : null),
    enabled: !!userId,
  });
  const updateM = useMutation({
    mutationFn: async (patch: Parameters<typeof settingsService.update>[1]) =>
      settingsService.update(userId!, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-settings", userId] }),
  });
  const setE2BKeyM = useMutation({
    mutationFn: async (key: string | null) => settingsService.setSandboxKey(userId!, key),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-settings", userId] }),
  });
  return {
    settings: query.data ?? null,
    loading: query.isLoading,
    update: updateM.mutateAsync,
    // `setE2BKey` is the legacy name — both names write the same DB column.
    setE2BKey: setE2BKeyM.mutateAsync,
    setSandboxKey: setE2BKeyM.mutateAsync,
  };
}

export function useSlashCommands() {
  const { user } = useAuthStore();
  const userId = user?.id;
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["slash-commands", userId],
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slash-commands", userId] }),
  });
  const updateM = useMutation({
    mutationFn: async ({ id, patch }: { id: ID; patch: Record<string, unknown> }) =>
      slashCommandService.update(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slash-commands", userId] }),
  });
  const toggleBuiltinM = useMutation({
    mutationFn: async ({ name, isEnabled }: { name: string; isEnabled: boolean }) =>
      slashCommandService.toggleBuiltin(userId!, name, isEnabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slash-commands", userId] }),
  });
  const deleteM = useMutation({
    mutationFn: async (id: ID) => slashCommandService.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slash-commands", userId] }),
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

export function useMCPServers() {
  const { user } = useAuthStore();
  const userId = user?.id;
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["mcp-servers", userId],
    queryFn: () => (userId ? mcpService.list(userId) : []),
    enabled: !!userId,
  });
  const createM = useMutation({
    mutationFn: async (input: Parameters<typeof mcpService.create>[1]) =>
      mcpService.create(userId!, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp-servers", userId] }),
  });
  const updateM = useMutation({
    mutationFn: async ({ id, patch }: { id: ID; patch: Record<string, unknown> }) =>
      mcpService.update(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp-servers", userId] }),
  });
  const deleteM = useMutation({
    mutationFn: async (id: ID) => mcpService.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp-servers", userId] }),
  });
  return {
    servers: query.data ?? [],
    loading: query.isLoading,
    create: createM.mutateAsync,
    update: updateM.mutateAsync,
    remove: deleteM.mutateAsync,
  };
}

export function useCustomTools() {
  const { user } = useAuthStore();
  const userId = user?.id;
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["custom-tools", userId],
    queryFn: () => (userId ? customToolService.list(userId) : []),
    enabled: !!userId,
  });
  const createM = useMutation({
    mutationFn: async (input: Parameters<typeof customToolService.create>[1]) =>
      customToolService.create(userId!, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["custom-tools", userId] }),
  });
  const updateM = useMutation({
    mutationFn: async ({ id, patch }: { id: ID; patch: Record<string, unknown> }) =>
      customToolService.update(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["custom-tools", userId] }),
  });
  const deleteM = useMutation({
    mutationFn: async (id: ID) => customToolService.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["custom-tools", userId] }),
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
  const { user } = useAuthStore();
  const userId = user?.id;
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["skills", userId],
    queryFn: () => (userId ? skillService.list(userId) : []),
    enabled: !!userId,
  });
  const deleteM = useMutation({
    mutationFn: async (id: ID) => skillService.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills", userId] }),
  });
  return {
    skills: query.data ?? [],
    loading: query.isLoading,
    remove: deleteM.mutateAsync,
  };
}
