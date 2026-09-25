// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToolContext } from "./registry";
import {
  bumpWorkspaceVersion,
  resetWorkspaceSnapshotCache,
  computeTreeDigest,
  parseFindOutput,
  isSnapshotFresh,
  canReuseKeyFiles,
  getWorkspaceSnapshot,
  TREE_WALK_CAP,
  WORKSPACE_SNAPSHOT_TTL_MS,
  type SnapshotCacheEntry,
} from "./workspace-snapshot";

// ============================================================================
// PRD §22 — analyze_workspace must be near-instant. These tests pin the
// cache-invalidation contract:
//   1. TTL fast path: a repeat call within 60s (nothing bumped) does ZERO
//      sandbox round trips.
//   2. bumpWorkspaceVersion() (files) forces a re-walk AND a key-file re-read.
//   3. bumpWorkspaceVersion("local") forces a re-walk but REUSES key files
//      when the tree digest (path+size+mtime) is unchanged.
//   4. Tree-hash reuse: TTL expiry alone re-walks (1 round trip) and reuses
//      key files when the digest matches; a changed tree re-reads them.
// Plus the find-output parser and digest edge cases.
// ============================================================================

// ---------------------------------------------------------------------------
// Module mocks (E2B client + local stores).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  readFilesBatch: vi.fn(),
  walkFiles: vi.fn(),
  createSandbox: vi.fn(),
  peekSandboxId: vi.fn(),
}));

vi.mock("@/lib/e2b/client", () => ({
  getE2BClient: () => ({
    exec: mocks.exec,
    readFilesBatch: mocks.readFilesBatch,
    walkFiles: mocks.walkFiles,
    createSandbox: mocks.createSandbox,
    peekSandboxId: mocks.peekSandboxId,
  }),
  evictAllE2BClients: () => {},
}));

vi.mock("@/lib/services", () => ({
  skillService: {
    list: vi.fn(async () => [
      { id: "s1", name: "Demo Skill", description: "demo", is_active: true, dir_path: "users/u1/skills/demo" },
    ]),
  },
  mcpService: { list: vi.fn(async () => []) },
  settingsService: {
    getDecryptedEnvVars: vi.fn(async () => ({ FOO: "bar" })),
    get: vi.fn(async () => ({ env_vars: [{ name: "FOO", is_secret: false }] })),
    getDecryptedSandboxKey: vi.fn(async () => "test-key"),
  },
}));

vi.mock("@/stores/subagent-store", () => ({
  useSubagentStore: {
    getState: () => ({
      subagents: [
        {
          id: "a1", name: "Researcher", role: null, specialty: null,
          disposable: false, enabled: true, lifecycle_status: "idle",
          last_activity: null, parent_task: null,
        },
      ],
    }),
  },
}));

vi.mock("@/lib/storage/opfs", () => ({
  ensurePath: vi.fn(async () => {
    throw new Error("no OPFS in tests");
  }),
  walkFiles: vi.fn(async () => []),
}));

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;

const FIND_OUTPUT = [
  "d\t4096\t1712345678.0000000000\tsrc",
  "f\t548\t1712345678.1000000000\tsrc/app.ts",
  "f\t1024\t1712345679.2000000000\tREADME.md",
  "f\t220\t1712345680.0000000000\tpackage.json",
  "f\t80\t1712345681.0000000000\t.env",
  "f\t20000\t1712345682.0000000000\ttsconfig.json", // oversized key file
  "f\t9\t1712345683.0000000000\tnotes.txt",
].join("\n");

const FIND_OUTPUT_CHANGED = FIND_OUTPUT + "\nf\t44\t1712345999.0000000000\tnew-file.ts";

const KEY_FILE_CONTENTS: Record<string, string> = {
  "/home/user/README.md": "# Demo\nHello world",
  "/home/user/package.json": '{"name":"demo"}',
  "/home/user/.env": "FOO=hello\nBAR=world\n# comment",
};

function b64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

function makeCtx(): ToolContext {
  return {
    userId: "u1",
    e2bApiKey: "k1",
    emit: () => {},
  } as ToolContext;
}

/** Wire the exec mock to a given find output (exit 0). */
function givenTree(output: string): void {
  mocks.exec.mockImplementation(async () => ({
    stdout: output,
    stderr: "",
    exit_code: 0,
    duration_ms: 4,
  }));
}

function givenKeyFiles(): void {
  mocks.readFilesBatch.mockImplementation(async (paths: string[]) => ({
    files: paths.map((p: string) => ({
      path: p,
      base64: b64(KEY_FILE_CONTENTS[p] ?? ""),
      size: (KEY_FILE_CONTENTS[p] ?? "").length,
    })),
    errors: [],
  }));
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  resetWorkspaceSnapshotCache();
  vi.clearAllMocks();
  mocks.peekSandboxId.mockReturnValue("sbx-known");
  mocks.createSandbox.mockResolvedValue({ id: "sbx-known" });
  givenTree(FIND_OUTPUT);
  givenKeyFiles();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Pure: computeTreeDigest.
// ---------------------------------------------------------------------------

describe("computeTreeDigest", () => {
  const entries = [
    { path: "src", size: 4096, type: "directory", mtime: "1712345678.0" },
    { path: "src/app.ts", size: 548, type: "file", mtime: "1712345678.1" },
  ];

  it("is order-insensitive (find vs list order must not matter)", () => {
    expect(computeTreeDigest(entries)).toBe(computeTreeDigest([...entries].reverse()));
  });

  it("changes when a size changes", () => {
    expect(computeTreeDigest([{ ...entries[1], size: 549 }])).not.toBe(computeTreeDigest(entries));
  });

  it("changes when an mtime changes (same-size rewrite detection)", () => {
    expect(computeTreeDigest([{ ...entries[1], mtime: "1799999999.9" }])).not.toBe(
      computeTreeDigest(entries),
    );
  });

  it("changes when a type changes", () => {
    expect(computeTreeDigest([{ ...entries[1], type: "directory" }])).not.toBe(
      computeTreeDigest(entries),
    );
  });

  it("changes when a path is added/removed", () => {
    expect(computeTreeDigest(entries.slice(0, 1))).not.toBe(computeTreeDigest(entries));
    expect(computeTreeDigest([])).not.toBe(computeTreeDigest(entries));
  });

  it("treats missing mtime as a distinct digest input", () => {
    const noMtime = entries.map(({ path, size, type }) => ({ path, size, type }));
    expect(computeTreeDigest(noMtime)).not.toBe(computeTreeDigest(entries));
  });
});

// ---------------------------------------------------------------------------
// Pure: parseFindOutput.
// ---------------------------------------------------------------------------

describe("parseFindOutput", () => {
  it("parses types, sizes, mtimes and paths", () => {
    const { files, truncated, digest } = parseFindOutput(FIND_OUTPUT, 100);
    expect(files).toHaveLength(7);
    expect(files[0]).toEqual({ path: "src", size: 4096, type: "directory" });
    expect(files[1]).toEqual({ path: "src/app.ts", size: 548, type: "file" });
    expect(truncated).toBe(false);
    // Digest matches an explicit recompute over the parsed entries (mtime included).
    const withMtime = files.map((f, i) => ({
      ...f,
      mtime: FIND_OUTPUT.split("\n")[i].split("\t")[2],
    }));
    expect(digest).toBe(computeTreeDigest(withMtime));
  });

  it("keeps paths that contain tabs (everything after the 3rd tab is the path)", () => {
    const out = "f\t10\t1712345678.0\tweird\tname.txt";
    const { files } = parseFindOutput(out, 10);
    expect(files[0]?.path).toBe("weird\tname.txt");
  });

  it("marks truncation at the cap and stops parsing", () => {
    const { files, truncated } = parseFindOutput(FIND_OUTPUT, 3);
    expect(files).toHaveLength(3);
    expect(truncated).toBe(true);
  });

  it("skips malformed lines and handles CRLF + empty output", () => {
    const out = "garbage\r\nf\t1\t1712345678.0\ta.txt\r\n\r\nno-tabs-here\r\n";
    const { files } = parseFindOutput(out, 10);
    expect(files).toEqual([{ path: "a.txt", size: 1, type: "file" }]);
    expect(parseFindOutput("", 10).files).toEqual([]);
  });

  it("ignores non-file/dir types (symlinks etc.)", () => {
    const { files } = parseFindOutput("l\t1\t1712345678.0\tlink\nf\t1\t1712345678.0\treal", 10);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("real");
  });
});

// ---------------------------------------------------------------------------
// Pure: cache decision helpers.
// ---------------------------------------------------------------------------

function makeCache(overrides: Partial<SnapshotCacheEntry> = {}): SnapshotCacheEntry {
  return {
    files: [],
    treeTruncated: false,
    treeDigest: "abc",
    keyFiles: { readme: "x" },
    keyFilesRead: true,
    localScan: null,
    errors: [],
    fetchedAt: T0,
    fromCache: false,
    key: "k1::u1",
    fsVersion: 0,
    localVersion: 0,
    treeOk: true,
    ...overrides,
  };
}

describe("isSnapshotFresh (TTL fast path)", () => {
  it("is fresh within the TTL when nothing bumped", () => {
    expect(
      isSnapshotFresh(makeCache(), {
        fsVersion: 0,
        localVersion: 0,
        now: T0 + 59_999,
        readKeyFiles: true,
      }),
    ).toBe(true);
  });

  it("is stale after the TTL", () => {
    expect(
      isSnapshotFresh(makeCache(), {
        fsVersion: 0,
        localVersion: 0,
        now: T0 + WORKSPACE_SNAPSHOT_TTL_MS,
        readKeyFiles: true,
      }),
    ).toBe(false);
  });

  it("is stale after ANY file bump", () => {
    expect(
      isSnapshotFresh(makeCache(), {
        fsVersion: 1,
        localVersion: 0,
        now: T0 + 1,
        readKeyFiles: true,
      }),
    ).toBe(false);
  });

  it("is stale after a local bump", () => {
    expect(
      isSnapshotFresh(makeCache(), {
        fsVersion: 0,
        localVersion: 1,
        now: T0 + 1,
        readKeyFiles: true,
      }),
    ).toBe(false);
  });

  it("is stale when the caller wants key files the cache never read", () => {
    expect(
      isSnapshotFresh(makeCache({ keyFilesRead: false }), {
        fsVersion: 0,
        localVersion: 0,
        now: T0 + 1,
        readKeyFiles: true,
      }),
    ).toBe(false);
    // …but fine when the caller doesn't want key files.
    expect(
      isSnapshotFresh(makeCache({ keyFilesRead: false }), {
        fsVersion: 0,
        localVersion: 0,
        now: T0 + 1,
        readKeyFiles: false,
      }),
    ).toBe(true);
  });

  it("is stale after a failed walk or with no cache", () => {
    expect(
      isSnapshotFresh(null, { fsVersion: 0, localVersion: 0, now: T0, readKeyFiles: false }),
    ).toBe(false);
    expect(
      isSnapshotFresh(makeCache({ treeOk: false }), {
        fsVersion: 0,
        localVersion: 0,
        now: T0,
        readKeyFiles: false,
      }),
    ).toBe(false);
  });
});

describe("canReuseKeyFiles (tree-hash reuse)", () => {
  it("reuses when no file bump and the digest matches", () => {
    expect(
      canReuseKeyFiles(makeCache(), { fsVersion: 0, treeDigest: "abc" }),
    ).toBe(true);
  });

  it("never reuses after a file bump (even with a matching digest)", () => {
    expect(
      canReuseKeyFiles(makeCache(), { fsVersion: 1, treeDigest: "abc" }),
    ).toBe(false);
  });

  it("never reuses when the digest changed (tree actually changed)", () => {
    expect(
      canReuseKeyFiles(makeCache(), { fsVersion: 0, treeDigest: "zzz" }),
    ).toBe(false);
  });

  it("never reuses when the cache never read key files", () => {
    expect(
      canReuseKeyFiles(makeCache({ keyFilesRead: false }), { fsVersion: 0, treeDigest: "abc" }),
    ).toBe(false);
    expect(canReuseKeyFiles(null, { fsVersion: 0, treeDigest: "abc" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: getWorkspaceSnapshot round-trip economics.
// ---------------------------------------------------------------------------

describe("getWorkspaceSnapshot round trips", () => {
  it("cold scan = ONE exec (tree) + ONE batched key-file read, local scans included", async () => {
    const snap = await getWorkspaceSnapshot(makeCtx(), { readKeyFiles: true });

    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.readFilesBatch).toHaveBeenCalledTimes(1);
    expect(mocks.createSandbox).not.toHaveBeenCalled(); // known sandbox → no create

    expect(snap.fromCache).toBe(false);
    expect(snap.files).toHaveLength(7);
    expect(snap.treeDigest).toBeTruthy();
    expect(snap.keyFilesRead).toBe(true);
    expect(snap.keyFiles?.readme).toBe("# Demo\nHello world");
    expect(snap.keyFiles?.package_json).toBe('{"name":"demo"}');
    // Oversized key file → placeholder, NOT a batch entry.
    expect(snap.keyFiles?.config?.["tsconfig.json"]).toMatch(/\[file too large: .+ — read with read_file tool\]/);
    // .env values are masked.
    expect(snap.keyFiles?.env?.[".env"]).toBe("FOO=<5 chars>\nBAR=<5 chars>\n# comment");
    // Local scans landed.
    expect(snap.localScan?.skills).toHaveLength(1);
    expect(snap.localScan?.env_vars).toEqual([{ name: "FOO", value_length: 3, is_secret: false }]);
    expect(snap.localScan?.existing_subagents).toHaveLength(1);
    expect(snap.localScan?.memories).toEqual([]);
    expect(snap.errors).toEqual([]);
  });

  it("repeat call within TTL = ZERO round trips (cached snapshot)", async () => {
    await getWorkspaceSnapshot(makeCtx(), { readKeyFiles: true });
    const snap = await getWorkspaceSnapshot(makeCtx(), { readKeyFiles: true });

    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.readFilesBatch).toHaveBeenCalledTimes(1);
    expect(snap.fromCache).toBe(true);
    expect(snap.keyFiles?.readme).toBe("# Demo\nHello world");
    expect(snap.localScan?.skills).toHaveLength(1);
  });

  it("local bump forces a re-walk but REUSES key files when the tree digest matches", async () => {
    await getWorkspaceSnapshot(makeCtx(), { readKeyFiles: true });
    bumpWorkspaceVersion("local");
    const snap = await getWorkspaceSnapshot(makeCtx(), { readKeyFiles: true });

    expect(mocks.exec).toHaveBeenCalledTimes(2); // tree re-walked (1 round trip)
    expect(mocks.readFilesBatch).toHaveBeenCalledTimes(1); // key files REUSED
    expect(snap.fromCache).toBe(false);
    expect(snap.keyFiles?.readme).toBe("# Demo\nHello world");
  });

  it("file bump forces a re-walk AND a key-file re-read", async () => {
    await getWorkspaceSnapshot(makeCtx(), { readKeyFiles: true });
    bumpWorkspaceVersion(); // files scope
    await getWorkspaceSnapshot(makeCtx(), { readKeyFiles: true });

    expect(mocks.exec).toHaveBeenCalledTimes(2);
    expect(mocks.readFilesBatch).toHaveBeenCalledTimes(2);
  });

  it("TTL expiry re-walks but reuses key files while the digest matches", async () => {
    await getWorkspaceSnapshot(makeCtx(), { readKeyFiles: true });
    vi.setSystemTime(T0 + WORKSPACE_SNAPSHOT_TTL_MS + 1_000);
    const snap = await getWorkspaceSnapshot(makeCtx(), { readKeyFiles: true });

    expect(mocks.exec).toHaveBeenCalledTimes(2);
    expect(mocks.readFilesBatch).toHaveBeenCalledTimes(1); // digest hit → reuse
    expect(snap.fromCache).toBe(false);
  });

  it("a changed tree (digest mismatch) re-reads key files", async () => {
    await getWorkspaceSnapshot(makeCtx(), { readKeyFiles: true });
    vi.setSystemTime(T0 + WORKSPACE_SNAPSHOT_TTL_MS + 1_000);
    givenTree(FIND_OUTPUT_CHANGED); // a file appeared — no bump needed
    const snap = await getWorkspaceSnapshot(makeCtx(), { readKeyFiles: true });

    expect(mocks.exec).toHaveBeenCalledTimes(2);
    expect(mocks.readFilesBatch).toHaveBeenCalledTimes(2); // digest miss → re-read
    expect(snap.files).toHaveLength(8);
  });

  it("serves a cold read_key_files=false scan without any key-file round trip", async () => {
    const snap = await getWorkspaceSnapshot(makeCtx(), { readKeyFiles: false });

    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.readFilesBatch).not.toHaveBeenCalled();
    expect(snap.keyFiles).toBeNull();
    expect(snap.keyFilesRead).toBe(false);
  });

  it("a key-files read after a key-files-less cached scan re-fetches them", async () => {
    await getWorkspaceSnapshot(makeCtx(), { readKeyFiles: false });
    const snap = await getWorkspaceSnapshot(makeCtx(), { readKeyFiles: true });

    // The TTL fast path must NOT serve a snapshot lacking key files.
    expect(mocks.exec).toHaveBeenCalledTimes(2);
    expect(mocks.readFilesBatch).toHaveBeenCalledTimes(1);
    expect(snap.keyFilesRead).toBe(true);
  });

  it("falls back to the SDK walk_files action when exec fails", async () => {
    mocks.exec.mockResolvedValue({ stdout: "", stderr: "boom", exit_code: 1, duration_ms: 1 });
    mocks.walkFiles.mockResolvedValue([
      { path: "a.txt", size: 5 },
      { path: "b/c.txt", size: 7 },
    ]);
    const snap = await getWorkspaceSnapshot(makeCtx(), { readKeyFiles: true });

    expect(mocks.walkFiles).toHaveBeenCalledTimes(1);
    expect(snap.files).toEqual([
      { path: "a.txt", size: 5, type: "file" },
      { path: "b/c.txt", size: 7, type: "file" },
    ]);
    // No key-file candidates in the fallback tree → no batch read, empty key files.
    expect(mocks.readFilesBatch).not.toHaveBeenCalled();
    expect(snap.keyFiles).toEqual({});
    expect(snap.keyFilesRead).toBe(true);
  });

  it("reports walk failure honestly (no caching of failed walks)", async () => {
    mocks.exec.mockRejectedValue(new Error("network down"));
    mocks.walkFiles.mockRejectedValue(new Error("network down"));
    const snap = await getWorkspaceSnapshot(makeCtx(), { readKeyFiles: true });

    expect(snap.files).toEqual([]);
    expect(snap.errors[0]).toMatch(/Failed to walk sandbox/);

    // Next call must retry (not serve the failed snapshot from the fast path).
    givenTree(FIND_OUTPUT);
    const snap2 = await getWorkspaceSnapshot(makeCtx(), { readKeyFiles: true });
    expect(snap2.fromCache).toBe(false);
    expect(snap2.files).toHaveLength(7);
  });

  it("creates a sandbox exactly once when none is known (first-run cost only)", async () => {
    mocks.peekSandboxId.mockReturnValue(null);
    await getWorkspaceSnapshot(makeCtx(), { readKeyFiles: true });
    await getWorkspaceSnapshot(makeCtx(), { readKeyFiles: true }); // TTL hit

    expect(mocks.createSandbox).toHaveBeenCalledTimes(1);
  });

  it("caches per user+key (different context → fresh scan)", async () => {
    await getWorkspaceSnapshot(makeCtx(), { readKeyFiles: true });
    const other = { ...makeCtx(), userId: "u2" } as ToolContext;
    const snap = await getWorkspaceSnapshot(other, { readKeyFiles: true });

    expect(mocks.exec).toHaveBeenCalledTimes(2);
    expect(snap.fromCache).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sanity: the constants the design depends on.
// ---------------------------------------------------------------------------

describe("tunables", () => {
  it("TREE_WALK_CAP is a generous superset of the 500-file default", () => {
    expect(TREE_WALK_CAP).toBeGreaterThanOrEqual(2000);
  });

  it("WORKSPACE_SNAPSHOT_TTL_MS is the spec'd 60s", () => {
    expect(WORKSPACE_SNAPSHOT_TTL_MS).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the registered analyze_workspace tool (registration intact +
// legacy output shape, now a superset with `meta`).
// ---------------------------------------------------------------------------

describe("analyze_workspace tool contract", () => {
  it("registers unchanged (orchestration, no approval) and returns the legacy shape", async () => {
    await import("./workspace_analysis");
    const { getTool } = await import("./registry");
    const tool = getTool("analyze_workspace");
    expect(tool).toBeDefined();
    expect(tool?.category).toBe("orchestration");
    expect(tool?.requires_approval).toBe(false);
    expect(tool?.parameters).toHaveProperty("properties.max_files");
    expect(tool?.parameters).toHaveProperty("properties.read_key_files");

    const result = (await tool!.handler({ max_files: 10 }, makeCtx())) as Record<string, unknown>;

    // Legacy keys — all present, exact set plus the new `meta` telemetry.
    expect(Object.keys(result).sort()).toEqual(
      [
        "available_tools",
        "env_vars",
        "errors",
        "existing_subagents",
        "file_count",
        "files",
        "key_files",
        "mcp_servers",
        "memories",
        "meta",
        "skills",
        "summary",
        "total_size_bytes",
      ].sort(),
    );

    // FIND_OUTPUT: 1 directory + 6 files.
    expect(result.files).toHaveLength(7);
    expect(result.file_count).toBe(6);
    expect(result.total_size_bytes).toBe(4096 + 548 + 1024 + 220 + 80 + 20000 + 9);
    expect(result.errors).toEqual([]); // 7 entries < max_files 10 → no truncation
    expect((result.summary as string)).toContain("Files: 6 (1 directories");
    expect((result.summary as string)).toContain("Node.js"); // package.json detected
    const keyFiles = result.key_files as Record<string, unknown>;
    expect(keyFiles.readme).toBe("# Demo\nHello world");
    expect(keyFiles.package_json).toBe('{"name":"demo"}');
    const meta = result.meta as { cached: boolean; scan_ms: number; tree_digest: string };
    expect(meta.cached).toBe(false);
    expect(typeof meta.tree_digest).toBe("string");
  });

  it("respects max_files slicing + truncation error parity", async () => {
    await import("./workspace_analysis");
    const { getTool } = await import("./registry");
    const tool = getTool("analyze_workspace")!;
    const result = (await tool.handler({ max_files: 3 }, makeCtx())) as Record<string, unknown>;

    expect(result.files).toHaveLength(3);
    expect(result.errors).toEqual([
      "File list truncated at 3 entries — increase max_files for full listing.",
    ]);
  });
});
