"use client";

import { useMemo } from "react";
import {
  AlertTriangle,
  Check,
  Cloud,
  CloudDownload,
  CloudUpload,
  Info,
  Loader2,
  Minus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { ToolCall } from "@/types";
import { cn } from "@/lib/utils";

/**
 * Glassmorphic workspace-sync card for `push_workspace` / `retrieve_workspace`
 * (PRD §19-21). These two tools NEVER render as raw JSON by default — they
 * get a translucent glass surface with a soft blur, thin border, entrance
 * animation, compact stats, and a status-aware icon + tint.
 *
 * States: running (live shimmer) · success · partial · error ·
 * not_configured · not_found · check.
 */

interface WsSyncResult {
  ok?: boolean;
  status?: string;
  tool?: string;
  workspaceId?: string;
  syncedFiles?: number;
  unchangedFiles?: number;
  updatedFiles?: number;
  uploadedBytes?: number;
  removedFiles?: number;
  restoredFiles?: number;
  downloadedBytes?: number;
  integrityVerified?: boolean;
  degraded?: boolean;
  salvage?: { salvagedFiles?: number; salvagedBytes?: number; salvagedPaths?: string[]; unrecoverableGroups?: number };
  cloud?: { totalFiles?: number; totalBytes?: number; updatedAt?: string; generation?: number };
  skippedFiles?: Array<{ path?: string; reason?: string }>;
  errors?: Array<{ path?: string; code?: string; message?: string }>;
  /** Non-fatal notes from the engine (propagation lag, deferred GC …) —
   *  the sync SUCCEEDED; these explain what to expect next. */
  warnings?: string[];
  durationMs?: number;
}

export function isWorkspaceSyncTool(name: string): boolean {
  return name === "push_workspace" || name === "retrieve_workspace";
}

export function parseWorkspaceSyncResult(toolCall: ToolCall): WsSyncResult | null {
  const r = toolCall.result;
  if (r == null) return null;
  if (typeof r === "object") return r as WsSyncResult;
  if (typeof r === "string") {
    try {
      const parsed: unknown = JSON.parse(r);
      if (typeof parsed === "object" && parsed !== null) return parsed as WsSyncResult;
    } catch {
      return null;
    }
  }
  return null;
}

function formatBytes(n: number | undefined): string {
  if (!n || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(toolCall: ToolCall): string {
  const ts = toolCall.endedAt ?? toolCall.startedAt;
  if (!ts) return "Just now";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return `${Math.floor(diff / 86_400_000)} d ago`;
}

function shortWorkspace(id: string | undefined): string {
  return (id ?? "workspace_default").replace(/^workspace_/, "");
}

function reasonLabel(reason: string | undefined): string {
  switch (reason) {
    case "file_too_large":
      return "too large";
    case "secret_file":
      return "secret — skipped";
    case "excluded_directory":
      return "generated — skipped";
    case "app_managed_file":
      return "app-managed";
    case "checksum_mismatch":
      return "integrity failed";
    default:
      return reason ?? "skipped";
  }
}

function friendlyError(code: string | undefined, message: string | undefined): string {
  switch (code) {
    case "ONYXBASE_NOT_CONFIGURED":
      return "Cloud workspace isn't configured yet. Add your OnyxBase API key in Settings → Cloud Workspace.";
    case "ONYXBASE_UNAUTHORIZED":
      return "OnyxBase rejected the API key. Check it in Settings → Cloud Workspace.";
    case "ONYXBASE_UNAVAILABLE":
      return "Couldn't reach OnyxBase. It may be down — try again shortly.";
    case "WORKSPACE_NOT_FOUND":
      return "No persistent workspace is saved in the cloud yet.";
    case "EMPTY_PUSH_BLOCKED":
      return "Push refused — the sandbox is empty while the cloud still holds files. Restoring first; nothing was deleted.";
    case "CHECKSUM_MISMATCH":
      // The engine crafts a detailed, honest salvage-aware message — surface it.
      return (
        message ??
        "Parts of the cloud snapshot were lost by OnyxBase. Whatever could be verified was salvaged; nothing was deleted."
      );
    case "E2B_UNAVAILABLE":
      return "The E2B sandbox isn't available right now.";
    default:
      return message ?? "Something went wrong during the sync.";
  }
}

// ---------------------------------------------------------------------------
// Stat row.
// ---------------------------------------------------------------------------

function StatRow({
  icon: Icon,
  children,
  tone = "ok",
}: {
  icon: typeof Check;
  children: React.ReactNode;
  tone?: "ok" | "muted" | "warn";
}) {
  return (
    <div className="flex items-center gap-2 text-[13px] leading-6">
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          tone === "ok" && "text-emerald-500 dark:text-emerald-400",
          tone === "muted" && "text-muted-foreground/70",
          tone === "warn" && "text-amber-500 dark:text-amber-400",
        )}
      />
      <span className="text-foreground/85">{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card.
// ---------------------------------------------------------------------------

export function WorkspaceSyncResult({ toolCall }: { toolCall: ToolCall }) {
  const isPush = toolCall.name === "push_workspace";
  const isRunning = toolCall.status === "running" || toolCall.status === "pending";
  const isError = toolCall.status === "error";
  const parsed = useMemo(() => parseWorkspaceSyncResult(toolCall), [toolCall]);

  const status = parsed?.status ?? (isError ? "error" : isRunning ? "running" : undefined);

  // ── Running: live glass shimmer card (stage lines stream in the running
  // panel above this card in technical mode; simple mode shows the caption).
  if (isRunning || !parsed) {
    return (
      <div
        className="onyx-ws-card onyx-ws-enter mt-1 overflow-hidden rounded-xl"
        role="status"
        aria-label={isPush ? "Syncing workspace to cloud" : "Retrieving workspace from cloud"}
      >
        <div className="flex items-center gap-2.5 px-4 py-3.5">
          <span className="relative flex size-7 items-center justify-center">
            {isPush ? (
              <CloudUpload className="size-5 text-sky-500 dark:text-sky-300" />
            ) : (
              <CloudDownload className="size-5 text-sky-500 dark:text-sky-300" />
            )}
            <span className="onyx-ws-pulse absolute inset-0 rounded-full" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium">
              {isPush ? "Syncing workspace to cloud…" : "Restoring workspace from cloud…"}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {toolCall.streamingOutput?.trim().split("\n").pop() ??
                (isPush ? "Collecting workspace…" : "Checking cloud workspace…")}
            </p>
          </div>
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  // ── Settled states.
  const title =
    status === "not_configured"
      ? "Cloud workspace not configured"
      : status === "not_found"
        ? "No cloud workspace yet"
        : status === "check"
          ? isPush
            ? "Workspace status"
            : "Cloud workspace found"
          : isError || status === "error"
            ? isPush
              ? "Workspace sync failed"
              : "Workspace restore failed"
            : status === "partial"
              ? isPush
                ? "Workspace partially synced"
                : parsed?.salvage
                  ? "Snapshot salvaged"
                  : "Workspace partially restored"
              : isPush
                ? "Workspace Synced"
                : "Workspace Restored";

  const success = status === "success";
  const partial = status === "partial";
  const neutral = status === "check" || status === "not_found" || status === "not_configured";
  const failure = isError || status === "error";

  const skipped = parsed.skippedFiles ?? [];
  const errors = parsed.errors ?? [];
  const firstError = errors[0];

  const Icon =
    status === "not_configured" || status === "not_found"
      ? Info
      : failure || partial
        ? AlertTriangle
        : success
          ? isPush
            ? CloudUpload
            : CloudDownload
          : Cloud;

  return (
    <div
      className={cn(
        "onyx-ws-card onyx-ws-enter mt-1 overflow-hidden rounded-xl",
        success && "onyx-ws-ok",
        failure && "onyx-ws-err",
        partial && "onyx-ws-partial",
      )}
      role="status"
      aria-label={`${title} — workspace ${shortWorkspace(parsed.workspaceId)}`}
    >
      {/* header */}
      <div className="flex items-center gap-2.5 px-4 pb-1 pt-3.5">
        <Icon
          className={cn(
            "size-5 shrink-0",
            success && "text-sky-500 dark:text-sky-300",
            partial && "text-amber-500 dark:text-amber-300",
            failure && "text-destructive",
            neutral && "text-muted-foreground",
          )}
        />
        <p className="text-[13.5px] font-semibold tracking-tight">{title}</p>
      </div>

      {/* stats */}
      <div className="space-y-0.5 px-4 py-2">
        {status === "not_configured" && (
          <StatRow icon={Info} tone="muted">
            {friendlyError(firstError?.code, firstError?.message)}
          </StatRow>
        )}
        {status === "not_found" && (
          <StatRow icon={Info} tone="muted">
            Nothing has been pushed to the cloud yet — push_workspace creates it.
          </StatRow>
        )}

        {status === "check" && parsed.cloud && (
          <>
            <StatRow icon={Check}>
              {parsed.cloud.totalFiles ?? 0} files in the cloud
            </StatRow>
            <StatRow icon={Cloud} tone="muted">
              {formatBytes(parsed.cloud.totalBytes ?? 0)} stored
            </StatRow>
            <StatRow icon={RefreshCw} tone="muted">
              Last synced {parsed.cloud.updatedAt ? formatWhen({ endedAt: new Date(parsed.cloud.updatedAt).getTime() } as ToolCall) : "—"}
            </StatRow>
          </>
        )}

        {isPush && (success || partial) && (
          <>
            <StatRow icon={Check}>
              {parsed.syncedFiles ?? 0} files synchronized
            </StatRow>
            <StatRow icon={CloudUpload}>
              {formatBytes(parsed.uploadedBytes)} uploaded
            </StatRow>
            {(parsed.updatedFiles ?? 0) > 0 && (
              <StatRow icon={RefreshCw}>
                {parsed.updatedFiles} files updated
              </StatRow>
            )}
            {(parsed.unchangedFiles ?? 0) > 0 && (
              <StatRow icon={ShieldCheck} tone="muted">
                {parsed.unchangedFiles} unchanged — reused
              </StatRow>
            )}
            {skipped.length > 0 && (
              <StatRow icon={Minus} tone="warn">
                {skipped.length === 1
                  ? `1 file skipped — ${reasonLabel(skipped[0]?.reason)}`
                  : `${skipped.length} files skipped`}
              </StatRow>
            )}
            {(parsed.removedFiles ?? 0) > 0 && (
              <StatRow icon={Minus} tone="muted">
                {parsed.removedFiles} removed from cloud
              </StatRow>
            )}
          </>
        )}

        {!isPush && (success || partial) && (
          <>
            <StatRow icon={Check}>
              {parsed.restoredFiles ?? 0} files restored
            </StatRow>
            <StatRow icon={CloudDownload}>
              {formatBytes(
                (parsed.downloadedBytes ?? 0) + (parsed.salvage?.salvagedBytes ?? 0),
              )}{" "}
              downloaded
            </StatRow>
            <StatRow icon={ShieldCheck}>
              {parsed.integrityVerified ? "Integrity verified" : "Integrity issues detected"}
            </StatRow>
            {parsed.degraded && (
              <StatRow icon={RefreshCw} tone="warn">
                Rebuilt from per-file records (manifest was lost)
              </StatRow>
            )}
            {parsed.salvage && (parsed.salvage.salvagedFiles ?? 0) > 0 && (
              <StatRow icon={CloudDownload} tone="warn">
                {parsed.salvage.salvagedFiles} file(s) salvaged to .onyx-salvage/ —{" "}
                {parsed.salvage.unrecoverableGroups ?? 0} group(s) not recoverable
              </StatRow>
            )}
            {skipped.length > 0 && (
              <StatRow icon={Minus} tone="warn">
                {skipped.length} file{skipped.length === 1 ? "" : "s"} skipped —{" "}
                {reasonLabel(skipped[0]?.reason)}
              </StatRow>
            )}
          </>
        )}

        {(failure || partial) && firstError && status !== "not_configured" && (
          <StatRow icon={AlertTriangle} tone="warn">
            {friendlyError(firstError.code, firstError.message)}
          </StatRow>
        )}
        {/* partial with skipped-only failures stays calm — stats above show it */}

        {/* Non-fatal engine warnings — the sync SUCCEEDED (green card); the
            note just tells the user about propagation lag / deferred GC. */}
        {success && (parsed.warnings?.length ?? 0) > 0 && (
          <StatRow icon={Info} tone="muted">
            {parsed.warnings![0]}
          </StatRow>
        )}
      </div>

      {/* footer */}
      <div className="flex items-center justify-between gap-2 border-t border-border/40 px-4 py-2 text-[11.5px] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          <Cloud className="size-3 shrink-0" />
          <span className="truncate">
            Workspace · {shortWorkspace(parsed.workspaceId)}
          </span>
        </span>
        <span className="shrink-0 tabular-nums">
          {success
            ? `${isPush ? "✓ Saved to cloud" : "✓ Restored from cloud"} · ${formatWhen(toolCall)}`
            : formatWhen(toolCall)}
        </span>
      </div>
    </div>
  );
}
