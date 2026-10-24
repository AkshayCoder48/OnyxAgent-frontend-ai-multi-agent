"use client";

// ============================================================================
// Cloud-config CLIENT mirror — the serverless survival layer for the
// Trigger.dev Cloud connection (Background Task Execution Framework).
//
// WHY: on serverless deployments (Netlify/Vercel) the API routes run with a
// READ-ONLY filesystem, so the server-side SQLite seal (TaskCloudConfig)
// cannot persist. This module mirrors the verified connection in the
// BROWSER's durable store (Dexie user_settings.extra) exactly like every
// other API key in this app (E2B, Tavily, OnyxBase, …):
//
//   · the key + WORKER_TOKEN are sealed with the user's vault key
//     (AES-256-GCM, src/lib/crypto/vault.ts) before they touch IndexedDB,
//   · when the server reports "not configured" (fresh lambda), the
//     useCloudOrchestrator hook transparently re-submits the stored key —
//     the operator never notices the server forgot,
//   · the WORKER_TOKEN rides along so the setup checklist stays STABLE
//     across serverless cold starts (no re-mint churn).
//
// SECURITY: nothing is ever stored unencrypted; the vault must be unlocked
// (user signed in) for any of this to work.
// ============================================================================

import { db } from "@/lib/db";
import { vaultEncrypt, vaultDecrypt } from "@/lib/crypto/vault";

/** The Dexie `user_settings.extra` key holding the sealed mirror. */
const EXTRA_KEY = "trigger_cloud_mirror";

interface SealedMirror {
  /** Vault-sealed api.trigger.dev key. */
  key: string;
  /** Kicked task id ("agent-run" by default). */
  taskSlug: string;
  /** Vault-sealed WORKER_TOKEN ("" when none was minted). */
  workerToken: string;
  /** ISO timestamp of the connect that created this mirror. */
  connectedAt: string;
}

export interface ClientCloudConfig {
  apiKey: string;
  taskSlug: string;
  workerToken: string;
  connectedAt: string;
}

async function readSealed(userId: string): Promise<SealedMirror | null> {
  const row = await db.user_settings.where("user_id").equals(userId).first();
  const raw = row?.extra?.[EXTRA_KEY];
  if (!raw || typeof raw !== "object") return null;
  const sealed = raw as Partial<SealedMirror>;
  if (typeof sealed.key !== "string" || !sealed.key) return null;
  return sealed as SealedMirror;
}

async function writeSealed(userId: string, sealed: SealedMirror): Promise<void> {
  const row = await db.user_settings.where("user_id").equals(userId).first();
  if (!row) return; // settings row not initialized yet — nothing to mirror into
  await db.user_settings.update(row.id, {
    extra: { ...(row.extra ?? {}), [EXTRA_KEY]: sealed },
    updated_at: new Date().toISOString(),
  });
}

/**
 * Persist the verified connection in the browser (vault-sealed). Best-effort:
 * a locked vault simply means no mirror — the server-side seal (when the
 * deployment has a writable filesystem) remains the primary store.
 */
export async function saveClientCloudConfig(
  userId: string,
  input: { apiKey: string; taskSlug: string; workerToken?: string | null },
): Promise<void> {
  try {
    const sealed: SealedMirror = {
      key: await vaultEncrypt(input.apiKey),
      taskSlug: input.taskSlug,
      workerToken: input.workerToken ? await vaultEncrypt(input.workerToken) : "",
      connectedAt: new Date().toISOString(),
    };
    await writeSealed(userId, sealed);
  } catch {
    // Vault locked / row missing — no mirror (manual reconnect next session).
  }
}

/** Load the mirrored connection (null when absent or the vault is locked). */
export async function loadClientCloudConfig(
  userId: string,
): Promise<ClientCloudConfig | null> {
  try {
    const sealed = await readSealed(userId);
    if (!sealed) return null;
    return {
      apiKey: await vaultDecrypt(sealed.key),
      taskSlug: sealed.taskSlug || "agent-run",
      workerToken: sealed.workerToken ? await vaultDecrypt(sealed.workerToken) : "",
      connectedAt: sealed.connectedAt,
    };
  } catch {
    return null; // locked vault or tampered row — treat as absent
  }
}

/** Drop the mirrored connection (disconnect). */
export async function clearClientCloudConfig(userId: string): Promise<void> {
  try {
    const row = await db.user_settings.where("user_id").equals(userId).first();
    if (!row) return;
    const extra = { ...(row.extra ?? {}) };
    delete extra[EXTRA_KEY];
    await db.user_settings.update(row.id, {
      extra,
      updated_at: new Date().toISOString(),
    });
  } catch {
    // best-effort — the server-side disconnect already succeeded
  }
}
