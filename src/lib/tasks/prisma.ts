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
// ============================================================================

import path from "node:path";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

/**
 * Datasource URL resolved explicitly instead of relying on env("DATABASE_URL")
 * inside schema.prisma alone. Why: the generated PrismaClient caches its
 * engine config, and a dev-server instance booted before `.env` existed (or
 * after the var was removed) keeps throwing
 * "Environment variable not found: DATABASE_URL" for its entire lifetime —
 * even after `.env` is fixed — because the globalThis singleton below is
 * reused across hot reloads. Passing `datasourceUrl` here makes the
 * resolution deterministic: env var first (set by Next.js from `.env` at
 * boot), then a cwd-anchored fallback to the SQLite file.
 */
function resolveDatabaseUrl(): string | undefined {
  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  try {
    return `file:${path.join(process.cwd(), "db", "custom.db")}`;
  } catch {
    return undefined; // let Prisma surface its own error
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
