/**
 * Tests for the OnyxBase skills-sync engine (src/lib/onyxbase/skills-sync.ts).
 *
 * The KV client is faked with an in-memory store; OPFS and the services
 * barrel are mocked so the full push → reconcile → restore round trip runs
 * in the node test environment.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OnyxBaseKV } from "@/lib/onyxbase/kv-client";

// ---------------------------------------------------------------------------
// Mocks — in-memory OPFS + services.
// ---------------------------------------------------------------------------

const memFs = new Map<string, Uint8Array>();

vi.mock("@/lib/storage/opfs", () => ({
  ensureSkillDir: vi.fn(async () => ({})),
  writeFileAtPath: vi.fn(async (dirPath: string, filename: string, data: Blob | string) => {
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(await data.arrayBuffer());
    memFs.set(`${dirPath}/${filename}`, bytes);
    return `${dirPath}/${filename}`;
  }),
  walkFiles: vi.fn(async () => {
    // Not used in these tests (the file provider is injected).
    return [];
  }),
  readTextFile: vi.fn(async (path: string) => {
    const bytes = memFs.get(path);
    if (!bytes) throw new Error(`no such file: ${path}`);
    return new TextDecoder().decode(bytes);
  }),
}));

interface MockSkillRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  dir_path: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  sync_state?: string | null;
  synced_at?: string | null;
  cloud_sha256?: string | null;
  sync_chunks?: number | null;
  sync_error?: string | null;
  file_count?: number | null;
  source?: string;
}

const skillRows = new Map<string, MockSkillRow>();

vi.mock("@/lib/services", () => ({
  skillService: {
    list: vi.fn(async (userId: string) =>
      [...skillRows.values()].filter((r) => r.user_id === userId),
    ),
    install: vi.fn(
      async (
        userId: string,
        name: string,
        description: string | null,
        dirPath: string,
        meta: { source?: string; fileCount?: number; resetSync?: boolean } = {},
      ) => {
        const existing = [...skillRows.values()].find((r) => r.user_id === userId && r.name === name);
        if (existing) {
          existing.description = description ?? existing.description;
          existing.dir_path = dirPath;
          existing.is_active = true;
          existing.file_count = meta.fileCount ?? existing.file_count ?? null;
          if (meta.source) existing.source = meta.source;
          if (meta.resetSync !== false) {
            existing.sync_state = "local";
            existing.synced_at = null;
            existing.cloud_sha256 = null;
          }
          existing.updated_at = new Date().toISOString();
          return existing;
        }
        const row: MockSkillRow = {
          id: `row-${name}`,
          user_id: userId,
          name,
          description,
          dir_path: dirPath,
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          file_count: meta.fileCount ?? null,
          source: meta.source,
          sync_state: "local",
        };
        skillRows.set(row.id, row);
        return row;
      },
    ),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const row = skillRows.get(id);
      if (!row) throw new Error(`no row ${id}`);
      Object.assign(row, patch);
      return row;
    }),
    getByName: vi.fn(async (userId: string, name: string) =>
      [...skillRows.values()].find((r) => r.user_id === userId && r.name === name) ?? null,
    ),
  },
  settingsService: {
    // The sandbox upload is a no-op in tests (no key configured).
    getDecryptedSandboxKey: vi.fn(async () => null),
    getFileSystemMode: vi.fn(async () => "auto"),
    getDecryptedOnyxBaseApiKey: vi.fn(async () => null),
    get: vi.fn(async () => null),
  },
}));

// ---------------------------------------------------------------------------
// Fake KV client.
// ---------------------------------------------------------------------------

class FakeKV {
  store = new Map<string, string>();
  setCalls: Array<{ key: string; value: string }> = [];
  deleteCalls: string[] = [];
  /** Keys whose set() should fail (simulating KV write failures). */
  failKeys = new Set<string>();

  async set(key: string, value: string): Promise<void> {
    if (this.failKeys.has(key)) throw new Error(`KV write failed for ${key}`);
    this.setCalls.push({ key, value });
    this.store.set(key, value);
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    this.store.delete(key);
  }
  async listKeys(prefix: string): Promise<string[]> {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
}

const kv = () => new FakeKV() as unknown as OnyxBaseKV & FakeKV;

// ---------------------------------------------------------------------------
// Imports (after mocks are registered).
// ---------------------------------------------------------------------------

import {
  buildSkillPayload,
  parseSkillChunkKey,
  parseSkillPayload,
  planReconcile,
  pushSkillsToCloud,
  readSkillsPointer,
  reconcileSkillsFromCloud,
  restoreSkillFromCloud,
  skillChunkKey,
  skillMetaKey,
  skillsNamespace,
  skillsPointerKey,
  type LocalSkillRow,
} from "./skills-sync";

const USER = "user-1";
const enc = new TextEncoder();

/** ~300 KB of incompressible random bytes (forces multi-chunk payloads). */
function random300k(): Uint8Array {
  const b = new Uint8Array(300 * 1024);
  // getRandomValues caps at 65,536 bytes per call — fill in 32 KB slices.
  for (let i = 0; i < b.length; i += 32 * 1024) {
    crypto.getRandomValues(b.subarray(i, Math.min(i + 32 * 1024, b.length)));
  }
  return b;
}

function makeRow(name: string, overrides: Partial<LocalSkillRow> = {}): LocalSkillRow {
  return {
    id: `row-${name}`,
    name,
    description: `${name} description`,
    dir_path: `users/${USER}/skills/${name}`,
    is_active: true,
    updated_at: new Date().toISOString(),
    sync_state: "local",
    synced_at: null,
    ...overrides,
  };
}

function fileProvider(files: Record<string, Array<{ path: string; bytes: Uint8Array }>>) {
  return async (slug: string) => files[slug] ?? [];
}

const rowUpdates: Array<{ id: string; patch: Record<string, unknown> }> = [];
const rowUpdater = async (id: string, patch: Record<string, unknown>) => {
  rowUpdates.push({ id, patch });
  const row = skillRows.get(id);
  if (row) Object.assign(row, patch);
};

beforeEach(() => {
  memFs.clear();
  skillRows.clear();
  rowUpdates.length = 0;
});

// ---------------------------------------------------------------------------
// Key builders + payload.
// ---------------------------------------------------------------------------

describe("skills KV key builders", () => {
  it("builds the documented namespace layout", () => {
    expect(skillsNamespace(USER)).toBe("skills:user-1");
    expect(skillsPointerKey(USER)).toBe("skills:user-1:manifest");
    expect(skillMetaKey(USER, "code-reviewer")).toBe("skills:user-1:skill:code-reviewer:meta");
    expect(skillChunkKey(USER, "code-reviewer", 0)).toBe("skills:user-1:skill:code-reviewer:chunk:000001");
    expect(skillChunkKey(USER, "code-reviewer", 41)).toBe("skills:user-1:skill:code-reviewer:chunk:000042");
  });

  it("hashes unsafe userIds into a KV-safe namespace segment", () => {
    const ns = skillsNamespace("user with spaces/and:colons");
    expect(ns).toMatch(/^skills:[0-9a-f]{16}$/);
    expect(skillsNamespace("user with spaces/and:colons")).toBe(ns); // deterministic
  });

  it("parses only its own chunk keys (the GC guard)", () => {
    expect(parseSkillChunkKey("skills:user-1:skill:a:chunk:000003")).toEqual({
      ns: "user-1",
      slug: "a",
      index: 3,
    });
    expect(parseSkillChunkKey("workspace:default:f:abc:deadbeef:000003")).toBeNull();
    expect(parseSkillChunkKey("skills:user-1:skill:a:meta")).toBeNull();
    expect(parseSkillChunkKey("skills:user-1:skill:a:chunk:000000")).toBeNull();
  });
});

describe("buildSkillPayload", () => {
  it("is deterministic and order-insensitive across files", async () => {
    const files = [
      { path: "b.txt", bytes: enc.encode("bbb") },
      { path: "SKILL.md", bytes: enc.encode("---\nname: t\n---\nlong instructions") },
      { path: "a.txt", bytes: enc.encode("aaa") },
    ];
    const p1 = await buildSkillPayload("t", files);
    const p2 = await buildSkillPayload("t", [...files].reverse());
    expect(p1.sha256).toBe(p2.sha256);
    expect(p1.files.map((f) => f.p)).toEqual(["SKILL.md", "a.txt", "b.txt"]); // sorted
    expect(p1.rawBytes).toBe(
      "bbb".length + "---\nname: t\n---\nlong instructions".length + "aaa".length,
    );
  });

  it("produces one chunk for a small skill and several for a big one", async () => {
    const small = await buildSkillPayload("s", [{ path: "SKILL.md", bytes: enc.encode("x".repeat(500)) }]);
    expect(small.chunks).toHaveLength(1);
    // ~300 KB of incompressible RANDOM content → several 120k-char chunks.
    const big = await buildSkillPayload("s", [{ path: "data.bin", bytes: random300k() }]);
    expect(big.chunks.length).toBeGreaterThan(1);
  });

  it("round-trips through parseSkillPayload with the same sha", async () => {
    const files = [
      { path: "SKILL.md", bytes: enc.encode("---\nname: t\n---\nlong instructions here") },
      { path: "bin/asset.bin", bytes: new Uint8Array([0, 1, 2, 255]) },
    ];
    const payload = await buildSkillPayload("t", files);
    const decoded = await parseSkillPayload(payload.encoded, payload.encoding, payload.sha256);
    expect(decoded.map((f) => f.path)).toEqual(["SKILL.md", "bin/asset.bin"]);
    expect(Array.from(decoded[1]!.bytes)).toEqual([0, 1, 2, 255]);
  });

  it("rejects a corrupted payload with a checksum error", async () => {
    const payload = await buildSkillPayload("t", [{ path: "SKILL.md", bytes: enc.encode("content") }]);
    await expect(
      parseSkillPayload(payload.encoded, payload.encoding, "deadbeef".repeat(8)),
    ).rejects.toThrow(/Checksum mismatch/);
  });
});

// ---------------------------------------------------------------------------
// planReconcile (pure conflict resolution).
// ---------------------------------------------------------------------------

describe("planReconcile", () => {
  const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

  it("marks identical content as synced", () => {
    const sha = "a".repeat(64);
    const plan = planReconcile(
      [{ slug: "s", sha, updatedAt: iso(0), syncedAt: iso(0) }],
      {
        v: 1,
        updatedAt: iso(0),
        generation: 1,
        skills: [
          {
            slug: "s", name: "s", description: null, sha256: sha, chunkCount: 1,
            encoding: "gzip", size: 10, rawBytes: 20, fileCount: 1,
            files: [], syncedAt: iso(0), version: 1,
          },
        ],
      },
    );
    expect(plan.local[0]!.verdict).toBe("synced");
    expect(plan.cloudOnly).toHaveLength(0);
  });

  it("local wins when the cloud is not newer", () => {
    const plan = planReconcile(
      [{ slug: "s", sha: "b".repeat(64), updatedAt: iso(0), syncedAt: iso(-10_000) }],
      {
        v: 1, updatedAt: iso(0), generation: 1,
        skills: [
          {
            slug: "s", name: "s", description: null, sha256: "c".repeat(64), chunkCount: 1,
            encoding: "gzip", size: 10, rawBytes: 20, fileCount: 1,
            files: [], syncedAt: iso(-20_000), version: 1,
          },
        ],
      },
    );
    expect(plan.local[0]!.verdict).toBe("local");
  });

  it("flags cloud-newer only when the cloud push is newer than our last sync", () => {
    const mk = (localSyncedAt: string | null, cloudSyncedAt: string) =>
      planReconcile(
        [{ slug: "s", sha: "b".repeat(64), updatedAt: iso(0), syncedAt: localSyncedAt }],
        {
          v: 1, updatedAt: iso(0), generation: 1,
          skills: [
            {
              slug: "s", name: "s", description: null, sha256: "c".repeat(64), chunkCount: 1,
              encoding: "gzip", size: 10, rawBytes: 20, fileCount: 1,
              files: [], syncedAt: cloudSyncedAt, version: 2,
            },
          ],
        },
      );
    // Never synced locally + different cloud content → local wins.
    expect(mk(null, iso(1000)).local[0]!.verdict).toBe("local");
    // Synced yesterday, cloud pushed a minute ago → cloud-newer.
    expect(mk(iso(-86_400_000), iso(-60_000)).local[0]!.verdict).toBe("cloud-newer");
    // Synced after the cloud push (our content is the newest) → local.
    expect(mk(iso(-60_000), iso(-86_400_000)).local[0]!.verdict).toBe("local");
  });

  it("marks unreadable local dirs as missing-files", () => {
    const plan = planReconcile([{ slug: "s", sha: null, updatedAt: iso(0), syncedAt: iso(0) }], {
      v: 1, updatedAt: iso(0), generation: 1,
      skills: [
        {
          slug: "s", name: "s", description: null, sha256: "c".repeat(64), chunkCount: 1,
          encoding: "gzip", size: 10, rawBytes: 20, fileCount: 1,
          files: [], syncedAt: iso(0), version: 1,
        },
      ],
    });
    expect(plan.local[0]!.verdict).toBe("missing-files");
  });

  it("lists cloud-only skills for Restore-from-cloud (never deletes)", () => {
    const plan = planReconcile(
      [{ slug: "local-only", sha: "a".repeat(64), updatedAt: iso(0), syncedAt: null }],
      {
        v: 1, updatedAt: iso(0), generation: 1,
        skills: [
          {
            slug: "cloud-only", name: "cloud-only", description: "d", sha256: "c".repeat(64),
            chunkCount: 1, encoding: "gzip", size: 10, rawBytes: 20, fileCount: 1,
            files: [], syncedAt: iso(0), version: 1,
          },
        ],
      },
    );
    expect(plan.cloudOnly.map((e) => e.slug)).toEqual(["cloud-only"]);
    expect(plan.local[0]!.verdict).toBe("local");
  });

  it("returns an empty plan with no cloud state", () => {
    const plan = planReconcile([{ slug: "s", sha: "a".repeat(64), updatedAt: iso(0), syncedAt: null }], null);
    expect(plan.local[0]!.verdict).toBe("local");
    expect(plan.cloudOnly).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// pushSkillsToCloud + restoreSkillFromCloud (fake KV round trip).
// ---------------------------------------------------------------------------

describe("pushSkillsToCloud", () => {
  it("pushes a skill, commits the manifest, and marks the row synced", async () => {
    const client = kv();
    const files = {
      "code-reviewer": [
        { path: "SKILL.md", bytes: enc.encode("---\nname: code-reviewer\n---\nReview code carefully.") },
        { path: "scripts/check.py", bytes: enc.encode("print(1)") },
      ],
    };
    const result = await pushSkillsToCloud(USER, {
      kv: client,
      rows: [makeRow("code-reviewer")],
      fileProvider: fileProvider(files),
      rowUpdater,
      fastReads: true,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("success");
    expect(result.pushed).toBe(1);
    expect(result.unchanged).toBe(0);

    // KV layout: manifest + meta + at least one chunk.
    expect(client.store.has("skills:user-1:manifest")).toBe(true);
    expect(client.store.has("skills:user-1:skill:code-reviewer:meta")).toBe(true);
    expect([...client.store.keys()].some((k) => k.startsWith("skills:user-1:skill:code-reviewer:chunk:"))).toBe(true);

    // Manifest committed with the skill entry.
    const pointer = await readSkillsPointer(client, USER);
    expect(pointer?.skills).toHaveLength(1);
    expect(pointer?.skills[0]!.slug).toBe("code-reviewer");
    expect(pointer?.skills[0]!.fileCount).toBe(2);

    // Row bookkeeping: synced AFTER persistence (§38).
    expect(rowUpdates.at(-1)?.patch).toMatchObject({
      sync_state: "synced",
      cloud_sha256: pointer?.skills[0]!.sha256,
    });
  });

  it("is incremental — identical content costs zero chunk writes", async () => {
    const client = kv();
    const files = {
      s1: [{ path: "SKILL.md", bytes: enc.encode("---\nname: s1\n---\nSome instructions that are long enough.") }],
    };
    const rows = [makeRow("s1")];
    await pushSkillsToCloud(USER, { kv: client, rows, fileProvider: fileProvider(files), rowUpdater });
    const chunkWritesAfterFirst = client.setCalls.filter((c) => c.key.includes(":chunk:")).length;

    const second = await pushSkillsToCloud(USER, { kv: client, rows, fileProvider: fileProvider(files), rowUpdater });
    const chunkWritesAfterSecond = client.setCalls.filter((c) => c.key.includes(":chunk:")).length;
    expect(second.unchanged).toBe(1);
    expect(second.pushed).toBe(0);
    expect(chunkWritesAfterSecond).toBe(chunkWritesAfterFirst);
  });

  it("re-pushes modified content and bumps the version", async () => {
    const client = kv();
    const rows = [makeRow("s1")];
    await pushSkillsToCloud(USER, {
      kv: client, rows,
      fileProvider: fileProvider({ s1: [{ path: "SKILL.md", bytes: enc.encode("v1 ".repeat(30)) }] }),
      rowUpdater,
      fastReads: true,
    });
    const result = await pushSkillsToCloud(USER, {
      kv: client, rows,
      fileProvider: fileProvider({ s1: [{ path: "SKILL.md", bytes: enc.encode("v2 ".repeat(30)) }] }),
      rowUpdater,
      fastReads: true,
    });
    expect(result.pushed).toBe(1);
    const pointer = await readSkillsPointer(client, USER);
    expect(pointer?.skills[0]!.version).toBe(2);
  });

  it("NEVER deletes cloud-only skills (carried over in every manifest)", async () => {
    const client = kv();
    // First push: two skills.
    await pushSkillsToCloud(USER, {
      kv: client,
      rows: [makeRow("keep-me"), makeRow("gone-later")],
      fileProvider: fileProvider({
        "keep-me": [{ path: "SKILL.md", bytes: enc.encode("keep ".repeat(20)) }],
        "gone-later": [{ path: "SKILL.md", bytes: enc.encode("gone ".repeat(20)) }],
      }),
      rowUpdater,
      fastReads: true,
    });
    // Second push: only one local skill remains (the other was uninstalled).
    const result = await pushSkillsToCloud(USER, {
      kv: client,
      rows: [makeRow("keep-me")],
      fileProvider: fileProvider({
        "keep-me": [{ path: "SKILL.md", bytes: enc.encode("keep ".repeat(20)) }],
      }),
      rowUpdater,
      fastReads: true,
    });
    expect(result.cloudOnly).toBe(1);
    const pointer = await readSkillsPointer(client, USER);
    expect(pointer?.skills.map((s) => s.slug).sort()).toEqual(["gone-later", "keep-me"]);
    // The cloud-only skill's records are fully intact.
    expect(client.store.has("skills:user-1:skill:gone-later:meta")).toBe(true);
  });

  it("refuses to replace a non-empty cloud skill with an empty local dir", async () => {
    const client = kv();
    await pushSkillsToCloud(USER, {
      kv: client,
      rows: [makeRow("s1")],
      fileProvider: fileProvider({ s1: [{ path: "SKILL.md", bytes: enc.encode("real ".repeat(20)) }] }),
      rowUpdater,
      fastReads: true,
    });
    // Local dir wiped (e.g. OPFS cleared) — push must NOT overwrite the cloud.
    const result = await pushSkillsToCloud(USER, {
      kv: client,
      rows: [makeRow("s1")],
      fileProvider: fileProvider({ s1: [] }),
      rowUpdater,
      fastReads: true,
    });
    expect(result.pushed).toBe(0);
    expect(result.skipped[0]).toContain("cloud copy holds");
    const pointer = await readSkillsPointer(client, USER);
    expect(pointer?.skills[0]!.fileCount).toBe(1);
  });

  it("skips oversize skills and does NOT commit a manifest when any skill fails", async () => {
    const client = kv();
    const big = new Uint8Array(3 * 1024 * 1024).fill(1); // > 2 MB cap
    const result = await pushSkillsToCloud(USER, {
      kv: client,
      rows: [makeRow("small"), makeRow("big")],
      fileProvider: fileProvider({
        small: [{ path: "SKILL.md", bytes: enc.encode("tiny") }],
        big: [{ path: "data.bin", bytes: big }],
      }),
      rowUpdater,
      fastReads: true,
    });
    expect(result.failed).toBe(1);
    expect(result.status).toBe("partial");
    // No commit — the previous cloud state (empty) is untouched.
    expect(client.store.has("skills:user-1:manifest")).toBe(false);
  });

  it("GC-trims stale over-index chunks of manifest members only", async () => {
    const client = kv();
    const rows = [makeRow("s1")];
    // First push: big payload → 3 chunks.
    await pushSkillsToCloud(USER, {
      kv: client, rows,
      fileProvider: fileProvider({ s1: [{ path: "data.bin", bytes: random300k() }] }),
      rowUpdater,
      fastReads: true,
    });
    const pointer1 = await readSkillsPointer(client, USER);
    const chunks1 = pointer1!.skills[0]!.chunkCount;
    expect(chunks1).toBeGreaterThan(1);
    // Second push: tiny payload → 1 chunk; the stale 2..N chunks get GC'd.
    await pushSkillsToCloud(USER, {
      kv: client, rows,
      fileProvider: fileProvider({ s1: [{ path: "SKILL.md", bytes: enc.encode("small") }] }),
      rowUpdater,
      fastReads: true,
    });
    const stale = client.deleteCalls.filter((k) => k.includes(":chunk:"));
    expect(stale.length).toBe(chunks1 - 1);
    const remaining = [...client.store.keys()].filter(
      (k) => k.startsWith("skills:user-1:skill:s1:chunk:"),
    );
    expect(remaining).toEqual(["skills:user-1:skill:s1:chunk:000001"]);
  });

  it("retries a failed chunk write exactly once, then fails that skill", async () => {
    const client = kv();
    client.failKeys.add("skills:user-1:skill:s1:chunk:000001");
    const result = await pushSkillsToCloud(USER, {
      kv: client,
      rows: [makeRow("s1")],
      fileProvider: fileProvider({ s1: [{ path: "SKILL.md", bytes: enc.encode("data ".repeat(20)) }] }),
      rowUpdater,
      fastReads: true,
    });
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain("s1");
    // Two attempts (initial + 1 retry), then the honest per-skill failure.
    expect(client.setCalls.filter((c) => c.key.endsWith("chunk:000001")).length).toBeLessThanOrEqual(2);
    expect(client.store.has("skills:user-1:manifest")).toBe(false); // no commit
  });
});

describe("restoreSkillFromCloud", () => {
  it("round-trips a pushed skill back into local storage", async () => {
    const client = kv();
    const original = [
      { path: "SKILL.md", bytes: enc.encode("---\nname: restored\n---\nThese are the restored instructions.") },
      { path: "assets/x.bin", bytes: new Uint8Array([9, 8, 7]) },
    ];
    await pushSkillsToCloud(USER, {
      kv: client,
      rows: [makeRow("restored")],
      fileProvider: fileProvider({ restored: original }),
      rowUpdater,
      fastReads: true,
    });

    // "Wipe" the device: local rows + OPFS gone.
    skillRows.clear();
    memFs.clear();

    const restore = await restoreSkillFromCloud(USER, "restored", { kv: client, rowUpdater });
    expect(restore.ok).toBe(true);
    expect(restore.restoredFiles).toBe(2);
    // Files restored byte-identically.
    const restoredMd = memFs.get(`users/${USER}/skills/restored/SKILL.md`);
    expect(restoredMd).toBeDefined();
    expect(new TextDecoder().decode(restoredMd!)).toContain("restored instructions");
    const restoredBin = memFs.get(`users/${USER}/skills/restored/assets/x.bin`);
    expect(Array.from(restoredBin!)).toEqual([9, 8, 7]);
    // Dexie row re-registered as a cloud restore, marked synced.
    const row = skillRows.get("row-restored");
    expect(row).toBeDefined();
    expect(row!.source).toBe("restore");
    expect(row!.sync_state).toBe("synced");
  });

  it("refuses a corrupted cloud copy BEFORE writing anything locally", async () => {
    const client = kv();
    await pushSkillsToCloud(USER, {
      kv: client,
      rows: [makeRow("s1")],
      fileProvider: fileProvider({ s1: [{ path: "SKILL.md", bytes: enc.encode("content ".repeat(10)) }] }),
      rowUpdater,
      fastReads: true,
    });
    // Corrupt the stored chunk value.
    const chunkKey = [...client.store.keys()].find((k) => k.includes(":chunk:"))!;
    client.store.set(chunkKey, client.store.get(chunkKey)!.slice(0, -4));
    skillRows.clear();
    memFs.clear();

    const restore = await restoreSkillFromCloud(USER, "s1", { kv: client, rowUpdater });
    expect(restore.ok).toBe(false);
    expect(restore.error).toMatch(/[Cc]hecksum|valid skill payload/);
    // Nothing was written locally.
    expect(memFs.size).toBe(0);
    expect(skillRows.size).toBe(0);
  });

  it("reports a missing cloud skill honestly", async () => {
    const client = kv();
    const restore = await restoreSkillFromCloud(USER, "never-pushed", { kv: client, rowUpdater });
    expect(restore.ok).toBe(false);
    expect(restore.error).toContain("never-pushed");
  });
});

describe("reconcileSkillsFromCloud", () => {
  it("resets stuck syncing rows from a crashed session and returns the plan", async () => {
    const client = kv();
    const files = { s1: [{ path: "SKILL.md", bytes: enc.encode("content ".repeat(10)) }] };
    await pushSkillsToCloud(USER, {
      kv: client,
      rows: [makeRow("s1")],
      fileProvider: fileProvider(files),
      rowUpdater,
      fastReads: true,
    });
    // Simulate a crashed push: row stuck at "syncing".
    const stuck = makeRow("s1", { sync_state: "syncing", synced_at: new Date().toISOString() });
    const outcome = await reconcileSkillsFromCloud(USER, {
      kv: client,
      rows: [stuck],
      fileProvider: fileProvider(files),
      rowUpdater,
      fastReads: true,
    });
    expect(outcome.resetStuck).toEqual(["s1"]);
    expect(outcome.plan.local[0]!.verdict).toBe("synced"); // content matches cloud
    expect(outcome.plan.cloudOnly).toHaveLength(0);
  });

  it("lists cloud-only skills after a local wipe", async () => {
    const client = kv();
    await pushSkillsToCloud(USER, {
      kv: client,
      rows: [makeRow("s1"), makeRow("s2")],
      fileProvider: fileProvider({
        s1: [{ path: "SKILL.md", bytes: enc.encode("one ".repeat(10)) }],
        s2: [{ path: "SKILL.md", bytes: enc.encode("two ".repeat(10)) }],
      }),
      rowUpdater,
      fastReads: true,
    });
    const outcome = await reconcileSkillsFromCloud(USER, {
      kv: client,
      rows: [makeRow("s1")], // s2 was uninstalled locally
      fileProvider: fileProvider({
        s1: [{ path: "SKILL.md", bytes: enc.encode("one ".repeat(10)) }],
      }),
      rowUpdater,
      fastReads: true,
    });
    expect(outcome.plan.cloudOnly.map((e) => e.slug)).toEqual(["s2"]);
    expect(outcome.plan.local[0]!.verdict).toBe("synced");
  });
});
