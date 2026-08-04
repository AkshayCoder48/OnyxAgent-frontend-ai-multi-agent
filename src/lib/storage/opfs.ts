"use client";

/**
 * OPFS (Origin Private File System) storage — the backendless replacement
 * for the server-side `MEDIA_DIR`.
 *
 * All chat attachments and per-user files live under `users/<userId>/...`
 * inside the OPFS root. Blobs are read out on demand and exposed to the UI
 * via temporary object URLs (`makeBlobURL`). Skills are stored as
 * directories under `users/<userId>/skills/<name>/` containing `SKILL.md`.
 *
 * The OPFS API is async + promise-based on `navigator.storage.getDirectory()`
 * — every method here is awaitable.
 */

// ---------------------------------------------------------------------------
// Path helpers.
// ---------------------------------------------------------------------------

/** Split a relative path into a string[] of path segments. */
function splitPath(p: string): string[] {
  return p
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== ".");
}

/** Join path segments with `/`. */
function joinPath(...parts: string[]): string {
  return parts
    .flatMap(splitPath)
    .filter((s) => s.length > 0)
    .join("/");
}

/**
 * Walk a chain of subdirectory names from a FileSystemDirectoryHandle,
 * creating any missing directories along the way. Returns the leaf handle.
 */
async function walkAndCreate(
  root: FileSystemDirectoryHandle,
  segments: string[],
): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const seg of segments) {
    current = await current.getDirectoryHandle(seg, { create: true });
  }
  return current;
}

/** Walk a chain of subdirectory names from a root OPFS path string. */
async function getDirByPath(
  path: string,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const segments = splitPath(path);
  if (segments.length === 0) return root;
  let current = root;
  for (const seg of segments) {
    current = await current.getDirectoryHandle(seg, { create });
  }
  return current;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/** True iff OPFS is available in the current browser. */
export function isOPFSAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === "function"
  );
}

/** Ensure the user's root directory exists. Returns its directory handle. */
export async function ensureUserDir(
  userId: string,
): Promise<FileSystemDirectoryHandle> {
  return getDirByPath(`users/${userId}`, true);
}

/** Ensure `users/<userId>/<subPath>` exists. Returns the leaf directory. */
export async function ensurePath(
  userId: string,
  subPath: string,
): Promise<FileSystemDirectoryHandle> {
  await ensureUserDir(userId);
  return getDirByPath(`users/${userId}/${subPath}`, true);
}

/**
 * Write a file at `users/<userId>/<subPath>/<filename>`. Overwrites any
 * existing file with the same name.
 */
export async function writeFile(
  userId: string,
  subPath: string,
  filename: string,
  data: Blob | BufferSource | string,
): Promise<string> {
  const dir = await ensurePath(userId, subPath);
  // sanitize filename — strip path separators from the basename.
  const safeName = filename.replace(/[\\/]+/g, "_");
  const fileHandle = await dir.getFileHandle(safeName, { create: true });
  const writable = await fileHandle.createWritable();
  const blob =
    typeof data === "string"
      ? new Blob([data], { type: "text/plain" })
      : data instanceof Blob
        ? data
        : new Blob([data]);
  await writable.write(blob);
  await writable.close();
  return joinPath(`users/${userId}`, subPath, safeName);
}

/**
 * Read a file at `users/<userId>/<subPath>/<filename>` as a Blob.
 */
export async function readFile(
  path: string,
): Promise<Blob> {
  const segments = splitPath(path);
  if (segments.length < 2) throw new Error(`Invalid OPFS path: ${path}`);
  const filename = segments.pop()!;
  const dir = await getDirByPath(segments.join("/"));
  const handle = await dir.getFileHandle(filename);
  return handle.getFile();
}

/** Read an OPFS file at `path` as UTF-8 text. */
export async function readTextFile(path: string): Promise<string> {
  const blob = await readFile(path);
  return blob.text();
}

/** Delete a file at `path` (best-effort — no-op if missing). */
export async function deleteFile(path: string): Promise<void> {
  const segments = splitPath(path);
  if (segments.length < 2) return;
  const filename = segments.pop()!;
  try {
    const dir = await getDirByPath(segments.join("/"));
    await dir.removeEntry(filename);
  } catch {
    // missing file — no-op.
  }
}

/**
 * Recursively remove a directory at `users/<userId>/<subPath>`. Best-effort —
 * any failure (missing dir, partial delete) is swallowed. Used by the skill
 * uninstall flow to wipe `users/<userId>/skills/<name>/`.
 */
export async function removeDir(userId: string, subPath: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const userDir = await root.getDirectoryHandle("users");
    const targetDir = await userDir.getDirectoryHandle(userId);
    const segments = splitPath(subPath);
    let dir = targetDir;
    // Walk to the parent of the leaf, then remove the leaf.
    for (let i = 0; i < segments.length - 1; i++) {
      dir = await dir.getDirectoryHandle(segments[i]!);
    }
    const leaf = segments[segments.length - 1];
    if (leaf) {
      await dir.removeEntry(leaf, { recursive: true });
    }
  } catch {
    // missing dir — no-op.
  }
}

/**
 * Write a file at an explicit OPFS path. The `dirPath` is a slash-joined
 * sequence of directory segments (e.g. `users/<userId>/skills/<name>`); the
 * `filename` is the leaf file name. Overwrites any existing file. Returns
 * the full OPFS path of the written file.
 *
 * This is the lower-level write primitive the skill installer uses —
 * `writeFile` above is a thin wrapper that takes `userId + subPath`.
 */
export async function writeFileAtPath(
  dirPath: string,
  filename: string,
  data: Blob | BufferSource | string,
): Promise<string> {
  const dir = await getDirByPath(dirPath, true);
  const safeName = filename.replace(/[\\/]+/g, "_");
  const fileHandle = await dir.getFileHandle(safeName, { create: true });
  const writable = await fileHandle.createWritable();
  const blob =
    typeof data === "string"
      ? new Blob([data], { type: "text/plain" })
      : data instanceof Blob
        ? data
        : new Blob([data]);
  await writable.write(blob);
  await writable.close();
  return joinPath(dirPath, safeName);
}

export interface OPFSDirEntry {
  name: string;
  kind: "file" | "directory";
  path: string;
  size?: number;
  lastModified?: number;
}

/** List entries in `users/<userId>/<subPath>`. Returns empty array if missing.
 *
 * PERF: By default, does NOT call `entry.getFile()` for every file to fetch
 * size/lastModified — that's an O(n) async op per file which made listing a
 * folder with 50+ files take 2+ minutes (each getFile = round-trip to the
 * OPFS internal database). Instead we return entries with `size: undefined`
 * and `lastModified: undefined`. Pass `withMetadata: true` to opt into the
 * slow path (used by the file sidebar which shows sizes). */
export async function listDir(
  userId: string,
  subPath = "",
  withMetadata = false,
): Promise<OPFSDirEntry[]> {
  try {
    // Ensure the directory exists before listing — create it if missing.
    // This prevents the sidebar from showing empty when the workspace
    // hasn't been created yet.
    const dir = await getDirByPath(joinPath(`users/${userId}`, subPath), true);
    const out: OPFSDirEntry[] = [];
    // @ts-expect-error — `values()` is part of the OPFS spec but missing from some TS lib defs.
    for await (const entry of dir.values()) {
      const path = joinPath(`users/${userId}`, subPath, entry.name);
      if (entry.kind === "file") {
        if (withMetadata) {
          // Slow path — fetch size + lastModified (only for the file sidebar).
          let size: number | undefined;
          let lastModified: number | undefined;
          try {
            const file = await entry.getFile();
            size = file.size;
            lastModified = file.lastModified;
          } catch {
            // ignore — best-effort.
          }
          out.push({ name: entry.name, kind: "file", path, size, lastModified });
        } else {
          // Fast path — skip getFile(). The AI's list_folder tool doesn't
          // need sizes; it just needs names + types.
          out.push({ name: entry.name, kind: "file", path });
        }
      } else {
        out.push({ name: entry.name, kind: "directory", path });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Create a temporary object URL for an OPFS file. Caller MUST revoke when
 * done (e.g. via `URL.revokeObjectURL`). Useful for image previews and
 * download links.
 */
export async function makeBlobURL(path: string): Promise<string> {
  const blob = await readFile(path);
  return URL.createObjectURL(blob);
}

// ---------------------------------------------------------------------------
// Skill + collection directory helpers.
// ---------------------------------------------------------------------------

/** Ensure `users/<userId>/skills/<name>` exists. Returns its directory handle. */
export async function ensureSkillDir(
  userId: string,
  name: string,
): Promise<FileSystemDirectoryHandle> {
  const safe = name.replace(/[\\/]+/g, "_");
  return ensurePath(userId, `skills/${safe}`);
}

/** Ensure `users/<userId>/collections/<name>` exists. Returns its directory handle. */
export async function ensureCollectionDir(
  userId: string,
  name: string,
): Promise<FileSystemDirectoryHandle> {
  const safe = name.replace(/[\\/]+/g, "_");
  return ensurePath(userId, `collections/${safe}`);
}

/**
 * Walk every file inside a directory recursively (OPFS has no built-in
 * recursive listing). Used by send_folder (zip) and search_documents (grep).
 */
export async function walkFiles(
  dirHandle: FileSystemDirectoryHandle,
  basePath = "",
): Promise<Array<{ path: string; handle: FileSystemFileHandle }>> {
  const out: Array<{ path: string; handle: FileSystemFileHandle }> = [];
  // @ts-expect-error — `values()` is in the spec but missing from some lib defs.
  for await (const entry of dirHandle.values()) {
    const childPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.kind === "file") {
      out.push({ path: childPath, handle: entry as FileSystemFileHandle });
    } else {
      const nested = await walkFiles(
        entry as FileSystemDirectoryHandle,
        childPath,
      );
      out.push(...nested);
    }
  }
  return out;
}
