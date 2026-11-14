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
  const repoDb = `file:${path.join(process.cwd(), "db", "custom.db")}`;
  if (isWritableSqliteLocation(path.join(process.cwd(), "db", "custom.db"))) {
    return repoDb;
  }
  // Read-only filesystem (Vercel & friends) — fall back to the writable
  // per-instance tmpfs. Runs are durable on Trigger.dev Cloud; this DB is
  // the local index only (DEPLOY.md: "ephemeral on serverless — fine").
  console.warn(
    `[tasks] db at ${repoDb} is on a read-only filesystem — using ${TMP_DB_PATH} (per-instance, ephemeral)`,
  );
  return `file:${TMP_DB_PATH}`;
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
 * Apply the embedded DDL when the target database has no TaskRun table
 * (a fresh /tmp fallback file on serverless, or a fresh clone). Idempotent
 * and cheap after the first call — the work is memoized in a singleton
 * promise, so awaiting it on every route handler is effectively free.
 * Failures are logged, not thrown: the subsequent query then surfaces its
 * own (real) error, which the routes report honestly.
 */
export function ensureTasksSchema(): Promise<void> {
  globalForPrisma.__onyxTasksSchemaReady ??= (async () => {
    try {
      const rows = (await prisma.$queryRawUnsafe(
        "SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='TaskRun'",
      )) as Array<{ c?: number | bigint }>;
      const existing = Number(rows[0]?.c ?? 0);
      if (existing > 0) return;
      const statements = TASKS_SCHEMA_SQL.split(";")
        .map((s) =>
          s
            .split("\n")
            .filter((line) => !line.trim().startsWith("--"))
            .join("\n")
            .trim(),
        )
        .filter(Boolean);
      for (const statement of statements) {
        await prisma.$executeRawUnsafe(statement);
      }
      console.log(`[tasks] schema initialized (${statements.length} statements)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[tasks] schema init failed: ${message.slice(0, 200)}`);
    }
  })();
  return globalForPrisma.__onyxTasksSchemaReady;
}
