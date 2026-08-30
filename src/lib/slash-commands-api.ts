/**
 * API client for user-scoped slash command settings — backendless.
 *
 * Two row shapes share one table:
 *  - "custom"  → user-defined `/<name>` shortcuts (prompt is set)
 *  - "builtin-override" → on/off flag for one of the built-ins (prompt is null)
 *
 * Backendless mode: all calls go to `slashCommandService` from
 * `@/lib/services`, which persists rows to IndexedDB (Dexie) scoped by
 * user id. The exported function names + types match the original API
 * exactly so hooks/components don't break.
 */

import { slashCommandService } from "@/lib/services";
import { useAuthStore } from "@/stores";

export interface UserSlashCommandRecord {
  id: string;
  name: string;
  /** null for built-in overrides; non-null for user-defined custom commands. */
  prompt: string | null;
  is_enabled: boolean;
  /** True for built-in (catalog) commands; false for user-defined. */
  is_builtin?: boolean;
  created_at: string;
  updated_at: string | null;
}

function requireUserId(): string {
  const userId = useAuthStore.getState().user?.id;
  if (!userId) {
    throw new Error("You must be signed in to manage slash commands.");
  }
  return userId;
}

export async function listSlashCommands(): Promise<UserSlashCommandRecord[]> {
  const userId = requireUserId();
  return slashCommandService.list(userId);
}

export async function createCustomCommand(input: {
  name: string;
  prompt: string;
  is_enabled?: boolean;
}): Promise<UserSlashCommandRecord> {
  const userId = requireUserId();
  return slashCommandService.createCustom(userId, input);
}

export async function upsertBuiltinOverride(input: {
  name: string;
  is_enabled: boolean;
}): Promise<UserSlashCommandRecord> {
  const userId = requireUserId();
  return slashCommandService.toggleBuiltin(userId, input.name, input.is_enabled);
}

export async function updateSlashCommand(
  id: string,
  patch: { name?: string; prompt?: string; is_enabled?: boolean },
): Promise<UserSlashCommandRecord> {
  // `slashCommandService.update` doesn't take a userId (it operates by id),
  // but the row carries a `user_id` so the underlying Dexie update is scoped.
  return slashCommandService.update(id, patch);
}

export async function deleteSlashCommand(id: string): Promise<void> {
  await slashCommandService.delete(id);
}
