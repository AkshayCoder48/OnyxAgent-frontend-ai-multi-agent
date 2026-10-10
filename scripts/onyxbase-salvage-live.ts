/**
 * LIVE salvage + round-trip test (dev-only, run with bun).
 *
 * 1. Recovers the 4 files that survived the 2026-09-11 overnight incident
 *    (verified byte-complete during diagnosis) from the old chunk records.
 * 2. Runs the REAL pushWorkspace (fixed engine: 120 KB chunks, paced writes,
 *    preflight budget, atomic commit) — which also GC-deletes all the
 *    unrecoverable garbage the broken pushes left behind.
 * 3. Runs the REAL retrieveWorkspace into a fresh sandbox and verifies every
 *    file round-trips byte-identical.
 *
 * Usage: ONYXBASE_KEY=kv_live_… bun scripts/onyxbase-salvage-live.ts
 */
import { OnyxBaseKV } from "../src/lib/onyxbase/kv-client";
import {
  pushWorkspace,
  retrieveWorkspace,
  WORKSPACE_ID,
} from "../src/lib/onyxbase/workspace-sync";
import type { E2BClient } from "../src/lib/e2b/client";

const KEY = process.env.ONYXBASE_KEY;
if (!KEY) {
  console.error("Set ONYXBASE_KEY first.");
  process.exit(1);
}

// ---- helpers -----------------------------------------------------------

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Minimal sandbox stub implementing exactly the methods the sync engine
 *  calls: walkFiles / readFilesBatch (push) + batchWriteBytes (retrieve). */
class StubE2B {
  constructor(public files = new Map<string, Uint8Array>()) {}
  async walkFiles() {
    return [...this.files.entries()].map(([path, b]) => ({ path, size: b.length }));
  }
  async readFilesBatch(paths: string[]) {
    const files = paths
      .filter((p) => this.files.has(p))
      .map((p) => {
        const b = this.files.get(p)!;
        return { path: p, base64: bytesToB64(b), size: b.length };
      });
    const errors = paths
      .filter((p) => !this.files.has(p))
      .map((p) => ({ path: p, error: "not found" }));
    return { files, errors };
  }
  async batchWriteBytes(fs: Array<{ path: string; base64: string }>) {
    for (const f of fs) this.files.set(f.path, b64ToBytes(f.base64));
    return { written: fs.length, errors: [] };
  }
}

// ---- 1. recover the surviving files from the old chunks ----------------

/** (path, fileId, sha8, chunkCount, encoding) — established during the
 *  2026-09-12 diagnosis by cross-referencing fm records, orphaned manifest
 *  partials, and gapless chunk groups. These 4 files are byte-complete. */
const RECOVERY_SPEC = [
  { path: ".bashrc", fileId: "b7cf3e96e1f74fc1", sha8: "afae8986", chunks: 1, enc: "gzip" as const, size: 3526 },
  { path: ".profile", fileId: "ba67a16499c753f7", sha8: "28b4a453", chunks: 1, enc: "gzip" as const, size: 807 },
  { path: ".onyx/runs/run_mtwvqp7y_2szttx/state.json", fileId: "8bb04b68bb66f91e", sha8: "5a81ee95", chunks: 4, enc: "gzip" as const, size: 27539 },
];

async function main() {
  const kv = new OnyxBaseKV(KEY!);
  const t0 = Date.now();

  const sandbox = new StubE2B();
  console.log("== 1. Recovering surviving files ==");
  for (const spec of RECOVERY_SPEC) {
    // Prefer the local copy (saved during the 2026-09-12 diagnosis) — the
    // cloud records may be mid-deletion or on stale instances. Fall back to
    // the adaptive cloud-chunk join when the local copy is absent.
    let recovered: Uint8Array | null = null;
    try {
      const { readFileSync } = await import("node:fs");
      const bytes = new Uint8Array(readFileSync(`/tmp/recovered/${spec.path}`));
      if (bytes.length === spec.size) recovered = bytes;
    } catch {
      /* no local copy — fall through to cloud recovery */
    }
    if (!recovered) {
      // Read every chunk record that exists for this file, then try joining
      // prefixes 1..k (shortest first) — the cloud may hold a MIX of old
      // 3000-char chunks and full-file chunks from a newer write under the
      // same content-addressed keys; the sha256 check picks the valid join.
      const parts: string[] = [];
      for (let i = 1; i <= spec.chunks; i++) {
        const key = `workspace:default:f:${spec.fileId}:${spec.sha8}:${String(i).padStart(6, "0")}`;
        const v = await kv.get(key);
        if (v === null) break;
        parts.push(v);
      }
      for (let k = 1; k <= parts.length; k++) {
        try {
          let payload = b64ToBytes(parts.slice(0, k).join(""));
          if (spec.enc === "gzip") payload = await gunzip(payload);
          if (payload.length === spec.size) {
            const sha = await sha256Hex(payload);
            if (sha.startsWith(spec.sha8)) {
              recovered = payload;
              break;
            }
          }
        } catch {
          /* try next prefix length */
        }
      }
    }
    if (!recovered) throw new Error(`${spec.path}: no valid copy found`);
    sandbox.files.set(spec.path, recovered);
    console.log(`   + ${spec.path} (${recovered.length}B, sha ${await sha256Hex(recovered)})`);
  }

  // ---- 2. push via the REAL fixed engine (GC on) -----------------------

  console.log("\n== 2. pushWorkspace (real fixed code path) ==");
  const push = await pushWorkspace({
    e2b: sandbox as unknown as E2BClient,
    kv,
    onStage: (ev) => console.log(`   [${ev.stage}] ${ev.detail}`),
  });
  console.log(
    `   -> status=${push.status} files=${push.syncedFiles} bytes=${push.uploadedBytes} dur=${push.durationMs}ms errors=${push.errors.length}`,
  );
  for (const e of push.errors) console.log(`      ! ${e.code}: ${e.message.slice(0, 140)}`);
  for (const w of push.warnings ?? []) console.log(`      ⚠ ${w.slice(0, 140)}`);
  if (push.status !== "success") {
    console.error("PUSH FAILED — cloud left untouched.");
    process.exit(1);
  }

  // ---- 3. retrieve into a FRESH sandbox, byte-verify --------------------

  console.log("\n== 3. retrieveWorkspace (fresh sandbox) ==");
  const fresh = new StubE2B();
  const retrieve = await retrieveWorkspace({
    e2b: fresh as unknown as E2BClient,
    kv,
    onStage: (ev) => console.log(`   [${ev.stage}] ${ev.detail}`),
  });
  console.log(
    `   -> status=${retrieve.status} files=${retrieve.restoredFiles} bytes=${retrieve.downloadedBytes} verified=${retrieve.integrityVerified} dur=${retrieve.durationMs}ms`,
  );
  for (const e of retrieve.errors) console.log(`      ! ${e.code}: ${e.message.slice(0, 140)}`);
  if (retrieve.status !== "success") {
    console.error("RETRIEVE FAILED.");
    process.exit(1);
  }

  let mismatches = 0;
  for (const [path, bytes] of sandbox.files) {
    const got = fresh.files.get(path);
    if (!got) {
      console.error(`   ✗ ${path}: MISSING after retrieve`);
      mismatches++;
      continue;
    }
    const a = await sha256Hex(bytes);
    const b = await sha256Hex(got);
    if (a !== b) {
      console.error(`   ✗ ${path}: sha mismatch (${a.slice(0, 8)} vs ${b.slice(0, 8)})`);
      mismatches++;
    } else {
      console.log(`   ✓ ${path}: byte-identical (${bytes.length}B)`);
    }
  }

  // ---- 4. final cloud state ---------------------------------------------

  const finalKeys = await kv.listKeys("workspace:");
  const byKind: Record<string, number> = {};
  for (const k of finalKeys) {
    const kind = k.replace(/:\d+$/, ":#").split(":").slice(0, 3).join(":");
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  console.log("\n== 4. Final cloud key inventory ==");
  console.log("  ", JSON.stringify(byKind), `total=${finalKeys.length}`);

  console.log(
    `\n${mismatches === 0 ? "PASS" : "FAIL"} — workspace ${WORKSPACE_ID}, total ${(Date.now() - t0) / 1000 | 0}s`,
  );
  process.exit(mismatches === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("UNEXPECTED:", e);
  process.exit(1);
});
