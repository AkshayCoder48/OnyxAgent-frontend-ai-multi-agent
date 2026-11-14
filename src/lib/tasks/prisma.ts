// ============================================================================
// Background Task Execution Framework — Prisma client singleton (server).
//
// Standard globalThis-guarded PrismaClient: Next.js dev HMR reloads modules
// on every edit, and an unguarded `new PrismaClient()` per reload exhausts
// SQLite's connection pool ("Too many connections"). The cached instance is
// reused across hot reloads and across every route handler in
// src/app/api/tasks/** (each route gets its own module graph entry otherwise).
//
// NOTE: src/lib/db/** is the CLIENT-side Dexie database — a completely
// different storage layer owned by another task. This file is the only
// server-side Prisma entry point for the task framework.
//
// SERVERLESS READ-ONLY FS (fix 2026-11-14 — the "failed to create the run"
// 500 on Vercel): the repo SHIPS db/custom.db, and on Vercel it lands on the
// function's READ-ONLY filesystem (process.cwd() = /var/task). SQLite then
// fails every write with SQLITE_READONLY (extended code 8) — every
// background-run dispatch died inside prisma.taskRun.create and the trigger
// route's catch-all answered the generic 500. Resolution order now:
//   1. DATABASE_URL env (operator's explicit choice — NEVER overridden);
//   2. the cwd-anchored repo db, WHEN its file/directory is writable;
//   3. /tmp/onyx-tasks.db — the serverless fallback (writable, per-instance,
//      documented as ephemeral in DEPLOY.md).
// A fresh fallback file has no tables — ensureTasksSchema() applies the
// embedded DDL (schema-sql.ts) at runtime.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { TASKS_SCHEMA_SQL } from "./schema-sql";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  __onyxTasksSchemaReady?: Promise<void>;
};

/** Serverless fallback location (writable, per-instance, ephemeral). */
const TMP_DB_PATH = "/tmp/onyx-tasks.db";

/** True when the db FILE and its DIRECTORY both allow writes (SQLite needs
 *  the directory for its journal/WAL sidecar files). */
function isWritableSqliteLocation(dbPath: string): boolean {
  try {
    const dir = path.dirname(dbPath);
    fs.accessSync(dir, fs.constants.W_OK);
    if (fs.existsSync(dbPath)) fs.accessSync(dbPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Datasource URL resolved explicitly instead of relying on env("DATABASE_URL")
 * inside schema.prisma alone. Why: the generated PrismaClient caches its
 * engine config, and a dev-server instance booted before `.env` existed (or
 * after the var was removed) keeps throwing
 * "Environment variable not found: DATABASE_URL" for its entire lifetime —
 * even after `.env` is fixed — because the globalThis singleton below is
 * reused across hot reloads. Passing `datasourceUrl` here makes the
 * resolution deterministic: env var first (operator's choice), then a
 * cwd-anchored fallback to the SQLite file, then the /tmp serverless
 * fallback when that location is read-only (see header comment).
 */
function resolveDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  const repoDbPath = path.join(process.cwd(), "db", "custom.db");
  const repoDb = `file:${repoDbPath}`;
  if (isWritableSqliteLocation(repoDbPath)) {
    return repoDb;
  }
  // Read-only filesystem (Vercel & friends) — fall back to the writable
  // per-instance tmpfs. Runs are durable on Trigger.dev Cloud; this DB is
  // the local index only (DEPLOY.md: "ephemeral on serverless — fine").
  // SEED from the read-only repo db first (fix 2026-11-14 #2): the committed
  // file carries the operator's sealed Trigger.dev Cloud key (TaskCloudConfig)
  // and schedules — a fresh empty fallback silently disconnected every
  // instance ("Background runs need a connected Trigger.dev Cloud key").
  seedTmpDbFromRepo(repoDbPath);
  console.warn(
    `[tasks] db at ${repoDb} is on a read-only filesystem — using ${TMP_DB_PATH} (per-instance, ephemeral)`,
  );
  return `file:${TMP_DB_PATH}`;
}

/** Copy the read-only repo db into the /tmp fallback location (once per
 *  instance) so the sealed cloud key + schedules survive the fallback.
 *  Atomic: copy to a staging name, then rename. Best-effort — on any
 *  failure the DDL guard below builds a fresh schema instead. */
function seedTmpDbFromRepo(repoDbPath: string): void {
  try {
    if (fs.existsSync(TMP_DB_PATH) || !fs.existsSync(repoDbPath)) return;
    fs.copyFileSync(repoDbPath, `${TMP_DB_PATH}.seed`);
    // copyFileSync preserves the source mode — the read-only repo db would
    // make the SEEDED copy unwritable too (SQLITE_READONLY on first write).
    fs.chmodSync(`${TMP_DB_PATH}.seed`, 0o644);
    fs.renameSync(`${TMP_DB_PATH}.seed`, TMP_DB_PATH);
    console.log(`[tasks] seeded ${TMP_DB_PATH} from the read-only repo db`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[tasks] seeding ${TMP_DB_PATH} failed: ${message.slice(0, 120)}`);
  }
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["error", "warn"],
    datasources: { db: { url: resolveDatabaseUrl() } },
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * Apply the embedded DDL for any object the target database is missing —
 * a fresh /tmp fallback file, a fresh clone, or a SEEDED file whose committed
 * schema predates a new table (per-statement idempotency: each CREATE
 * TABLE/INDEX is skipped when its object already exists). Cheap after the
 * first call — the work is memoized in a singleton promise, so awaiting it
 * on every route handler is effectively free. Failures are logged, not
 * thrown: the subsequent query then surfaces its own (real) error, which
 * the routes report honestly.
 */
export function ensureTasksSchema(): Promise<void> {
  globalForPrisma.__onyxTasksSchemaReady ??= (async () => {
    try {
      const existing = new Set(
        (
          (await prisma.$queryRawUnsafe(
            "SELECT type || ':' || name AS k FROM sqlite_master WHERE type IN ('table','index')",
          )) as Array<{ k?: string }>
        )
          .map((r) => r.k ?? "")
          .filter(Boolean),
      );
      const statements = TASKS_SCHEMA_SQL.split(";")
        .map((s) =>
          s
            .split("\n")
            .filter((line) => !line.trim().startsWith("--"))
            .join("\n")
            .trim(),
        )
        .filter(Boolean);
      let applied = 0;
      for (const statement of statements) {
        // "CREATE TABLE \"X\" …" / "CREATE [UNIQUE] INDEX \"Y\" ON …" — skip
        // when the object already exists (seeded dbs keep their rows).
        const target = /^CREATE (?:UNIQUE )?(?:TABLE|INDEX) "([^"]+)"/.exec(statement);
        if (!target?.[1]) continue;
        const kind = /^CREATE UNIQUE INDEX|^CREATE INDEX/.test(statement) ? "index" : "table";
        if (existing.has(`${kind}:${target[1]}`)) continue;
        await prisma.$executeRawUnsafe(statement);
        applied += 1;
      }
      if (applied > 0) console.log(`[tasks] schema initialized (${applied} statements)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[tasks] schema init failed: ${message.slice(0, 200)}`);
    }
  })();
  return globalForPrisma.__onyxTasksSchemaReady;
}
