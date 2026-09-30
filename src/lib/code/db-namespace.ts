"use client";

/**
 * OnyxCode Database namespace — shared between the Database tab
 * (DatabasePanel) and the `manage_database` agent tool, so the UI and the
 * agent read/write EXACTLY the same records.
 *
 * Storage: the user's OnyxBase KV account (same client + key resolution as
 * the workspace-sync tools — the key never enters the prompt). Records live
 * in the existing "onyxagent" collection under the `code:db:` key prefix.
 */

import { OnyxBaseKV, ONYXBASE_DEFAULT_BASE_URL } from "@/lib/onyxbase/kv-client";
import { settingsService } from "@/lib/services";
import { useAuthStore } from "@/stores";

/** All OnyxCode database records are stored under this key prefix. */
export const CODE_DB_PREFIX = "code:db:";

/** Upper bound on records pulled into the Database tab per refresh. */
export const CODE_DB_MAX_RECORDS = 100;

export function codeDbKey(name: string): string {
  return `${CODE_DB_PREFIX}${name.replace(/^\/+/, "").replace(/^code:db:/, "")}`;
}

export function stripCodeDbPrefix(key: string): string {
  return key.startsWith(CODE_DB_PREFIX) ? key.slice(CODE_DB_PREFIX.length) : key;
}

/** A single OnyxCode database record (key + parsed-when-possible JSON value). */
export interface CodeDbRecord {
  key: string;
  name: string;
  value: string;
  parsed: unknown;
  isJson: boolean;
  size: number;
}

export interface CodeDbClient {
  kv: OnyxBaseKV;
}

export type CodeDbFailure =
  | { kind: "not_configured" }
  | { kind: "error"; message: string };

/**
 * Resolve the OnyxBase KV client for the current (or given) user. Mirrors
 * the workspace_sync tool's key resolution: vault-decrypted key + optional
 * custom base URL, never any secret in the prompt.
 */
export async function resolveCodeDbClient(userId?: string): Promise<CodeDbClient | CodeDbFailure> {
  const uid = userId || useAuthStore.getState().user?.id;
  if (!uid) return { kind: "not_configured" };
  try {
    const key = await settingsService.getDecryptedOnyxBaseApiKey(uid);
    if (!key || !key.trim()) return { kind: "not_configured" };
    const settings = await settingsService.get(uid).catch(() => null);
    const baseUrl = settings?.onyxbase_base_url || ONYXBASE_DEFAULT_BASE_URL;
    return { kv: new OnyxBaseKV(key, baseUrl) };
  } catch {
    return { kind: "not_configured" };
  }
}

/** List every OnyxCode database record (bounded). */
export async function listCodeDbRecords(
  client: CodeDbClient,
  opts?: { onProgress?: (n: number) => void },
): Promise<CodeDbRecord[]> {
  const keys = (await client.kv.listKeys(CODE_DB_PREFIX))
    .filter((k) => k.startsWith(CODE_DB_PREFIX))
    .slice(0, CODE_DB_MAX_RECORDS);
  const records: CodeDbRecord[] = [];
  for (const key of keys) {
    try {
      const value = await client.kv.get(key);
      if (value === null) continue; // deleted between list + get
      records.push(makeRecord(key, value));
      opts?.onProgress?.(records.length);
    } catch {
      /* skip unreadable rows — the list stays useful */
    }
  }
  records.sort((a, b) => a.name.localeCompare(b.name));
  return records;
}

export function makeRecord(key: string, value: string): CodeDbRecord {
  let parsed: unknown;
  let isJson = false;
  try {
    parsed = JSON.parse(value);
    isJson = true;
  } catch {
    parsed = undefined;
  }
  return {
    key,
    name: stripCodeDbPrefix(key),
    value,
    parsed,
    isJson,
    size: value.length,
  };
}

/** Human-friendly message for OnyxBase failures (panel + tool share this). */
export function codeDbFailureMessage(failure: CodeDbFailure): string {
  if (failure.kind === "not_configured") {
    return "No OnyxBase API key configured. Add one in Settings → Cloud to use the Code Mode database.";
  }
  return failure.message ?? "OnyxBase request failed.";
}
