/**
 * Tests for the safe multi-skill ZIP pipeline (src/lib/skills/zip.ts).
 *
 * A tiny raw ZIP writer is included so tests can control fields fflate's
 * `zipSync` cannot (symlink external attributes, LYING uncompressed-size
 * headers for zip-bomb cases, unsupported compression methods).
 */
import { describe, expect, it } from "vitest";
import { deflateSync, zipSync } from "fflate";

import {
  ZIP_MAX_ENTRIES,
  ZIP_MAX_TOTAL_UNCOMPRESSED,
  extractZipEntries,
  isJunkZipEntry,
  isSkillMdName,
  parseZipCentralDirectory,
  planSkillBundles,
  validateSkillMdText,
  zipEntrySafePath,
  ZipFormatError,
  type ZipEntryInfo,
} from "./zip";

// ---------------------------------------------------------------------------
// Test ZIP builder (store + deflate, raw central directory control).
// ---------------------------------------------------------------------------

interface RawEntry {
  name: string;
  /** Raw (possibly lying) uncompressed size written into the headers. */
  uncompSize?: number;
  method?: number; // 0 store | 8 deflate
  extAttr?: number;
  flags?: number;
  /** Bytes to store (defaults to the encoded name). */
  data?: Uint8Array;
}

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function buildZip(entries: RawEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();

  const push = (buf: Uint8Array) => {
    chunks.push(buf);
    offset += buf.length;
  };

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const method = e.method ?? 0;
    const raw = e.data ?? enc.encode(e.name);
    const stored = method === 8 ? deflateSync(raw) : raw;
    const uncompSize = e.uncompSize ?? raw.length;
    const flags = e.flags ?? 0;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true); // time
    lv.setUint16(12, 0x2100, true); // date (invalid-but-parsed)
    lv.setUint32(14, crc32(stored), true);
    lv.setUint32(18, stored.length, true);
    lv.setUint32(22, uncompSize, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra len
    local.set(nameBytes, 30);
    const localOffset = offset;
    push(local);
    push(stored);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, (3 << 8) | 20, true); // made by unix
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x2100, true);
    cv.setUint32(16, crc32(stored), true);
    cv.setUint32(20, stored.length, true);
    cv.setUint32(24, uncompSize, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, e.extAttr ?? 0, true);
    cv.setUint32(42, localOffset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
  }

  const cdOffset = offset;
  for (const c of central) push(c);
  const cdSize = offset - cdOffset;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  chunks.push(eocd);

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const encoder = new TextEncoder();
const u8 = (s: string) => encoder.encode(s);

/** Unix mode helper — plain file / symlink attributes. */
const UNIX_FILE = (0o100644 << 16) >>> 0;
const UNIX_SYMLINK = (0o120777 << 16) >>> 0;

// ---------------------------------------------------------------------------
// zipEntrySafePath
// ---------------------------------------------------------------------------

describe("zipEntrySafePath", () => {
  it("accepts plain relative paths", () => {
    expect(zipEntrySafePath("SKILL.md")).toBe("SKILL.md");
    expect(zipEntrySafePath("skill-a/scripts/run.py")).toBe("skill-a/scripts/run.py");
    expect(zipEntrySafePath("dir/")).toBe("dir/"); // directory placeholder
  });

  it("normalizes backslash separators", () => {
    expect(zipEntrySafePath("skill\\assets\\icon.png")).toBe("skill/assets/icon.png");
  });

  it("rejects traversal, absolute and drive paths", () => {
    expect(zipEntrySafePath("../escape.txt")).toBeNull();
    expect(zipEntrySafePath("a/../../escape.txt")).toBeNull();
    expect(zipEntrySafePath("..\\escape.txt")).toBeNull();
    expect(zipEntrySafePath("/etc/passwd")).toBeNull();
    expect(zipEntrySafePath("C:/evil.txt")).toBeNull();
    expect(zipEntrySafePath("evil\0.txt")).toBeNull();
  });
});

describe("isJunkZipEntry / isSkillMdName", () => {
  it("flags macOS + windows cruft", () => {
    expect(isJunkZipEntry("__MACOSX/skill/._SKILL.md")).toBe(true);
    expect(isJunkZipEntry("skill/.DS_Store")).toBe(true);
    expect(isJunkZipEntry("skill/Thumbs.db")).toBe(true);
    expect(isJunkZipEntry("skill/._asset.png")).toBe(true);
    expect(isJunkZipEntry("skill/assets/keep.png")).toBe(false);
  });

  it("matches SKILL.md case-insensitively at ONE path level", () => {
    expect(isSkillMdName("SKILL.md")).toBe(true);
    expect(isSkillMdName("skill.md")).toBe(true);
    expect(isSkillMdName("Skill.MD")).toBe(true);
    expect(isSkillMdName("README.md")).toBe(false);
    expect(isSkillMdName("nested/SKILL.md")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseZipCentralDirectory
// ---------------------------------------------------------------------------

describe("parseZipCentralDirectory", () => {
  it("parses a normal store-method archive", () => {
    const zip = buildZip([
      { name: "skill-a/SKILL.md", data: u8("---\nname: a\n---\nbody") },
      { name: "skill-a/assets/x.bin", data: new Uint8Array([1, 2, 3]), extAttr: UNIX_FILE },
    ]);
    const parsed = parseZipCentralDirectory(zip);
    expect(parsed.entries.map((e) => e.name).sort()).toEqual([
      "skill-a/SKILL.md",
      "skill-a/assets/x.bin",
    ]);
    expect(parsed.totalUncompressed).toBe(u8("---\nname: a\n---\nbody").length + 3);
  });

  it("parses deflate entries and reports sizes", () => {
    const big = u8("hello world ".repeat(100));
    const zip = buildZip([{ name: "a.txt", data: big, method: 8, extAttr: UNIX_FILE }]);
    const parsed = parseZipCentralDirectory(zip);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.uncompSize).toBe(big.length);
    expect(parsed.entries[0]!.method).toBe(8);
    const out = extractZipEntries(zip, parsed.entries);
    expect(Buffer.from(out.get("a.txt")!).toString()).toBe("hello world ".repeat(100));
  });

  it("drops directory placeholders, junk and symlinks as rejected entries", () => {
    const zip = buildZip([
      { name: "skill-a/" }, // dir placeholder
      { name: "skill-a/SKILL.md", data: u8("x") },
      { name: "__MACOSX/skill-a/._SKILL.md", data: u8("junk") },
      { name: "skill-a/.DS_Store", data: u8("junk") },
      { name: "skill-a/link", data: u8("/etc/passwd"), extAttr: UNIX_SYMLINK },
    ]);
    const parsed = parseZipCentralDirectory(zip);
    expect(parsed.entries.map((e) => e.name)).toEqual(["skill-a/SKILL.md"]);
    const reasons = parsed.rejected.map((r) => r.reason).join("\n");
    expect(reasons).toContain("symlink");
  });

  it("rejects path traversal entries individually", () => {
    const zip = buildZip([
      { name: "skill-a/SKILL.md", data: u8("x") },
      { name: "../evil.txt", data: u8("boom") },
    ]);
    const parsed = parseZipCentralDirectory(zip);
    expect(parsed.entries.map((e) => e.name)).toEqual(["skill-a/SKILL.md"]);
    expect(parsed.rejected.some((r) => r.reason.includes("traversal"))).toBe(true);
  });

  it("rejects unsupported compression methods and encrypted entries", () => {
    const zip = buildZip([
      { name: "skill-a/SKILL.md", data: u8("x") },
      { name: "skill-a/lzma.bin", data: u8("x"), method: 14 },
      { name: "skill-a/secret", data: u8("x"), flags: 0x1 },
    ]);
    const parsed = parseZipCentralDirectory(zip);
    expect(parsed.entries.map((e) => e.name)).toEqual(["skill-a/SKILL.md"]);
    expect(parsed.rejected.some((r) => r.reason.includes("compression method 14"))).toBe(true);
    expect(parsed.rejected.some((r) => r.reason.includes("encrypted"))).toBe(true);
  });

  it("throws on the zip-bomb TOTAL size cap", () => {
    const zip = buildZip([
      { name: "bomb1.bin", data: u8("x"), uncompSize: 30 * 1024 * 1024 },
      { name: "bomb2.bin", data: u8("x"), uncompSize: 30 * 1024 * 1024 },
    ]);
    expect(() => parseZipCentralDirectory(zip)).toThrow(ZipFormatError);
    expect(() => parseZipCentralDirectory(zip)).toThrow(/zip-bomb/);
  });

  it("throws on the entry-count cap", () => {
    // Build a zip whose EOCD advertises more entries than allowed without
    // actually writing them (saturated count → we fake via many entries is
    // slow; instead patch the EOCD count of a small archive).
    const base = buildZip([{ name: "a.txt", data: u8("x") }]);
    const v = new DataView(base.buffer, base.byteOffset, base.byteLength);
    const eocd = base.length - 22;
    v.setUint16(eocd + 10, ZIP_MAX_ENTRIES + 1, true); // totalEntries
    expect(() => parseZipCentralDirectory(base)).toThrow(/entries/);
  });

  it("throws on corrupt/truncated archives", () => {
    expect(() => parseZipCentralDirectory(new Uint8Array(10))).toThrow(ZipFormatError);
    const zip = buildZip([{ name: "a.txt", data: u8("x") }]);
    const truncated = zip.subarray(0, zip.length - 15);
    expect(() => parseZipCentralDirectory(truncated)).toThrow(ZipFormatError);
    const garbage = u8("this is not a zip file at all, definitely not");
    expect(() => parseZipCentralDirectory(garbage)).toThrow(ZipFormatError);
  });

  it("enforces the inflate budget against LYING headers (real zip bomb)", () => {
    // The header claims 3 bytes, but the deflate stream actually inflates to
    // ~100 KB — extraction must abort instead of allocating past the budget.
    const bomb = u8("A".repeat(100_000));
    const zip = buildZip([{ name: "bomb.bin", data: bomb, method: 8, uncompSize: 3 }]);
    const parsed = parseZipCentralDirectory(zip); // headers look tiny — passes
    expect(() => extractZipEntries(zip, parsed.entries, 50_000)).toThrow(/zip-bomb/);
    // With a budget that legitimately fits, the same entry extracts fine.
    const out = extractZipEntries(zip, parsed.entries, 200_000);
    expect(out.get("bomb.bin")!.length).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// extractZipEntries — round trip vs fflate-produced archives.
// ---------------------------------------------------------------------------

describe("extractZipEntries", () => {
  it("round-trips an fflate-produced (deflate) multi-skill archive", () => {
    const zip = zipSync({
      "code-reviewer/SKILL.md": u8("---\nname: code-reviewer\n---\n# Code reviewer\nlong instructions here"),
      "code-reviewer/scripts/check.py": u8("print('hi')"),
      "doc-writer/SKILL.md": u8("---\nname: doc-writer\n---\n# Doc writer\nwrites docs"),
    });
    const parsed = parseZipCentralDirectory(zip);
    const out = extractZipEntries(zip, parsed.entries);
    expect(Buffer.from(out.get("code-reviewer/scripts/check.py")!).toString()).toBe("print('hi')");
    expect(out.size).toBe(3);
  });

  it("rejects a local-header signature mismatch", () => {
    const good = buildZip([{ name: "a.txt", data: u8("x") }]);
    // Corrupt the local header signature — the central directory at the end
    // still parses, but extraction must refuse the mismatched local header.
    good[0] = 0x00;
    const parsed = parseZipCentralDirectory(good);
    expect(parsed.entries).toHaveLength(1);
    expect(() => extractZipEntries(good, parsed.entries)).toThrow(ZipFormatError);
  });
});

// ---------------------------------------------------------------------------
// planSkillBundles
// ---------------------------------------------------------------------------

describe("planSkillBundles", () => {
  it("detects a single skill at the archive root", () => {
    const plan = planSkillBundles(["SKILL.md", "assets/logo.png", "scripts/run.py"]);
    expect(plan.skills).toHaveLength(1);
    expect(plan.skills[0]!.dir).toBe("");
    expect(plan.skills[0]!.skillMdPath).toBe("SKILL.md");
    expect(plan.skills[0]!.files.sort()).toEqual(["SKILL.md", "assets/logo.png", "scripts/run.py"]);
    expect(plan.rejected).toHaveLength(0);
  });

  it("detects a single skill inside one top-level folder (legacy layout)", () => {
    const plan = planSkillBundles(["my-skill/SKILL.md", "my-skill/scripts/run.py"]);
    expect(plan.skills).toHaveLength(1);
    expect(plan.skills[0]!.dir).toBe("my-skill");
    expect(plan.skills[0]!.skillMdPath).toBe("SKILL.md");
  });

  it("detects MULTIPLE skills at the root", () => {
    const plan = planSkillBundles([
      "skill-a/SKILL.md",
      "skill-a/assets/x.txt",
      "skill-b/SKILL.md",
      "skill-b/scripts/y.py",
      "skill-c/SKILL.md",
    ]);
    expect(plan.skills.map((s) => s.dir)).toEqual(["skill-a", "skill-b", "skill-c"]);
    expect(plan.rejected).toHaveLength(0);
  });

  it("matches SKILL.md case-insensitively", () => {
    const plan = planSkillBundles(["lower/skill.md", "upper/SKILL.md", "mixed/Skill.MD"]);
    expect(plan.skills.map((s) => s.dir)).toEqual(["lower", "mixed", "upper"]);
  });

  it("rejects dirs without a direct SKILL.md with actionable reasons", () => {
    const plan = planSkillBundles([
      "good/SKILL.md",
      "no-skill/readme.md",
      "nested-too-deep/inner/SKILL.md",
    ]);
    expect(plan.skills.map((s) => s.dir)).toEqual(["good"]);
    const noSkill = plan.rejected.find((r) => r.dir === "no-skill");
    const nested = plan.rejected.find((r) => r.dir === "nested-too-deep");
    expect(noSkill?.reason).toContain("no SKILL.md");
    expect(nested?.reason).toContain("nested-too-deep/inner/SKILL.md");
    expect(nested?.reason).toContain("nested-too-deep/SKILL.md");
  });

  it("returns an empty plan for an archive with no skills at all", () => {
    const plan = planSkillBundles(["docs/readme.md", "img/logo.png"]);
    expect(plan.skills).toHaveLength(0);
    expect(plan.rejected).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// validateSkillMdText
// ---------------------------------------------------------------------------

describe("validateSkillMdText", () => {
  it("accepts front-matter with name + description", () => {
    const r = validateSkillMdText(
      "---\nname: code-reviewer\ndescription: Reviews code\n---\nLong, detailed instructions for reviewing source code carefully.",
      "fallback",
    );
    expect(r.ok).toBe(true);
    expect(r.name).toBe("code-reviewer");
    expect(r.description).toBe("Reviews code");
  });

  it("derives the name from a markdown heading when front-matter lacks one", () => {
    const r = validateSkillMdText("# Web Scraper\nFetches URLs and returns markdown content.", "fallback");
    expect(r.ok).toBe(true);
    expect(r.name).toBe("Web Scraper");
  });

  it("falls back to the provided name when neither front-matter name nor heading exists", () => {
    const r = validateSkillMdText(
      "---\ndescription: something\n---\nThese are long enough instructions for the skill to be useful.",
      "from-filename",
    );
    expect(r.ok).toBe(true);
    expect(r.name).toBe("from-filename");
  });

  it("rejects an empty SKILL.md", () => {
    const r = validateSkillMdText("   \n\n  ", "fallback");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("empty");
  });

  it("rejects content with neither front-matter nor heading", () => {
    const r = validateSkillMdText("Just a plain paragraph with no structure at all, quite long enough.", "fallback");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("front-matter");
  });

  it("rejects a trivial body", () => {
    const r = validateSkillMdText("---\nname: x\n---\nhi", "fallback");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("too short");
  });

  it("rejects a SKILL.md when no name can be derived at all", () => {
    const r = validateSkillMdText(
      "---\ndescription: d\n---\nThis body is long enough to pass the length check, no heading though.",
      "",
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no `name:`");
  });
});

// ---------------------------------------------------------------------------
// Full-pipeline sanity vs the caps.
// ---------------------------------------------------------------------------

describe("zip pipeline caps", () => {
  it("keeps the documented caps stable", () => {
    expect(ZIP_MAX_ENTRIES).toBe(2000);
    expect(ZIP_MAX_TOTAL_UNCOMPRESSED).toBe(50 * 1024 * 1024);
  });
});
