"use client";

/**
 * Cloud workspace tools — `push_workspace` + `retrieve_workspace`.
 *
 * Persistent cloud backup/restore of the COMPLETE E2B workspace using
 * OnyxBase KV (manifest + content-addressed chunks — see
 * `src/lib/onyxbase/workspace-sync.ts` for the storage model).
 *
 * SECURITY MODEL (PRD §5):
 *  - The OnyxBase `kv_live_…` key is resolved HERE, from the encrypted
 *    settings store, at execution time. It is NEVER part of the tool schema,
 *    the tool arguments, the system prompt, the result, or anything the
 *    model can see. The model cannot even ask for it — the tool takes no
 *    credential arguments.
 *  - The E2B sandbox never sees the key either: all KV traffic runs in the
 *    browser; the sandbox route only ferries file bytes.
 */

import { registerTool } from "./registry";
import { getE2BClient } from "@/lib/e2b/client";
import { ensureFreshSandboxForCtx } from "@/lib/e2b/sandbox-rotation";
import { OnyxBaseKV, ONYXBASE_DEFAULT_BASE_URL, looksLikeOnyxBaseKey } from "@/lib/onyxbase/kv-client";
import {
  pushWorkspace,
  retrieveWorkspace,
  WORKSPACE_ID,
  type PushResult,
  type RetrieveResult,
  type StageEvent,
} from "@/lib/onyxbase/workspace-sync";

const NO_KEY_MESSAGE =
  "Cloud workspace isn't configured yet. Add your OnyxBase API key in Settings → Cloud Workspace.";

const NO_E2B_MESSAGE =
  "Workspace sync requires an E2B Sandbox API key. Add one in Settings → Config → E2B Sandbox.";

interface OnyxBaseRuntime {
  kv: OnyxBaseKV;
  userId: string;
}

/** Resolve the encrypted OnyxBase key + build the KV client at execution
 *  time. Returns null when unconfigured (never throws — the tool reports a
 *  clean not_configured result instead). */
async function resolveOnyxBase(ctx: { userId?: string }): Promise<OnyxBaseRuntime | null> {
  try {
    const { settingsService } = await import("@/lib/services");
    const { useAuthStore } = await import("@/stores");
    const userId = ctx.userId || useAuthStore.getState().user?.id;
    if (!userId) return null;
    const key = await settingsService.getDecryptedOnyxBaseApiKey(userId);
    if (!key || !key.trim()) return null;
    // Base URL: user-configured instance or the default OnyxBase deployment.
    const settings = await settingsService.get(userId).catch(() => null);
    const baseUrl = settings?.onyxbase_base_url || ONYXBASE_DEFAULT_BASE_URL;
    return { kv: new OnyxBaseKV(key, baseUrl), userId };
  } catch {
    return null;
  }
}

/** Progress line helper — pipes stage events into the live tool-output
 *  stream (the running tool panel + the workspace sync card). */
function progressPipe(ctx: { onToolOutput?: (id: string, out: string, t: "stdout" | "stderr" | "prompt") => void }) {
  return (ev: StageEvent) => {
    ctx.onToolOutput?.("", ev.detail, "stdout");
  };
}

/** Stamp last-synced after a successful push. */
async function stampLastSynced(userId: string): Promise<void> {
  try {
    const { settingsService } = await import("@/lib/services");
    await settingsService.update(userId, { onyxbase_last_synced: new Date().toISOString() });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// push_workspace
// ---------------------------------------------------------------------------

registerTool(
  "push_workspace",
  "Synchronize the COMPLETE current E2B workspace to the user's persistent OnyxBase KV cloud workspace (id: workspace_default). This is a SYNCHRONIZATION, not a new backup — it overwrites the cloud state to exactly match the current workspace. Files larger than 50 MB, secrets (.env, private keys), and generated directories (node_modules, .git, .next…) are skipped automatically. Unchanged files are detected by SHA-256 and reused, so re-running after an interruption is cheap. Runs are budget-limited (10 min hard cap): if the budget elapses mid-upload the push aborts SAFELY with a partial — nothing is committed, the cloud keeps its previous state, and re-running resumes. A 'warnings' field in a SUCCESSFUL result is informational only (OnyxBase instance lag) — the snapshot is committed. SAFETY: if the sandbox has NO syncable files while the cloud still holds files, the push is REFUSED (EMPTY_PUSH_BLOCKED) — restore/salvage first; pass force=true ONLY when the user explicitly confirms they want to wipe the cloud state. Call this after every meaningful task that modifies workspace files. No arguments needed — the workspace is discovered automatically.",
  {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Optional short note about why this sync is running (for the sync log).",
      },
      force: {
        type: "boolean",
        description:
          "Allow overwriting a non-empty cloud snapshot with an empty workspace. Default false — the push is refused otherwise. Use ONLY with the user's explicit confirmation.",
      },
    },
    additionalProperties: false,
  },
  async (_args, ctx) => {
    // 1. E2B availability (PRD §13).
    const e2bKey = await ensureFreshSandboxForCtx(ctx);
    if (!e2bKey) {
      return {
        ok: false, status: "error", tool: "push_workspace", workspaceId: WORKSPACE_ID,
        syncedFiles: 0, unchangedFiles: 0, updatedFiles: 0, uploadedBytes: 0, removedFiles: 0,
        skippedFiles: [], errors: [{ code: "E2B_UNAVAILABLE", message: NO_E2B_MESSAGE }], durationMs: 0,
      } satisfies PushResult;
    }

    // 2. OnyxBase credential (resolved server-… client-side at execution
    //    time; never part of the model-visible context).
    const ob = await resolveOnyxBase(ctx);
    if (!ob) {
      return {
        ok: false, status: "not_configured", tool: "push_workspace", workspaceId: WORKSPACE_ID,
        syncedFiles: 0, unchangedFiles: 0, updatedFiles: 0, uploadedBytes: 0, removedFiles: 0,
        skippedFiles: [], errors: [{ code: "ONYXBASE_NOT_CONFIGURED", message: NO_KEY_MESSAGE }], durationMs: 0,
      } satisfies PushResult;
    }

    const e2b = getE2BClient(e2bKey, null, "shared");
    try {
      const result = await pushWorkspace({
        e2b,
        kv: ob.kv,
        onStage: progressPipe(ctx),
        signal: ctx.signal,
        force: _args.force === true,
      });
      if (result.ok) await stampLastSynced(ob.userId);
      return result;
    } catch (e) {
      return {
        ok: false,
        status: "error",
        tool: "push_workspace",
        workspaceId: WORKSPACE_ID,
        syncedFiles: 0,
        unchangedFiles: 0,
        updatedFiles: 0,
        uploadedBytes: 0,
        removedFiles: 0,
        skippedFiles: [],
        errors: [
          {
            code: e instanceof Error && "code" in e ? String((e as { code?: unknown }).code) : "KV_WRITE_FAILED",
            message: e instanceof Error ? e.message : "push failed",
          },
        ],
        durationMs: 0,
      } satisfies PushResult;
    }
  },
  false,
  "workspace",
);

// ---------------------------------------------------------------------------
// retrieve_workspace
// ---------------------------------------------------------------------------

registerTool(
  "retrieve_workspace",
  "Retrieve the user's persistent workspace from OnyxBase KV and restore it into the current E2B workspace (existing files are overwritten by the cloud copy; SHA-256 integrity is verified per file). Use mode 'restore' (default) to actually restore files, or mode 'check' to only report whether a cloud workspace exists. If the cloud snapshot's manifest was lost, this tool degrades gracefully: it rebuilds the file list from per-file records, or SALVAGES whatever files can be checksum-verified from surviving chunks into .onyx-salvage/ — it never deletes anything and never requires a re-push. When a fresh E2B environment starts and a persistent workspace may exist, call this BEFORE workspace-dependent work.",
  {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["restore", "check"],
        description: "'restore' (default) writes the files into the sandbox; 'check' only reports cloud state.",
      },
    },
    additionalProperties: false,
  },
  async (args, ctx) => {
    const mode = (args.mode as string) === "check" ? "check" : "restore";

    const ob = await resolveOnyxBase(ctx);
    if (!ob) {
      return {
        ok: false, status: "not_configured", tool: "retrieve_workspace", workspaceId: WORKSPACE_ID,
        restoredFiles: 0, downloadedBytes: 0, integrityVerified: false, skippedFiles: [],
        errors: [{ code: "ONYXBASE_NOT_CONFIGURED", message: NO_KEY_MESSAGE }], durationMs: 0,
      } satisfies RetrieveResult;
    }

    // check mode doesn't need a sandbox — pure KV lookup.
    if (mode === "check") {
      try {
        const result = await retrieveWorkspace({ e2b: null, kv: ob.kv, mode: "check", onStage: progressPipe(ctx) });
        return result;
      } catch (e) {
        return {
          ok: false, status: "error", tool: "retrieve_workspace", workspaceId: WORKSPACE_ID,
          restoredFiles: 0, downloadedBytes: 0, integrityVerified: false, skippedFiles: [],
          errors: [{ code: "KV_READ_FAILED", message: e instanceof Error ? e.message : "check failed" }],
          durationMs: 0,
        } satisfies RetrieveResult;
      }
    }

    const e2bKey = await ensureFreshSandboxForCtx(ctx);
    if (!e2bKey) {
      return {
        ok: false, status: "error", tool: "retrieve_workspace", workspaceId: WORKSPACE_ID,
        restoredFiles: 0, downloadedBytes: 0, integrityVerified: false, skippedFiles: [],
        errors: [{ code: "E2B_UNAVAILABLE", message: NO_E2B_MESSAGE }], durationMs: 0,
      } satisfies RetrieveResult;
    }

    const e2b = getE2BClient(e2bKey, null, "shared");
    try {
      return await retrieveWorkspace({
        e2b,
        kv: ob.kv,
        mode: "restore",
        onStage: progressPipe(ctx),
        signal: ctx.signal,
      });
    } catch (e) {
      return {
        ok: false, status: "error", tool: "retrieve_workspace", workspaceId: WORKSPACE_ID,
        restoredFiles: 0, downloadedBytes: 0, integrityVerified: false, skippedFiles: [],
        errors: [{ code: "RESTORE_FAILED", message: e instanceof Error ? e.message : "restore failed" }],
        durationMs: 0,
      } satisfies RetrieveResult;
    }
  },
  false,
  "workspace",
);

/** Re-exported for the settings UI (Test Connection) — the key check helper. */
export { looksLikeOnyxBaseKey };
