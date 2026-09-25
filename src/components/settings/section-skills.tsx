"use client";

/**
 * Settings → Skills (PRD §5-8, §36) — the multi-skill upload + cloud-sync UI.
 *
 * Common controls stay visible: Upload ZIP (MULTIPLE archives, each may hold
 * several skill folders), Upload SKILL.md (single bare file), the skills
 * list (name, description, sync badge, enable/disable, download, delete).
 *
 * Advanced options live under "More options ▾" (the shared collapsible in
 * more-options.tsx): per-skill sync details (last synced,
 * chunk counts), the Restore-from-cloud list, and per-skill raw metadata.
 *
 * Sync badges never lie (PRD §38): "Synced" only appears after the push's KV
 * writes + manifest commit actually succeeded; a crashed push leaves an
 * honest "Sync failed"/"Local" that the reconcile pass re-derives from
 * content hashes. Deleting a skill is always explicit and local-only — the
 * cloud copy survives and shows up under "Restore from cloud".
 */

import * as React from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Cloud,
  CloudDownload,
  Download,
  Info,
  Loader2,
  Package,
  Sparkles,
  Trash2,
  TriangleAlert,
  Upload,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SectionCard } from "@/components/settings/settings-section";
import { MoreOptions } from "@/components/settings/more-options";
import { Switch } from "@/components/ui/switch";
import { useSettings } from "@/hooks/use-data";
import { useAuth } from "@/hooks";
import type { Skill } from "@/types";
import { isOPFSAvailable } from "@/lib/storage/opfs";
import {
  exportSkillZip,
  installSkillFiles,
  uninstallSkill,
  type SkillInstallItemResult,
} from "@/lib/skills/installer";
import {
  pushSkillsToCloud,
  reconcileSkillsFromCloud,
  restoreSkillFromCloud,
  resolveSkillsKVClient,
  type SkillsManifestEntry,
  type ReconcileVerdict,
} from "@/lib/onyxbase/skills-sync";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Sync badge rendering (the display state is DERIVED, never cached blindly).
// ---------------------------------------------------------------------------

type DisplaySyncState = "synced" | "syncing" | "sync-failed" | "local" | "local-cloud-newer" | "local-missing-files";

function syncBadge(state: DisplaySyncState): {
  label: string;
  className: string;
  icon: React.ReactNode;
} {
  switch (state) {
    case "synced":
      return {
        label: "Synced",
        className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        icon: <CheckCircle2 className="size-3" />,
      };
    case "syncing":
      return {
        label: "Syncing…",
        className: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
        icon: <Loader2 className="size-3 animate-spin" />,
      };
    case "sync-failed":
      return {
        label: "Sync failed",
        className: "border-destructive/30 bg-destructive/10 text-destructive",
        icon: <XCircle className="size-3" />,
      };
    case "local-cloud-newer":
      return {
        label: "Local · cloud newer",
        className: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
        icon: <Cloud className="size-3" />,
      };
    case "local-missing-files":
      return {
        label: "Missing files",
        className: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
        icon: <TriangleAlert className="size-3" />,
      };
    default:
      return {
        label: "Local",
        className: "border-border bg-muted/50 text-muted-foreground",
        icon: <Package className="size-3" />,
      };
  }
}

function formatSynced(iso: string | null | undefined): string {
  if (!iso) return "Never";
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return "Just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
    return d.toLocaleString();
  } catch {
    return "Never";
  }
}

// ---------------------------------------------------------------------------
// Section.
// ---------------------------------------------------------------------------

export function SectionSkills() {
  const { settings } = useSettings();
  // useAuth (not the raw store) so a cold direct navigation rehydrates the
  // user before any Dexie/sync work (same reason as the Cloud section).
  const { user } = useAuth();
  const userId = user?.id;
  const qc = useQueryClient();

  // Local skill rows come through a light react-query subscription (same key
  // the useSkills hook uses) so every mutation below can just invalidate it.
  const [rows, setRows] = React.useState<Skill[]>([]);
  const [rowsLoading, setRowsLoading] = React.useState(true);
  const cloudConfigured = !!settings?.onyxbase_api_key_present;
  const opfsAvailable = typeof window !== "undefined" && isOPFSAvailable();

  const [deleteTarget, setDeleteTarget] = React.useState<Skill | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploadResults, setUploadResults] = React.useState<SkillInstallItemResult[] | null>(null);
  const [pushing, setPushing] = React.useState(false);
  const [restoringSlug, setRestoringSlug] = React.useState<string | null>(null);
  const [downloadingSlug, setDownloadingSlug] = React.useState<string | null>(null);
  const [togglingId, setTogglingId] = React.useState<string | null>(null);

  /** Slugs currently being pushed in THIS session (badge override). */
  const pushingRef = React.useRef<Set<string>>(new Set());

  const zipInputRef = React.useRef<HTMLInputElement>(null);
  const mdInputRef = React.useRef<HTMLInputElement>(null);

  // -- reconcile state (cloud verdicts + cloud-only list) ------------------
  const [verdicts, setVerdicts] = React.useState<Map<string, ReconcileVerdict>>(new Map());
  const [cloudOnly, setCloudOnly] = React.useState<SkillsManifestEntry[]>([]);
  const [reconcileError, setReconcileError] = React.useState<string | null>(null);

  const refreshRows = React.useCallback(async () => {
    if (!userId) return;
    try {
      const { skillService } = await import("@/lib/services");
      setRows((await skillService.list(userId)) as Skill[]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load skills");
    } finally {
      setRowsLoading(false);
    }
  }, [userId]);

  /** Reconcile local skills with the OnyxBase manifest (badges + cloud-only). */
  const runReconcile = React.useCallback(async () => {
    if (!userId) return;
    setRowsLoading(true);
    await refreshRows();
    if (!cloudConfigured) {
      setVerdicts(new Map());
      setCloudOnly([]);
      return;
    }
    try {
      const kv = await resolveSkillsKVClient(userId);
      if (!kv) return;
      const outcome = await reconcileSkillsFromCloud(userId, { kv, fastReads: true });
      setVerdicts(new Map(outcome.plan.local.map((e) => [e.slug, e.verdict])));
      setCloudOnly(outcome.plan.cloudOnly);
      setReconcileError(null);
      await refreshRows();
    } catch (err) {
      setReconcileError(err instanceof Error ? err.message : "Cloud skills check failed");
    }
  }, [userId, cloudConfigured, refreshRows]);

  React.useEffect(() => {
    void runReconcile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, cloudConfigured]);

  // ---------------------------------------------------------------------------
  // Uploads.
  // ---------------------------------------------------------------------------

  async function handleUpload(files: File[] | FileList) {
    const list = Array.from(files);
    if (list.length === 0 || !userId) return;
    if (!opfsAvailable) {
      toast.error("OPFS is not available in this browser — can't install skills.");
      return;
    }
    setUploading(true);
    setUploadResults(null);
    try {
      const results = await installSkillFiles(userId, list);
      setUploadResults(results);
      const ok = results.filter((r) => r.ok).length;
      const bad = results.length - ok;
      if (ok > 0) {
        toast.success(`Installed ${ok} skill${ok === 1 ? "" : "s"}`, {
          description: bad > 0 ? `${bad} item(s) failed — see the details below.` : undefined,
          icon: <CheckCircle2 className="size-4" />,
        });
      } else if (bad > 0) {
        toast.error("No skills were installed", {
          description: "See the per-item errors below.",
          icon: <XCircle className="size-4" />,
        });
      }
      await qc.invalidateQueries({ queryKey: ["skills", userId] });
      await runReconcile();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Cloud push / restore.
  // ---------------------------------------------------------------------------

  async function handlePushSkills() {
    if (!userId) return;
    if (!cloudConfigured) {
      toast.error("Add your OnyxBase API key first", {
        description: "Settings → Cloud Workspace.",
      });
      return;
    }
    const kv = await resolveSkillsKVClient(userId);
    if (!kv) return;
    setPushing(true);
    pushingRef.current = new Set(rows.map((r) => r.name));
    try {
      const result = await pushSkillsToCloud(userId, {
        kv,
        onStage: (detail) => toast.info(detail, { id: "skills-push", duration: 2000 }),
      });
      if (result.status === "success" || (result.ok && result.pushed + result.unchanged > 0)) {
        toast.success(
          `Skills cloud sync: ${result.pushed} pushed, ${result.unchanged} unchanged`,
          {
            description: result.cloudOnly
              ? `${result.cloudOnly} cloud-only skill(s) kept restorable.`
              : undefined,
            icon: <CheckCircle2 className="size-4" />,
          },
        );
      } else if (result.failed > 0) {
        toast.error(`${result.failed} skill(s) failed to sync`, {
          description: result.errors[0],
          icon: <XCircle className="size-4" />,
        });
      } else {
        toast.info("No skills to push yet.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Skills push failed");
    } finally {
      setPushing(false);
      pushingRef.current.clear();
      await qc.invalidateQueries({ queryKey: ["skills", userId] });
      await runReconcile();
    }
  }

  async function handleRestore(slug: string) {
    if (!userId) return;
    const kv = await resolveSkillsKVClient(userId);
    if (!kv) return;
    setRestoringSlug(slug);
    try {
      const result = await restoreSkillFromCloud(userId, slug, { kv, fastReads: true });
      if (result.ok) {
        toast.success(`Restored "${slug}" from cloud`, {
          description: `${result.restoredFiles} file(s) written to local storage.`,
          icon: <CheckCircle2 className="size-4" />,
        });
      } else {
        toast.error(result.error ?? `Failed to restore "${slug}"`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Restore failed");
    } finally {
      setRestoringSlug(null);
      await qc.invalidateQueries({ queryKey: ["skills", userId] });
      await runReconcile();
    }
  }

  // ---------------------------------------------------------------------------
  // Per-skill actions.
  // ---------------------------------------------------------------------------

  async function handleDelete() {
    if (!deleteTarget || !userId) return;
    const target = deleteTarget;
    try {
      await uninstallSkill(userId, target.name);
      toast.success(`Removed skill: ${target.name}`, {
        description: "Removed locally only — a pushed cloud copy (if any) stays restorable under More options.",
      });
      await qc.invalidateQueries({ queryKey: ["skills", userId] });
      await runReconcile();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to uninstall skill");
    } finally {
      setDeleteTarget(null);
    }
  }

  async function handleToggle(skill: Skill) {
    setTogglingId(skill.id);
    try {
      const { skillService } = await import("@/lib/services");
      await skillService.setActive(skill.id, !skill.is_active);
      await refreshRows();
      await qc.invalidateQueries({ queryKey: ["skills", userId] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to toggle skill");
    } finally {
      setTogglingId(null);
    }
  }

  async function handleDownload(skill: Skill) {
    if (!userId) return;
    setDownloadingSlug(skill.name);
    try {
      const out = await exportSkillZip(userId, skill.name);
      if (!out) {
        toast.error(`No local files found for "${skill.name}"`);
        return;
      }
      const url = URL.createObjectURL(out.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${skill.name}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Downloaded ${skill.name}.zip`, {
        description: `${out.fileCount} file(s).`,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Download failed");
    } finally {
      setDownloadingSlug(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Derived per-skill display state (badges never lie — see header).
  // ---------------------------------------------------------------------------

  function displayState(s: Skill): DisplaySyncState {
    if (pushingRef.current.has(s.name) && pushing) return "syncing";
    if (s.sync_state === "syncing" && s.name && pushingRef.current.has(s.name)) return "syncing";
    if (s.sync_state === "sync_failed") return "sync-failed";
    const verdict = verdicts.get(s.name);
    if (verdict === "synced") return "synced";
    if (verdict === "cloud-newer") return "local-cloud-newer";
    if (verdict === "missing-files") return "local-missing-files";
    return "local";
  }

  return (
    <div className="space-y-4">
      <Alert>
        <Info className="size-4" />
        <AlertTitle>About skills</AlertTitle>
        <AlertDescription>
          Skills are reusable instruction packs the agent loads when a task
          matches. Upload one or more <code>.zip</code> archives (each may
          contain several skill folders) or a bare <code>SKILL.md</code>. With
          an OnyxBase key, skills sync to your private cloud alongside the
          workspace and survive any device loss.
        </AlertDescription>
      </Alert>

      {/* Common controls */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          Installed skills are stored locally (survive refresh &amp; navigation) and loaded into the
          agent at runtime.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => zipInputRef.current?.click()}
            size="sm"
            disabled={uploading || !opfsAvailable}
          >
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            Upload ZIP
          </Button>
          <Button
            variant="outline"
            onClick={() => mdInputRef.current?.click()}
            size="sm"
            disabled={uploading || !opfsAvailable}
          >
            <Upload className="size-4" /> Upload SKILL.md
          </Button>
          <Button
            variant="outline"
            onClick={handlePushSkills}
            size="sm"
            disabled={pushing || !cloudConfigured}
            title={cloudConfigured ? "Push every installed skill to OnyxBase (also rides along with push_workspace)" : "Add an OnyxBase API key in Cloud Workspace first"}
          >
            {pushing ? <Loader2 className="size-4 animate-spin" /> : <Cloud className="size-4" />}
            Push skills to cloud
          </Button>
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip"
            multiple
            className="hidden"
            onChange={(e) => {
              void handleUpload(e.target.files ?? []);
              e.target.value = "";
            }}
          />
          <input
            ref={mdInputRef}
            type="file"
            accept=".md,.markdown"
            multiple
            className="hidden"
            onChange={(e) => {
              void handleUpload(e.target.files ?? []);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {/* Per-item upload results (PRD §5/§6 — actionable, never silent) */}
      {uploadResults && uploadResults.length > 0 && (
        <div className="rounded-lg border">
          <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
            Upload results ({uploadResults.filter((r) => r.ok).length}/{uploadResults.length} installed)
          </div>
          <ul className="divide-y">
            {uploadResults.map((r, i) => (
              <li key={`${r.source}-${i}`} className="flex items-start gap-2 px-3 py-2 text-sm">
                {r.ok ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                ) : (
                  <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {r.ok ? r.name : r.source}
                    {r.ok && r.files.length > 0 && (
                      <span className="text-muted-foreground ml-2 text-xs font-normal">
                        {r.files.length} file{r.files.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </p>
                  {r.ok ? (
                    r.description ? (
                      <p className="text-muted-foreground truncate text-xs">{r.description}</p>
                    ) : null
                  ) : (
                    <p className="text-destructive text-xs">{r.error}</p>
                  )}
                  {r.warnings.length > 0 && (
                    <ul className="text-muted-foreground mt-1 space-y-0.5 text-xs">
                      {r.warnings.map((w, j) => (
                        <li key={j}>· {w}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!opfsAvailable && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
          Your browser doesn&apos;t support OPFS (Origin Private File System), so skill installation
          is disabled. Try Chrome, Edge, or Safari.
        </div>
      )}

      {reconcileError && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
          <TriangleAlert className="mr-1 inline size-3.5 -mt-0.5" />
          {reconcileError}
        </div>
      )}

      {/* Skills list */}
      {rowsLoading && rows.length === 0 ? (
        <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading skills…
        </div>
      ) : rows.length === 0 ? (
        <div className="text-muted-foreground rounded-md border border-dashed p-8 text-center">
          <Sparkles className="mx-auto mb-2 size-6 opacity-50" />
          <p className="text-sm">No skills installed yet.</p>
          <p className="text-xs">Upload a .zip bundle or a SKILL.md file to get started.</p>
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">On</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="hidden sm:table-cell">Description</TableHead>
                <TableHead>Sync</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((s) => {
                const state = displayState(s);
                const badge = syncBadge(state);
                return (
                  <TableRow key={s.id} className={cn("mb-fade-in-soft", !s.is_active && "opacity-55")}>
                    <TableCell>
                      <Switch
                        checked={!!s.is_active}
                        disabled={togglingId === s.id}
                        onCheckedChange={() => void handleToggle(s)}
                        aria-label={`Enable or disable ${s.name}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      {s.name}
                      {s.source && (
                        <span className="text-muted-foreground ml-2 text-[10px] uppercase tracking-wide">
                          {s.source}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden max-w-[260px] truncate text-xs sm:table-cell">
                      {s.description}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium",
                            badge.className,
                          )}
                          title={s.sync_error ?? undefined}
                        >
                          {badge.icon}
                          {badge.label}
                        </span>
                        {(state === "local-cloud-newer" || state === "local-missing-files") && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => void handleRestore(s.name)}
                            disabled={restoringSlug === s.name || !cloudConfigured}
                          >
                            {restoringSlug === s.name ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <CloudDownload className="size-3.5" />
                            )}
                            Update from cloud
                          </Button>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleDownload(s)}
                          disabled={downloadingSlug === s.name}
                          title="Download this skill as a .zip"
                        >
                          {downloadingSlug === s.name ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Download className="size-3.5" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteTarget(s)}
                          className="text-destructive hover:text-destructive"
                          title="Uninstall"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* ── More options (advanced) ──────────────────────────────────────── */}
      <MoreOptions>
        <SectionCard
          title="Cloud sync details"
          description={
            cloudConfigured
              ? "Per-skill OnyxBase sync bookkeeping. Badges are re-derived from content hashes on every load."
              : "Add an OnyxBase API key (Settings → Cloud Workspace) to sync skills to your private cloud."
          }
        >
          {rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">No skills installed.</p>
          ) : (
            <div className="space-y-2">
              {rows.map((s) => (
                <div
                  key={s.id}
                  className="mb-fade-in-soft flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs font-medium">{s.name}</p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      Last synced {formatSynced(s.synced_at)} ·{" "}
                      {s.sync_chunks ?? 0} chunk record(s) ·{" "}
                      {s.file_count ?? "?"} file(s)
                      {s.cloud_sha256 ? ` · sha ${s.cloud_sha256.slice(0, 8)}…` : ""}
                    </p>
                    {s.sync_error && (
                      <p className="mt-0.5 text-xs text-destructive">{s.sync_error}</p>
                    )}
                  </div>
                  <span className={cn("rounded-md border px-2 py-0.5 text-xs font-medium", syncBadge(displayState(s)).className)}>
                    {syncBadge(displayState(s)).label}
                  </span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Restore from cloud"
          description="Skills present in your OnyxBase cloud but not installed here. Nothing is ever auto-restored or auto-deleted — restore is always your explicit action."
        >
          {cloudOnly.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {cloudConfigured
                ? "No cloud-only skills — every cloud skill is installed locally."
                : "Cloud restore requires an OnyxBase API key."}
            </p>
          ) : (
            <ul className="space-y-2">
              {cloudOnly.map((e) => (
                <li
                  key={e.slug}
                  className="mb-fade-in-soft flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs font-medium">{e.slug}</p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {e.fileCount} file(s) · {(e.rawBytes / 1024).toFixed(1)} KB · pushed{" "}
                      {formatSynced(e.syncedAt)}
                    </p>
                    {e.description && (
                      <p className="text-muted-foreground mt-0.5 truncate text-xs">{e.description}</p>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleRestore(e.slug)}
                    disabled={restoringSlug === e.slug}
                  >
                    {restoringSlug === e.slug ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <CloudDownload className="size-3.5" />
                    )}
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Raw skill metadata"
          description="The exact Dexie rows behind the list above (troubleshooting)."
        >
          {rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">No skills installed.</p>
          ) : (
            <div className="space-y-2">
              {rows.map((s) => (
                <details key={s.id} className="mb-fade-in-soft rounded-lg border px-3 py-2">
                  <summary className="cursor-pointer font-mono text-xs font-medium">{s.name}</summary>
                  <pre className="text-muted-foreground mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
                    {JSON.stringify(s, null, 2)}
                  </pre>
                </details>
              ))}
            </div>
          )}
        </SectionCard>
      </MoreOptions>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall skill?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes <strong>{deleteTarget?.name}</strong> and its files from local
              storage. A previously synced cloud copy (if any) is kept and stays restorable
              under More options → Restore from cloud. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={handleDelete}
            >
              Uninstall
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default SectionSkills;
