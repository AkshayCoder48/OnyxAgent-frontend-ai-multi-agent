"use client";

/**
 * Safe multi-skill ZIP handling (PRD §5-6).
 *
 * The legacy installer used `fflate.unzipSync`, which inflates EVERY entry
 * up-front with no caps — a zip-bomb or a hostile archive (path traversal,
 * symlinks, absolute paths) was extracted wholesale before any validation
 * could run. This module replaces that with a two-phase, defense-in-depth
 * pipeline:
 *
 *   1. `parseZipCentralDirectory` — parse the ZIP central directory ONLY
 *      (no inflation) to learn every entry's name, sizes, unix attributes
 *      and flags. Validation happens HERE, before a single byte is
 *      inflated: entry count cap, total-uncompressed cap, path traversal,
 *      absolute paths, symlinks, encrypted entries, unsupported codecs.
 *
 *   2. `extractZipEntries` — entry-at-a-time extraction. Each entry is
 *      inflated through fflate's streaming `Inflate` with a running byte
 *      budget, so even an archive with LYING size headers cannot allocate
 *      more than the remaining global budget of memory. (Store (method 0)
 *      entries are sliced directly — their size is bounded by the archive
 *      itself.)
 *
 *   3. `planSkillBundles` — group the validated entries into candidate
 *      skill directories: a root-level `SKILL.md` (case-insensitive) means
 *      ONE skill at the archive root; otherwise every top-level directory
 *      that directly contains `SKILL.md` is a skill. Dirs without one are
 *      reported as per-item errors (never silent, never blocking siblings).
 *
 *   4. `validateSkillMdText` — structural validation of the SKILL.md
 *      content: must have YAML front-matter (name/description) or a
 *      markdown heading, plus a non-trivial body. Actionable error
 *      messages for the UI.
 *
 * Everything here is pure/no-DOM (works in vitest node environment).
 */

import { Inflate } from "fflate";

// ---------------------------------------------------------------------------
// Limits (PRD §5).
// ---------------------------------------------------------------------------

/** Hard cap on archive entries — rejects pathological archives cheaply. */
export const ZIP_MAX_ENTRIES = 2000;

/** Hard cap on the TOTAL uncompressed payload across all entries (~50 MB). */
export const ZIP_MAX_TOTAL_UNCOMPRESSED = 50 * 1024 * 1024;

/** Junk prefixes/basenames dropped before detection (macOS/Windows cruft). */
const JUNK_PREFIXES = ["__MACOSX/"];
const JUNK_BASENAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const APPLEDOUBLE_PREFIX = "._";

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipFormatError";
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — central directory parsing + validation (no inflation).
// ---------------------------------------------------------------------------

export interface ZipEntryInfo {
  /** Raw entry name (backslashes NOT normalized yet — see `safePath`). */
  name: string;
  /** Compression method: 0 = store, 8 = deflate. */
  method: number;
  compSize: number;
  uncompSize: number;
  /** Raw external attributes (unix mode lives in the high 16 bits). */
  extAttr: number;
  /** General purpose bit flags. */
  flags: number;
  /** Absolute offset of the LOCAL file header inside the archive. */
  localOffset: number;
  /** Directory placeholder (trailing `/` or MS-DOS dir bit). */
  isDir: boolean;
  /** Unix symlink (mode & 0o170000 === 0o120000). */
  isSymlink: boolean;
}

export interface ParsedZip {
  entries: ZipEntryInfo[];
  /** Entries dropped during validation, with the reason (surfaced in UI). */
  rejected: Array<{ name: string; reason: string }>;
  /** Sum of uncompressed sizes of the accepted entries. */
  totalUncompressed: number;
}

/** Normalize an entry name into a safe relative path, or return the reason
 *  it must be rejected (traversal / absolute / backslash trickery). */
export function zipEntrySafePath(rawName: string): string | null {
  if (!rawName) return null;
  if (rawName.includes("\0")) return null;
  // Windows-created archives sometimes use `\` separators — normalize, but
  // reject drive-letter absolute paths either way.
  let name = rawName.replace(/\\/g, "/");
  if (name.startsWith("/")) return null; // absolute path
  if (/^[A-Za-z]:/.test(name)) return null; // windows drive path
  const segments = name.split("/");
  for (const seg of segments) {
    if (seg === "..") return null; // traversal
  }
  // Note: "a//b" (empty middle segment) and trailing "/" (directory
  // placeholder) are tolerated — they cannot escape the skill directory.
  // Strip a single leading "./" (some packers emit it).
  if (name.startsWith("./")) name = name.slice(2);
  return name;
}

/** Is this entry pure junk (macOS/Windows metadata) that never reaches a skill dir? */
export function isJunkZipEntry(name: string): boolean {
  if (JUNK_PREFIXES.some((p) => name.startsWith(p))) return true;
  const base = name.split("/").pop() ?? name;
  if (JUNK_BASENAMES.has(base)) return true;
  if (base.startsWith(APPLEDOUBLE_PREFIX)) return true;
  return false;
}

function readU16(v: DataView, o: number): number {
  return v.getUint16(o, true);
}
function readU32(v: DataView, o: number): number {
  return v.getUint32(o, true);
}
function readU64(v: DataView, o: number): number {
  // Numbers up to Number.MAX_SAFE_INTEGER are enough for our caps.
  return v.getUint32(o, true) + v.getUint32(o + 4, true) * 0x1_0000_0000;
}

/** Locate + parse the End Of Central Directory record (with ZIP64 support).
 *  Returns { cdOffset, cdSize, totalEntries } or throws ZipFormatError. */
function locateCentralDirectory(
  bytes: Uint8Array,
): { cdOffset: number; cdSize: number; totalEntries: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // EOCD is at most 22 bytes + a 64 KB comment. Scan backwards.
  const sig = 0x06054b50; // "PK\x05\x06" little-endian
  let eocd = -1;
  const min = Math.max(0, bytes.length - (22 + 65_536));
  for (let i = bytes.length - 22; i >= min; i--) {
    if (readU32(v, i) === sig) {
      const commentLen = readU16(v, i + 20);
      if (i + 22 + commentLen <= bytes.length) {
        eocd = i;
        break;
      }
    }
  }
  if (eocd < 0) throw new ZipFormatError("Invalid ZIP archive: end-of-central-directory record not found (corrupt or truncated file).");

  let totalEntries = readU16(v, eocd + 10);
  let cdSize = readU32(v, eocd + 12);
  let cdOffset = readU32(v, eocd + 16);

  // ZIP64 — when any of the classic fields are saturated, the real values
  // live in the ZIP64 EOCD record pointed at by the locator just before EOCD.
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locatorSig = 0x07064b50; // "PK\x06\x07"
    const z64EocdSig = 0x06064b50; // "PK\x06\x06"
    if (eocd >= 20 && readU32(v, eocd - 20) === locatorSig) {
      const z64Offset = readU64(v, eocd - 20 + 8);
      if (z64Offset + 56 <= bytes.length && readU32(v, z64Offset) === z64EocdSig) {
        totalEntries = readU64(v, z64Offset + 32);
        cdSize = readU64(v, z64Offset + 40);
        cdOffset = readU64(v, z64Offset + 48);
      }
    }
    if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new ZipFormatError("Invalid ZIP archive: ZIP64 central directory is malformed.");
    }
  }

  if (cdOffset + cdSize > bytes.length) {
    throw new ZipFormatError("Invalid ZIP archive: central directory points past the end of the file (corrupt or truncated).");
  }
  return { cdOffset, cdSize, totalEntries };
}

/** Parse + validate the central directory. Throws ZipFormatError for a
 *  corrupt archive or when the ARCHIVE-LEVEL limits are exceeded (zip-bomb
 *  totals, absurd entry counts). Per-entry problems (traversal, symlink,
 *  junk, unsupported codec) are REJECTED individually — see `rejected`. */
export function parseZipCentralDirectory(bytes: Uint8Array): ParsedZip {
  const { cdOffset, cdSize, totalEntries } = locateCentralDirectory(bytes);
  if (totalEntries > ZIP_MAX_ENTRIES) {
    throw new ZipFormatError(
      `Archive has ${totalEntries} entries — above the ${ZIP_MAX_ENTRIES}-entry safety cap.`,
    );
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries: ZipEntryInfo[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];
  let totalUncompressed = 0;
  let pos = cdOffset;
  const cdEnd = cdOffset + cdSize;
  let seen = 0;

  while (pos + 46 <= cdEnd && seen < totalEntries) {
    if (readU32(v, pos) !== 0x02014b50) {
      throw new ZipFormatError("Invalid ZIP archive: corrupted central directory entry.");
    }
    const flags = readU16(v, pos + 8);
    const method = readU16(v, pos + 10);
    const compSize = readU32(v, pos + 20);
    let uncompSize = readU32(v, pos + 24);
    const nameLen = readU16(v, pos + 28);
    const extraLen = readU16(v, pos + 30);
    const commentLen = readU16(v, pos + 32);
    const extAttr = readU32(v, pos + 38);
    let localOffset = readU32(v, pos + 42);

    if (pos + 46 + nameLen + extraLen + commentLen > cdEnd) {
      throw new ZipFormatError("Invalid ZIP archive: truncated central directory entry.");
    }
    const rawName = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));

    // ZIP64 extended information (extra field 0x0001) carries the real
    // sizes/offset for saturated classic fields.
    let extraPos = pos + 46 + nameLen;
    const extraEnd = extraPos + extraLen;
    while (extraPos + 4 <= extraEnd) {
      const id = readU16(v, extraPos);
      const size = readU16(v, extraPos + 2);
      if (extraPos + 4 + size > extraEnd) break;
      if (id === 0x0001) {
        let f = extraPos + 4;
        if (uncompSize === 0xffffffff && f + 8 <= extraPos + 4 + size) {
          uncompSize = readU64(v, f);
          f += 8;
        }
        if (compSize === 0xffffffff && f + 8 <= extraPos + 4 + size) f += 8;
        if (localOffset === 0xffffffff && f + 8 <= extraPos + 4 + size) {
          localOffset = readU64(v, f);
          f += 8;
        }
      }
      extraPos += 4 + size;
    }

    seen++;
    pos += 46 + nameLen + extraLen + commentLen;

    // ---- per-entry validation ------------------------------------------
    const note = (reason: string) => rejected.push({ name: rawName || "(unnamed entry)", reason });
    if (!rawName) {
      note("entry has no file name");
      continue;
    }
    if (flags & 0x1) {
      note("encrypted entries are not supported");
      continue;
    }
    if (method !== 0 && method !== 8) {
      note(`unsupported compression method ${method} (only store/deflate are supported)`);
      continue;
    }
    const isDir = rawName.endsWith("/") || (extAttr & 0x10) !== 0;
    const mode = (extAttr >>> 16) & 0xffff;
    const isSymlink = mode !== 0 && (mode & 0o170000) === 0o120000;
    if (isSymlink) {
      note("symlink entries are rejected for security");
      continue;
    }
    const safePath = zipEntrySafePath(rawName);
    if (!safePath) {
      note("path traversal or absolute path — rejected for security");
      continue;
    }
    if (isJunkZipEntry(safePath)) {
      // Junk (__.MACOSX, .DS_Store …) is dropped silently-safe: recorded but
      // never shown as an error.
      note("dropped archive junk entry");
      continue;
    }
    if (isDir) continue; // directory placeholder — nothing to extract

    if (!Number.isFinite(uncompSize) || uncompSize < 0) {
      note("invalid uncompressed size");
      continue;
    }
    totalUncompressed += uncompSize;
    if (totalUncompressed > ZIP_MAX_TOTAL_UNCOMPRESSED) {
      throw new ZipFormatError(
        `Archive expands to more than ${Math.round(ZIP_MAX_TOTAL_UNCOMPRESSED / 1048576)} MB ` +
          "uncompressed — above the safety cap (zip-bomb protection).",
      );
    }
    if (localOffset + 30 > bytes.length) {
      note("local header offset points outside the archive");
      continue;
    }
    entries.push({ name: safePath, method, compSize, uncompSize, extAttr, flags, localOffset, isDir, isSymlink });
  }

  if (seen !== totalEntries) {
    throw new ZipFormatError(
      `Invalid ZIP archive: central directory advertises ${totalEntries} entries but only ${seen} parse — the file is corrupt or truncated.`,
    );
  }

  return { entries, rejected, totalUncompressed };
}

// ---------------------------------------------------------------------------
// Phase 2 — entry-at-a-time extraction with a hard byte budget.
// ---------------------------------------------------------------------------

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Inflate ONE raw-deflate stream with a hard output cap. fflate's streaming
 * `Inflate` runs synchronously and calls `ondata` per output block — we count
 * bytes as they arrive and abort the moment the budget is exceeded, so even a
 * lying zip header (small `uncompSize`, huge actual stream) can never
 * allocate more than `cap` bytes of memory.
 */
function inflateCapped(data: Uint8Array, cap: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  const inf = new Inflate((chunk) => {
    if (overflow) return;
    total += chunk.length;
    if (total > cap) {
      overflow = true;
      return;
    }
    parts.push(chunk);
  });
  try {
    inf.push(data, true);
  } catch {
    throw new ZipFormatError("Failed to decompress a ZIP entry (corrupt deflate stream).");
  }
  if (overflow) {
    throw new ZipFormatError(
      "ZIP entry expands beyond the remaining size budget — archive aborted (zip-bomb protection).",
    );
  }
  return concatBytes(parts);
}

/** Extract the given (already validated) entries. Budget = remaining global
 *  uncompressed allowance — enforced again per entry at INFLATE time, so
 *  lying headers cannot bypass it. Returns a map of safePath → bytes. */
export function extractZipEntries(
  bytes: Uint8Array,
  entries: ZipEntryInfo[],
  budget: number = ZIP_MAX_TOTAL_UNCOMPRESSED,
): Map<string, Uint8Array> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, Uint8Array>();
  let remaining = budget;
  for (const e of entries) {
    // Parse the LOCAL file header at the recorded offset (its name/extra
    // lengths can legitimately differ from the central directory copy).
    if (readU32(v, e.localOffset) !== 0x04034b50) {
      throw new ZipFormatError(`Invalid ZIP archive: local header missing for ${e.name}.`);
    }
    const lNameLen = readU16(v, e.localOffset + 26);
    const lExtraLen = readU16(v, e.localOffset + 28);
    const dataStart = e.localOffset + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + e.compSize;
    if (dataEnd > bytes.length) {
      throw new ZipFormatError(`Invalid ZIP archive: entry data for ${e.name} is truncated.`);
    }
    const raw = bytes.subarray(dataStart, dataEnd);
    if (e.method === 0) {
      if (raw.length > remaining) {
        throw new ZipFormatError("Archive expands beyond the 50 MB safety cap (zip-bomb protection).");
      }
      out.set(e.name, raw);
      remaining -= raw.length;
    } else {
      const inflated = inflateCapped(raw, remaining);
      out.set(e.name, inflated);
      remaining -= inflated.length;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase 3 — skill bundle detection.
// ---------------------------------------------------------------------------

/** Case-insensitive SKILL.md match ("SKILL.md" / "skill.md" / "Skill.MD" …). */
export function isSkillMdName(name: string): boolean {
  return /^skill\.md$/i.test(name);
}

export interface PlannedSkill {
  /** The top-level directory the skill lives in ("" for archive root). */
  dir: string;
  /** Safe relative paths of every file, e.g. ["SKILL.md", "scripts/run.py"]. */
  files: string[];
  /** Path of the SKILL.md inside the bundle ("SKILL.md" for root skills). */
  skillMdPath: string;
  /** Fallback name derived from the directory (used when front-matter has none). */
  dirName: string;
}

export interface RejectedSkillDir {
  dir: string;
  reason: string;
}

export interface BundlePlan {
  skills: PlannedSkill[];
  rejected: RejectedSkillDir[];
}

/**
 * Group validated entry paths into skill bundles:
 *  - `SKILL.md` at the archive root (case-insensitive) → ONE skill holding
 *    the ENTIRE archive (root files + nested asset folders — legacy
 *    single-skill-at-root semantics).
 *  - otherwise every TOP-LEVEL directory that directly contains `SKILL.md`
 *    is one skill holding its subtree.
 * Dirs without a direct SKILL.md are rejected with a per-item reason.
 */
export function planSkillBundles(paths: string[]): BundlePlan {
  // Root-level SKILL.md → the whole archive is ONE skill.
  const rootSkillMd = paths.find((p) => isSkillMdName(p));
  if (rootSkillMd) {
    return {
      skills: [
        {
          dir: "",
          files: paths,
          skillMdPath: rootSkillMd,
          dirName: "",
        },
      ],
      rejected: [],
    };
  }

  // Otherwise group by top-level segment.
  const byTop = new Map<string, string[]>();
  for (const p of paths) {
    const seg = p.split("/")[0] ?? "";
    const rest = p.slice(seg.length + 1);
    const arr = byTop.get(seg) ?? [];
    arr.push(rest);
    byTop.set(seg, arr);
  }

  const skills: PlannedSkill[] = [];
  const rejected: RejectedSkillDir[] = [];
  for (const [top, rest] of byTop) {
    const direct = rest.find((p) => isSkillMdName(p));
    if (direct) {
      skills.push({
        dir: top,
        files: rest,
        skillMdPath: direct,
        dirName: top,
      });
    } else {
      // Give the most precise reason we can.
      const nested = rest.find((p) => isSkillMdName(p.split("/").pop() ?? ""));
      rejected.push({
        dir: top,
        reason: nested
          ? `SKILL.md found at "${top}/${nested}" — it must sit at the TOP of the skill folder ("${top}/SKILL.md")`
          : "no SKILL.md found in this folder",
      });
    }
  }
  // Deterministic order (stable UI output).
  skills.sort((a, b) => (a.dir < b.dir ? -1 : 1));
  rejected.sort((a, b) => (a.dir < b.dir ? -1 : 1));
  return { skills, rejected };
}

// ---------------------------------------------------------------------------
// Phase 4 — SKILL.md content validation (PRD §6: never silent failure).
// ---------------------------------------------------------------------------

export interface SkillMdValidation {
  ok: boolean;
  /** Actionable error shown per-item in the UI (null when ok). */
  error: string | null;
  name: string | null;
  description: string | null;
}

/** Minimum non-whitespace body length for a skill to be useful. */
const MIN_BODY_CHARS = 40;

/**
 * Structural validation of a SKILL.md:
 *  - must not be empty;
 *  - must have YAML front-matter (with a name) OR at least one markdown
 *    heading;
 *  - the body (after front-matter) must be non-trivial.
 * Returns the parsed name/description when present (front-matter keys take
 * precedence; a `# Heading` is used as the display name when front-matter
 * has no name).
 */
export function validateSkillMdText(text: string, fallbackName: string): SkillMdValidation {
  const fail = (error: string): SkillMdValidation => ({ ok: false, error, name: null, description: null });

  if (!text || !text.trim()) {
    return fail("SKILL.md is empty — add YAML front-matter (name/description) and instructions for the agent.");
  }

  // Front-matter (reuse of the installer's tolerant parser shape, kept local
  // so this module stays dependency-free and testable).
  const fmMatch = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  const fm: Record<string, string> = {};
  let body = text;
  let hasFrontMatter = false;
  if (fmMatch?.[1]) {
    hasFrontMatter = true;
    body = text.slice(fmMatch[0].length);
    for (const line of fmMatch[1].split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;
      const key = trimmed.slice(0, colonIdx).trim();
      let value = trimmed.slice(colonIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key === "name" || key === "description") fm[key] = value;
    }
  }

  const headingMatch = body.match(/^#\s+(.+)$/m);
  const nonWs = body.replace(/\s+/g, "");

  if (!hasFrontMatter && !headingMatch) {
    return fail(
      "SKILL.md has neither YAML front-matter (--- name: … / description: … ---) nor a markdown (# ) heading — nothing identifies this skill.",
    );
  }
  if (nonWs.length < MIN_BODY_CHARS) {
    return fail(
      `SKILL.md instructions are too short (${nonWs.length} non-whitespace characters, minimum ${MIN_BODY_CHARS}) — add guidance for the agent.`,
    );
  }

  const name = fm.name?.trim() || headingMatch?.[1]?.trim() || fallbackName.trim() || null;
  const description = fm.description?.trim() || null;
  if (!name) {
    return fail(
      "SKILL.md has no `name:` in its front-matter, no markdown heading to derive one from, and no file/folder name to fall back on.",
    );
  }
  return { ok: true, error: null, name, description };
}
