// ============================================================================
// Background Task Execution Framework — sandbox file manifest (FR-4.1).
//
// Every background task mounts its serialized payload files into the E2B
// sandbox BEFORE the runner starts, and writes a manifest
// (.onyxagent_files.json) next to them. The verify pass lists the sandbox
// filesystem through the same SDK API the sandbox route uses
// (sandbox.files.list) and compares each manifest entry (path + size),
// producing the mount report stored in TaskRun.progress — so a partial
// upload is detected before any LLM round is spent, and the artifact diff
// at finalize knows which files were pristine inputs.
// ============================================================================

import type { Sandbox } from "@e2b/code-interpreter";
import {
  MANIFEST_PATH,
  type OnyxAgentFilesManifest,
  type TaskPayloadFile,
} from "./protocol";

/** Sandbox workspace root — every payload path is relative to this. */
export const SANDBOX_ROOT = "/home/user";
/** Absolute manifest location inside the sandbox. */
export const MANIFEST_ABS_PATH = `${SANDBOX_ROOT}/${MANIFEST_PATH}`;

/** Normalize a workspace-relative payload path to its sandbox-absolute form.
 *  Returns null for paths that would escape the workspace root. */
export function toSandboxPath(relPath: string): string | null {
  let p = String(relPath ?? "").trim();
  if (!p) return null;
  if (p.startsWith("/")) p = p.slice(1);
  const parts = p.split("/").filter((seg) => seg.length > 0 && seg !== ".");
  if (parts.length === 0) return null;
  if (parts.some((seg) => seg === "..")) return null;
  return `${SANDBOX_ROOT}/${parts.join("/")}`;
}

/** Build the FR-4.1 manifest for a run's payload files (in-memory only —
 *  the driver writes it into the sandbox right after mounting). */
export function buildManifest(
  runId: string,
  files: TaskPayloadFile[],
): OnyxAgentFilesManifest {
  return {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    files: files.map((f) => ({
      path: f.path,
      size: f.size,
      sha256: f.sha256,
      source: f.source,
    })),
  };
}

/** FR-4.1 verification result — persisted verbatim into
 *  TaskRun.progress.mountReport. */
export interface MountReport {
  /** Total file entries the sandbox listing returned (across the manifest's
   *  parent directories). */
  filesListed: number;
  /** Files the manifest asked to mount. */
  filesMounted: number;
  /** Files present in the sandbox with a byte-exact size match. */
  filesVerified: number;
  /** Manifest paths that are absent or size-mismatched in the sandbox. */
  missing: string[];
}

/** List one directory through the SDK and collect file entries
 *  (path → size). Subdirectories are collected but not recursed into — the
 *  manifest groups by parent directory, so one listing per unique parent is
 *  enough (and far cheaper than walking the whole 55-skill workspace). */
async function listDirFiles(
  sandbox: Sandbox,
  dir: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let entries: Awaited<ReturnType<Sandbox["files"]["list"]>> = [];
  try {
    entries = await sandbox.files.list(dir);
  } catch {
    return out; // missing dir → every manifest file under it is "missing"
  }
  for (const e of entries) {
    const type = String(e.type ?? "");
    if (type === "dir" || type === "directory" || type === "FILE_TYPE_DIRECTORY") {
      continue;
    }
    out.set(e.path, e.size ?? 0);
  }
  return out;
}

/**
 * Verify a mounted payload against its manifest: group the manifest entries
 * by parent directory, list each directory once, and compare path + size.
 * (Size is the cheap integrity signal — a byte-level sha comparison would
 * mean re-reading every mounted byte back over the wire.)
 */
export async function verifyMount(
  sandbox: Sandbox,
  manifest: OnyxAgentFilesManifest,
): Promise<MountReport> {
  const report: MountReport = {
    filesListed: 0,
    filesMounted: manifest.files.length,
    filesVerified: 0,
    missing: [],
  };

  // Group manifest entries by absolute parent directory.
  const byDir = new Map<string, Array<{ abs: string; rel: string; size: number }>>();
  for (const f of manifest.files) {
    const abs = toSandboxPath(f.path);
    if (!abs) {
      report.missing.push(f.path); // unusable path → cannot be mounted
      continue;
    }
    const dir = abs.slice(0, abs.lastIndexOf("/")) || "/";
    const bucket = byDir.get(dir) ?? [];
    bucket.push({ abs, rel: f.path, size: f.size });
    byDir.set(dir, bucket);
  }

  for (const [dir, wanted] of byDir) {
    const listed = await listDirFiles(sandbox, dir);
    report.filesListed += listed.size;
    for (const w of wanted) {
      const size = listed.get(w.abs);
      if (size !== undefined && size === w.size) {
        report.filesVerified += 1;
      } else {
        report.missing.push(w.rel);
      }
    }
  }

  return report;
}
