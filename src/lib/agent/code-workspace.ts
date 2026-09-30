/**
 * OnyxCode workspace store — one workspace per code-mode conversation.
 *
 * In-memory hot cache (authoritative while this process lives) with Prisma
 * write-through so workspaces survive server restarts. Files are a single
 * JSON {path: content} map on one row — millisecond read/write.
 */

import { db } from "@/lib/db";

export interface WorkspaceAppMeta {
  framework?: string;
  name?: string;
  description?: string;
}

export interface Workspace {
  id: string;
  files: Record<string, string>;
  appMeta: WorkspaceAppMeta;
  createdAt: number;
  updatedAt: number;
}

const cache = new Map<string, Workspace>();
const loading = new Map<string, Promise<Workspace | null>>();

function now(): number {
  return Date.now();
}

function emptyWorkspace(id: string): Workspace {
  return { id, files: {}, appMeta: {}, createdAt: now(), updatedAt: now() };
}

async function loadFromDb(id: string): Promise<Workspace | null> {
  try {
    const row = await db.codeWorkspace.findUnique({ where: { id } });
    if (!row) return null;
    let files: Record<string, string> = {};
    let appMeta: WorkspaceAppMeta = {};
    try {
      const parsed = JSON.parse(row.files) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [path, content] of Object.entries(parsed)) {
          if (typeof content === "string") files[path] = content;
        }
      }
    } catch {
      files = {};
    }
    try {
      const meta = JSON.parse(row.appMeta) as WorkspaceAppMeta;
      if (meta && typeof meta === "object") appMeta = meta;
    } catch {
      appMeta = {};
    }
    return {
      id,
      files,
      appMeta,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
    };
  } catch {
    return null;
  }
}

export async function getWorkspace(id: string): Promise<Workspace> {
  const hit = cache.get(id);
  if (hit) return hit;
  const inflight = loading.get(id);
  if (inflight) {
    const loaded = await inflight;
    if (loaded) return loaded;
    const fresh = emptyWorkspace(id);
    cache.set(id, fresh);
    return fresh;
  }
  const promise = loadFromDb(id);
  loading.set(id, promise);
  try {
    const loaded = await promise;
    if (loaded) {
      cache.set(id, loaded);
      return loaded;
    }
    const fresh = emptyWorkspace(id);
    cache.set(id, fresh);
    return fresh;
  } finally {
    loading.delete(id);
  }
}

async function persist(workspace: Workspace): Promise<void> {
  workspace.updatedAt = now();
  try {
    await db.codeWorkspace.upsert({
      where: { id: workspace.id },
      create: {
        id: workspace.id,
        files: JSON.stringify(workspace.files),
        appMeta: JSON.stringify(workspace.appMeta),
      },
      update: {
        files: JSON.stringify(workspace.files),
        appMeta: JSON.stringify(workspace.appMeta),
      },
    });
  } catch {
    // Disk/DB hiccup — the in-memory copy stays authoritative.
  }
}

export async function writeFiles(
  id: string,
  files: Record<string, string>,
  appMeta?: WorkspaceAppMeta,
): Promise<Workspace> {
  const workspace = await getWorkspace(id);
  for (const [path, content] of Object.entries(files)) {
    const clean = path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!clean || clean.startsWith("..") || clean.includes("/../")) continue;
    workspace.files[clean] = content;
  }
  if (appMeta) workspace.appMeta = { ...workspace.appMeta, ...appMeta };
  await persist(workspace);
  return workspace;
}

export async function deleteFile(id: string, path: string): Promise<boolean> {
  const workspace = await getWorkspace(id);
  if (!(path in workspace.files)) return false;
  delete workspace.files[path];
  await persist(workspace);
  return true;
}

/** Replace the whole file set (scaffold overwrite). */
export async function replaceWorkspace(
  id: string,
  files: Record<string, string>,
  appMeta: WorkspaceAppMeta,
): Promise<Workspace> {
  const workspace = await getWorkspace(id);
  workspace.files = { ...files };
  workspace.appMeta = { ...appMeta };
  await persist(workspace);
  return workspace;
}

export function workspaceSummary(workspace: Workspace, maxFiles = 40): string {
  const meta = workspace.appMeta;
  const paths = Object.keys(workspace.files).sort();
  const lines: string[] = [];
  if (meta.name || meta.framework) {
    lines.push(`App: ${meta.name ?? "(unnamed)"}${meta.framework ? ` (${meta.framework})` : ""}`);
    if (meta.description) lines.push(`Description: ${meta.description}`);
  }
  if (paths.length === 0) {
    lines.push("Files: (empty workspace — no app scaffolded yet)");
  } else {
    const shown = paths.slice(0, maxFiles);
    lines.push(`Files (${paths.length}):`);
    for (const p of shown) lines.push(`  - ${p} (${workspace.files[p].length} bytes)`);
    if (paths.length > maxFiles) lines.push(`  … and ${paths.length - maxFiles} more`);
  }
  return lines.join("\n");
}
